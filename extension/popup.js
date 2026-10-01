const $ = (id) => document.getElementById(id);
let tab;
let pollTimer;

function randomRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId: tab.id });
}

// Copies text and briefly confirms on the button itself.
async function copy(buttonId, text) {
  const btn = $(buttonId);
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  await navigator.clipboard.writeText(text);
  btn.textContent = 'Copied';
  btn.classList.add('done');
  clearTimeout(btn.resetTimer);
  btn.resetTimer = setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove('done');
  }, 1500);
}

// ---- The marquee ----------------------------------------------------------------

const BULBS = 15;
const BOARD_W = 250; // usable width of the felt, in px
const LETTER_EM = 0.56; // average width of a Big Shoulders capital, in em

for (const row of document.querySelectorAll('.bulbs')) {
  row.append(...Array.from({ length: BULBS }, () => document.createElement('i')));
}

// While connecting, every third bulb is lit and the pattern walks along.
let chaseStep = 0;
let chaseTimer = null;
function setBulbs(state) {
  $('marquee').dataset.state = state;
  const chase = state === 'warn' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = () => {
    document.querySelectorAll('.bulbs').forEach((row, r) => {
      [...row.children].forEach((b, i) => b.classList.toggle('lit', (i + (r ? 0 : 1) + chaseStep) % 3 === 0));
    });
  };
  if (chase && !chaseTimer) {
    chaseTimer = setInterval(() => { chaseStep = (chaseStep + 1) % 3; paint(); }, 260);
  } else if (!chase && chaseTimer) {
    clearInterval(chaseTimer);
    chaseTimer = null;
  }
  paint();
}

// Small fixed tilt and lift per position, so the same code always looks the same.
function wobble(i) {
  const rot = [-1.6, 0.9, -0.4, 1.4, -1.1, 0.5, 1.8, -0.8][i % 8];
  const dy = [0, 1, -1, 0, 1, 0, -1, 1][i % 8];
  return { rot: `${rot}deg`, dy: `${dy}px` };
}

let boardRows = [];
// Puts lines of text on the board. Letters that change drop in; the rest stay put.
function setBoard(rows, label) {
  const board = $('board');
  board.setAttribute('aria-label', label);
  const longest = Math.max(...rows.map((r) => [...r].length), 1);
  const size = Math.max(16, Math.min(rows.length > 1 ? 40 : 52, BOARD_W / (longest * (LETTER_EM + 0.08))));
  board.style.setProperty('--size', `${Math.floor(size)}px`);
  if (rows.length === boardRows.length && rows.every((r, i) => r === boardRows[i])) return;
  const previous = boardRows;
  boardRows = rows;
  board.replaceChildren(...rows.map((text, r) => {
    const line = document.createElement('div');
    line.className = 'row-letters';
    line.setAttribute('aria-hidden', 'true');
    const before = [...(previous[r] || '')];
    let dropped = 0;
    [...text].forEach((ch, i) => {
      const span = document.createElement('span');
      span.textContent = ch === ' ' ? ' ' : ch;
      const { rot, dy } = wobble(i + r * 3);
      span.style.setProperty('--rot', rot);
      span.style.setProperty('--dy', dy);
      if (before[i] !== ch) {
        span.className = 'drop';
        span.style.setProperty('--delay', `${dropped++ * 55}ms`);
      }
      line.append(span);
    });
    return line;
  }));
}

const WAKING_HINT_AFTER_S = 3;
const REASONS = { buffering: 'buffering', ad: 'watching an ad', hold: 'on hold', autoplay: 'needs to click play', syncing: 'syncing' };
const NAME_HUES = [4, 32, 150, 190, 250, 300]; // same palette as the chat names in overlay.js

function hueFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return NAME_HUES[h % NAME_HUES.length];
}

// Status style and text: bulbs lit when connected, chasing while waking or
// connecting, dark with the reason when something's wrong.
function statusFor(st) {
  const relay = st.relay || { state: 'unknown' };
  if (st.joined && st.status === 'connected') return ['ok', 'Connected'];
  if (st.joined && st.status === 'error') return ['err', st.error || 'Something went wrong'];
  switch (relay.state) {
    case 'waking': return ['warn', `Waking up the server… ${relay.wakingFor}s`];
    case 'down': return ['err', "Can't reach the server. Retrying…"];
    case 'ready': return st.joined ? ['warn', 'Joining…'] : ['ok', 'Server ready'];
    default: return ['warn', st.joined ? 'Connecting…' : 'Checking the server…'];
  }
}

