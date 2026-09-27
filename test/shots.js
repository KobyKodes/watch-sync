// Renders the chat overlay in its main states and saves screenshots for design review.
// Run: CHROME_PATH=... node shots.js [outDir]
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

process.env.PORT = process.env.TEST_RELAY_PORT || '8797'; // separate from a relay you may be running
const relay = require('../server/server.js');
const site = require('./serve.js');

const EXT = path.resolve(__dirname, '../extension');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'shots'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function user(name) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), `ws-shot-${name}-`)), {
    headless: !process.env.HEADED,
    executablePath: process.env.CHROME_PATH || undefined,
    viewport: { width: 1000, height: 560 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const url = `http://localhost:8080/?u=${name}`;
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(url);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${sw.url().split('/')[2]}/popup.html`);
  await page.bringToFront();
  const call = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), { ...msg, tabId });
  const frame = () => page.frames().find((f) => f.url().startsWith('http://127.0.0.1:8081/'));
  return { ctx, page, call, frame };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const a = await user('Jad');
  const b = await user('Maya');
  try {
    await sleep(1500);
    await a.call({ type: 'join', room: 'SHOTS', name: 'Jad', server: `ws://localhost:${process.env.PORT}` });
    await b.call({ type: 'join', room: 'SHOTS', name: 'Maya', server: `ws://localhost:${process.env.PORT}` });
    await sleep(1500);
    await a.frame().evaluate(() => { const v = document.querySelector('video'); v.currentTime = 95; v.play(); });
    await sleep(2500);

    const iframe = await a.page.locator('iframe').boundingBox();
    const shoot = (name, page = a.page) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

    // Messages from Maya float in on Jad's screen.
    await b.call({ type: 'status' });
    const say = async (u, text) => {
      await u.page.mouse.move(iframe.x + iframe.width - 35, iframe.y + 35);
      await u.page.mouse.click(iframe.x + iframe.width - 35, iframe.y + 35);
      await sleep(300);
      await u.page.keyboard.type(text);
      await u.page.keyboard.press('Enter');
      await u.page.keyboard.press('Escape');
    };
    await say(b, 'this scene is unreal');
    await sleep(250);
    await say(b, 'wait for the twist');
    await sleep(600);
    await a.page.mouse.move(iframe.x + iframe.width - 60, iframe.y + 60);
    await sleep(400);
    await shoot('1-previews');

    // Jad opens the panel and replies.
    await a.page.mouse.click(iframe.x + iframe.width - 35, iframe.y + 35);
    await sleep(400);
    await a.page.keyboard.type('no spoilers');
    await a.page.keyboard.press('Enter');
    await a.page.keyboard.type('pausing in 5');
    await sleep(500);
    await shoot('2-panel-open');

    await a.page.mouse.move(100, 500);
    await sleep(5000);
    await shoot('3-panel-resting');

    // Maya swipes Jad's message to reply; Jad opens the emoji picker.
    const inspect = (u) => u.call({ type: 'inspect-chat' });
    await b.page.mouse.move(iframe.x + iframe.width - 35, iframe.y + 35);
    await b.page.mouse.click(iframe.x + iframe.width - 35, iframe.y + 35);
    await sleep(400);
    const m = (await inspect(b)).messages.find((x) => x.text === 'no spoilers');
    if (m) {
      const y = iframe.y + m.rect.y + m.rect.h / 2;
      await b.page.mouse.move(iframe.x + m.rect.x + 10, y);
      await b.page.mouse.down();
      for (let i = 1; i <= 4; i++) { await b.page.mouse.move(iframe.x + m.rect.x + 10 + i * 9, y); await sleep(30); }
      await shoot('6-swipe-in-progress', b.page);
      for (let i = 5; i <= 8; i++) await b.page.mouse.move(iframe.x + m.rect.x + 10 + i * 9, y);
      await b.page.mouse.up();
      await b.page.keyboard.type('fine, no spoilers 🤐');
      await b.page.keyboard.press('Enter');
    }
    await sleep(600);
    const st = await inspect(a);
    await a.page.mouse.click(iframe.x + st.emojiButton.x + 15, iframe.y + st.emojiButton.y + 15);
    await sleep(300);
    await shoot('7-reply-and-emoji');
    await a.page.keyboard.press('Escape');

    // Maya goes fullscreen on the <video> element itself.
    await b.frame().click('#fs');
    await sleep(800);
    await b.page.mouse.move(900, 100);
    await sleep(200);
    await b.page.mouse.move(920, 110);
    await sleep(300);
    await shoot('4-fullscreen-video', b.page);
    await b.page.mouse.click(1000 - 35, 35);
    await sleep(500);
    await b.page.keyboard.type('ok going fullscreen');
    await b.page.keyboard.press('Enter');
    await sleep(600);
    await shoot('5-fullscreen-panel', b.page);
    console.log('saved to', OUT);
  } finally {
    await a.ctx.close();
    await b.ctx.close();
    relay.wss.close();
    relay.server.close();
    site.close();
    process.exit(0);
  }
})();
