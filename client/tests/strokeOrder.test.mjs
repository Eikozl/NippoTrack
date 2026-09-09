// v5.1-B.2 KanjiVG-supported stroke-order autoplay — contract tests.
// Covers: eligibility, file naming/URLs, fetch-on-mount autoplay (no
// trigger/Close in DOM, Escape does nothing), safe parsing (paths-only
// via DOMParser + createElementNS, never innerHTML), sequential draw →
// Replay hidden-until-done, ghost discipline (single rendering per phase),
// reduced-motion instant-final, no focus theft, failure fallback,
// cross-kanji no-leak and both-surface lazy-module wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STROKE_DRAW_MS,
  STROKE_PAUSE_MS,
  extractStrokePathsFromDocument,
  loadStrokePaths,
  mountStrokeOrder,
  mountStrokeSlots,
  hasStrokeAsset,
  strokeAssetUrl,
  strokeFileName,
  strokeAssetCodePoints
} from '../src/strokeOrder.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const readAsset = (file) => readFileSync(join(root, 'public', 'stroke', 'kanji', file), 'utf8');
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async () => { await sleep(); await sleep(); await sleep(); };

test('KanjiVG availability follows the local canonical asset index, not Jōyō membership', () => {
  for (const character of ['学', '龍', '鬱', '𠮟']) {
    assert.equal(hasStrokeAsset(character), true, `${character} has a local KanjiVG asset`);
  }
  for (const character of ['龘', '', '日日', null, undefined]) {
    assert.equal(hasStrokeAsset(character), false, `${JSON.stringify(character)} has no local KanjiVG asset`);
  }
});

test('the generated index exactly matches each vendored canonical SVG', () => {
  const files = readdirSync(join(root, 'public', 'stroke', 'kanji'))
    .filter((file) => /^[0-9a-f]{5}\.svg$/.test(file))
    .sort();
  const indexed = [...strokeAssetCodePoints]
    .map((codePoint) => `${codePoint.toString(16).padStart(5, '0')}.svg`)
    .sort();
  assert.equal(files.length, 6702, 'full r20250816 canonical set is vendored');
  assert.deepEqual(indexed, files, 'index contains every asset exactly once');
});

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