function renderMembers(st) {
  const blocking = new Map(st.blockers.map((b) => [b.id, b.reason]));
  const people = [...st.members].sort((a, b) => (b.id === st.selfId) - (a.id === st.selfId));
  $('members').replaceChildren(...people.map((m) => {
    const li = document.createElement('li');
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = `hsl(${hueFor(m.name)} 55% 42%)`;
    avatar.textContent = [...m.name][0]?.toUpperCase() || '?';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name;
    li.append(avatar, name);
    if (m.id === st.selfId) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'you';
      li.append(you);
    }
    const reason = blocking.get(m.id);
    if (reason || m.reason === 'standby') {
      const state = document.createElement('span');
      state.className = reason ? 'state blocking' : 'state';
      state.textContent = reason ? REASONS[reason] || reason : "hasn't pressed play";
      li.append(state);
    }
    return li;
  }));
  $('people').hidden = !st.members.length;
  $('count').textContent = st.members.length > 1 ? String(st.members.length) : '';
  $('alone').hidden = st.members.length > 1;
}

function lobbyBoard() {
  const code = $('room').value.trim().toUpperCase();
  if (code) setBoard([code], `Room code ${code}`);
  else setBoard(['WATCH', 'SYNC'], 'Watch Sync');
}

function render(st) {
  $('lobby').hidden = st.joined;
  $('party').hidden = !st.joined;

  const [cls, text] = statusFor(st);
  setBulbs(cls);
  $('status').className = `status ${cls}`;
  $('statusText').textContent = text;
  $('ping').textContent = st.joined && st.status === 'connected' && st.rtt ? `${st.rtt} ms delay` : '';
  const relay = st.relay || {};
  $('wakeHint').hidden = st.status === 'connected' || relay.state !== 'waking' || relay.wakingFor < WAKING_HINT_AFTER_S;
  // In a room, the reason shows in the status line; in the lobby it shows here.
  $('error').hidden = st.joined || !st.error;
  $('error').textContent = st.error || '';
  if (!st.joined) {
    lobbyBoard();
    return;
  }

  const ok = st.status === 'connected';
  setBoard([st.room], `Room code ${st.room}. Click to copy.`);
  $('board').onclick = () => copy('copyCode', st.room);
  $('copyCode').onclick = () => copy('copyCode', st.room);
  renderMembers(st);
  $('video').textContent = st.hasVideo ? 'Video found on this page' : 'No video found on this page yet';

  const waiting = st.phase === 'waiting' && st.blockers.length > 0;
  $('waiting').hidden = !waiting;
  $('waitingText').textContent = waiting
    ? `Waiting for ${st.blockers.map((b) => `${b.name} (${REASONS[b.reason] || b.reason})`).join(', ')}`
    : '';
  $('resync').disabled = !ok || !st.hasVideo;
  $('resync').classList.toggle('primary', !waiting); // one gold button at a time
  $('resync').onclick = async () => {
    render(await send({ type: 'resync' }));
    $('resync').textContent = 'Syncing…';
    setTimeout(() => { $('resync').textContent = 'Sync everyone'; }, 1500);
  };
  $('hold').textContent = st.hold ? 'Release hold' : 'Hold for me';
  $('hold').onclick = async () => render(await send({ type: 'hold', active: !st.hold }));

  const differentPage = st.roomUrl && st.roomUrl !== tab.url;
  $('openRoomUrlRow').hidden = !differentPage;
  $('openRoomUrl').onclick = () => chrome.tabs.update(tab.id, { url: st.roomUrl });
  $('copyLink').onclick = () => copy('copyLink', st.roomUrl || tab.url);
  $('openChat').hidden = !st.hasVideo;
  $('openChat').textContent = st.unread ? `Open chat (${st.unread} new)` : 'Open chat';
}

async function refresh() {
  render(await send({ type: 'status' }));
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = await chrome.storage.local.get('name');
  $('name').value = saved.name || '';
  chrome.storage.local.remove('server'); // left over from when the relay could be changed here

  $('room').addEventListener('input', () => {
    $('join').textContent = $('room').value.trim() ? 'Join room' : 'Start a room';
    lobbyBoard();
  });

  $('joinForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('name').value.trim() || 'Guest';
    const room = $('room').value.trim().toUpperCase() || randomRoom();
    await chrome.storage.local.set({ name });
    render(await send({ type: 'join', room, name }));
  };
  $('leave').onclick = async () => render(await send({ type: 'leave' }));
  $('force').onclick = async () => render(await send({ type: 'force' }));
  $('openChat').onclick = async () => {
    await send({ type: 'open-chat' });
    window.close();
  };

  await refresh();
  pollTimer = setInterval(refresh, 1000);
}

window.addEventListener('pagehide', () => {
  clearInterval(pollTimer);
  clearInterval(chaseTimer);
});
init();
