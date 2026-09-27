// Watch Sync background worker. Holds one WebSocket per synced tab, keeps a
// clock offset to the server, and relays between the server and the frame that
// holds the video. The socket lives here (not in the content script) so page
// CSP and mixed-content rules on the watched site can't block it.

importScripts('config.js');

const DEFAULT_SERVER = WATCH_SYNC_DEFAULT_SERVER;
const PING_INTERVAL_MS = 10000; // also keeps the service worker alive (Chrome 116+)
const CLOCK_SAMPLES = 10;
// Ad frames heartbeat every 500ms while their ad plays. Hidden tabs throttle
// timers to once a second, so allow a few missed beats.
const AD_FRAME_TIMEOUT_MS = 3000;
const CHAT_KEEP = 100;

const sessions = new Map(); // tabId -> session

function newSession(tabId, cfg) {
  return {
    tabId,
    room: cfg.room,
    server: cfg.server || DEFAULT_SERVER,
    name: cfg.name || 'Guest',
    url: cfg.url || '',
    ws: null,
    status: 'connecting',
    error: '',
    roomUrl: '',
    state: null, // latest room state from the server
    clock: [], // recent { rtt, offset } samples
    offset: 0, // server time minus local time, from the lowest-RTT sample
    rtt: 0,
    frames: new Map(), // frameId -> video area
    frameId: null,
    adFrames: new Map(), // frameId -> last heartbeat, for frames showing an ad player
    externalAd: false,
    hold: false, // manual "I'm on an ad" hold
    selfId: null,
    chat: [], // recent chat messages, so a reloaded or new video frame gets history
    lastReport: null,
    timers: [],
    closedByUser: false,
    retries: 0,
  };
}

async function saveConfigs() {
  const configs = {};
  for (const [tabId, s] of sessions) {
    configs[tabId] = { room: s.room, server: s.server, name: s.name, url: s.url };
  }
  await chrome.storage.session.set({ configs });
}

async function restoreSessions() {
  const { configs = {} } = await chrome.storage.session.get('configs');
  for (const [tabId, cfg] of Object.entries(configs)) {
    const id = Number(tabId);
    if (!sessions.has(id)) {
      try {
        await chrome.tabs.get(id);
        connect(id, cfg);
      } catch {
        // Tab no longer exists.
      }
    }
  }
}
const restored = restoreSessions();

function wsSend(s, msg) {
  if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(msg));
}

function toFrame(s, msg) {
  if (s.frameId === null) return Promise.resolve(undefined);
  return chrome.tabs.sendMessage(s.tabId, msg, { frameId: s.frameId }).catch(() => undefined);
}

// Everything the video frame needs to act on.
function pushToFrame(s) {
  if (!s.state) return;
  toFrame(s, {
    type: 'state',
    state: s.state,
    offset: s.offset,
    externalAd: s.externalAd,
    hold: s.hold,
    selfId: s.selfId,
  });
}

function connect(tabId, cfg) {
  disconnect(tabId, { silent: true });
  const s = newSession(tabId, cfg);
  sessions.set(tabId, s);
  saveConfigs();
  openSocket(s);
  return s;
}

function openSocket(s) {
  let ws;
  try {
    ws = new WebSocket(s.server);
  } catch (e) {
    s.status = 'error';
    s.error = `Bad server URL: ${e.message}`;
    return;
  }
  s.ws = ws;
  s.status = 'connecting';

  ws.onopen = () => {
    s.retries = 0;
    wsSend(s, { t: 'join', room: s.room, name: s.name, url: s.url });
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(s, msg);
  };

  ws.onclose = () => {
    if (sessions.get(s.tabId) !== s || s.closedByUser) return;
    clearTimers(s);
    s.status = 'reconnecting';
    s.state = null;
    const delay = Math.min(30000, 1000 * 2 ** s.retries++);
    s.timers.push(setTimeout(() => {
      if (sessions.get(s.tabId) === s) openSocket(s);
    }, delay));
  };

  ws.onerror = () => {
    s.error = `Could not reach ${s.server}`;
  };
}

function clearTimers(s) {
  s.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  s.timers = [];
}

function disconnect(tabId, { silent = false } = {}) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.closedByUser = true;
  clearTimers(s);
  if (s.ws) s.ws.close();
  sessions.delete(tabId);
  saveConfigs();
  if (!silent) toFrame(s, { type: 'left' });
}

function ping(s) {
  wsSend(s, { t: 'ping', id: Date.now() });
}

function handleServerMessage(s, msg) {
  switch (msg.t) {
    case 'joined':
      s.status = 'connected';
      s.error = '';
      s.roomUrl = msg.url;
      s.selfId = msg.id;
      s.chat = msg.chat || [];
      toFrame(s, { type: 'chat-history', messages: s.chat, selfId: s.selfId });
      clearTimers(s);
      // A quick burst of pings gives a good clock offset before playback starts.
      for (let i = 0; i < 5; i++) s.timers.push(setTimeout(() => ping(s), i * 150));
      s.timers.push(setInterval(() => ping(s), PING_INTERVAL_MS));
      s.timers.push(setInterval(() => updateExternalAd(s), 500));
      break;
    case 'pong': {
      const now = Date.now();
      const rtt = now - msg.id;
      s.clock.push({ rtt, offset: msg.now - (msg.id + rtt / 2) });
      if (s.clock.length > CLOCK_SAMPLES) s.clock.shift();
      const best = s.clock.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      s.offset = best.offset;
      s.rtt = rtt;
      break;
    }
    case 'state':
      s.state = msg;
      s.lastReport = null;
      if (s.frameId === null) {
        // Nothing to play here yet; tell the room not to wait for us.
        report(s, { epoch: msg.epoch, ready: false, reason: 'novideo', pos: null });
      } else {
        pushToFrame(s);
      }
      break;
    case 'chat':
      s.chat.push(msg.message);
      if (s.chat.length > CHAT_KEEP) s.chat.shift();
      toFrame(s, { type: 'chat', message: msg.message, selfId: s.selfId });
      break;
    case 'chat-error':
      toFrame(s, { type: 'toast', text: msg.error });
      break;
    case 'url':
      s.roomUrl = msg.url;
      break;
    case 'error':
      s.status = 'error';
      s.error = msg.error;
      break;
  }
}