function okResponse(text) {
  return { ok: true, status: 200, text: () => Promise.resolve(text) };
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
function replayIn(slot) { return slot.querySelector('button.stroke-replay'); }
function viewIn(slot) { return slot.querySelector('div.stroke-view'); }
function svgsIn(slot) { return slot.querySelectorAll('svg'); }
function loadingNoteIn(slot) { return slot.querySelector('p.stroke-note'); }
function svgPathsIn(slot) {
  const svg = slot.querySelector('svg');
  return svg ? svg.children.filter((child) => child.tagName === 'PATH') : [];
}
function glyphHidden(glyph) {
  return glyph.hidden === true || glyph.getAttribute('hidden') !== null;
}
function collectFocused(node, out = []) {
  if (node.focused) out.push(node);
  for (const child of node.children || []) collectFocused(child, out);
  return out;
}

// --- eligibility ------------------------------------------------------------

test('mount autoplays only for indexed local assets', async () => {
  const doc = new FakeDoc();
  for (const char of ['日', '学', '龍', '鬱', '龘']) {
    const slot = makeSlot(doc, char);
    const { fn, calls } = fetchOf(syntheticSvg);
    mountStrokeOrder(slot, { character: char, doc, fetchFn: fn, parseFn: miniParseSvg });
    await settle();
    assert.equal(calls.length, hasStrokeAsset(char) ? 1 : 0, `${char || '(empty)'} fetch matches availability`);
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

// --- mount: unavailable assets leave the slot empty ----------------------------

test('unsupported mount leaves the slot empty/static with zero network and zero trace', async () => {
  const doc = new FakeDoc();
  for (const char of ['龘', '日日', '']) {
    const panel = makePanel(doc, char);
    const slot = panel.querySelector('div');
    const glyph = panel.querySelector('span');
    const { fn, calls } = fetchOf(syntheticSvg);
    const cleanup = mountStrokeOrder(slot, { character: char, doc, fetchFn: fn });
    assert.equal(typeof cleanup, 'function', 'cleanup returned');
    await settle();
    assert.equal(calls.length, 0, 'no fetch for an unavailable asset');
    assert.equal(buttonsIn(slot).length, 0, 'no control rendered');
    assert.equal(svgsIn(slot).length, 0, 'no SVG rendered');
    assert.equal(slot.getAttribute('aria-hidden'), 'true', 'empty slot stays hidden');
    assert.equal(slot.children.length, 0, 'slot stays empty');
    assert.equal(glyphHidden(glyph), false, 'static glyph stands alone, never hidden');
    assert.equal(glyph.textContent, char, 'static glyph untouched');
  }
});

// --- mount: supported assets autoplay with no trigger/Close ---------------------

test('supported mount fetches on mount with a polite loading note and no trigger button', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '日');
  const slot = panel.querySelector('div');
  const glyph = panel.querySelector('span');
  const pending = deferredFetch();
  const { raf, queue } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: pending.fn, raf, parseFn: miniParseSvg,
    prefersReducedMotion: () => false
  });
  await sleep();
  assert.equal(pending.calls.length, 1, 'autoplay: fetch fired on mount, no gesture needed');
  assert.ok(pending.calls[0].url.endsWith('stroke/kanji/065e5.svg'), `fetched 日 asset (${pending.calls[0].url})`);
  assert.equal(slot.querySelector('button.stroke-trigger'), null, 'no trigger button rendered');
  assert.equal(buttonsIn(slot).length, 0, 'no buttons at all while loading');
  assert.equal(slot.getAttribute('data-stroke-state'), 'loading', 'loading state hook');
  assert.equal(slot.getAttribute('aria-hidden'), null, 'populated slot exposed to assistive tech');
  const note = loadingNoteIn(slot);
  assert.ok(note, 'loading note holds the slot');
  assert.equal(note.getAttribute('role'), 'status', 'loading note announced politely');
  assert.equal(queue.length, 0, 'no animation scheduled before the asset arrives');
  assert.equal(glyphHidden(glyph), false, 'static glyph stays visible while loading (no blank panel)');
  assert.equal(svgsIn(slot).length, 0, 'loading phase: glyph only, zero SVG');
});

test('newly included non-Jōyō assets autoplay and expose Replay after completion', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '龍');
  const slot = panel.querySelector('div');
  const { fn, calls } = fetchOf(syntheticSvg);
  const { raf, caf, drain } = makeRaf();
  mountStrokeOrder(slot, {
    character: '龍', doc, fetchFn: fn, parseFn: miniParseSvg, raf, caf,
    drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  await settle();
  assert.equal(calls.length, 1, '龍 fetches its one local asset');
  drain();
  assert.ok(replayIn(slot), 'Replay appears after the supported character settles');
  assert.equal(svgsIn(slot).length, 1, 'the completed SVG remains the sole glyph');
});

// --- autoplay: fetch → safe build → sequential draw → Replay ---------------------

