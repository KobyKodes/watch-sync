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
  clearTimeout(btn.resetTimer);
  btn.resetTimer = setTimeout(() => { btn.textContent = label; }, 1500);
}

function render(st) {
  $('lobby').hidden = st.joined;
  $('party').hidden = !st.joined;
  $('error').hidden = !st.error;
  $('error').textContent = st.error || '';
  if (!st.joined) return;

  $('roomCode').textContent = st.room;
  const ok = st.status === 'connected';
  $('dot').className = `dot ${ok ? 'ok' : st.status === 'error' ? 'err' : ''}`;
  $('statusText').textContent = ok
    ? `Connected${st.rtt ? ` · ${st.rtt} ms` : ''}`
    : st.status[0].toUpperCase() + st.status.slice(1);
  $('peers').textContent = st.members.length > 1
    ? `In the room: ${st.members.map((m) => m.name).join(', ')}`
    : 'Nobody else here yet. Share the invite.';
  $('video').textContent = st.hasVideo ? 'Video found on this page' : 'No video found on this page yet';

  const REASONS = { buffering: 'buffering', ad: 'watching an ad', hold: 'on hold', autoplay: 'needs to click play', syncing: 'syncing' };
  const waiting = st.phase === 'waiting' && st.blockers.length > 0;
  $('waiting').hidden = !waiting;
  $('waiting').textContent = waiting
    ? `Waiting for ${st.blockers.map((b) => `${b.name} (${REASONS[b.reason] || b.reason})`).join(', ')}`
    : '';
  $('forceRow').hidden = !waiting;
  $('hold').textContent = st.hold ? 'Release hold' : 'Hold for me';
  $('hold').onclick = async () => render(await send({ type: 'hold', active: !st.hold }));

  const differentPage = st.roomUrl && st.roomUrl !== tab.url;
  $('openRoomUrlRow').hidden = !differentPage;
  $('openRoomUrl').onclick = () => chrome.tabs.update(tab.id, { url: st.roomUrl });
  $('copyLink').onclick = () => copy('copyLink', st.roomUrl || tab.url);
  $('copyCode').onclick = () => copy('copyCode', st.room);
}

async function refresh() {
  render(await send({ type: 'status' }));
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = await chrome.storage.local.get(['name', 'server']);
  $('name').value = saved.name || '';
  $('server').value = saved.server || '';
  $('server').placeholder = WATCH_SYNC_DEFAULT_SERVER;

  $('room').addEventListener('input', () => {
    $('join').textContent = $('room').value.trim() ? 'Join room' : 'Create room';
  });

  $('join').onclick = async () => {
    const name = $('name').value.trim() || 'Guest';
    const server = $('server').value.trim() || WATCH_SYNC_DEFAULT_SERVER;
    const room = $('room').value.trim().toUpperCase() || randomRoom();
    await chrome.storage.local.set({ name, server: $('server').value.trim() });
    render(await send({ type: 'join', room, name, server }));
  };
  $('leave').onclick = async () => render(await send({ type: 'leave' }));
  $('force').onclick = async () => render(await send({ type: 'force' }));

  await refresh();
  pollTimer = setInterval(refresh, 1000);
}

window.addEventListener('unload', () => clearInterval(pollTimer));
init();