// Ad frames can disappear without notice (the player just removes the iframe),
// so an ad counts only while its frame keeps sending heartbeats.
function updateExternalAd(s) {
  const now = Date.now();
  for (const [frameId, seen] of s.adFrames) {
    if (now - seen > AD_FRAME_TIMEOUT_MS) s.adFrames.delete(frameId);
  }
  const active = s.adFrames.size > 0;
  if (active !== s.externalAd) {
    s.externalAd = active;
    pushToFrame(s);
  }
}

function report(s, st) {
  const key = `${st.epoch}|${st.ready}|${st.reason}`;
  if (key === s.lastReport) return;
  s.lastReport = key;
  wsSend(s, { t: 'status', ...st });
}

function pickFrame(s) {
  // Stay on the current video frame while it exists, so an ad overlay in a
  // bigger frame can't take over.
  if (s.frameId !== null && s.frames.has(s.frameId)) return;
  let best = null;
  let bestArea = -1;
  for (const [frameId, area] of s.frames) {
    if (area > bestArea) { best = frameId; bestArea = area; }
  }
  if (best !== s.frameId) {
    s.frameId = best;
    s.lastReport = null;
    if (best !== null) {
      pushToFrame(s);
      toFrame(s, { type: 'chat-history', messages: s.chat, selfId: s.selfId });
    }
    else if (s.state) report(s, { epoch: s.state.epoch, ready: false, reason: 'novideo', pos: null });
  }
}

function statusFor(tabId) {
  const s = sessions.get(tabId);
  if (!s) return { joined: false };
  const st = s.state;
  return {
    joined: true,
    room: s.room,
    server: s.server,
    name: s.name,
    status: s.status,
    error: s.error,
    roomUrl: s.roomUrl,
    rtt: s.rtt,
    hasVideo: s.frameId !== null,
    hold: s.hold,
    phase: st ? st.phase : null,
    blockers: st ? st.blockers : [],
    members: st ? st.members : [],
    chat: s.chat.slice(-20),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await restored;
    // The popup names its tab explicitly; content scripts are identified by their sender.
    const tabId = msg.tabId ?? sender.tab?.id;
    const s = sessions.get(tabId);
    const fromMain = s && sender.tab && sender.frameId === s.frameId;

    switch (msg.type) {
      // From the popup.
      case 'status':
        return statusFor(tabId);
      case 'join': {
        const tab = await chrome.tabs.get(tabId);
        connect(tabId, { ...msg, url: tab.url });
        // Frames already on the page re-announce their videos.
        chrome.tabs.sendMessage(tabId, { type: 'announce' }).catch(() => {});
        return statusFor(tabId);
      }
      case 'leave':
        disconnect(tabId);
        return statusFor(tabId);
      case 'force':
        if (s) wsSend(s, { t: 'force' });
        return statusFor(tabId);
      case 'inspect-chat':
        return s ? toFrame(s, { type: 'inspect-chat' }) : null;
      case 'hold':
        if (s) {
          s.hold = !!msg.active;
          pushToFrame(s);
        }
        return statusFor(tabId);

      // From content scripts.
      case 'video':
        if (s) {
          s.frames.set(sender.frameId, msg.area);
          pickFrame(s);
        }
        return { joined: !!s };
      case 'video-gone':
        if (s) {
          s.frames.delete(sender.frameId);
          pickFrame(s);
        }
        return;
      case 'ad-frame':
        if (s) {
          if (msg.active) s.adFrames.set(sender.frameId, Date.now());
          else s.adFrames.delete(sender.frameId);
          updateExternalAd(s);
        }
        return;
      case 'report':
        if (fromMain && s.state) report(s, msg.status);
        return;
      case 'chat':
        if (fromMain && s.status === 'connected') wsSend(s, { t: 'chat', text: msg.text, replyTo: msg.replyTo || null });
        return;
      case 'intent':
        if (fromMain && s.status === 'connected') {
          wsSend(s, { t: 'intent', action: msg.action, pos: msg.pos, reason: msg.reason });
        }
        return;
    }
  })().then(sendResponse);
  return true;
});

// Keyboard shortcut (Option+C / Alt+C by default) opens and closes the chat.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-chat') return;
  await restored;
  const id = tab ? tab.id : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  const s = sessions.get(id);
  if (s) toFrame(s, { type: 'toggle-chat' });
});

chrome.tabs.onRemoved.addListener((tabId) => disconnect(tabId, { silent: true }));

chrome.tabs.onUpdated.addListener((tabId, info) => {
  const s = sessions.get(tabId);
  if (!s || info.status !== 'loading' || !info.url) return;
  // A real navigation replaces every frame; frames re-announce their videos.
  s.frames.clear();
  s.adFrames.clear();
  pickFrame(s);
});