test('autoplay builds SVG safely, draws sequentially, and ends in one clean rendering', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '日');
  const slot = panel.querySelector('div');
  const glyph = panel.querySelector('span');
  const { fn, calls } = fetchOf(syntheticSvg);
  const { raf, caf, tick, drain, queue } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 100, pauseMs: 20, prefersReducedMotion: () => false
  });
  await settle();
  assert.equal(calls.length, 1, 'exactly one fetch, fired on mount');
  assert.equal(slot.getAttribute('data-stroke-state'), 'playing', 'playing state hook');
  const paths = svgPathsIn(slot);
  assert.equal(svgsIn(slot).length, 1, 'single SVG rendering (no duplicate)');
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
  // Ghost fix: the static glyph hides the moment the SVG takes over.
  assert.equal(glyphHidden(glyph), true, 'static glyph hidden during the draw (no ghost)');
  // Sequential: after a partial advance the first stroke is done while the
  // last is still hidden.
  tick(50); tick(50); tick(50);
  const mid = svgPathsIn(slot).map((path) => path.style.strokeDashoffset);
  assert.equal(mid[0], '0', 'first stroke completes first');
  assert.equal(mid[2], '120', 'last stroke still hidden mid-animation');
  assert.ok(queue.length > 0, 'animation progresses via scheduled frames');
  // Replay stays hidden until the first completion.
  assert.equal(replayIn(slot)?.hidden, true, 'Replay hidden while playing');
  drain();
  assert.equal(slot.getAttribute('data-stroke-state'), 'done', 'done state hook');
  const done = svgPathsIn(slot).map((path) => path.style.strokeDashoffset);
  assert.deepEqual(done, ['0', '0', '0'], 'completed strokes stay visible');
  assert.equal(svgsIn(slot).length, 1, 'final phase: still exactly one SVG (no double-render)');
  assert.equal(glyphHidden(glyph), true, 'final phase: glyph stays hidden (SVG is the single final image)');
  const replay = replayIn(slot);
  assert.ok(replay, 'Replay appears on completion');
  assert.equal(replay.hidden, false, 'Replay revealed when done');
  assert.equal(replay.disabled, false, 'Replay enabled when done');
  assert.equal(replay.getAttribute('type'), 'button', 'Replay is a real button');
  assert.ok((replay.getAttribute('aria-label') || '').includes('日'), 'Replay label names the kanji');
});

// --- Replay ---------------------------------------------------------------------

test('Replay is hidden until done, then replays on demand', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '花');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, drain, queue } = makeRaf();
  mountStrokeOrder(slot, {
    character: '花', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 100, pauseMs: 20, prefersReducedMotion: () => false
  });
  await settle();
  drain();
  const replay = replayIn(slot);
  assert.ok(replay && replay.hidden === false, 'Replay visible after first completion');
  replay.click();
  assert.equal(replay.disabled, true, 'Replay disabled while replaying');
  assert.equal(replay.hidden, true, 'Replay hidden while replaying');
  assert.ok(queue.length > 0, 'replay schedules fresh frames');
  drain();
  assert.equal(replay.hidden, false, 'Replay revealed after the second run');
  assert.equal(replay.disabled, false, 'Replay re-enabled after the second run');
  assert.deepEqual(svgPathsIn(slot).map((p) => p.style.strokeDashoffset), ['0', '0', '0'], 'final state again');
  assert.equal(svgsIn(slot).length, 1, 'replay never duplicates the SVG');
});

// --- reduced motion ---------------------------------------------------------------

test('prefers-reduced-motion renders the final state instantly with no animation frames', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '鳥');
  const slot = panel.querySelector('div');
  const glyph = panel.querySelector('span');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, queue } = makeRaf();
  mountStrokeOrder(slot, {
    character: '鳥', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, prefersReducedMotion: () => true
  });
  await settle();
  assert.equal(queue.length, 0, 'zero animation frames scheduled');
  assert.equal(svgsIn(slot).length, 1, 'single SVG rendering, no ghost');
  assert.deepEqual(svgPathsIn(slot).map((p) => p.style.strokeDashoffset), ['0', '0', '0'], 'all strokes visible immediately');
  assert.equal(glyphHidden(glyph), true, 'glyph hidden: finished SVG is the single final image');
  const replay = replayIn(slot);
  assert.ok(replay && replay.hidden === false && replay.disabled === false, 'Replay available (instant final again)');
  replay.click();
  await settle();
  assert.equal(queue.length, 0, 'Replay never auto-draws under reduced motion');
  assert.deepEqual(svgPathsIn(slot).map((p) => p.style.strokeDashoffset), ['0', '0', '0'], 'Replay restores the instant final');
});

// --- no trigger / no Close / Escape does nothing -------------------------------------

