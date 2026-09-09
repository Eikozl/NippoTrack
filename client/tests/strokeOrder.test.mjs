// v5.1-B.2 Jōyō stroke-order animation — contract tests.
// Covers: eligibility, file naming/URLs, lazy fetch (no fetch at mount, no
// autoplay), safe parsing (paths-only via DOMParser + createElementNS, never
// innerHTML), sequential draw → Replay, reduced-motion instant-final,
// failure fallback, cross-kanji no-leak, both-surface wiring, and the
// strokeJoyo import discipline (tiny table imported ONLY by strokeOrder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STROKE_DRAW_MS,
  STROKE_PAUSE_MS,
  extractStrokePathsFromDocument,
  loadStrokePaths,
  mountStrokeOrder,
  mountStrokeSlots,
  strokeAssetUrl,
  strokeFileName
} from '../src/strokeOrder.js';
import { isJoyoKanji } from '../src/strokeJoyo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const readAsset = (file) => readFileSync(join(root, 'public', 'stroke', 'kanji', file), 'utf8');
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// --- minimal DOM doubles ----------------------------------------------------
// Just enough for the stroke module: namespaced creation, attributes,
// dataset, style, tree ops, listeners with bubbling, and a throwing
// innerHTML setter that behaviorally proves the module never injects raw
// SVG source.

