// End-to-end test: real Chromium profiles with the extension loaded, syncing a
// <video> inside a cross-origin iframe through buffering, ads and drift.
// Run: CHROME_PATH=... node e2e.js   (HEADED=1 to watch)
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert/strict');
const { chromium } = require('playwright');

process.env.PORT = process.env.TEST_RELAY_PORT || '8797'; // separate from a relay you may be running
const relay = require('../server/server.js');
const site = require('./serve.js');
const localExtension = require('./extension.js');

const EXT = localExtension(process.env.PORT);
const ROOM = 'E2ETEST';
const IN_SYNC_SEC = 0.3; // how close positions must be while playing
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => e);
    if (last === true) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

async function launchUser(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `watchsync-${name}-`));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: !process.env.HEADED,
    // Branded Google Chrome ignores --load-extension; use Chromium or Chrome for Testing.
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      // Remote "play" has no user gesture; in normal use a toast asks for one click.
      '--autoplay-policy=no-user-gesture-required',
      // Serve the ad-network iframe from the local test server.
      '--host-resolver-rules=MAP ads.doubleclick.net 127.0.0.1',
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];

  const url = `http://localhost:8080/?u=${name}`;
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (process.env.DEBUG) {
    page.on('pageerror', (e) => console.log(`  [${name} pageerror]`, e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${name} console]`, m.text()); });
  }
  await page.goto(url);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);

  // Drive the real popup message path from an extension page.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const call = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), { ...msg, tabId });
  // Keep the video tab in front like a real viewer; hidden tabs get throttled timers.
  await page.bringToFront();

  const frame = () => {
    const f = page.frames().find((fr) => fr.url().startsWith('http://127.0.0.1:8081/'));
    if (!f) throw new Error('player iframe not loaded');
    return f;
  };
  // Runs fn(mainVideo, arg) inside the player iframe.
  const video = (fn, arg) => frame().evaluate(
    ([src, a]) => new Function('v', 'arg', `return (${src})(v, arg)`)(document.querySelector('video'), a),
    [fn.toString(), arg],
  );
  // `at` lets us compare positions from different browsers at the same instant.
  const state = () => video((v) => ({ paused: v.paused, time: v.currentTime, src: v.currentSrc, at: Date.now() }));
  const player = (fnName) => frame().evaluate((n) => window[n](), fnName);

  // Opens the chat with a real click on the chat button and sends a message.
  const chat = async (text, { close = true } = {}) => {
    const box = await page.locator('iframe').boundingBox();
    const x = box.x + box.width - 35;
    const y = box.y + 35;
    await page.mouse.move(x - 60, y + 60);
    await page.mouse.move(x, y);
    await sleep(250);
    await page.mouse.click(x, y);
    await sleep(350);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    if (close) await page.keyboard.press('Escape');
  };

  const inspect = () => call({ type: 'inspect-chat' });
  // Converts a rect inside the player iframe to page coordinates.
  const toPage = async (r) => {
    const box = await page.locator('iframe').boundingBox();
    return { x: box.x + r.x, y: box.y + r.y, w: r.w, h: r.h };
  };
  const openChat = async () => {
    if ((await inspect()).open) return;
    const box = await page.locator('iframe').boundingBox();
    const x = box.x + box.width - 35;
    const y = box.y + 35;
    await page.mouse.move(x - 60, y + 60);
    await page.mouse.move(x, y);
    await sleep(250);
    await page.mouse.click(x, y);
    await sleep(350);
  };
  const focusField = async () => {
    await openChat();
    const f = await toPage((await inspect()).field);
    await page.mouse.click(f.x + f.w / 2, f.y + f.h / 2);
  };
  const type = async (text) => {
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };

  return {
    name, ctx, sw, page, call, video, state, player, chat, inspect, toPage, openChat, focusField, type,
    join: () => call({ type: 'join', room: ROOM, name }),
    status: () => call({ type: 'status' }),
  };
}

// Position difference between two playing viewers, projected to the same instant
// so the time between the two reads doesn't count as drift.
function gap(x, y) {
  const t = Math.max(x.at, y.at);
  return (x.time + (t - x.at) / 1000) - (y.time + (t - y.at) / 1000);
}

async function inSync(a, b, tolerance = IN_SYNC_SEC) {
  const [x, y] = await Promise.all([a.state(), b.state()]);
  return !x.paused && !y.paused && Math.abs(gap(x, y)) < tolerance;
}

async function expectHeld(waiter, reason, blockerName, minMs = 2500) {
  await waitFor(async () => {
    const st = await waiter.status();
    return st.phase === 'waiting' && st.blockers.some((b) => b.name === blockerName && b.reason === reason)
      ? true : st;
  }, `room to wait for ${blockerName} (${reason})`);
  await waitFor(async () => (await waiter.state()).paused, `${waiter.name} to pause while waiting`, 3000);
  const t0 = (await waiter.state()).time;
  await sleep(minMs);
  const s = await waiter.state();
  assert.ok(s.paused && Math.abs(s.time - t0) < 0.05, `${waiter.name} should stay paused (${t0} -> ${s.time})`);
  return t0;
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
  results.push(name);
  console.log(`ok  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

(async () => {
  const users = [];
  let failed = false;
  try {
    const a = await launchUser('Alice');
    const b = await launchUser('Bob');
    users.push(a, b);

    await step('both users connected; video found in cross-origin iframe', async () => {
      for (const u of [a, b]) {
        await waitFor(async () => (await u.video((v) => !!v && v.readyState >= 1)) === true, `${u.name} video ready`);
      }
      await a.join();
      await b.join();
      for (const u of [a, b]) {
        await waitFor(async () => {
          const st = await u.status();
          return st.status === 'connected' && st.hasVideo && st.members.length === 2 ? true : st;
        }, `${u.name} connected`);
      }
    });

    await step('play starts together', async () => {
      await a.video((v) => v.play());
      await waitFor(() => inSync(a, b), 'both playing in sync');
      await sleep(2000);
      assert.ok(await inSync(a, b), 'drifted apart after 2s');
    });

    await step('seek and pause sync, control from either side', async () => {
      await a.video((v) => { v.currentTime = 60; });
      await waitFor(async () => (await inSync(a, b)) && Math.abs((await b.state()).time - 60) < 3, 'both at ~60s');
      await b.video((v) => v.pause());
      await waitFor(async () => (await a.state()).paused, 'Alice to pause');
      await sleep(400);
      const [x, y] = [await a.state(), await b.state()];
      assert.ok(Math.abs(x.time - y.time) < 0.3, `pause positions differ: ${x.time} vs ${y.time}`);
      await b.video((v) => v.play());
      await waitFor(() => inSync(a, b), 'resume in sync');
    });

    await step('chat reaches everyone, and typing never controls the player', async () => {
      // Space, f, k and arrows are common player shortcuts; none may leak out of the chat.
      await a.chat('hey f k  space test');
      await a.page.keyboard.press('ArrowLeft');
      await waitFor(async () => {
        const st = await b.status();
        return st.chat.some((m) => m.kind === 'msg' && m.name === 'Alice' && m.text === 'hey f k space test') ? true : st.chat;
      }, 'Bob to receive the message');
      await b.chat('hi alice');
      await waitFor(async () => (await a.status()).chat.some((m) => m.name === 'Bob' && m.text === 'hi alice'), 'Alice to receive the reply');
      const [x, y] = await Promise.all([a.state(), b.state()]);
      assert.ok(!x.paused && !y.paused, 'typing in chat paused the video');
      assert.equal((await a.status()).phase, 'playing');
      assert.ok(await a.video(() => !document.fullscreenElement), 'typing "f" toggled fullscreen');
      await waitFor(() => inSync(a, b), 'still in sync after chatting');
    });

    await step('chat works while the <video> element itself is fullscreen', async () => {
      await b.page.frames().find((f) => f.url().includes('8081')).click('#fs');
      await waitFor(async () => (await b.video(() => !!document.fullscreenElement)) === true, 'Bob fullscreen');
      await sleep(400);
      // The chat button is clickable above the fullscreen video, and so is the video.
      const hits = await b.video(() => ({
        corner: document.elementFromPoint(innerWidth - 35, 35)?.tagName,
        center: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName,
      }));
      assert.equal(hits.center, 'VIDEO', `video should still get clicks, got ${hits.center}`);
      await b.chat('typed in fullscreen', { close: false });
      await waitFor(async () => (await a.status()).chat.some((m) => m.text === 'typed in fullscreen'), 'message from fullscreen');
      assert.ok(await inSync(a, b, 0.5), 'fullscreen chat should not disturb playback');
      const before = await b.video((v) => v.getAttribute('style'));
      await b.video(() => document.exitFullscreen());
      await waitFor(async () => (await b.video(() => !document.fullscreenElement)) === true, 'exit fullscreen');
      await sleep(300);
      assert.equal(await b.video((v) => v.getAttribute('style')), null, `video style not restored: ${before}`);
      assert.ok(await b.video(() => !document.querySelector('[data-watch-sync-fullscreen]')), 'promotion marker left behind');
    });

    await step('swipe right on a message to reply; the reply shows what it answers', async () => {
      await b.openChat();
      await a.chat('who is that guy');
      await waitFor(async () => (await b.inspect()).messages.some((m) => m.text === 'who is that guy'), 'Alice\'s message in Bob\'s panel');
      const target = (await b.inspect()).messages.find((m) => m.text === 'who is that guy');
      const r = await b.toPage(target.rect);
      const y = r.y + r.h / 2;
      await b.page.mouse.move(r.x + 12, y);
      await b.page.mouse.down();
      for (let i = 1; i <= 8; i++) await b.page.mouse.move(r.x + 12 + i * 10, y);
      await b.page.mouse.up();
      assert.equal((await b.inspect()).replyingTo?.text, 'who is that guy', 'swipe should start a reply');
      await b.type('agreed');
      await waitFor(async () => {
        const m = (await a.status()).chat.find((x) => x.text === 'agreed');
        return m && m.replyTo && m.replyTo.name === 'Alice' && m.replyTo.text === 'who is that guy' ? true : m;
      }, 'reply with quote to reach Alice');
      await a.openChat();
      const shown = (await a.inspect()).messages.find((m) => m.text === 'agreed');
      assert.ok(shown && shown.quote.includes('who is that guy'), `quote not shown: ${JSON.stringify(shown)}`);
      assert.equal((await b.inspect()).replyingTo, null, 'reply bar should clear after sending');
    });

    await step('two-finger trackpad swipe also replies; Esc cancels', async () => {
      const target = (await a.inspect()).messages.find((m) => m.text === 'agreed');
      const r = await a.toPage(target.rect);
      await a.page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
      for (let i = 0; i < 6; i++) { await a.page.mouse.wheel(-25, 0); await sleep(16); }
      await waitFor(async () => (await a.inspect()).replyingTo?.text === 'agreed', 'trackpad swipe to start a reply', 3000);
      await a.page.keyboard.press('Escape');
      const st = await a.inspect();
      assert.equal(st.replyingTo, null, 'Esc should cancel the reply');
      assert.ok(st.open, 'Esc should cancel the reply before closing the panel');
    });

    await step('emoji picker inserts emoji into the message', async () => {
      const st = await a.inspect();
      const btn = await a.toPage(st.emojiButton);
      await a.page.mouse.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
      assert.ok((await a.inspect()).pickerOpen, 'picker should open');
      const first = (await a.inspect()).firstEmoji;
      const e = await a.toPage(first.rect);
      await a.page.mouse.click(e.x + e.w / 2, e.y + e.h / 2);
      await a.type(' lol');
      await waitFor(async () => (await b.status()).chat.some((m) => m.text === `${first.char} lol`), 'emoji message to reach Bob');
      assert.ok(!(await a.inspect()).pickerOpen, 'picker closes after sending');
    });

    await step('chat panel stays within half the video; older messages scroll', async () => {
      for (let i = 1; i <= 16; i++) {
        await b.type(`msg ${i}`);
        await sleep(650); // stay under the server's 8-per-5s limit
      }
      await waitFor(async () => (await a.status()).chat.some((m) => m.text === 'msg 16'), 'last message delivered', 5000);
      const atBottom = (st) => st.log.scrollHeight - st.log.scrollTop - st.log.clientHeight <= 8;
      for (const u of [a, b]) {
        const st = await u.inspect();
        const texts = st.messages.map((m) => m.text);
        assert.ok(st.panel.h <= st.stage.h / 2 + 1, `${u.name}: panel ${st.panel.h}px exceeds half of ${st.stage.h}px`);
        assert.equal(texts[texts.length - 1], 'msg 16', `${u.name}: newest message should be last`);
        assert.ok(texts.includes('msg 1'), `${u.name}: older messages should be kept, got ${texts.join(' | ')}`);
        assert.ok(st.log.scrollHeight > st.log.clientHeight, `${u.name}: log should overflow and scroll`);
        assert.ok(atBottom(st), `${u.name}: log should follow the newest message`);
        const last = st.messages[st.messages.length - 1].rect;
        assert.ok(last.y + last.h <= st.panel.y + st.panel.h, `${u.name}: newest message is cut off`);
      }

      // Bob scrolls up to the start; a new message doesn't yank him back down.
      // Overlay rects are relative to the player's iframe.
      const frameBox = await b.page.locator('iframe').boundingBox();
      let st = await b.inspect();
      await b.page.mouse.move(frameBox.x + st.log.rect.x + st.log.rect.w / 2, frameBox.y + st.log.rect.y + st.log.rect.h / 2);
      for (let i = 0; i < 10; i++) { await b.page.mouse.wheel(0, -400); await sleep(30); }
      await waitFor(async () => (await b.inspect()).log.scrollTop === 0, 'Bob scrolled to the oldest message', 3000);
      st = await b.inspect();
      const first = st.messages[0].rect;
      assert.ok(first.y >= st.log.rect.y - 1 && first.y + first.h <= st.log.rect.y + st.log.rect.h + 1, 'the oldest message should be visible after scrolling up');
      await a.type('one more');
      await waitFor(async () => !!(await b.inspect()).newer, '"New messages" button for Bob', 5000);
      assert.equal((await b.inspect()).log.scrollTop, 0, 'a new message should not move a viewer who scrolled up');
      const btn = (await b.inspect()).newer;
      await b.page.mouse.click(frameBox.x + btn.x + btn.w / 2, frameBox.y + btn.y + btn.h / 2);
      await waitFor(async () => atBottom(await b.inspect()), 'jump back to the newest message', 3000);
      assert.equal((await b.inspect()).newer, null, '"New messages" button should hide at the bottom');

      const video = await Promise.all([a.state(), b.state()]);
      assert.ok(!video[0].paused && !video[1].paused, 'chatting should not pause playback');
    });

    await step('drag the chat to any corner; the spot is saved for the site', async () => {
      // Drags in small steps, like a hand would; `hold` presses still first.
      const drag = async (u, from, to, hold = 0) => {
        await u.page.mouse.move(from.x, from.y);
        await u.page.mouse.down();
        if (hold) await sleep(hold);
        for (let i = 1; i <= 8; i++) {
          await u.page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
          await sleep(20);
        }
        await u.page.mouse.up();
        await sleep(400); // snap animation
      };
      const box = await a.page.locator('iframe').boundingBox();
      const center = (r) => ({ x: box.x + r.x + r.w / 2, y: box.y + r.y + r.h / 2 });
      const saved = async () => (await a.sw.evaluate(() => chrome.storage.local.get('chatCorners'))).chatCorners;

      // The panel moves by its header.
      await a.openChat();
      let st = await a.inspect();
      await drag(a, center(st.head), { x: box.x + 80, y: box.y + 60 });
      st = await a.inspect();
      assert.equal(st.corner, 'tl');
      assert.ok(st.panel.x < 30 && st.panel.y < 30, `panel should sit top left, got ${JSON.stringify(st.panel)}`);
      assert.ok(st.open, 'dragging the header should not close the chat');
      // Saved under the page's site, not the player iframe's.
      assert.deepEqual(await saved(), { 'localhost:8080': 'tl' });

      // A press and hold on a preview moves the previews; a plain swipe still replies (tested above).
      await a.page.keyboard.press('Escape');
      await waitFor(async () => !(await a.inspect()).open, 'Esc still closes the chat after moving it', 3000);
      await b.focusField();
      await b.type('move me');
      await waitFor(async () => (await a.inspect()).bubbles.some((x) => x.text.includes('move me')), 'preview for Alice', 5000);
      st = await a.inspect();
      const bubble = st.bubbles.find((x) => x.text.includes('move me'));
      await drag(a, center(bubble.rect), { x: box.x + 60, y: box.y + box.height - 60 }, 600);
      st = await a.inspect();
      assert.equal(st.corner, 'bl');
      assert.equal(st.replyingTo, null, 'moving a preview should not start a reply');
      assert.ok(st.bubbles.every((x) => x.rect.x < box.width / 2), 'previews should sit on the left');

      // The chat button moves too, and a drag doesn't count as a click.
      await a.page.mouse.move(box.x + 40, box.y + 40);
      await a.page.mouse.move(box.x + 35, box.y + 35);
      await sleep(250);
      st = await a.inspect();
      await drag(a, center(st.pill), { x: box.x + box.width - 60, y: box.y + box.height - 60 });
      st = await a.inspect();
      assert.equal(st.corner, 'br');
      assert.equal(st.open, false, 'dragging the chat button should not open the chat');
      assert.deepEqual(await saved(), { 'localhost:8080': 'br' });
    });

    await step('unread messages show on the toolbar icon until the chat is seen', async () => {
      const badge = () => a.sw.evaluate(() => chrome.action.getBadgeText({}));
      // Earlier steps left Alice with unread messages; seeing them clears the count.
      await a.openChat();
      await waitFor(async () => (await badge()) === '' || (await badge()), 'opening the chat clears earlier unread messages', 3000);
      await a.page.keyboard.press('Escape');
      await waitFor(async () => !(await a.inspect()).open, 'Alice closes the chat', 3000);
      await b.focusField();
      await b.type('one');
      await b.type('two');
      await waitFor(async () => (await badge()) === '2' || (await badge()), 'badge counts 2 while the chat is closed', 5000);
      await a.openChat();
      await waitFor(async () => (await badge()) === '' || (await badge()), 'opening the chat clears the badge', 3000);

      // With the chat open but the tab in the background, messages still count.
      const other = await a.ctx.newPage();
      await other.bringToFront();
      await b.type('while you were away');
      await waitFor(async () => (await badge()) === '1' || (await badge()), 'badge counts in a background tab', 5000);
      await a.page.bringToFront();
      await waitFor(async () => (await badge()) === '' || (await badge()), 'coming back to the open chat clears the badge', 3000);
      await other.close();
      await a.page.keyboard.press('Escape');
      await waitFor(async () => !(await a.inspect()).open, 'Alice closes the chat', 3000);
    });

    await step('room waits while one viewer buffers after a seek', async () => {
      site.control('Bob', { stalled: true });
      await a.video((v) => { v.currentTime = 400; });
      const held = await expectHeld(a, 'buffering', 'Bob');
      assert.ok(Math.abs(held - 400) < 1, `held at ${held}, expected ~400`);
      site.control('Bob', { stalled: false });
      await waitFor(() => inSync(a, b), 'resume together after buffering');
      assert.ok(Math.abs((await b.state()).time - 400) < 5);
    });

    await step('room waits when a viewer stalls mid-playback, nobody misses anything', async () => {
      // Starve Bob: his buffer drains and playback stalls on its own.
      site.control('Bob', { stalled: true });
      await waitFor(async () => {
        const st = await a.status();
        return st.phase === 'waiting' && st.blockers.some((x) => x.name === 'Bob') ? true : st.phase;
      }, 'Bob to run out of buffer', 60000);
      await waitFor(async () => (await a.state()).paused, 'Alice to pause');
      const [x, y] = [await a.state(), await b.state()];
      // Alice is held at (or before) where Bob got stuck.
      assert.ok(x.time <= y.time + 0.5, `Alice ran ahead of stalled Bob: ${x.time} vs ${y.time}`);
      await sleep(2000);
      assert.ok((await a.state()).paused, 'Alice resumed while Bob was still stalled');
      site.control('Bob', { stalled: false });
      await waitFor(() => inSync(a, b), 'resume together after stall', 15000);
    });

    await step('ad in the same <video> element holds the room; ad plays out untouched', async () => {
      const before = (await b.state()).time;
      await b.player('startSameElementAd');
      await expectHeld(a, 'ad', 'Bob');
      const ad1 = await b.state();
      assert.ok(ad1.src.includes('ad.mp4') && !ad1.paused, 'Bob\'s ad should keep playing');
      await sleep(1000);
      assert.ok((await b.state()).time > ad1.time, 'Bob\'s ad should be advancing');
      await b.player('endSameElementAd');
      await waitFor(() => inSync(a, b), 'resume together after ad', 15000);
      const after = (await a.state()).time;
      assert.ok(Math.abs(after - before) < 5, `resumed at ${after}, ad started at ${before}`);
    });

    await step('overlay ad player (separate <video> + ad class) holds the room', async () => {
      const before = (await a.state()).time;
      await a.player('startOverlayAd');
      await expectHeld(b, 'ad', 'Alice');
      const adPlaying = await a.video(() => {
        const ad = document.querySelector('.ad-video');
        return !!ad && !ad.paused;
      });
      assert.ok(adPlaying, 'Alice\'s overlay ad should keep playing');
      // The room must not have been paused by the player's own pause before the ad.
      const st = await b.status();
      assert.equal(st.phase, 'waiting', 'ad start should hold the room, not pause it');
      await a.player('endOverlayAd');
      await waitFor(() => inSync(a, b), 'resume together after overlay ad', 15000);
      const after = (await b.state()).time;
      assert.ok(Math.abs(after - before) < 5, `resumed at ${after}, ad started at ${before}`);
    });

    await step('ad served in an ad-network iframe holds the room', async () => {
      const before = (await b.state()).time;
      await b.player('startIframeAd');
      await expectHeld(a, 'ad', 'Bob');
      await b.player('endIframeAd');
      await waitFor(() => inSync(a, b), 'resume together after iframe ad', 15000);
      const after = (await a.state()).time;
      assert.ok(Math.abs(after - before) < 5, `resumed at ${after}, ad started at ${before}`);
    });

    await step('manual hold, then "play without waiting", then the held viewer catches up', async () => {
      await b.call({ type: 'hold', active: true });
      await expectHeld(a, 'hold', 'Bob', 1000);
      await a.call({ type: 'force' });
      await waitFor(async () => !(await a.state()).paused, 'Alice to play without waiting');
      await sleep(1500);
      await b.call({ type: 'hold', active: false });
      await waitFor(() => inSync(a, b, 0.5), 'Bob to catch up after releasing hold', 15000);
    });

    await step('small drift is corrected smoothly by speed, not seeking', async () => {
      // Knock Bob 0.8s ahead (under the 1s threshold for counting as a user seek).
      await b.video((v) => { v.currentTime += 0.8; });
      await sleep(300);
      await b.video((v) => {
        window.__seeks = 0;
        v.addEventListener('seeking', () => window.__seeks++);
      });
      const [x, y] = await Promise.all([a.state(), b.state()]);
      assert.ok(Math.abs(gap(x, y)) > 0.3, `expected drift, got ${x.time} vs ${y.time}`);
      await waitFor(() => inSync(a, b, 0.1), 'drift to converge', 20000);
      assert.equal(await b.video(() => window.__seeks), 0, 'drift should be fixed without seeking');
      assert.equal((await a.status()).phase, 'playing', 'drift correction should not hold the room');
    });

    await step('"Sync everyone" fixes drift that automatic correction cannot see', async () => {
      // Give Bob a stale clock measurement 2s off, as after a laptop wakes from
      // sleep. His player then keeps itself "in sync" with the wrong time.
      await b.sw.evaluate(() => {
        for (const s of sessions.values()) {
          s.offset += 2000;
          s.clock = [{ rtt: 0, offset: s.offset }]; // looks like the best sample, so it sticks
          pushToFrame(s);
        }
      });
      await waitFor(async () => {
        const [x, y] = await Promise.all([a.state(), b.state()]);
        return Math.abs(gap(x, y)) > 1.5;
      }, 'Bob to drift about 2s away', 20000);
      assert.equal((await a.status()).phase, 'playing');

      await a.call({ type: 'resync' });
      await waitFor(() => inSync(a, b), 'everyone back in sync after pressing Sync everyone', 15000);
      await sleep(2000);
      assert.ok(await inSync(a, b), 'drifted again after resync');
      assert.equal((await a.status()).phase, 'playing');
    });

    await step('late joiner is brought to the current position', async () => {
      const c = await launchUser('Carol');
      users.push(c);
      await waitFor(async () => (await c.video((v) => !!v && v.readyState >= 1)) === true, 'Carol video ready');
      await c.join();
      await waitFor(async () => (await inSync(b, c)) && (await inSync(a, c)), 'Carol in sync', 20000);
      const history = (await c.status()).chat.map((m) => m.text);
      assert.ok(history.includes('msg 16'), `Carol should see earlier chat, got ${JSON.stringify(history)}`);
    });

    await step('a click-to-play player starting at 0:00 never moves the room', async () => {
      const c = users[2];
      // What pressing play on a click-to-load embed does: a brand-new <video> at 0:00
      // replaces the old one, and the player's startup code seeks to its start and plays.
      const pressPlay = () => c.video((old) => {
        const v = document.createElement('video');
        v.src = old.currentSrc;
        v.controls = true;
        v.autoplay = true;
        v.addEventListener('loadedmetadata', () => { v.currentTime = 0; }, { once: true });
        old.replaceWith(v);
      });

      const before = (await a.state()).time;
      await pressPlay();
      await waitFor(async () => (await inSync(a, c)) && (await inSync(a, b)), 'Carol back in sync while playing', 20000);
      const after = (await a.state()).time;
      assert.ok(after >= before - 1, `room went back from ${before.toFixed(1)}s to ${after.toFixed(1)}s`);

      await a.video((v) => v.pause());
      await waitFor(async () => (await b.state()).paused && (await c.state()).paused, 'everyone paused');
      await sleep(800);
      const pausedAt = (await a.state()).time;
      await pressPlay();
      await waitFor(async () => {
        const st = await c.state();
        return st.paused && Math.abs(st.time - pausedAt) < 0.5;
      }, 'Carol lined up on the paused spot', 20000);
      await sleep(1000);
      const x = await a.state();
      assert.ok(x.paused && Math.abs(x.time - pausedAt) < 0.5, `paused room moved: ${pausedAt.toFixed(1)}s -> ${x.time.toFixed(1)}s, paused ${x.paused}`);

      await a.video((v) => v.play());
      await waitFor(async () => (await inSync(a, b)) && (await inSync(a, c)), 'everyone playing again', 20000);
    });

    await step('leaving stops syncing', async () => {
      const c = users[2];
      await c.call({ type: 'leave' });
      await waitFor(async () => (await a.status()).phase === 'playing' && (await inSync(a, b)), 'room steady after Carol left');
      await a.video((v) => v.pause());
      await waitFor(async () => (await b.state()).paused, 'Bob to pause');
      await sleep(800);
      assert.equal((await c.state()).paused, false, 'Carol should not follow after leaving');
    });

    console.log(`\nALL PASSED (${results.length} checks)`);
  } catch (e) {
    failed = true;
    console.error('FAIL', e.message);
  } finally {
    await Promise.all(users.map((u) => u.ctx.close().catch(() => {})));
    relay.wss.close();
    relay.server.close();
    site.close();
    process.exit(failed ? 1 : 0);
  }
})();