test('no trigger or Close button exists at any phase; Escape does nothing', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, drain } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  await settle();
  for (const button of buttonsIn(slot)) {
    assert.ok(!['Stroke order', 'Close', 'Loading…'].includes(button.textContent), `no legacy control ("${button.textContent}")`);
  }
  drain();
  assert.ok(viewIn(slot), 'autoplay view present');
  assert.equal(slot.querySelector('button.stroke-trigger'), null, 'no trigger after completion');
  assert.equal(buttonsIn(slot).length, 1, 'exactly ONE button: Replay');
  slot.keydown('Escape');
  assert.ok(viewIn(slot), 'Escape leaves the persistent view intact');
  assert.equal(slot.getAttribute('data-stroke-state'), 'done', 'Escape changes no state');
  assert.ok(replayIn(slot) && replayIn(slot).hidden === false, 'Replay still available after Escape');
  assert.equal(svgsIn(slot).length, 1, 'Escape duplicates nothing');
});

// --- no focus theft -------------------------------------------------------------------

test('autoplay never moves focus; Replay stays keyboard-reachable with a sane label', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '学');
  const slot = panel.querySelector('div');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, drain } = makeRaf();
  mountStrokeOrder(slot, {
    character: '学', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  await settle();
  drain();
  assert.deepEqual(collectFocused(panel), [], 'mount + autoplay + completion focus nothing');
  const replay = replayIn(slot);
  assert.ok(replay, 'Replay rendered');
  assert.equal(replay.getAttribute('type'), 'button', 'Replay is a native button (Tab-reachable, no hover-only)');
  assert.ok((replay.getAttribute('aria-label') || '').includes('学'), 'Replay label understandable by screen readers');
});

// --- failure paths ---------------------------------------------------------------------

test('fetch failure degrades to a calm note; static glyph remains, nothing spins', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '鬱');
  const slot = panel.querySelector('div');
  const glyph = panel.querySelector('span');
  const failing = () => Promise.reject(new Error('offline'));
  const clock = makeRaf();
  mountStrokeOrder(slot, { character: '鬱', doc, fetchFn: failing, raf: clock.raf, parseFn: miniParseSvg });
  await settle();
  assert.equal(slot.getAttribute('data-stroke-state'), 'failed', 'failure state hook');
  assert.equal(buttonsIn(slot).length, 0, 'no stranded control');
  assert.equal(svgsIn(slot).length, 0, 'no SVG on failure');
  const note = loadingNoteIn(slot);
  assert.ok(note, 'calm note shown');
  assert.equal(note.getAttribute('role'), 'status', 'note announced politely');
  assert.equal(note.textContent, 'Stroke order unavailable', 'no technical jargon');
  assert.equal(glyph.textContent, '鬱', 'static glyph remains');
  assert.equal(glyphHidden(glyph), false, 'glyph restored (no ghost, no blank panel)');
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
    const panel = makePanel(doc, '日');
    const slot = panel.querySelector('div');
    const glyph = panel.querySelector('span');
    const { fn } = fetchOf(body);
    const { raf } = makeRaf();
    mountStrokeOrder(slot, { character: '日', doc, fetchFn: fn, raf, parseFn: miniParseSvg });
    await settle();
    assert.equal(slot.getAttribute('data-stroke-state'), 'failed', `${label} → failed`);
    assert.ok(loadingNoteIn(slot), `${label} → calm note`);
    assert.equal(glyphHidden(glyph), false, `${label} → glyph restored`);
  }
  // A throwing parser is also a calm failure, never a crash.
  const slot = makeSlot(doc, '日');
  const { fn } = fetchOf('<svg></svg>');
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: fn, raf: makeRaf().raf,
    parseFn: () => { throw new Error('boom'); }
  });
  await settle();
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

test('persistent autoplay exposes no trigger/Close/Escape affordance in code', () => {
  const source = readSource('src/strokeOrder.js');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.ok(!codeOnly.includes('stroke-trigger'), 'no trigger class in executable code');
  assert.ok(!codeOnly.includes('aria-expanded'), 'no expand/collapse affordance in executable code');
  assert.ok(!codeOnly.includes('Escape'), 'no Escape handling in executable code');
});