class FakeNode {
  constructor(tag, doc = null, namespace = null) {
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = namespace;
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.focused = false;
    this.isConnected = true;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this._listeners = new Map();
  }
  set innerHTML(_) {
    throw new Error('innerHTML is forbidden in stroke rendering');
  }
  get innerHTML() {
    throw new Error('innerHTML is forbidden in stroke rendering');
  }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  hasAttribute(name) { return this.attributes.has(String(name)); }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler);
  }
  listenerCount(type) { return this._listeners.get(type)?.size ?? 0; }
  dispatchEvent(event) {
    let node = this;
    while (node) {
      for (const handler of node._listeners.get(event.type) || []) handler.call(node, event);
      node = node.parentNode;
    }
    return true;
  }
  click() {
    // Browsers focus a button on activation; mirror that for focus tests.
    if (this.tagName === 'BUTTON') this.focused = true;
    this.dispatchEvent({ type: 'click' });
  }
  keydown(key) { this.dispatchEvent({ type: 'keydown', key, stopPropagation() {} }); }
  focus() { this.focused = true; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) this.removeChild(child);
    for (const node of nodes) if (node) this.appendChild(node);
  }
  remove() { this.parentNode?.removeChild(this); }
  getTotalLength() { return 120; }
  matchesSelector(selector) {
    const pattern = /^(?:([a-zA-Z][a-zA-Z0-9]*)?)?(?:\.([a-zA-Z0-9_-]+))?(?:#([a-zA-Z0-9_-]+))?(?:\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\])?$/;
    const match = pattern.exec(selector.trim());
    if (!match) return false;
    const [, tag, cls, id, attr, attrValue] = match;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (cls && !(this.getAttribute('class') || '').split(/\s+/).includes(cls)) return false;
    if (id && this.getAttribute('id') !== id) return false;
    if (attr) {
      const value = this.getAttribute(attr);
      if (value === null) return false;
      if (attrValue !== undefined && value !== attrValue) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDoc {
  createElement(tag) { return new FakeNode(tag, this); }
  createElementNS(namespace, tag) { return new FakeNode(tag, this, namespace); }
}

// Test-only mini parser: builds a fake document whose path nodes expose the
// real `d` attributes in document order (groups preserved as nesting, so the
// "ignore everything else" behavior is genuinely exercised).
function miniParseSvg(svgText) {
  const doc = new FakeDoc();
  const rootNode = doc.createElement('svg');
  const stack = [rootNode];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let tagMatch;
  while ((tagMatch = tagPattern.exec(svgText)) !== null) {
    const [full, tag, attrs] = tagMatch;
    const closing = full.startsWith('</');
    const selfClosing = full.endsWith('/>') || tag === 'path';
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = tag === 'path'
      ? doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      : doc.createElement(tag);
    const attrPattern = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*"([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrs)) !== null) node.setAttribute(attrMatch[1], attrMatch[2]);
    stack[stack.length - 1].appendChild(node);
    if (!selfClosing) stack.push(node);
  }
  return {
    querySelectorAll: (selector) => rootNode.querySelectorAll(selector),
    getElementsByTagName: () => []
  };
}

const syntheticSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 109 109">'
  + '<g><path id="kvg:x-s1" kvg:type="x" d="M0 0L10 10"/>'
  + '<path id="kvg:x-s2" d="M5 5L15 15"/></g>'
  + '<path id="kvg:x-s3" d="M9 9L20 20"/></svg>';

function fetchOf(text, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = (url, options = {}) => {
    calls.push({ url: String(url), signal: options.signal || null });
    return Promise.resolve({ ok, status, text: () => Promise.resolve(text) });
  };
  return { fn, calls };
}

function deferredFetch() {
  const calls = [];
  const pending = [];
  const fn = (url, options = {}) => {
    calls.push({ url: String(url), signal: options.signal || null });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { fn, calls, pending };
}

function makeRaf() {
  const queue = [];
  let now = 0;
  let sequence = 0;
  const raf = (callback) => {
    sequence += 1;
    queue.push({ id: sequence, callback });
    return sequence;
  };
  const caf = (id) => {
    const index = queue.findIndex((entry) => entry.id === id);
    if (index >= 0) queue.splice(index, 1);
  };
  const tick = (ms) => {
    now += ms;
    for (const entry of queue.splice(0)) entry.callback(now);
  };
  const drain = (ms = 50, limit = 500) => {
    let steps = 0;
    while (queue.length && steps < limit) {
      steps += 1;
      tick(ms);
    }
    assert.ok(steps < limit, 'animation settled (no runaway rAF loop)');
  };
  return { raf, caf, tick, drain, queue, now: () => now };
}

function makeSlot(doc, character) {
  const slot = doc.createElement('div');
  slot.setAttribute('class', 'kanji-stroke-slot');
  slot.setAttribute('data-kanji-stroke-slot', character);
  slot.setAttribute('aria-hidden', 'true');
  return slot;
}

function makePanel(doc, character) {
  const panel = doc.createElement('div');
  panel.setAttribute('class', 'kanji-identity-glyph kanji-glyph-panel-large kanji-identity-glyph--square');
  const glyph = doc.createElement('span');
  glyph.setAttribute('class', 'kanji-glyph-large');
  glyph.textContent = character;
  panel.appendChild(glyph);
  panel.appendChild(makeSlot(doc, character));
  return panel;
}

function buttonsIn(slot) { return slot.querySelectorAll('button'); }
function triggerIn(slot) { return slot.querySelector('button.stroke-trigger'); }
function viewIn(slot) { return slot.querySelector('div.stroke-view'); }
function svgPathsIn(slot) {
  const svg = slot.querySelector('svg');
  return svg ? svg.children.filter((child) => child.tagName === 'PATH') : [];
}

// --- eligibility ------------------------------------------------------------

test('eligibility: Jōyō representatives pass, non-Jōyō and non-chars fail', () => {
  for (const char of ['日', '学', '鳥', '鬱', '花']) {
    assert.equal(isJoyoKanji(char), true, `${char} is Jōyō`);
  }
  assert.equal(isJoyoKanji('𠮟'), true, '𠮟 (non-BMP extra) is eligible');
  for (const char of ['屁', '々', 'A', '', '日日', '12']) {
    assert.equal(isJoyoKanji(char), false, `${JSON.stringify(char)} is not eligible`);
  }
  assert.equal(isJoyoKanji(null), false, 'null is not eligible');
  assert.equal(isJoyoKanji(undefined), false, 'undefined is not eligible');
});

test('mount renders a control exactly when the mask says Jōyō (喰 follows the mask)', () => {
  const doc = new FakeDoc();
  for (const char of ['日', '学', '喰', '屁', '々']) {
    const slot = makeSlot(doc, char);
    const { fn } = fetchOf(syntheticSvg);
    mountStrokeOrder(slot, { character: char, doc, fetchFn: fn });
    assert.equal(buttonsIn(slot).length, isJoyoKanji(char) ? 1 : 0, `${char || '(empty)'} control matches eligibility`);
  }
});

// --- file naming + asset URLs ------------------------------------------------

test('file naming pads BMP hex to 5 digits and keeps non-BMP hex intact', () => {
  assert.equal(strokeFileName('学'), '05b66.svg');
  assert.equal(strokeFileName('日'), '065e5.svg');
  assert.equal(strokeFileName('花'), '082b1.svg');
  assert.equal(strokeFileName('𠮟'), '20b9f.svg');
  assert.equal(strokeFileName('屁'), '05c41.svg');
  assert.equal(strokeFileName(''), null);
  assert.equal(strokeFileName(null), null);
});

test('asset URL is app-relative (works at root in dev + Vercel), never an API route', () => {
  const url = strokeAssetUrl('学');
  assert.equal(url, 'stroke/kanji/05b66.svg');
  assert.ok(!url.startsWith('/'), 'relative to the app base, no leading slash');
  assert.ok(!url.includes('/api/'), 'static asset, never an API route');
  assert.equal(strokeAssetUrl('𠮟'), 'stroke/kanji/20b9f.svg');
  assert.equal(strokeAssetUrl('学', '/app/'), '/app/stroke/kanji/05b66.svg');
  assert.equal(strokeAssetUrl(''), null);
});

// --- real vendored assets feed the real extractor -----------------------------

test('representative assets expose canonical path counts in document order', () => {
  const expectations = [
    ['日', '065e5.svg', 4],
    ['学', '05b66.svg', 8],
    ['花', '082b1.svg', 7],
    ['鳥', '09ce5.svg', 11],
    ['鬱', '09b31.svg', 29]
  ];
  for (const [char, file, count] of expectations) {
    const paths = extractStrokePathsFromDocument(miniParseSvg(readAsset(file)));
    assert.equal(paths.length, count, `${char} has ${count} strokes`);
    for (const d of paths) assert.match(d, /^M/, 'each stroke is a path-data string');
  }
  const gaku = extractStrokePathsFromDocument(miniParseSvg(readAsset('05b66.svg')));
  assert.ok(gaku[0].startsWith('M29.5,17.25'), 'document order preserved (first stroke of 学)');
});

test('grouping is structural only: 花 groups contribute zero extra paths, 𠮟 asset parses', () => {
  const hanaSource = readAsset('082b1.svg');
  assert.ok(hanaSource.includes('<g'), '花 fixture genuinely uses groups');
  const paths = extractStrokePathsFromDocument(miniParseSvg(hanaSource));
  assert.equal(paths.length, 7, 'only <path> d attributes survive');
  const shitsu = extractStrokePathsFromDocument(miniParseSvg(readAsset('20b9f.svg')));
  assert.equal(shitsu.length, 5, 'non-BMP 𠮟 asset parses in order');
});

test('extractor drops empty d values and ignores non-path documents', () => {
  const doc = new FakeDoc();
  const rootNode = doc.createElement('svg');
  const empty = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  empty.setAttribute('d', '   ');
  const group = doc.createElement('g');
  group.textContent = 'structure only';
  rootNode.appendChild(empty);
  rootNode.appendChild(group);
  assert.deepEqual(
    extractStrokePathsFromDocument({ querySelectorAll: (s) => rootNode.querySelectorAll(s) }),
    [],
    'no usable paths'
  );
});

// --- mount: non-Jōyō leaves the slot empty -------------------------------------

test('non-Jōyō mount leaves the slot empty/static with zero network', async () => {
  const doc = new FakeDoc();
  for (const char of ['屁', '々', '']) {
    const slot = makeSlot(doc, char);
    const { fn, calls } = fetchOf(syntheticSvg);
    const cleanup = mountStrokeOrder(slot, { character: char, doc, fetchFn: fn });
    assert.equal(typeof cleanup, 'function', 'cleanup returned');
    await sleep();
    assert.equal(calls.length, 0, 'no fetch for non-Jōyō');
    assert.equal(buttonsIn(slot).length, 0, 'no control rendered');
    assert.equal(slot.getAttribute('aria-hidden'), 'true', 'empty slot stays hidden');
    assert.equal(slot.children.length, 0, 'slot stays empty');
  }
});

// --- mount: Jōyō renders ONE lazy button ---------------------------------------

test('Jōyō mount renders one reachable button and fetches nothing until activation', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const { fn, calls } = fetchOf(syntheticSvg);
  const { raf, queue } = makeRaf();
  mountStrokeOrder(slot, { character: '日', doc, fetchFn: fn, raf });
  await sleep();
  await sleep();
  assert.equal(calls.length, 0, 'lazy: no fetch at mount');
  assert.equal(queue.length, 0, 'no autoplay: no animation scheduled at mount');
  const triggers = buttonsIn(slot);
  assert.equal(triggers.length, 1, 'exactly one affordance');
  const trigger = triggers[0];
  assert.equal(trigger.getAttribute('type'), 'button', 'real button');
  assert.equal(trigger.textContent, 'Stroke order', 'restrained label');
  assert.ok((trigger.getAttribute('aria-label') || '').includes('日'), 'accessible label names the kanji');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'collapsed initially');
  assert.equal(slot.getAttribute('aria-hidden'), null, 'populated slot exposed to assistive tech');
  assert.equal(slot.getAttribute('data-stroke-state'), 'idle', 'idle state hook');
});

// --- activation: fetch → safe build → sequential draw → Replay ------------------

test('activation fetches the kanji asset, builds SVG safely, and draws sequentially to Replay', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const { fn, calls } = fetchOf(syntheticSvg);
  const { raf, caf, tick, drain, queue } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 100, pauseMs: 20, prefersReducedMotion: () => false
  });
  triggerIn(slot).click();
  assert.equal(triggerIn(slot).textContent, 'Loading…', 'loading state');
  assert.equal(triggerIn(slot).disabled, true, 'loading button disabled (no double activation)');
  assert.equal(slot.getAttribute('data-stroke-state'), 'loading', 'loading state hook');
  await sleep();
  assert.equal(calls.length, 1, 'fetch fired once, on activation');
  assert.ok(calls[0].url.endsWith('stroke/kanji/065e5.svg'), `fetched 日 asset (${calls[0].url})`);
  const paths = svgPathsIn(slot);
  assert.equal(paths.length, 3, 'nested group path included, document order kept');
  for (const path of paths) {
    assert.equal(path.namespaceURI, 'http://www.w3.org/2000/svg', 'programmatic SVG namespace');
    assert.ok(path.getAttribute('d').startsWith('M'), 'd carried over');
    assert.equal(path.getAttribute('id'), null, 'no source ids copied');
    assert.equal(path.getAttribute('kvg:type'), null, 'no foreign attributes copied');
    assert.equal(path.style.strokeDashoffset, '120', 'strokes start hidden');
  }
  const svg = slot.querySelector('svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 109 109', 'KanjiVG coordinate space');
  assert.ok((svg.getAttribute('aria-label') || '').includes('3 strokes'), 'stroke count exposed');
  // Sequential: after a partial advance the first stroke is done while the
  // last is still hidden.
  tick(50); tick(50); tick(50);
  const mid = svgPathsIn(slot).map((path) => path.style.strokeDashoffset);
  assert.equal(mid[0], '0', 'first stroke completes first');
  assert.equal(mid[2], '120', 'last stroke still hidden mid-animation');
  assert.ok(queue.length > 0, 'animation progresses via scheduled frames');
  drain();
  const done = svgPathsIn(slot).map((path) => path.style.strokeDashoffset);
  assert.deepEqual(done, ['0', '0', '0'], 'completed strokes stay visible');
  const replay = slot.querySelector('button.stroke-replay');
  assert.ok(replay, 'Replay appears on completion');
  assert.equal(replay.disabled, false, 'Replay enabled when done');
  assert.equal(replay.getAttribute('type'), 'button', 'Replay is a real button');
});

