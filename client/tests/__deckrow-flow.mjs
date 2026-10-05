// Follow-up: hold TTS (no auto-advance) to prove play sets progress, stop clears it;
// plus a full-viewport 320px screenshot showing the count fully inside the dialog.
import { browserFixture } from './helpers/browser.mjs';
import { writeFile } from 'node:fs/promises';

const OUT = 'C:/Users/luiss/AppData/Local/Temp/opencode';
const browser = await browserFixture();
const run = browser.evaluate;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      if (p === '/api/decks?limit=30') data = { items: [{ id: 1, title: 'Demo deck', description: 'd', entityType: 'vocabulary', ownerDisplay: 'Tester', followers: 4, viewerFollowing: false, itemCount: 2 }] };
      else if (p === '/api/decks/1') data = deckDetail();
      else if (p === '/api/decks/1/follow' && method === 'POST') { window.__liked = true; window.__followers = 5; data = { followers: 5 }; }
      else if (p === '/api/decks/1/follow' && method === 'DELETE') { window.__liked = false; window.__followers = 4; data = { followers: 4 }; }
      else if (p.includes('/analytics')) data = { overview: { followers: 4, items: 2, suggestions: { pending: 0 } } };
      else if (p.includes('/suggestions')) data = { items: [] };
      else data = { items: [] };
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    // HOLDING TTS stub: speak never ends, so progress stays until Stop.
    const holding = { cancel() {}, getVoices: () => [], speak(u) {} };
    try { Object.defineProperty(window, 'speechSynthesis', { configurable: true, writable: true, value: holding }); }
    catch { try { window.speechSynthesis = holding; } catch {} }
    try { Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: function (t) { this.text = t; this.lang = ''; } }); }
    catch { try { window.SpeechSynthesisUtterance = function (t) { this.text = t; this.lang = ''; }; } catch {} }
    'setup-done';
  `);
  await run(`
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
  `);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const flow = await run(`(async () => {
    const out = {};
    const play = document.querySelector('button[aria-label="Play every item aloud in order"]');
    const stop = document.querySelector('button[aria-label="Stop playback"]');
    const progress = [...document.querySelectorAll('p')].find((p) => p.getAttribute('aria-live') === 'polite');
    play.click();
    await new Promise((r) => setTimeout(r, 200));
    out.afterPlay = progress.textContent;
    stop.click();
    await new Promise((r) => setTimeout(r, 120));
    out.afterStop = progress.textContent;
    return out;
  })()`);
  console.log(JSON.stringify(flow));
  const shot = await browser.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${OUT}/deckrow-320-full.png`, Buffer.from(shot.data, 'base64'));
} finally {
  await browser.close();
}