test('autoplay works against nodes whose innerHTML setter throws', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const { fn } = fetchOf(syntheticSvg);
  const { raf, caf, drain } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  await settle();
  drain();
  assert.equal(svgPathsIn(slot).length, 3, 'rendered without touching innerHTML');
});

// --- stale-state + memory ---------------------------------------------------------------

test('cross-kanji remount never leaks: stale fetch ignored, prior work aborted', async () => {
  const doc = new FakeDoc();
  const panel = makePanel(doc, '日');
  const slot = panel.querySelector('div');
  const nichi = deferredFetch();
  const { raf, caf, drain } = makeRaf();
  mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: nichi.fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  await sleep();
  assert.equal(nichi.calls.length, 1, '日 autoplay fetch in flight');
  // Navigate to another kanji reusing the same slot node.
  slot.setAttribute('data-kanji-stroke-slot', '学');
  const gaku = deferredFetch();
  mountStrokeOrder(slot, {
    character: '学', doc, fetchFn: gaku.fn, raf, caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  });
  await sleep();
  assert.equal(nichi.calls[0].signal?.aborted, true, 'stale fetch aborted');
  assert.equal(gaku.calls.length, 1, '学 autoplay fetch started on remount');
  nichi.pending[0].resolve(okResponse(syntheticSvg));
  await settle();
  assert.equal(viewIn(slot), null, 'stale 日 response ignored');
  assert.equal(slot.getAttribute('data-stroke-state'), 'loading', 'slot loading for 学, no leak');
  assert.ok(gaku.calls[0].url.endsWith('stroke/kanji/05b66.svg'), '学 fetch uses the 学 asset');
  gaku.pending[0].resolve(okResponse(syntheticSvg));
  await settle();
  drain();
  const svg = slot.querySelector('svg');
  assert.ok((svg.getAttribute('aria-label') || '').includes('学'), 'only the current kanji renders');
  assert.equal(svgsIn(slot).length, 1, 'single rendering after remount');
});

test('cleanup aborts loading and repeated mounts do not accumulate controls', async () => {
  const doc = new FakeDoc();
  const slot = makeSlot(doc, '日');
  const pending = deferredFetch();
  const { raf, caf } = makeRaf();
  const cleanup = mountStrokeOrder(slot, {
    character: '日', doc, fetchFn: pending.fn, raf, caf,
    parseFn: miniParseSvg, prefersReducedMotion: () => false
  });
  await sleep();
  cleanup();
  assert.equal(pending.calls[0].signal?.aborted, true, 'cleanup aborts the in-flight fetch');
  pending.pending[0].resolve(okResponse(syntheticSvg));
  await settle();
  assert.equal(viewIn(slot), null, 'late response after cleanup ignored');

  // Repeated mounts on the same node: the stale autoplay is disposed, the
  // fresh one renders exactly one view with one Replay.
  const slot2 = makeSlot(doc, '日');
  const first = deferredFetch();
  const second = deferredFetch();
  const clock = makeRaf();
  const mountOptions = {
    character: '日', doc, raf: clock.raf, caf: clock.caf,
    parseFn: miniParseSvg, drawMs: 60, pauseMs: 10, prefersReducedMotion: () => false
  };
  mountStrokeOrder(slot2, { ...mountOptions, fetchFn: first.fn });
  mountStrokeOrder(slot2, { ...mountOptions, fetchFn: second.fn });
  await sleep();
  assert.equal(first.calls.length, 1, 'stale autoplay still fired its (aborted) fetch');
  assert.equal(first.calls[0].signal?.aborted, true, 'remount disposed the stale autoplay');
  assert.equal(second.calls.length, 1, 'fresh autoplay fetched once');
  first.pending[0].resolve(okResponse(syntheticSvg));
  await settle();
  assert.equal(viewIn(slot2), null, 'stale first response ignored');
  second.pending[0].resolve(okResponse(syntheticSvg));
  await settle();
  clock.drain();
  assert.equal(slot2.querySelectorAll('div.stroke-view').length, 1, 'exactly one view');
  assert.equal(buttonsIn(slot2).length, 1, 'exactly one Replay (no listener/control accumulation)');
  assert.equal(replayIn(slot2).listenerCount('click'), 1, 'single Replay listener');
});