// --- Replay ---------------------------------------------------------------------

test('Replay restarts the sequence and disables itself while playing', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '花');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, drain, queue } = makeRaf();
  mountStrokeOrder(slot, {
    character: '花', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 100, pauseMs: 20, prefersReducedMotion: () => false
  });
  triggerIn(slot).click();
  await sleep();
  drain();
  const replay = slot.querySelector('button.stroke-replay');
  replay.click();
  assert.equal(replay.disabled, true, 'Replay disabled while replaying');
  assert.ok(queue.length > 0, 'replay schedules fresh frames');
  drain();
  assert.equal(replay.disabled, false, 'Replay re-enabled after the second run');
  assert.deepEqual(svgPathsIn(slot).map((p) => p.style.strokeDashoffset), ['0', '0', '0'], 'final state again');
});

// --- reduced motion ---------------------------------------------------------------

test('prefers-reduced-motion renders the final state instantly with no animation frames', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '鳥');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, queue } = makeRaf();
  mountStrokeOrder(slot, {
    character: '鳥', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, prefersReducedMotion: () => true
  });
  triggerIn(slot).click();
  await sleep();
  assert.equal(queue.length, 0, 'zero animation frames scheduled');
  assert.deepEqual(svgPathsIn(slot).map((p) => p.style.strokeDashoffset), ['0', '0', '0'], 'all strokes visible immediately');
  const replay = slot.querySelector('button.stroke-replay');
  assert.ok(replay && replay.disabled === false, 'Replay available (instant final again)');
});

