// Watch Sync content script. Runs in every frame (including cross-origin
// iframes). In the frame that holds the main video it runs a control loop that
// makes the player follow the room state from the server, reports whether this
// viewer is ready (not buffering, not in an ad), and turns the viewer's own
// play/pause/seek into intents for the room. Frames served from ad networks only
// report that an ad is showing.
(() => {
  if (window.__watchSyncLoaded) return;
  window.__watchSyncLoaded = true;

  const TICK_MS = 200;
  const SCAN_INTERVAL_MS = 2000;
  const MIN_VIDEO_AREA = 100 * 60; // skip thumbnails and hidden previews
  const SHORT_VIDEO_SEC = 90; // a video this short replacing long content is an ad
  const LONG_VIDEO_SEC = 300;
  const HARD_SEEK_SEC = 1.5; // drift beyond this is fixed by seeking
  const RATE_START_SEC = 0.05; // drift beyond this is fixed by adjusting speed
  const RATE_STOP_SEC = 0.02;
  const MAX_RATE_DELTA = 0.1; // never play slower than 0.9x or faster than 1.1x
  const ALIGN_SEC = 0.15; // while paused or waiting, everyone lines up this closely
  const STALL_DEBOUNCE_MS = 700; // brief hiccups are absorbed by speed adjustment
  const WAITING_FALLBACK_MS = 3000; // players that stop fetching while paused
  const INTENT_DELAY_MS = 350; // lets ad detection catch up before we trust an event
  const QUIET_AFTER_AD_MS = 1500;
  const AD_AFTER_PAUSE_MS = 4000; // an ad this soon after our pause means the player paused for it
  const LOCAL_ACTION_GRACE_MS = 2500; // max time we let a viewer's action stand before the server answers

  const AD_HOSTS = /(^|\.)(doubleclick\.net|googlesyndication\.com|imasdk\.googleapis\.com|googleadservices\.com|adnxs\.com|springserve\.com|spotxchange\.com|spotx\.tv|aniview\.com|vidoomy\.com|connatix\.com|teads\.tv|adsrvr\.org|pubmatic\.com|rubiconproject\.com|innovid\.com|serving-sys\.com|smartadserver\.com|adform\.net|yieldmo\.com|primis\.tech|exoclick\.com|juicyads\.com|popads\.net|adsterra\.com|propellerads\.com)$/i;
  // Classes that common players (YouTube, JW Player, Video.js, IMA, Plyr) put on
  // the player while an ad is running.
  const AD_CLASS = /(^|\s)(ad-showing|ad-interrupting|jw-flag-ads|jw-flag-ads-vpaid|vjs-ad-playing|vjs-ad-loading|plyr--ad|ima-ad-playing|ad-playing|ads-playing|video-ad-playing)(\s|$)/i;
  const AD_UI_SELECTOR = [
    '[class*="skip-ad" i]', '[class*="skipad" i]', '[class*="ad-skip" i]', '[id*="skip-ad" i]',
    '[class*="ad-countdown" i]', '.ima-ad-container', '.videoAdUi',
  ].join(',');

  const isAdFrame = AD_HOSTS.test(location.hostname);

  // ---- Shared helpers --------------------------------------------------------

  function collectVideos(root = document, out = []) {
    root.querySelectorAll('video').forEach((v) => out.push(v));
    // Walk open shadow roots too; many custom players render inside one.
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collectVideos(el.shadowRoot, out);
    });
    return out;
  }

  function rectOf(el) {
    return el.isConnected ? el.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  }

  function areaOf(el) {
    const r = rectOf(el);
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function isVisible(el) {
    if (areaOf(el) < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch {
      // Extension was reloaded; this copy of the script is orphaned.
      clearInterval(scanTimer);
      clearInterval(tickTimer);
      return Promise.resolve(undefined);
    }
  }

  // ---- Ad-network frames -----------------------------------------------------

  if (isAdFrame) {
    let active = false;
    let beats = 0;
    var scanTimer = setInterval(() => {
      const now = collectVideos().some((v) => !v.paused && isVisible(v) && areaOf(v) >= MIN_VIDEO_AREA);
      // Report changes right away, and keep a heartbeat going while the ad plays so
      // the background notices if this frame is removed without saying goodbye.
      if (now !== active || (now && ++beats % 2 === 0)) {
        active = now;
        send({ type: 'ad-frame', active });
      }
    }, 250);
    var tickTimer = null;
    return;
  }

  // ---- Main video selection ----------------------------------------------------

  let video = null; // the content video we sync (kept even while an ad covers it)
  let lastArea = 0;
  let mainDuration = 0; // duration of the content, once known
  let mainMissingForAd = false; // content video removed and only ad-like videos remain
  let noVideoSince = 0;

  function isAdLike(v) {
    return mainDuration >= LONG_VIDEO_SEC && Number.isFinite(v.duration) && v.duration < SHORT_VIDEO_SEC;
  }

  function scan() {
    const all = collectVideos();
    const candidates = all.filter((v) => areaOf(v) >= MIN_VIDEO_AREA);
    const content = candidates.filter((v) => !isAdLike(v));

    let next = video;
    if (!video || !video.isConnected) {
      next = null;
      let bestScore = 0;
      for (const v of content) {
        const score = areaOf(v) * (v.paused ? 1 : 2) * (v.duration > 60 ? 2 : 1);
        if (score > bestScore) { next = v; bestScore = score; }
      }
    } else if (video.paused && !(video.duration >= SHORT_VIDEO_SEC)) {
      // We may have locked onto a trailer; move to a bigger, longer video if one shows up.
      for (const v of content) {
        if (v !== video && v.duration >= SHORT_VIDEO_SEC && areaOf(v) > areaOf(video) * 1.5) next = v;
      }
    }

    mainMissingForAd = !!video && !video.isConnected && !next && candidates.some(isAdLike);
    if (mainMissingForAd) next = video; // hold on to the old element until content returns

    if (next !== video) {
      if (video) detach(video);
      video = next;
      if (video) attach(video);
      if (overlay) {
        if (video) overlay.attach(video);
        else overlay.setVisible(false);
      }
    }

    if (video && (video.isConnected || mainMissingForAd)) {
      noVideoSince = 0;
      lastArea = Math.max(areaOf(video), video.isConnected ? 0 : lastArea);
      announce();
    } else if (video || lastArea) {
      // Give players a moment to swap elements before giving up on the video.
      noVideoSince = noVideoSince || Date.now();
      if (Date.now() - noVideoSince > 3000) {
        if (video) detach(video);
        video = null;
        lastArea = 0;
        mainDuration = 0;
        if (overlay) overlay.setVisible(false);
        send({ type: 'video-gone' });
      }
    }
  }

  function announce() {
    send({ type: 'video', area: Math.max(lastArea, 1) }).then((res) => {
      joined = !!(res && res.joined);
    });
  }

  // ---- Ad detection ---------------------------------------------------------------

  function ancestors(el, depth) {
    const out = [];
    let node = el;
    for (let i = 0; node && i < depth; i++) {
      out.push(node);
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return out;
  }

  function overlaps(a, b, minShare) {
    const ra = rectOf(a);
    const rb = rectOf(b);
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    return w > 0 && h > 0 && w * h >= minShare * Math.max(1, areaOf(b));
  }

  function detectAd() {
    if (hold) return 'hold';
    if (externalAd || mainMissingForAd) return 'ad';
    if (!video) return null;

    // Same <video> element switched from the long content to a short clip.
    if (isAdLike(video)) return 'ad';

    const chain = ancestors(video, 10);
    if (chain.some((el) => typeof el.className === 'string' && AD_CLASS.test(el.className))) return 'ad';

    // A separate ad player on top of (or in place of) ours.
    const mainHidden = areaOf(video) < MIN_VIDEO_AREA;
    for (const v of collectVideos()) {
      if (v === video || v.paused || !isVisible(v)) continue;
      if (mainHidden ? areaOf(v) >= lastArea * 0.3 : overlaps(v, video, 0.3)) return 'ad';
    }

    // Visible ad UI (skip buttons, countdowns, ad containers) inside the player.
    const player = chain[Math.min(4, chain.length - 1)];
    const scope = player && player.querySelectorAll ? player : document;
    for (const el of scope.querySelectorAll(AD_UI_SELECTOR)) {
      if (isVisible(el) && (el.querySelector('video, iframe') || el.textContent.trim())) return 'ad';
    }
    return null;
  }

  // ---- Room state and control loop ---------------------------------------------------------

  let joined = false;
  let room = null; // latest state from the server
  let offset = 0; // server clock minus local clock
  let externalAd = false;
  let hold = false;
  let adActive = false;
  let quietUntil = 0; // ignore viewer events until this time
  let lastContentPos = 0;
  let seekTarget = null; // our own pending seek
  let autoplayBlocked = false;
  let rateAdjusted = false;
  let stallSince = 0;
  let lastTime = -1;
  let lastTimeAt = 0;
  let waitingReadySince = 0;
  let startTimer = null;
  let lastEpochSeen = -1;
  let localActionUntil = 0; // viewer just acted; don't fight them while their intent is in flight
  let lastPause = null; // { at, pos, wasPlaying } for our most recent pause intent

  const serverNow = () => Date.now() + offset;

  function expectedPos(now = serverNow()) {
    if (!room) return 0;
    if (room.phase !== 'playing' || now < room.anchor) return room.position;
    return room.position + (now - room.anchor) / 1000;
  }

  function shouldBePaused(now = serverNow()) {
    return !room || room.phase !== 'playing' || now < room.anchor;
  }

  function report(ready, reason = '') {
    if (!room) return;
    send({ type: 'report', status: { epoch: room.epoch, ready, reason, pos: lastContentPos } });
  }

  function seekTo(t) {
    seekTarget = t;
    video.currentTime = t;
  }

  function setRate(rate) {
    if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
    rateAdjusted = rate !== 1;
  }

  function play() {
    if (!video.paused) return;
    video.play().then(() => { autoplayBlocked = false; }).catch((err) => {
      if (err.name === 'NotAllowedError') {
        autoplayBlocked = true;
        toast('Click here to start playback with the room', {
          sticky: true,
          onClick: () => { autoplayBlocked = false; video.play(); },
        });
      }
    });
  }

  function tick() {
    if (!video || !room || !joined) return;
    const now = serverNow();

    const ad = detectAd();
    if (ad) {
      if (!adActive) {
        adActive = true;
        if (lastPause && lastPause.wasPlaying && Date.now() - lastPause.at < AD_AFTER_PAUSE_MS) {
          // The "pause" we sent was really the player stopping for this ad. Take it
          // back: the room should keep wanting to play and wait for us instead.
          send({ type: 'intent', action: 'play', pos: lastPause.pos, reason: 'ad' });
        }
        lastPause = null;
        if (rateAdjusted) setRate(1);
        toast(ad === 'hold' ? 'Holding the room for you' : 'Ad detected. The room is waiting for you.');
      }
      // Hands off: the ad has to play out on its own.
      report(false, ad);
      return;
    }
    if (adActive) {
      adActive = false;
      quietUntil = Date.now() + QUIET_AFTER_AD_MS;
      toast('Back to the show. Syncing…');
    }

    // During a seek currentTime already reports the destination, which is what we want.
    if (!mainDuration || Math.abs(video.duration - mainDuration) < 2) lastContentPos = video.currentTime;
    if (Number.isFinite(video.duration) && video.duration >= SHORT_VIDEO_SEC) mainDuration = video.duration;

    if (Date.now() < localActionUntil) return;

    const target = expectedPos(now);
    const diff = video.currentTime - target;

    if (shouldBePaused(now)) {
      if (!video.paused) video.pause();
      if (rateAdjusted) setRate(1);
      stallSince = 0;
      lastTimeAt = Date.now();
      const aligned = Math.abs(diff) <= ALIGN_SEC;
      if (!aligned && !video.seeking) seekTo(target);

      if (room.phase === 'paused') return report(true);

      if (room.phase === 'waiting') {
        // Ready once this exact position is buffered.
        const partly = aligned && video.readyState >= 2 && !video.seeking;
        if (partly) waitingReadySince = waitingReadySince || Date.now();
        else waitingReadySince = 0;
        const ready = (partly && video.readyState >= 3)
          || (partly && Date.now() - waitingReadySince > WAITING_FALLBACK_MS);
        return report(ready, ready ? '' : 'buffering');
      }

      // Counting down to the scheduled start. Everyone already agreed; hiccups from
      // here on are handled by the stall detection once playback is running.
      report(true);
      if (!startTimer) {
        // Start at the exact scheduled instant rather than on the next tick.
        startTimer = setTimeout(() => {
          startTimer = null;
          if (room && !adActive && !shouldBePaused()) play();
        }, Math.max(0, room.anchor - now));
      }
      return;
    }

    // Playing. If the browser blocked autoplay, wait for the viewer's click.
    if (autoplayBlocked) return report(false, 'autoplay');
    play();

    // Stall detection: the playhead isn't moving even though it should be.
    const moving = video.currentTime !== lastTime;
    if (moving) { lastTime = video.currentTime; lastTimeAt = Date.now(); }
    const stuck = video.readyState < 3 || video.seeking || (!video.paused && Date.now() - lastTimeAt > 500);
    if (stuck) stallSince = stallSince || Date.now();
    else stallSince = 0;
    if (stallSince && Date.now() - stallSince > STALL_DEBOUNCE_MS) {
      if (rateAdjusted) setRate(1);
      return report(false, 'buffering');
    }
    report(true);
    if (stuck) return;

    if (Math.abs(diff) > HARD_SEEK_SEC) {
      seekTo(target);
    } else if (Math.abs(diff) > RATE_START_SEC || (rateAdjusted && Math.abs(diff) > RATE_STOP_SEC)) {
      // Nudge speed so we converge without a visible jump.
      setRate(1 + Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, -diff * 0.5)));
    } else if (rateAdjusted) {
      setRate(1);
    }
  }

  function onState(msg) {
    const prev = room;
    room = msg.state;
    offset = msg.offset;
    externalAd = msg.externalAd;
    hold = msg.hold;
    joined = true;
    if (startTimer && (!prev || prev.anchor !== room.anchor || room.phase !== 'playing')) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    if (room.epoch !== lastEpochSeen) {
      lastEpochSeen = room.epoch;
      localActionUntil = 0; // the server has answered; its state wins from here
      waitingReadySince = 0;
      stallSince = 0;
      announceChange(prev, room);
    } else if (room.phase === 'waiting') {
      showWaiting(room);
    }
    tick();
  }

  // ---- Viewer actions -> intents -----------------------------------------------------------

  let pendingIntent = null;

  function queueIntent(action) {
    clearTimeout(pendingIntent);
    localActionUntil = Date.now() + INTENT_DELAY_MS + LOCAL_ACTION_GRACE_MS;
    // Wait briefly: players often pause or seek right before an ad starts.
    pendingIntent = setTimeout(() => {
      pendingIntent = null;
      const cancel = () => { localActionUntil = 0; };
      if (!room || detectAd() || Date.now() < quietUntil) return cancel();
      if (action === 'pause' && !video.paused) return cancel();
      if (action === 'play' && video.paused) return cancel();
      if (action === 'pause') lastPause = { at: Date.now(), pos: video.currentTime, wasPlaying: room.intent === 'playing' };
      send({ type: 'intent', action, pos: video.currentTime });
    }, INTENT_DELAY_MS);
  }

  function onVideoEvent(event) {
    if (event.target !== video || !room || !joined) return;
    if (event.type === 'loadstart' || event.type === 'emptied') {
      // Source change (often an ad being swapped in): don't trust events for a moment.
      quietUntil = Date.now() + QUIET_AFTER_AD_MS;
      return;
    }
    if (adActive || Date.now() < quietUntil) return;

    if (event.type === 'seeked') {
      if (seekTarget !== null && Math.abs(video.currentTime - seekTarget) < 0.75) {
        seekTarget = null;
        return;
      }
      seekTarget = null;
      if (Math.abs(video.currentTime - expectedPos()) > 1) queueIntent('seek');
      return;
    }

    if (event.type === 'play') autoplayBlocked = false;
    const paused = shouldBePaused();
    if (event.type === 'play' && paused) {
      if (room.intent === 'playing') {
        // The room already wants to play; it's waiting on someone.
        video.pause();
        showWaiting(room, true);
      } else {
        queueIntent('play');
      }
    } else if (event.type === 'pause' && !paused) {
      queueIntent('pause');
    }
  }

  const EVENTS = ['play', 'pause', 'seeked', 'loadstart', 'emptied'];
  function attach(v) {
    EVENTS.forEach((e) => v.addEventListener(e, onVideoEvent));
    lastTime = -1;
    stallSince = 0;
  }
  function detach(v) {
    EVENTS.forEach((e) => v.removeEventListener(e, onVideoEvent));
  }

  // ---- Toasts ---------------------------------------------------------------------------------

  const REASONS = {
    buffering: 'buffering', ad: 'watching an ad', hold: 'on hold', autoplay: 'needs to click play',
    syncing: 'syncing', novideo: 'no video',
  };

  function describeBlockers(st) {
    return st.blockers.map((b) => `${b.name} (${REASONS[b.reason] || b.reason})`).join(', ');
  }

  function showWaiting(st, force = false) {
    if (!st.blockers.length || adActive) return;
    // The person being waited for already has their own toast.
    if (!force && st.blockers.every((b) => b.id === selfId)) return;
    toast(`Waiting for ${describeBlockers(st)}… Click to play without waiting.`, {
      sticky: true,
      onClick: () => send({ type: 'force' }),
    });
  }

  function announceChange(prev, st) {
    const a = st.lastAction;
    const fresh = a && (!prev || JSON.stringify(prev.lastAction) !== JSON.stringify(a));
    if (fresh && a.id !== selfId) {
      // 'ad' (a pause taken back because an ad started) gets no toast; the waiting toast covers it.
      const verb = { play: 'pressed play', pause: 'paused', seek: 'jumped to a new spot', force: 'started without waiting', resync: 'synced everyone' }[a.action];
      if (verb) toast(`${a.name} ${verb}`);
    }
    if (st.phase === 'waiting') showWaiting(st);
    else if (prev && prev.phase === 'waiting' && st.phase === 'playing') toast('Everyone is ready. Playing.');
  }

  // Notices and chat share the glass overlay drawn over the video.
  let overlay = null;
  function ui() {
    if (!overlay) overlay = window.__watchSyncCreateOverlay({ onSend: (text, replyTo) => send({ type: 'chat', text, replyTo }) });
    return overlay;
  }

  function toast(text, opts) {
    if (video && joined) ui().notice(text, opts);
  }

  function showOverlay() {
    const o = ui();
    o.attach(video);
    o.setSelf(selfId);
    if (room) o.setPeople(room.members.length);
    o.setVisible(true);
  }

  // ---- Messaging --------------------------------------------------------------------------------

  let selfId = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'inspect-chat':
        sendResponse(overlay ? overlay.inspect() : null);
        break;
      case 'announce':
        if (video) announce();
        break;
      case 'state':
        selfId = msg.selfId;
        if (video) {
          onState(msg);
          showOverlay();
        }
        break;
      case 'chat-history':
        selfId = msg.selfId;
        ui().setSelf(selfId);
        ui().setHistory(msg.messages);
        break;
      case 'chat':
        ui().setSelf(msg.selfId);
        ui().addMessage(msg.message);
        break;
      case 'toggle-chat':
        if (overlay) overlay.toggle();
        break;
      case 'toast':
        toast(msg.text);
        break;
      case 'left':
        joined = false;
        room = null;
        clearTimeout(startTimer);
        startTimer = null;
        if (video && rateAdjusted) setRate(1);
        if (overlay) overlay.setVisible(false);
        break;
    }
  });

  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scan(); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  var scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
  var tickTimer = setInterval(tick, TICK_MS);
  scan();
})();