// --- shared mounting across both surfaces -------------------------------------------------

test('mountStrokeSlots autoplays KanjiVG-supported slots only', async () => {
  const doc = new FakeDoc();
  const rootNode = doc.createElement('div');
  rootNode.appendChild(makePanel(doc, '日'));
  rootNode.appendChild(makePanel(doc, '龘'));
  const { fn, calls } = fetchOf(syntheticSvg);
  const { raf, caf, drain } = makeRaf();
  const cleanups = mountStrokeSlots(rootNode, { doc, fetchFn: fn, raf, caf, parseFn: miniParseSvg });
  assert.equal(cleanups.length, 2, 'one cleanup per slot');
  await settle();
  assert.equal(calls.length, 1, 'autoplay fetch for the supported slot only');
  assert.ok(calls[0].url.endsWith('stroke/kanji/065e5.svg'), 'fetched 日 asset');
  drain();
  const slots = rootNode.querySelectorAll('[data-kanji-stroke-slot]');
  assert.ok(replayIn(slots[0]), '日 slot completes to Replay');
  assert.equal(buttonsIn(slots[1]).length, 0, '龘 slot stays empty');
  assert.equal(svgsIn(slots[1]).length, 0, '龘 slot renders nothing');
});

test('both surfaces share the autoplay stroke module; builder stays presentational', () => {
  const entity = readSource('src/pages/entityPage.js');
  const reference = readSource('src/pages/kanjiReference.js');
  const builder = readSource('src/kanjiDetail.js');
  const main = readSource('src/main.js');
  assert.ok(entity.includes("../strokeOrder.js") && entity.includes('mountStrokeSlots'), 'owned dialog mounts via the shared module');
  assert.ok(reference.includes("../strokeOrder.js") && reference.includes('mountStrokeSlots'), 'reference page mounts via the shared module');
  assert.ok(entity.includes("import('../strokeOrder.js')"), 'owned surface lazy-loads (chunk split, fail-open)');
  assert.ok(reference.includes("import('../strokeOrder.js')"), 'reference surface lazy-loads (chunk split, fail-open)');
  assert.ok(!builder.includes('strokeOrder'), 'builder stays presentational (B.1 contract)');
  assert.ok(!main.includes('strokeOrder'), 'main chunk untouched by stroke code');
});

test('stroke availability index stays inside the lazy stroke module', () => {
  const candidates = [
    'src/main.js',
    'src/kanjiDetail.js',
    'src/pages/entityPage.js',
    'src/pages/kanjiReference.js',
    'src/ui.js'
  ];
  for (const path of candidates) {
    assert.ok(!readSource(path).includes('strokeAssetIndex'), `${path} must not import the asset index`);
  }
  assert.ok(readSource('src/strokeOrder.js').includes("from './strokeAssetIndex.js'"), 'only the lazy stroke module imports the index');
});

// --- pacing + restraint ----------------------------------------------------------------------

test('pacing is calm with autoplay-by-design and no quizzes or speed controls', () => {
  assert.ok(STROKE_DRAW_MS >= 300 && STROKE_DRAW_MS <= 500, `~${STROKE_DRAW_MS}ms per stroke`);
  assert.ok(STROKE_PAUSE_MS > 0 && STROKE_PAUSE_MS <= 200, `small ${STROKE_PAUSE_MS}ms pause`);
  const source = readSource('src/strokeOrder.js');
  assert.ok(/autoplay/i.test(source), 'autoplay-on-mount is the documented design');
  assert.ok(!/quiz|game|score/i.test(source), 'no quizzes or games');
  assert.ok(!/speed/i.test(source), 'no speed controls');
});