// --- way back to the static glyph ----------------------------------------------------

test('Close restores the static glyph; Escape does the same', async () => {
  const doc = new FakeDoc();
  for (const closeVia of ['button', 'escape']) {
    const panel = makePanel(doc, '学');
    const slot = panel.querySelector('div');
    const glyph = panel.querySelector('span');
    const { fn } = fetchOf(syntheticSvg);
    const { raf, caf, drain } = makeRaf();
    mountStrokeOrder(slot, {
      character: '学', doc, fetchFn: fn, raf, caf,
      parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
    });
    triggerIn(slot).click();
    await sleep();
    drain();
    assert.ok(viewIn(slot), 'overlay open');
    if (closeVia === 'button') triggerIn(slot).click();
    else slot.keydown('Escape');
    assert.equal(viewIn(slot), null, `overlay removed via ${closeVia}`);
    assert.equal(triggerIn(slot).textContent, 'Stroke order', 'trigger back to idle');
    assert.equal(triggerIn(slot).getAttribute('aria-expanded'), 'false', 'collapsed again');
    assert.equal(glyph.textContent, '学', 'static glyph node untouched');
    assert.equal(glyph.parentNode, panel, 'glyph still in the panel');
    assert.equal(triggerIn(slot).focused, true, 'focus returns to the trigger');
  }
});

