// Temporary real-browser verification for the deck playback-row fix.
// NOT part of the suite (no .test.mjs suffix). Deleted after the run.
import { browserFixture } from './helpers/browser.mjs';
import { writeFile } from 'node:fs/promises';

const OUT = 'C:/Users/luiss/AppData/Local/Temp/opencode';
const browser = await browserFixture();
const run = browser.evaluate;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
try {
  await run(`
    window.__liked = false;
    window.__followers = 4;
    const deckDetail = () => ({ id: 1, title: 'Demo deck',
      description: 'A short description for layout checks.',
      entityType: 'vocabulary', ownerDisplay: 'Tester',
      followers: window.__followers, viewerFollowing: window.__liked,
      items: [
        { id: 11, word: '猫', reading: 'ねこ', meaning: 'cat' },
        { id: 12, word: '犬', reading: 'いぬ', meaning: 'dog' }
      ] });
    window.fetch = async (path, options = {}) => {
      const p = String(path);
      const method = options.method || 'GET';
      let data;
      if (p === '/api/decks?limit=30') data = { items: [{ id: 1, title: 'Demo deck', description: 'A short description.', entityType: 'vocabulary', ownerDisplay: 'Tester', followers: 4, viewerFollowing: false, itemCount: 2 }] };
      else if (p === '/api/decks/1') data = deckDetail();
      else if (p === '/api/decks/1/follow' && method === 'POST') { window.__liked = true; window.__followers = 5; data = { followers: 5 }; }
      else if (p === '/api/decks/1/follow' && method === 'DELETE') { window.__liked = false; window.__followers = 4; data = { followers: 4 }; }
      else if (p.includes('/analytics')) data = { overview: { followers: 4, items: 2, suggestions: { pending: 0 } } };
      else if (p.includes('/suggestions')) data = { items: [] };
      else data = { items: [] };
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, writable: true,
        value: { cancel() {}, getVoices: () => [], speak(u) { setTimeout(() => { try { u.onend && u.onend(); } catch {} }, 60); } } });
    } catch { try { window.speechSynthesis = { cancel() {}, getVoices: () => [], speak(u) { setTimeout(() => { try { u.onend && u.onend(); } catch {} }, 60); } }; } catch {} }
    try {
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: function (t) { this.text = t; this.lang = ''; } });
    } catch { try { window.SpeechSynthesisUtterance = function (t) { this.text = t; this.lang = ''; }; } catch {} }
    window.__openDeck = async () => {
      document.getElementById('modal-root').replaceChildren();
      const { renderCommunity } = await import('/src/pages/community.js');
      await renderCommunity(document.getElementById('app'));
      await new Promise((resolve, reject) => {
        let n = 0;
        const timer = setInterval(() => {
          const row = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Open Demo deck'));
          if (row) { clearInterval(timer); resolve(); }
          else if (++n > 100) { clearInterval(timer); reject(new Error('deck row never rendered')); }
        }, 50);
      });
      const row = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Open Demo deck'));
      row.focus();
      row.click();
      await new Promise((resolve, reject) => {
        let n = 0;
        const timer = setInterval(() => {
          if (document.querySelector('button[aria-label="Stop playback"]')) { clearInterval(timer); resolve(); }
          else if (++n > 100) { clearInterval(timer); reject(new Error('deck dialog never opened')); }
        }, 50);
      });
    };
  `);
  await run('__openDeck()');

  const measure = () => run(`(() => {
    const q = (s) => document.querySelector(s);
    const play = q('button[aria-label="Play every item aloud in order"]');
    const stop = q('button[aria-label="Stop playback"]');
    const like = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Like '));
    if (!play || !stop || !like) return { missing: true };
    const row = play.parentElement;
    const panel = document.querySelector('.dialog-panel');
    const pr = play.getBoundingClientRect(), sr = stop.getBoundingClientRect(), lr = like.getBoundingClientRect();
    const rr = row.getBoundingClientRect(), panelR = panel.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    const likeCount = [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') || '').startsWith('Like ')).length;
    const progress = [...document.querySelectorAll('p')].find((p) => p.getAttribute('aria-live') === 'polite');
    return {
      play: { x: pr.x, y: pr.y, w: pr.width, h: pr.height },
      stop: { x: sr.x, y: sr.y, w: sr.width, h: sr.height, hasSvg: !!stop.querySelector('svg'), text: stop.textContent.trim() },
      like: { x: lr.x, y: lr.y, w: lr.width, h: lr.height, right: lr.right, pressed: like.getAttribute('aria-pressed') },
      row: { y: rr.y, h: rr.height, scrollW: row.scrollWidth, clientW: row.clientWidth, flexDirection: rowStyle.flexDirection, flexWrap: rowStyle.flexWrap, alignItems: rowStyle.alignItems },
      panel: { right: panelR.right, scrollW: panel.scrollWidth, clientW: panel.clientWidth },
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      innerWidth: window.innerWidth,
      likeCount,
      progressAlive: !!progress,
      sameRow: Math.abs(pr.y - sr.y) < 1.5 && Math.abs(sr.y - lr.y) < 1.5,
      sameHeight: Math.abs(pr.height - sr.height) < 1.5 && Math.abs(pr.height - lr.height) < 1.5,
      starInside: lr.right <= panelR.right + 1,
      rowFits: row.scrollWidth <= row.clientWidth + 1,
      panelFits: panel.scrollWidth <= panel.clientWidth + 1
    };
  })()`);

  for (const width of [320, 375, 768, 1280]) {
    const height = width <= 430 ? 700 : 800;
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const m = await measure();
    results.push({ width, ...m });
    // Row-clip screenshot with padding.
    const clip = await run(`(() => {
      const play = document.querySelector('button[aria-label="Play every item aloud in order"]');
      const r = play.parentElement.getBoundingClientRect();
      return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 };
    })()`);
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
    await writeFile(`${OUT}/deckrow-${width}.png`, Buffer.from(shot.data, 'base64'));
  }

  // Flow: play -> stop -> star toggle -> Esc close with focus return.
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const flow = await run(`(async () => {
    const out = {};
    const play = document.querySelector('button[aria-label="Play every item aloud in order"]');
    const stop = document.querySelector('button[aria-label="Stop playback"]');
    const like = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Like '));
    const progress = [...document.querySelectorAll('p')].find((p) => p.getAttribute('aria-live') === 'polite');
    play.click();
    await new Promise((r) => setTimeout(r, 250));
    out.afterPlay = progress.textContent;
    stop.click();
    await new Promise((r) => setTimeout(r, 120));
    out.afterStop = progress.textContent;
    out.pressedBefore = like.getAttribute('aria-pressed');
    like.click();
    await new Promise((resolve, reject) => {
      let n = 0;
      const timer = setInterval(() => {
        if (like.getAttribute('aria-pressed') === 'true') { clearInterval(timer); resolve(); }
        else if (++n > 100) { clearInterval(timer); reject(new Error('star toggle never applied')); }
      }, 50);
    });
    out.pressedAfter = like.getAttribute('aria-pressed');
    const count = like.parentElement.querySelector('p');
    out.countLabel = count && count.getAttribute('aria-label');
    out.focusBeforeEsc = document.activeElement === like || document.activeElement.tagName;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    out.dialogClosed = !document.querySelector('.dialog-panel');
    const focused = document.activeElement;
    out.focusReturned = focused && (focused.getAttribute('aria-label') || '').startsWith('Open Demo deck');
    return out;
  })()`);
  results.push({ flow });
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
