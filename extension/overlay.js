// Watch Sync overlay: the chat and notices drawn over the video. It lives in the
// browser's top layer (a manual popover), so it stays above the player in and
// out of fullscreen, and in a closed shadow root so page styles can't touch it.
// content.js creates it with window.__watchSyncCreateOverlay().
(() => {
  if (window.__watchSyncCreateOverlay) return;

  const STREAM_MS = 6000; // how long a message preview floats before fading
  const MAX_STREAM = 3;
  const PILL_IDLE_MS = 2500; // chat button hides like player controls do
  const REST_MS = 4000; // an idle open panel recedes so the picture comes first
  const MAX_LOG = 200; // older messages than this are dropped
  const PINNED_PX = 8; // this close to the bottom counts as following new messages
  const SWIPE_PX = 56; // drag this far right to reply
  const HOLD_MS = 350; // press and hold a preview this long to move the chat
  const DRAG_PX = 6; // movement before a press on the header or button counts as a drag
  const CORNERS = ['tl', 'tr', 'bl', 'br'];
  const EMOJIS = ['😂', '🤣', '😭', '🥲', '😅', '😮', '😱', '🤯', '😳', '🫣', '😬', '😍', '🥹', '🥺', '😤', '😡',
    '🙄', '🤔', '😴', '💀', '🔥', '❤️', '💔', '👀', '👍', '👎', '👏', '🙌', '🤝', '💯', '✨', '🍿'];
  const MIN_W = 240;
  const MIN_H = 140;

  const NAME_HUES = [4, 32, 150, 190, 250, 300];

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .stage {
      position: absolute; inset: 0; pointer-events: none;
      font: 16px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      color: rgba(255,255,255,0.94); -webkit-font-smoothing: antialiased;
      --edge: 16px; --controls: 112px;
    }
    .stage.compact { --edge: 10px; --controls: 88px; font-size: 14px; }

    /* Clear glass: no fill or blur, so the picture shows through untouched. A thin
       light rim gives each surface its shape, and text carries its own shadow to
       stay readable over any scene. */
    .glass {
      position: relative;
      background: transparent;
      border: 0.5px solid rgba(255,255,255,0.32);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.28);
      text-shadow: 0 0 2px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.75), 0 0 10px rgba(0,0,0,0.45);
    }

    button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid rgba(255,255,255,0.75); outline-offset: 2px; }
    svg { display: block; }

    /* Chat button, top right, shows on activity. */
    .pill {
      position: absolute; top: var(--edge); right: var(--edge);
      width: 42px; height: 42px; border-radius: 999px;
      display: grid; place-items: center; pointer-events: none;
      opacity: 0; transform: scale(0.92);
      transition: opacity 220ms ease, transform 220ms ease;
    }
    .pill.show { opacity: 1; transform: none; pointer-events: auto; }
    .pill .dot {
      position: absolute; top: 7px; right: 7px; width: 8px; height: 8px; border-radius: 50%;
      background: #fff; box-shadow: 0 0 0 2px rgba(26,26,30,0.35); display: none;
    }
    .pill.unread .dot { display: block; }

    /* Floating previews while the panel is closed. */
    .stream {
      position: absolute; right: var(--edge); bottom: calc(var(--controls) + 32px);
      width: min(360px, 40%); display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    }
    .bubble {
      max-width: 100%; padding: 8px 14px 9px; border-radius: 20px; pointer-events: auto;
      opacity: 0; transform: translateY(6px);
      transition: opacity 260ms ease, transform 260ms ease;
      overflow-wrap: anywhere;
    }
    .bubble.in { opacity: 1; transform: none; }
    .bubble.out { opacity: 0; transform: translateY(-4px); }
    .bubble .who { font-weight: 600; margin-right: 6px; }
    .bubble.system { color: rgba(255,255,255,0.85); font-size: 14px; }

    /* Open panel. */
    .panel {
      position: absolute; right: var(--edge); bottom: var(--controls);
      max-height: min(50%, calc(100% - var(--edge) - var(--controls)));
      width: clamp(250px, 30%, 380px); border-radius: 26px;
      display: flex; flex-direction: column; pointer-events: auto; overflow: hidden;
      opacity: 0; transform: translateX(12px) scale(0.98); visibility: hidden;
      transition: opacity 240ms ease, transform 240ms ease, visibility 0s linear 240ms;
    }
    .stage.compact .panel { width: min(66%, 310px); border-radius: 22px; }
    .panel.open { opacity: 1; transform: none; visibility: visible; transition-delay: 0s; }
    .panel.open.rest { opacity: 0.5; transition: opacity 600ms ease; }
    .head, .compose, .replying { flex: none; }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 10px 6px 16px; font-weight: 600; font-size: 16px;
    }
    .head .people { font-weight: 400; color: rgba(255,255,255,0.8); font-size: 14px; margin-left: 6px; }
    .close {
      width: 30px; height: 30px; border-radius: 999px; display: grid; place-items: center;
      color: rgba(255,255,255,0.75);
    }
    .close:hover { background: rgba(255,255,255,0.12); color: #fff; }
    .log {
      flex: 0 1 auto; min-height: 44px; overflow-y: auto; overscroll-behavior: contain; padding: 6px 14px 10px;
      display: flex; flex-direction: column; gap: 8px;
      mask-image: linear-gradient(to bottom, transparent, #000 10px);
      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.35) transparent;
    }
    /* Shown while scrolled up and something new arrives; jumps back to the latest. */
    .newer {
      position: sticky; bottom: 0; align-self: center; flex: none; display: none;
      padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; color: #fff;
      background: rgba(30,30,36,0.75); border: 0.5px solid rgba(255,255,255,0.35); cursor: pointer;
    }
    .newer.on { display: block; }
    .empty { margin: 6px auto; color: rgba(255,255,255,0.8); font-size: 14px; text-align: center; padding: 0 12px; }
    .msg, .bubble:not(.system) { touch-action: pan-y; user-select: none; -webkit-user-select: none; }
    .msg { position: relative; max-width: 88%; overflow-wrap: anywhere; transition: transform 220ms cubic-bezier(.2,.9,.3,1.2); }
    .msg.swiping, .bubble.swiping { transition: none; }
    /* Reply arrow revealed behind a message as it's swiped. */
    .hint {
      position: absolute; left: -24px; top: 50%; width: 18px; height: 18px; margin-top: -9px;
      display: grid; place-items: center; border-radius: 50%;
      opacity: var(--pull, 0); transform: scale(calc(0.6 + 0.4 * var(--pull, 0)));
      border: 0.5px solid rgba(255,255,255,0.5);
    }
    .quote {
      display: block; margin: 2px 0 3px; padding-left: 7px; border-left: 2px solid rgba(255,255,255,0.55);
      font-size: 14px; color: rgba(255,255,255,0.78);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }
    .quote b { font-weight: 600; margin-right: 4px; }
    .msg .who { display: block; font-size: 13px; font-weight: 600; margin-bottom: 1px; }
    .msg.self {
      align-self: flex-end; padding: 7px 13px 8px; border-radius: 18px;
      border: 0.5px solid rgba(255,255,255,0.32);
    }
    .msg.system { align-self: center; color: rgba(255,255,255,0.8); font-size: 13px; }
    .compose { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 8px; }
    .emoji-btn {
      width: 34px; height: 34px; border-radius: 999px; flex: none; display: grid; place-items: center;
      color: rgba(255,255,255,0.85);
    }
    .emoji-btn:hover, .emoji-btn.on { color: #fff; box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.5); }
    /* Two rows that scroll sideways, so the picker fits even in a small player. */
    .emojis {
      display: none; grid-auto-flow: column; grid-template-rows: repeat(2, 36px);
      grid-auto-columns: calc((100% - 14px) / 8); gap: 2px; padding: 4px 8px 0;
      flex: none; overflow-x: auto; scrollbar-width: none; overscroll-behavior: contain;
      mask-image: linear-gradient(to right, #000 88%, transparent);
    }
    .emojis::-webkit-scrollbar { display: none; }
    .emojis.open { display: grid; }
    .emojis button {
      height: 36px; border-radius: 9px; font-size: 22px; line-height: 36px; text-shadow: none;
      font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    }
    .emojis button:hover { box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.5); }
    .replying {
      display: none; align-items: center; gap: 8px; margin: 4px 10px 0; padding: 5px 4px 5px 9px;
      border-left: 2px solid rgba(255,255,255,0.7);
    }
    .replying.on { display: flex; }
    .replying .rtext { flex: 1; min-width: 0; font-size: 14px; line-height: 1.3; }
    .replying .rlabel { display: block; color: rgba(255,255,255,0.8); }
    .replying .rsnip { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .field {
      flex: 1; min-width: 0; height: 40px; border-radius: 999px; padding: 0 16px;
      border: 0.5px solid rgba(255,255,255,0.35); background: transparent;
      color: #fff; font: inherit; outline: none;
      text-shadow: inherit;
    }
    .field::placeholder { color: rgba(255,255,255,0.7); }
    .field:focus { border-color: rgba(255,255,255,0.4); }
    .send {
      width: 34px; height: 34px; border-radius: 999px; flex: none; display: grid; place-items: center;
      background: #fff; color: #1c1c1f; transform: scale(0.6); opacity: 0;
      transition: transform 160ms ease, opacity 160ms ease;
    }
    .send.ready { transform: none; opacity: 1; }

    /* Notices (sync status), top center. */
    .notice {
      position: absolute; top: var(--edge); left: 50%; max-width: min(70%, 520px);
      padding: 9px 18px 10px; border-radius: 999px; text-align: center;
      opacity: 0; transform: translate(-50%, -6px); pointer-events: none;
      transition: opacity 220ms ease, transform 220ms ease;
    }
    .notice.show { opacity: 1; transform: translate(-50%, 0); }
    .notice.show.action { pointer-events: auto; cursor: pointer; }

    /* The chat can sit in any corner. Bottom right is the default above;
       .left and .top mirror it. */
    .stage.left .pill { right: auto; left: var(--edge); }
    .stage.left .stream { right: auto; left: var(--edge); align-items: flex-start; }
    .stage.left .panel { right: auto; left: var(--edge); transform: translateX(-12px) scale(0.98); }
    .stage.left .panel.open { transform: none; }
    .stage.top .stream { bottom: auto; top: calc(var(--edge) + 50px); }
    .stage.top .panel { bottom: auto; top: var(--edge); }

    /* Moving the chat: drag the panel's header or the chat button, or press and
       hold a preview. It snaps to the nearest corner on release. */
    .head { cursor: grab; touch-action: none; }
    .pill { touch-action: none; }
    .moving { cursor: grabbing !important; scale: 1.02; filter: drop-shadow(0 8px 18px rgba(0,0,0,0.45)); }
    .moving, .moving * { user-select: none; }
    .snapping { transition: translate 300ms cubic-bezier(.2,.9,.3,1), opacity 240ms ease, transform 240ms ease !important; }

    @media (prefers-reduced-motion: reduce) {
      .pill, .bubble, .panel, .notice, .send, .msg, .snapping { transition-duration: 0s !important; }
    }
  `;

  const ICON_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4c4.97 0 9 3.13 9 7s-4.03 7-9 7c-.9 0-1.77-.1-2.6-.3L5 20l1.2-3.6C4.2 15.1 3 13.2 3 11c0-3.87 4.03-7 9-7Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const ICON_REPLY = '<svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M5 2.5 1.8 5.6 5 8.7M2.2 5.6h4.6c2 0 3.4 1.3 3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_EMOJI = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 14c.9 1.3 2 2 3.5 2s2.6-.7 3.5-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="9.2" cy="10" r="1.1" fill="currentColor"/><circle cx="14.8" cy="10" r="1.1" fill="currentColor"/></svg>';
  const ICON_SEND = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12V2.5M2.8 6.5 7 2.3l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function hueFor(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return NAME_HUES[h % NAME_HUES.length];
  }

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html) node.innerHTML = html;
    return node;
  }

  window.__watchSyncCreateOverlay = function createOverlay({ onSend, onMove = () => {}, onOpenChange = () => {} }) {
    const host = document.createElement('watch-sync-overlay');
    host.setAttribute('popover', 'manual');
    // Neutralize the popover's default box and any page styles aimed at it.
    for (const [k, v] of Object.entries({
      position: 'fixed', inset: 'auto', margin: '0', padding: '0', border: '0',
      background: 'transparent', overflow: 'visible', 'pointer-events': 'none',
      'max-width': 'none', 'max-height': 'none', 'color-scheme': 'dark',
    })) host.style.setProperty(k, v, 'important');

    const root = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = CSS;
    const stage = el('div', 'stage');
    root.append(style, stage);

    const notice = el('div', 'notice glass');
    notice.setAttribute('role', 'status');

    const pill = el('button', 'pill glass', `${ICON_CHAT}<span class="dot"></span>`);
    pill.setAttribute('aria-label', 'Open chat (Option+C)');
    pill.title = 'Chat (⌥C). Drag to move it to another corner.';

    const stream = el('div', 'stream');
    stream.setAttribute('aria-live', 'polite');

    const panel = el('section', 'panel glass');
    panel.setAttribute('aria-label', 'Party chat');
    const head = el('div', 'head', '<span>Chat<span class="people"></span></span>');
    head.title = 'Drag to move the chat to another corner';
    const closeBtn = el('button', 'close', ICON_CLOSE);
    closeBtn.setAttribute('aria-label', 'Close chat');
    head.append(closeBtn);
    const log = el('div', 'log');
    const empty = el('div', 'empty', 'Messages you send appear on everyone’s screen.');
    const newer = el('button', 'newer', 'New messages ↓');
    newer.type = 'button';
    log.append(newer);
    let pinned = true; // the log follows new messages until the viewer scrolls up
    log.prepend(empty);
    const compose = el('form', 'compose');
    const field = el('input', 'field');
    Object.assign(field, { type: 'text', placeholder: 'Message', maxLength: 500, autocomplete: 'off', enterKeyHint: 'send' });
    field.setAttribute('aria-label', 'Message');
    const sendBtn = el('button', 'send', ICON_SEND);
    sendBtn.type = 'submit';
    sendBtn.setAttribute('aria-label', 'Send');
    const emojiBtn = el('button', 'emoji-btn', ICON_EMOJI);
    emojiBtn.type = 'button';
    emojiBtn.setAttribute('aria-label', 'Add emoji');
    emojiBtn.setAttribute('aria-expanded', 'false');
    compose.append(emojiBtn, field, sendBtn);

    const emojis = el('div', 'emojis');
    emojis.setAttribute('role', 'group');
    emojis.setAttribute('aria-label', 'Emoji');
    for (const e of EMOJIS) {
      const b = el('button');
      b.type = 'button';
      b.textContent = e;
      b.setAttribute('aria-label', e);
      emojis.append(b);
    }

    const replying = el('div', 'replying');
    const rtext = el('div', 'rtext', '<span class="rlabel"></span><span class="rsnip"></span>');
    const replyCancel = el('button', 'close', ICON_CLOSE);
    replyCancel.type = 'button';
    replyCancel.setAttribute('aria-label', 'Cancel reply');
    replying.append(rtext, replyCancel);

    panel.append(head, log, emojis, replying, compose);

    stage.append(notice, stream, panel, pill);

    // Keep keystrokes and clicks inside the chat away from the site's player
    // (space would pause, "f" would toggle fullscreen, clicks would play/pause).
    for (const type of ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'mouseup',
      'pointerdown', 'pointerup', 'wheel', 'contextmenu']) {
      host.addEventListener(type, (e) => {
        e.stopPropagation();
        // Esc backs out one step at a time: emoji picker, then reply, then the panel.
        if (type === 'keydown' && e.key === 'Escape') {
          if (pickerOpen) setPicker(false);
          else if (replyTo) setReply(null);
          else if (isOpen) setOpen(false);
        }
      });
    }

    let video = null;
    let lastRect = null;
    let visible = false;
    let isOpen = false;
    let unread = false;
    let pillTimer = null;
    let restTimer = null;
    let noticeTimer = null;
    let noticeAction = null;
    let selfIdRef = null;
    let replyTo = null; // { mid, name, text } of the message being replied to
    let pickerOpen = false;
    let lastStageHeight = 0;

    // ---- Placement -----------------------------------------------------------

    function place() {
      if (!visible || !video) return;
      let r = video.isConnected ? video.getBoundingClientRect() : null;
      if (!r || r.width < 2 || r.height < 2) r = lastRect; // e.g. hidden during an ad
      if (!r) return;
      lastRect = r;
      // Clamp to the viewport so the chat never ends up off screen.
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const width = Math.min(window.innerWidth, r.right) - left;
      const height = Math.min(window.innerHeight, r.bottom) - top;
      const tooSmall = width < MIN_W || height < MIN_H;
      host.style.setProperty('left', `${left}px`, 'important');
      host.style.setProperty('top', `${top}px`, 'important');
      host.style.setProperty('width', `${Math.max(0, width)}px`, 'important');
      host.style.setProperty('height', `${Math.max(0, height)}px`, 'important');
      host.style.setProperty('visibility', tooSmall ? 'hidden' : 'visible', 'important');
      stage.classList.toggle('compact', width < 640);
      if (Math.round(height) !== lastStageHeight) {
        lastStageHeight = Math.round(height);
        follow();
      }
    }

    // While something is fullscreen, the browser makes everything outside it inert
    // (drawn, but not clickable). The top layer draws the overlay regardless of
    // where it sits in the DOM, so we move it inside the fullscreen element.
    function parentFor() {
      return document.fullscreenElement || document.documentElement;
    }

    function ensureShown() {
      const parent = parentFor();
      if (host.parentNode !== parent) parent.append(host);
      try {
        if (!host.matches(':popover-open')) host.showPopover();
      } catch {
        // Popover unsupported or host detached mid-change; next tick retries.
      }
    }

    // The top layer is ordered by insertion, so after anything goes fullscreen we
    // re-open to land above it.
    function restack() {
      if (!visible) return;
      try { if (host.matches(':popover-open')) host.hidePopover(); } catch { /* not open */ }
      ensureShown();
      place();
    }

    // A fullscreen <video> can't hold our overlay (its children never render), and
    // everything outside the fullscreen element is unclickable. So when the video
    // itself goes fullscreen, we also make its parent fullscreen and hold the
    // overlay there. The video stays fullscreen underneath, so we turn the parent
    // into a transparent, click-through layer: only the chat catches clicks.
    const PROMOTED_ATTR = 'data-watch-sync-fullscreen';
    let promoted = null; // { video, parent, videoStyle, parentStyle } while active
    let exiting = false; // unwinding the video's own fullscreen after ours ended

    function ensureBackdropRule() {
      if (document.getElementById('watch-sync-fullscreen-style')) return;
      const style = document.createElement('style');
      style.id = 'watch-sync-fullscreen-style';
      style.textContent = `[${PROMOTED_ATTR}]::backdrop { background: transparent !important; }`;
      (document.head || document.documentElement).append(style);
    }

    function restoreStyle(node, saved) {
      if (saved === null) node.removeAttribute('style');
      else node.setAttribute('style', saved);
    }

    function onFullscreenChange() {
      const fs = document.fullscreenElement;
      if (!fs) exiting = false;
      if (promoted && fs !== promoted.parent) {
        // Fullscreen ended (or something else took over): undo everything.
        const { video: v } = promoted;
        restoreStyle(promoted.video, promoted.videoStyle);
        restoreStyle(promoted.parent, promoted.parentStyle);
        promoted.parent.removeAttribute(PROMOTED_ATTR);
        promoted = null;
        if (fs === v) {
          // Exiting only removed our layer and left the video fullscreen underneath;
          // the viewer asked to leave fullscreen, so finish the job.
          exiting = true;
          document.exitFullscreen().catch(() => {});
          return;
        }
      }
      if (visible && fs && fs === video && fs.parentElement && !promoted && !exiting) {
        const parent = fs.parentElement;
        const saved = {
          video: fs, parent,
          videoStyle: fs.getAttribute('style'), parentStyle: parent.getAttribute('style'),
        };
        ensureBackdropRule();
        parent.setAttribute(PROMOTED_ATTR, '');
        parent.requestFullscreen({ navigationUI: 'hide' }).then(() => {
          promoted = saved;
          parent.style.setProperty('visibility', 'hidden', 'important');
          parent.style.setProperty('pointer-events', 'none', 'important');
          parent.style.setProperty('background', 'transparent', 'important');
          fs.style.setProperty('visibility', 'visible', 'important');
          fs.style.setProperty('pointer-events', 'auto', 'important');
        }).catch(() => {
          // Not allowed here; the chat still shows, it just can't be clicked.
          parent.removeAttribute(PROMOTED_ATTR);
        });
      }
      setTimeout(restack, 0);
    }

    const placeTimer = setInterval(() => { if (visible) { ensureShown(); place(); } }, 250);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // ---- Chat button and panel ------------------------------------------------

    function showPill() {
      if (!visible) return;
      pill.classList.add('show');
      clearTimeout(pillTimer);
      pillTimer = setTimeout(() => { if (!isOpen) pill.classList.remove('show'); }, PILL_IDLE_MS);
    }
    document.addEventListener('mousemove', showPill, { passive: true, capture: true });

    function wake() {
      panel.classList.remove('rest');
      clearTimeout(restTimer);
      restTimer = setTimeout(() => {
        // Receding doesn't need the field blurred: people leave the cursor there and keep watching.
        if (isOpen && !panel.matches(':hover')) panel.classList.add('rest');
      }, REST_MS);
    }

    function setOpen(open) {
      if (open !== isOpen) onOpenChange(open);
      isOpen = open;
      panel.classList.toggle('open', open);
      pill.classList.toggle('show', !open);
      pill.style.visibility = open ? 'hidden' : '';
      if (open) {
        unread = false;
        pill.classList.remove('unread');
        stream.replaceChildren();
        pinned = true;
        follow();
        wake();
        setTimeout(() => field.focus(), 60);
      } else {
        field.blur();
        setPicker(false);
        showPill();
      }
    }

    function setPicker(open) {
      pickerOpen = open;
      emojis.classList.toggle('open', open);
      emojiBtn.classList.toggle('on', open);
      emojiBtn.setAttribute('aria-expanded', String(open));
      follow();
    }

    function setReply(m) {
      replyTo = m ? { mid: m.mid, name: m.name, text: m.text } : null;
      replying.classList.toggle('on', !!m);
      if (m) {
        rtext.firstChild.textContent = `Replying to ${m.name}`;
        rtext.lastChild.textContent = m.text;
        if (!isOpen) setOpen(true);
        field.focus();
        wake();
      }
      follow();
    }

    emojiBtn.addEventListener('click', () => {
      setPicker(!pickerOpen);
      field.focus();
    });
    // A plain mouse wheel scrolls the strip sideways.
    emojis.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        emojis.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    emojis.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      // Insert at the cursor, replacing any selection.
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? field.value.length;
      field.setRangeText(b.textContent, start, end, 'end');
      field.dispatchEvent(new Event('input'));
      field.focus();
    });
    replyCancel.addEventListener('click', () => { setReply(null); field.focus(); });

    pill.addEventListener('click', () => {
      if (justMoved) return;
      setOpen(true);
    });
    closeBtn.addEventListener('click', () => setOpen(false));

    // ---- Moving the chat ----------------------------------------------------------

    let corner = 'br';
    let justMoved = false; // the click that ends a drag shouldn't also open the chat

    // Slides each part of the chat from where it was to where its corner puts it.
    function setCorner(c, { animate = false } = {}) {
      if (!CORNERS.includes(c)) return;
      const parts = [pill, stream, panel];
      const before = animate ? parts.map((n) => n.getBoundingClientRect()) : null;
      parts.forEach((n) => { n.style.translate = ''; });
      corner = c;
      stage.classList.toggle('top', c[0] === 't');
      stage.classList.toggle('left', c[1] === 'l');
      follow();
      if (!animate) return;
      parts.forEach((n, i) => {
        const after = n.getBoundingClientRect();
        const dx = before[i].left - after.left;
        const dy = before[i].top - after.top;
        if (!dx && !dy) return;
        n.classList.remove('snapping');
        n.style.translate = `${dx}px ${dy}px`;
        n.getBoundingClientRect(); // commit the start position before animating
        n.classList.add('snapping');
        n.style.translate = '';
        setTimeout(() => n.classList.remove('snapping'), 320);
      });
    }

    // Drags `node` with the pointer, then snaps the chat to the corner nearest to
    // where it was let go. `handle` receives the pointer events.
    function beginMove(handle, node, pointerId, x0, y0, first) {
      try { handle.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
      node.classList.add('moving');
      const startRect = node.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      const move = (e) => {
        if (e.pointerId !== pointerId) return;
        dx = e.clientX - x0;
        dy = e.clientY - y0;
        node.style.translate = `${dx}px ${dy}px`;
      };
      const end = (e) => {
        if (e.pointerId !== pointerId) return;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        node.classList.remove('moving');
        const s = stage.getBoundingClientRect();
        const cx = startRect.left + startRect.width / 2 + dx - s.left;
        const cy = startRect.top + startRect.height / 2 + dy - s.top;
        const next = `${cy < s.height / 2 ? 't' : 'b'}${cx < s.width / 2 ? 'l' : 'r'}`;
        setCorner(next, { animate: true });
        onMove(next);
        justMoved = true;
        setTimeout(() => { justMoved = false; }, 0);
        if (isOpen) wake();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      if (first) move(first); // so the chat doesn't lag behind the pointer
    }

    // The header and the chat button move the chat once the pointer travels a
    // few pixels; a press that doesn't move stays a click.
    function dragFrom(handle, node) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.close')) return;
        const { pointerId, clientX: x0, clientY: y0 } = e;
        try { handle.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
        const watch = (ev) => {
          if (ev.pointerId !== pointerId) return;
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return;
          stop();
          beginMove(handle, node, pointerId, x0, y0, ev);
        };
        const stop = () => {
          handle.removeEventListener('pointermove', watch);
          handle.removeEventListener('pointerup', stop);
          handle.removeEventListener('pointercancel', stop);
        };
        handle.addEventListener('pointermove', watch);
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
      });
    }
    dragFrom(head, panel);
    dragFrom(pill, pill);
    panel.addEventListener('pointerenter', wake);
    panel.addEventListener('pointermove', wake);
    field.addEventListener('focus', wake);
    field.addEventListener('keydown', wake);
    field.addEventListener('input', () => {
      sendBtn.classList.toggle('ready', field.value.trim().length > 0);
      wake();
    });
    compose.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = field.value.trim();
      if (!text) return;
      onSend(text, replyTo);
      field.value = '';
      sendBtn.classList.remove('ready');
      setReply(null);
      setPicker(false);
    });

    // ---- Messages ---------------------------------------------------------------

    function whoSpan(name) {
      const who = el('span', 'who');
      who.textContent = name;
      who.style.color = `hsl(${hueFor(name)} 85% 80%)`;
      return who;
    }

    function quoteEl(r) {
      const q = el('span', 'quote');
      const b = el('b');
      b.textContent = r.name;
      q.append(b, document.createTextNode(r.text));
      return q;
    }

    function isSelf(m) {
      return m.kind !== 'system' && m.from && m.from === selfIdRef;
    }

    // Swipe right (mouse drag, touch, or two-finger trackpad swipe) to reply.
    function pull(node, dx) {
      // Follows the pointer up to the threshold, then resists.
      const d = dx <= SWIPE_PX ? dx : SWIPE_PX + Math.min(30, (dx - SWIPE_PX) * 0.3);
      node.style.transform = d ? `translateX(${d}px)` : '';
      node.style.setProperty('--pull', Math.min(1, d / SWIPE_PX).toFixed(3));
    }

    function release(node) {
      node.classList.remove('swiping');
      pull(node, 0);
    }

    // `moves` (a preview's stack) is picked up and moved by pressing and holding.
    function attachSwipe(node, m, moves = null) {
      node.append(el('span', 'hint', ICON_REPLY));
      let startX = null;
      let startY = 0;
      let dx = 0;
      let dragging = false;
      let holdTimer = null;
      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // Keep the cursor in the message box while swiping.
        e.preventDefault();
        startX = e.clientX;
        startY = e.clientY;
        dx = 0;
        dragging = false;
        if (moves) {
          const { pointerId, clientX, clientY } = e;
          clearTimeout(holdTimer);
          holdTimer = setTimeout(() => {
            if (startX === null || dragging) return;
            startX = null;
            beginMove(node, moves, pointerId, clientX, clientY);
          }, HOLD_MS);
        }
      });
      node.addEventListener('pointermove', (e) => {
        if (startX === null) return;
        const x = e.clientX - startX;
        const y = e.clientY - startY;
        if (!dragging) {
          if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) { startX = null; clearTimeout(holdTimer); return; }
          if (x < 6) return;
          clearTimeout(holdTimer);
          dragging = true;
          node.setPointerCapture(e.pointerId);
          node.classList.add('swiping');
        }
        dx = Math.max(0, x);
        pull(node, dx);
      });
      const end = () => {
        clearTimeout(holdTimer);
        if (startX === null) return;
        if (dragging && dx >= SWIPE_PX) setReply(m);
        startX = null;
        release(node);
      };
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);

      // Trackpads send horizontal swipes as wheel events. Handling them here also
      // stops Chrome's swipe-to-go-back while over a message.
      let acc = 0;
      let idle = null;
      let fired = false;
      node.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        e.preventDefault();
        clearTimeout(idle);
        idle = setTimeout(() => { acc = 0; fired = false; release(node); }, 200);
        if (fired) return; // ignore the tail of the same gesture
        acc = Math.max(0, acc - e.deltaX);
        node.classList.add('swiping');
        pull(node, acc * 0.6);
        if (acc * 0.6 >= SWIPE_PX) {
          fired = true;
          release(node);
          setReply(m);
        }
      }, { passive: false });
    }

    function logEntry(m) {
      const self = isSelf(m);
      const row = el('div', `msg${m.kind === 'system' ? ' system' : ''}${self ? ' self' : ''}`);
      if (m.kind !== 'system' && !self) row.append(whoSpan(m.name));
      if (m.replyTo) row.append(quoteEl(m.replyTo));
      row.append(document.createTextNode(m.text));
      if (m.kind !== 'system') attachSwipe(row, m);
      return row;
    }

    // The panel never grows past half the video; older messages scroll. The log
    // follows new messages unless the viewer has scrolled up to read.
    log.addEventListener('scroll', () => {
      pinned = log.scrollHeight - log.scrollTop - log.clientHeight <= PINNED_PX;
      if (pinned) newer.classList.remove('on');
    });
    newer.addEventListener('click', () => {
      pinned = true;
      follow();
    });

    function follow() {
      if (!pinned) return;
      log.scrollTop = log.scrollHeight;
      newer.classList.remove('on');
    }

    function appendToLog(m) {
      empty.remove();
      if (isSelf(m)) pinned = true; // sending jumps back to the latest
      log.insertBefore(logEntry(m), newer);
      while (log.childElementCount > MAX_LOG + 1) log.firstElementChild.remove();
      if (pinned) follow();
      else newer.classList.add('on');
    }

    function float(m) {
      const b = el('div', `bubble glass${m.kind === 'system' ? ' system' : ''}`);
      if (m.kind !== 'system') b.append(whoSpan(m.name));
      if (m.replyTo) b.append(quoteEl(m.replyTo));
      b.append(document.createTextNode(m.text));
      if (m.kind !== 'system') attachSwipe(b, m, stream);
      stream.append(b);
      while (stream.childElementCount > MAX_STREAM) stream.firstElementChild.remove();
      requestAnimationFrame(() => b.classList.add('in'));
      const fade = () => {
        // Don't pull a preview out from under someone who's moving it.
        if (stream.classList.contains('moving')) return setTimeout(fade, 500);
        b.classList.add('out');
        setTimeout(() => b.remove(), 300);
      };
      setTimeout(fade, STREAM_MS);
    }

    function addMessage(m) {
      appendToLog(m);
      if (isOpen) {
        wake();
      } else if (!isSelf(m)) {
        float(m);
        if (m.kind !== 'system') {
          unread = true;
          pill.classList.add('unread');
        }
      }
    }

    // ---- Notices ------------------------------------------------------------------

    function showNotice(text, { onClick = null, sticky = false } = {}) {
      notice.textContent = text;
      noticeAction = onClick;
      notice.classList.toggle('action', !!onClick);
      notice.classList.add('show');
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => notice.classList.remove('show'), sticky ? 15000 : 2500);
    }
    notice.addEventListener('click', () => {
      if (!noticeAction) return;
      const fn = noticeAction;
      noticeAction = null;
      notice.classList.remove('show');
      fn();
    });

    return {
      attach(v) {
        video = v;
        lastRect = null;
        if (visible) place();
      },
      setVisible(on) {
        visible = on;
        if (on) {
          ensureShown();
          place();
          showPill();
        } else {
          setOpen(false);
          try { if (host.matches(':popover-open')) host.hidePopover(); } catch { /* not open */ }
        }
      },
      setSelf(id) { selfIdRef = id; },
      setCorner,
      setPeople(count) {
        root.querySelector('.people').textContent = count > 1 ? `${count} watching` : '';
      },
      setHistory(messages) {
        log.replaceChildren(newer);
        if (!messages.length) log.prepend(empty);
        messages.forEach((m) => log.insertBefore(logEntry(m), newer));
        pinned = true;
        follow();
      },
      addMessage,
      notice: showNotice,
      toggle() {
        if (visible) setOpen(!isOpen);
      },
      open() {
        if (visible) setOpen(true);
      },
      // Layout snapshot for tests and troubleshooting (the shadow root is closed).
      inspect() {
        const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
        return {
          open: isOpen,
          corner,
          stage: rect(stage),
          panel: rect(panel),
          pill: rect(pill),
          head: rect(head),
          messages: [...log.querySelectorAll('.msg')].map((n) => ({
            text: n.lastChild.previousSibling ? n.lastChild.previousSibling.textContent : n.textContent,
            quote: n.querySelector('.quote')?.textContent || null,
            rect: rect(n),
          })),
          bubbles: [...stream.querySelectorAll('.bubble')].map((n) => ({ text: n.textContent, rect: rect(n) })),
          log: { rect: rect(log), scrollTop: log.scrollTop, scrollHeight: log.scrollHeight, clientHeight: log.clientHeight },
          newer: newer.classList.contains('on') ? rect(newer) : null,
          replyingTo: replyTo,
          pickerOpen,
          emojiButton: rect(emojiBtn),
          firstEmoji: { char: EMOJIS[0], rect: rect(emojis.firstElementChild) },
        };
      },
      destroy() {
        clearInterval(placeTimer);
        host.remove();
      },
    };
  };
})();