// --- failure paths ---------------------------------------------------------------------

test('fetch failure degrades to a calm note; static glyph remains, nothing spins', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '鬱');
  const slot = panel.querySelector('div');
  const failing = () => Promise.reject(new Error('offline'));
  const clock = makeRaf();
  mountStrokeOrder(slot, { character: '鬱', doc, fetchFn: failing, raf: clock.raf, parseFn: miniParseSvg });
  triggerIn(slot).click();
  await sleep();
  await sleep();
  assert.equal(slot.getAttribute('data-stroke-state'), 'failed', 'failure state hook');
  assert.equal(buttonsIn(slot).length, 0, 'no stranded control');
  const note = slot.querySelector('p.stroke-note');
  assert.ok(note, 'calm note shown');
  assert.equal(note.getAttribute('role'), 'status', 'note announced politely');
  assert.equal(note.textContent, 'Stroke order unavailable', 'no technical jargon');
  assert.equal(panel.querySelector('span').textContent, '鬱', 'static glyph remains');
  assert.equal(clock.queue.length, 0, 'nothing scheduled after failure');
});

test('corrupt assets (zero paths, unparseable) take the same failure path', async () => {
  const doc = new FakeDoc();
  const cases = [
    ['zero paths', '<svg xmlns="http://www.w3.org/2000/svg"><g id="kvg:x"></g></svg>'],
    ['empty file', ''],
    ['not svg', 'oops not xml {{{']
  ];
  for (const [label, body] of cases) {
    const slot = makeSlot(doc, '日');
    const { fn } = fetchOf(body);
    const { raf } = makeRaf();
    mountStrokeOrder(slot, { character: '日', doc, fetchFn: fn, raf, parseFn: miniParseSvg });
    triggerIn(slot).click();
    await sleep();
    await sleep();
    assert.equal(slot.getAttribute('data-stroke-state'), 'failed', `${label} → failed`);
    assert.ok(slot.querySelector('p.stroke-note'), `${label} → calm note`);
  }
  // A throwing parser is also a calm failure, never a crash.
  const slot = makeSlot(doc, '日');
  const { fn } = fetchOf('<svg></svg>');
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: fn, raf: makeRaf().raf,
    parseFn: () => { throw new Error('boom'); }
  });
  triggerIn(slot).click();
  await sleep();
  await sleep();
  assert.equal(slot.getAttribute('data-stroke-state'), 'failed', 'throwing parser → failed');
});

