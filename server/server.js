// Watch Sync relay server. Each room has one authoritative playback state.
// Clients send intents (play/pause/seek) and readiness reports; the server
// decides when the room actually plays. If any member is buffering or watching
// an ad, the room holds at a shared position and resumes for everyone at a
// scheduled server time once all members are ready again.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const MAX_ROOM_SIZE = 16;
const START_DELAY_MS = 700; // lead time so every client can start at the same instant
const UNRESPONSIVE_MS = 10000; // members that never report for a state stop blocking
// Reasons that mean "not watching right now" rather than "hold the room for me".
const NON_BLOCKING = new Set(['novideo', 'standby']);
const CHAT_HISTORY = 50; // messages kept per room for people who join later
const CHAT_MAX_LEN = 500;
const CHAT_BURST = 8; // messages allowed per member within CHAT_WINDOW_MS
const CHAT_WINDOW_MS = 5000;

const rooms = new Map(); // roomId -> room
let nextId = 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`watch-sync relay ok, ${rooms.size} room(s)\n`);
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function cleanRoomId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
}

function newRoom(url) {
  return {
    url,
    members: new Map(), // id -> member
    epoch: 0,
    intent: 'paused', // what people asked for
    phase: 'paused', // 'paused' | 'waiting' (intent playing, someone not ready) | 'playing'
    position: 0, // seconds; while playing, the position at `anchor`
    anchor: 0, // server ms at which `position` applies
    lastAction: null, // { name, action }
    unresponsiveTimer: null,
    chat: [], // recent { mid, kind, from, name, text, ts }
    nextMid: 1,
  };
}

function positionAt(room, now) {
  if (room.phase !== 'playing' || now < room.anchor) return room.position;
  return room.position + (now - room.anchor) / 1000;
}

function isBlocking(room, m) {
  if (m.ignored || m.unresponsive) return false;
  if (m.epoch !== room.epoch) return room.phase === 'waiting'; // no report yet for this state
  return !m.ready && !NON_BLOCKING.has(m.reason);
}

function blockers(room) {
  return [...room.members.values()]
    .filter((m) => isBlocking(room, m))
    .map((m) => ({ id: m.id, name: m.name, reason: m.epoch === room.epoch ? m.reason : 'syncing' }));
}

function snapshot(room) {
  return {
    t: 'state',
    epoch: room.epoch,
    intent: room.intent,
    phase: room.phase,
    position: room.position,
    anchor: room.anchor,
    now: Date.now(),
    blockers: blockers(room),
    members: [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      ready: m.epoch === room.epoch ? m.ready : null,
      reason: m.reason,
      ignored: m.ignored,
    })),
    lastAction: room.lastAction,
  };
}

function broadcastState(room) {
  const msg = snapshot(room);
  for (const m of room.members.values()) send(m.ws, msg);
}

// Every change to the playback state gets a new epoch; readiness reports only
// count for the epoch they were made against.
function setState(room, changes) {
  Object.assign(room, changes);
  room.epoch++;
  clearTimeout(room.unresponsiveTimer);
  for (const m of room.members.values()) m.unresponsive = false;
  const epoch = room.epoch;
  room.unresponsiveTimer = setTimeout(() => {
    if (room.epoch !== epoch) return;
    for (const m of room.members.values()) if (m.epoch !== epoch) m.unresponsive = true;
    evaluate(room);
  }, UNRESPONSIVE_MS);
  evaluate(room);
}

function evaluate(room) {
  if (room.intent === 'playing') {
    const now = Date.now();
    const waitingOn = [...room.members.values()].filter((m) => isBlocking(room, m));
    if (room.phase === 'playing' && waitingOn.length) {
      // Hold everyone where the slowest blocker is (within reason) so nobody misses anything.
      const roomPos = positionAt(room, now);
      const reported = waitingOn
        .map((m) => m.pos)
        .filter((p) => typeof p === 'number' && p >= roomPos - 15 && p <= roomPos + 1);
      const position = reported.length ? Math.min(...reported) : roomPos;
      return setState(room, { phase: 'waiting', position, anchor: now });
    }
    if (room.phase === 'waiting' && !waitingOn.length) {
      return setState(room, { phase: 'playing', anchor: now + START_DELAY_MS });
    }
  }
  // Nothing to transition; still share readiness so clients can show who we're waiting for.
  broadcastState(room);
}

function postChat(room, entry) {
  const msg = { mid: room.nextMid++, ts: Date.now(), ...entry };
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY) room.chat.shift();
  for (const m of room.members.values()) send(m.ws, { t: 'chat', message: msg });
}

// Quote the original from history when we still have it, so replies can't
// misquote anyone; fall back to the client's copy for messages that aged out.
function resolveReply(room, r) {
  if (!r || !Number.isFinite(r.mid)) return null;
  const orig = room.chat.find((c) => c.mid === r.mid && c.kind === 'msg');
  const src = orig || r;
  return { mid: r.mid, name: String(src.name || '').slice(0, 32), text: String(src.text || '').slice(0, 140) };
}