test('loadStrokePaths rejects non-OK responses and empty documents', async () => {
  const notFound = fetchOf('missing', { ok: false, status: 404 });
  await assert.rejects(() => loadStrokePaths('日', { fetchFn: notFound.fn, parseFn: miniParseSvg }), '404 rejects');
  const empty = fetchOf('<svg></svg>');
  await assert.rejects(() => loadStrokePaths('日', { fetchFn: empty.fn, parseFn: miniParseSvg }), 'zero paths reject');
});

// --- SVG-security core ------------------------------------------------------------------

test('implementation parses with DOMParser and builds with createElementNS — never innerHTML', () => {
  const source = readSource('src/strokeOrder.js');
  assert.ok(source.includes('DOMParser'), 'DOMParser used for parsing');
  assert.ok(source.includes('createElementNS'), 'programmatic SVG construction');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.ok(!codeOnly.includes('innerHTML'), 'no innerHTML in executable code (comments may name the ban)');
  assert.ok(!/import\s+[^;]*\.svg/.test(source), 'no SVG imports (assets never bundled)');
});

test('activation works against nodes whose innerHTML setter throws', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, drain } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  triggerIn(slot).click();
  await sleep();
  drain();
  assert.equal(svgPathsIn(slot).length, 3, 'rendered without touching innerHTML');
});

// --- stale-state + memory ---------------------------------------------------------------

test('cross-kanji remount never leaks: stale fetch ignored, prior work aborted', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const nichi = deferredFetch();
  const { raf, caf, drain } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: nichi.fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  triggerIn(slot).click();
  await sleep();
  assert.equal(nichi.calls.length, 1, '日 fetch in flight');
  // Navigate to another kanji reusing the same slot node.
  slot.setAttribute('data-kanji-stroke-slot', '学');
  const gaku = deferredFetch();
  mountStrokeOrder(slot, {
    character: '学', doc, fetchFn: gaku.fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  assert.equal(nichi.calls[0].signal?.aborted, true, 'stale fetch aborted');
  nichi.pending[0].resolve({ ok: true, status: 200, text: () => Promise.resolve(syntheticSvg) });
  await sleep();
  await sleep();
  assert.equal(viewIn(slot), null, 'stale 日 response ignored');
  assert.equal(triggerIn(slot).textContent, 'Stroke order', 'slot idle for 学, no leak');
  triggerIn(slot).click();
  await sleep();
  assert.ok(gaku.calls[0].url.endsWith('stroke/kanji/05b66.svg'), '学 fetch uses the 学 asset');
  gaku.pending[0].resolve({ ok: true, status: 200, text: () => Promise.resolve(syntheticSvg) });
  await sleep();
  drain();
  const svg = slot.querySelector('svg');
  assert.ok((svg.getAttribute('aria-label') || '').includes('学'), 'only the current kanji renders');
});

test('cleanup aborts loading and repeated cycles do not accumulate listeners', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const pending = deferredFetch();
  const { raf, caf } = makeRaf();
  const cleanup = mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: pending.fn, raf, caf,
    parseFn: miniParseSvg, prefersReducedMotion: () => false
  });
  triggerIn(slot).click();
  await sleep();
  cleanup();
  assert.equal(pending.calls[0].signal?.aborted, true, 'cleanup aborts the in-flight fetch');
  assert.equal(triggerIn(slot).listenerCount('click'), 0, 'trigger listener removed');
  pending.pending[0].resolve({ ok: true, status: 200, text: () => Promise.resolve(syntheticSvg) });
  await sleep();
  await sleep();
  assert.equal(viewIn(slot), null, 'late response after cleanup ignored');

  // Repeated open cycles on a fresh mount: one click → exactly one fetch.
  const slot2 = makeSlot(doc, '日');
  const { fn, calls } = fetchOf(syntheticSvg);
  const clock = makeRaf();
  mountStrokeOrder(slot2, {
    character: '日', doc, fetchFn: fn, raf: clock.raf, caf: clock.caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  mountStrokeOrder(slot2, {
    character: '日', doc, fetchFn: fn, raf: clock.raf, caf: clock.caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  triggerIn(slot2).click();
  await sleep();
  assert.equal(calls.length, 1, 'remount disposed the stale trigger (single activation)');
});

// --- shared mounting across both surfaces -------------------------------------------------

test('mountStrokeSlots mounts Jōyō slots only, lazily', async () => {
  const doc = new FakeDoc();
  const rootNode = doc.createElement('div');
  rootNode.appendChild(makePanel(doc, '日'));
  rootNode.appendChild(makePanel(doc, '屁'));
  const { fn, calls } = fetchOf(syntheticSvg);
  const { raf } = makeRaf();
  const cleanups = mountStrokeSlots(rootNode, { doc, fetchFn: fn, raf, parseFn: miniParseSvg });
  assert.equal(cleanups.length, 2, 'one cleanup per slot');
  const slots = rootNode.querySelectorAll('[data-kanji-stroke-slot]');
  assert.equal(buttonsIn(slots[0]).length, 1, '日 slot gets the control');
  assert.equal(buttonsIn(slots[1]).length, 0, '屁 slot stays empty');
  await sleep();
  assert.equal(calls.length, 0, 'mounting never prefetches');
});

test('both surfaces share the lazy stroke module; builder stays presentational', () => {
  const entity = readSource('src/pages/entityPage.js');
  const reference = readSource('src/pages/kanjiReference.js');
  const builder = readSource('src/kanjiDetail.js');
  const main = readSource('src/main.js');
  assert.ok(entity.includes("../strokeOrder.js") && entity.includes('mountStrokeSlots'), 'owned dialog mounts via the shared module');
  assert.ok(reference.includes("../strokeOrder.js") && reference.includes('mountStrokeSlots'), 'reference page mounts via the shared module');
  assert.ok(entity.includes("import('../strokeOrder.js')"), 'owned surface lazy-loads (chunk split, fail-open)');
  assert.ok(reference.includes("import('../strokeOrder.js')"), 'reference surface lazy-loads (chunk split, fail-open)');
  assert.ok(!builder.includes('strokeOrder') && !builder.includes('strokeJoyo'), 'builder stays presentational (B.1 contract)');
  assert.ok(!main.includes('strokeOrder') && !main.includes('strokeJoyo'), 'main chunk untouched by stroke code');
});

test('strokeJoyo is imported ONLY by the stroke module (tiny table never leaks into main paths)', () => {
  const candidates = [
    'src/main.js',
    'src/kanjiDetail.js',
    'src/pages/entityPage.js',
    'src/pages/kanjiReference.js',
    'src/ui.js'
  ];
  for (const path of candidates) {
    assert.ok(!readSource(path).includes('strokeJoyo'), `${path} must not import the eligibility table`);
  }
  assert.ok(readSource('src/strokeOrder.js').includes("from './strokeJoyo.js'"), 'only the stroke module imports it');
});

// --- pacing + restraint ----------------------------------------------------------------------

test('pacing is calm with no autoplay, quizzes, or speed controls', () => {
  assert.ok(STROKE_DRAW_MS >= 300 && STROKE_DRAW_MS <= 500, `~${STROKE_DRAW_MS}ms per stroke`);
  assert.ok(STROKE_PAUSE_MS > 0 && STROKE_PAUSE_MS <= 200, `small ${STROKE_PAUSE_MS}ms pause`);
  const source = readSource('src/strokeOrder.js');
  assert.ok(!/autoplay/i.test(source), 'no autoplay');
  assert.ok(!/quiz|game|score/i.test(source), 'no quizzes or games');
  assert.ok(!/speed/i.test(source), 'no speed controls');
});