function applyIntent(room, member, msg) {
  const now = Date.now();
  const pos = Number.isFinite(msg.pos) ? Math.max(0, msg.pos) : positionAt(room, now);
  room.lastAction = { id: member.id, name: member.name, action: msg.reason === 'ad' ? 'ad' : msg.action };
  // Someone took control; let everyone be waited for again.
  for (const m of room.members.values()) m.ignored = false;

  if (msg.action === 'pause') {
    setState(room, { intent: 'paused', phase: 'paused', position: pos, anchor: now });
  } else if (msg.action === 'play') {
    setState(room, { intent: 'playing', phase: 'waiting', position: pos, anchor: now });
  } else if (msg.action === 'resync') {
    // Everyone lines up on the room's position and, if playing, restarts together.
    const position = positionAt(room, now);
    if (room.intent === 'playing') setState(room, { phase: 'waiting', position, anchor: now });
    else setState(room, { position, anchor: now });
  } else if (msg.action === 'seek') {
    // Everyone has to buffer the new position, so playback restarts through 'waiting'.
    const phase = room.intent === 'playing' ? 'waiting' : 'paused';
    setState(room, { phase, position: pos, anchor: now });
  }
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  let room = null;
  let roomId = null;
  let member = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.t === 'ping') return send(ws, { t: 'pong', id: msg.id, now: Date.now() });

    if (msg.t === 'join') {
      if (room) return;
      roomId = cleanRoomId(msg.room);
      if (!roomId) return send(ws, { t: 'error', error: 'Invalid room code' });
      room = rooms.get(roomId);
      if (!room) {
        room = newRoom(String(msg.url || ''));
        rooms.set(roomId, room);
      }
      if (room.members.size >= MAX_ROOM_SIZE) {
        room = null;
        return send(ws, { t: 'error', error: 'Room is full' });
      }
      member = {
        id, ws,
        name: String(msg.name || 'Guest').slice(0, 32),
        epoch: -1, ready: false, reason: 'syncing', pos: null,
        ignored: false, unresponsive: false, chatTimes: [],
      };
      room.members.set(id, member);
      send(ws, { t: 'joined', id, room: roomId, url: room.url, chat: room.chat });
      postChat(room, { kind: 'system', from: id, name: member.name, text: `${member.name} joined` });
      broadcastState(room);
      return;
    }

    if (!room) return;

    if (msg.t === 'intent') {
      if (['play', 'pause', 'seek', 'resync'].includes(msg.action)) applyIntent(room, member, msg);
    } else if (msg.t === 'status') {
      if (msg.epoch !== room.epoch) return; // stale report for an older state
      const ready = !!msg.ready;
      const reason = ready ? '' : String(msg.reason || 'buffering').slice(0, 16);
      const pos = Number.isFinite(msg.pos) ? msg.pos : null;
      const changed = member.epoch !== msg.epoch || member.ready !== ready || member.reason !== reason;
      Object.assign(member, { epoch: msg.epoch, ready, reason, pos, unresponsive: false });
      if (ready) member.ignored = false;
      if (changed) evaluate(room);
    } else if (msg.t === 'force') {
      // "Play without waiting": stop waiting for whoever is currently holding the room.
      for (const m of room.members.values()) if (isBlocking(room, m)) m.ignored = true;
      room.lastAction = { id: member.id, name: member.name, action: 'force' };
      evaluate(room);
    } else if (msg.t === 'chat') {
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
      if (!text) return;
      const now = Date.now();
      member.chatTimes = member.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
      if (member.chatTimes.length >= CHAT_BURST) {
        return send(ws, { t: 'chat-error', error: 'Slow down: too many messages at once.' });
      }
      member.chatTimes.push(now);
      postChat(room, { kind: 'msg', from: id, name: member.name, text, replyTo: resolveReply(room, msg.replyTo) });
    } else if (msg.t === 'url') {
      room.url = String(msg.url || '');
      for (const m of room.members.values()) if (m !== member) send(m.ws, { t: 'url', url: room.url, name: member.name });
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.members.delete(id);
    if (room.members.size === 0) {
      clearTimeout(room.unresponsiveTimer);
      rooms.delete(roomId);
    } else {
      postChat(room, { kind: 'system', from: id, name: member.name, text: `${member.name} left` });
      evaluate(room);
    }
  });
});

// Drop connections that stop answering protocol-level pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => {
  clearInterval(heartbeat);
  for (const room of rooms.values()) clearTimeout(room.unresponsiveTimer);
});

server.listen(PORT, () => console.log(`watch-sync relay listening on :${PORT}`));

module.exports = { server, wss, rooms };
