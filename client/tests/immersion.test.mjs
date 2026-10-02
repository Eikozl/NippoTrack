// V5.3a Immersion page — interaction tests over the real
// src/pages/immersion.js source via source-transform (same loader pattern
// as reviewHub.test.mjs / vocabularyAutofill.test.mjs): the '../api' and
// '../ui' imports are stripped and re-injected, so no Vite import.meta or
// network ever runs under node:test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(join(root, 'src/pages/immersion.js'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- Fake DOM
class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc || null;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this._classes = new Set();
    this._listeners = new Map();
    this.focused = false;
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.name = '';
  }
  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...names) => names.forEach((n) => self._classes.add(n)),
      remove: (...names) => names.forEach((n) => self._classes.delete(n)),
      contains: (n) => self._classes.has(n)
    };
  }
  get firstElementChild() { return this.children[0] || null; }
  setAttribute(name, value) {
    const k = String(name);
    const v = String(value);
    this.attributes.set(k, v);
    if (k === 'disabled') this.disabled = true;
    if (k === 'checked') this.checked = true;
    if (k === 'value') this.value = v;
    if (k === 'type') this.type = v;
    if (k === 'name') this.name = v;
  }
  getAttribute(name) { const k = String(name); return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(name) { return this.attributes.has(String(name)); }
  removeAttribute(name) {
    const k = String(name);
    this.attributes.delete(k);
    if (k === 'disabled') this.disabled = false;
    if (k === 'checked') this.checked = false;
  }
  appendChild(child) {
    if (!child) return child;
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    if (!this.children.includes(child)) this.children.push(child);
    return child;
  }
  append(...nodes) { for (const n of nodes) if (n) this.appendChild(n); return this; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  removeChild(child) { this.children = this.children.filter((n) => n !== child); if (child) child.parentNode = null; return child; }
  replaceChildren(...nodes) {
    for (const c of [...this.children]) this.removeChild(c);
    const flat = nodes.length === 1 && Array.isArray(nodes[0]) ? nodes[0] : nodes;
    for (const n of flat) if (n) this.appendChild(n);
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((fn) => fn !== handler));
  }
  dispatchEvent(event) {
    const e = event || {};
    if (!e.target) e.target = this;
    if (typeof e.preventDefault !== 'function') e.preventDefault = () => {};
    for (const fn of [...(this._listeners.get(e.type) || [])]) fn(e);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); }
  focus() { this.focused = true; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  matches(selector) {
    let text = String(selector).trim();
    if (!text) return false;
    const attrConds = [];
    const attrRe = /\[([\w-]+)(?:="([^"]*)")?\]/g;
    let m;
    while ((m = attrRe.exec(text)) !== null) attrConds.push({ name: m[1], value: m[2] });
    const withoutAttrs = text.replace(attrRe, '').trim();
    let tag = null;
    if (withoutAttrs && withoutAttrs !== '*') {
      const tagMatch = withoutAttrs.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
      if (tagMatch) tag = tagMatch[1].toUpperCase();
    }
    if (tag && this.tagName !== tag) return false;
    for (const cond of attrConds) {
      let candidate = this.getAttribute(cond.name);
      if (candidate == null) {
        if (cond.name === 'value' && this.value !== undefined) candidate = String(this.value);
        else if (cond.name === 'type' && this.type) candidate = String(this.type);
        else if (cond.name === 'name' && this.name) candidate = String(this.name);
      }
      if (cond.value !== undefined) {
        if (candidate !== cond.value) return false;
      } else if (candidate == null) {
        return false;
      }
    }
    return true;
  }
  querySelector(selector) {
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (node.matches(selector)) return node;
      queue.push(...node.children);
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (node.matches(selector)) found.push(node);
      queue.push(...node.children);
    }
    return found;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super('#document', null);
    this.activeElement = null;
    this.body = this.appendChild(new FakeNode('body', this));
  }
  createElement(tag) { return new FakeNode(tag, this); }
}

const textOf = (node) => {
  if (!node) return '';
  const parts = [node.textContent || ''];
  for (const c of node.children || []) parts.push(textOf(c));
  return parts.join(' ');
};

function makeUi(doc, toasts) {
  const element = (tagName, { className, text, attrs, dataset } = {}, children = []) => {
    const node = doc.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null) continue;
      node.setAttribute(k, String(v));
    }
    for (const [k, v] of Object.entries(dataset || {})) node.dataset[k] = String(v);
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) if (c) node.appendChild(c);
    return node;
  };
  const pageHeader = ({ eyebrow, title, description } = {}) => {
    const wrap = doc.createElement('header');
    if (eyebrow) { const e = doc.createElement('p'); e.textContent = String(eyebrow); wrap.appendChild(e); }
    if (title) { const h = doc.createElement('h1'); h.textContent = String(title); wrap.appendChild(h); }
    if (description) { const d = doc.createElement('p'); d.textContent = String(description); wrap.appendChild(d); }
    return wrap;
  };
  const showToast = (message, type = 'success') => { toasts.push({ message: String(message), type }); };
  const withPendingAction = async (button, action, _opts = {}) => {
    if (!button) return action({ setProgress() {} });
    if (button.disabled) return undefined;
    button.disabled = true;
    try {
      return await action({ setProgress() {} });
    } finally {
      button.disabled = false;
    }
  };
  return { element, pageHeader, showToast, withPendingAction };
}

function loadImmersionModule({ analyzePayload, analyzeReject, createPayload, createReject, historyPayload, historyReject, hash = '#immersion' } = {}) {
  const doc = new FakeDocument();
  const toasts = [];
  const apiCalls = [];
  const ui = makeUi(doc, toasts);
  const analyzeImmersionText = async (text) => {
    apiCalls.push({ fn: 'analyze', text });
    if (analyzeReject) throw analyzeReject;
    return typeof analyzePayload === 'function' ? analyzePayload(text) : analyzePayload;
  };
  const createImmersionSession = async (payload) => {
    apiCalls.push({ fn: 'create', payload });
    if (createReject) throw createReject;
    return createPayload;
  };
  const listImmersionHistory = async (params) => {
    apiCalls.push({ fn: 'history', params });
    if (historyReject) throw historyReject;
    return historyPayload ?? { items: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } };
  };
  let code = pageSource
    .replace(/import\s*\{[^}]+\}\s*from\s*['"]\.\.\/api['"];?/, '')
    .replace(/import\s*\{[^}]+\}\s*from\s*['"]\.\.\/ui['"];?/, '')
    .replace(/export\s+async\s+function\s+renderImmersion/, 'async function renderImmersion');
  code += '\nreturn { renderImmersion };';
  const factory = new Function(
    'analyzeImmersionText', 'createImmersionSession', 'listImmersionHistory',
    'element', 'pageHeader', 'showToast', 'withPendingAction', 'window',
    code
  );
  const fakeWindow = { location: { hash }, addEventListener() {}, removeEventListener() {} };
  const { renderImmersion } = factory(
    analyzeImmersionText, createImmersionSession, listImmersionHistory,
    ui.element, ui.pageHeader, ui.showToast, ui.withPendingAction, fakeWindow
  );
  return { doc, toasts, apiCalls, renderImmersion, fakeWindow };
}

// ---------------------------------------------------------------- fixtures
function analyzeFixture() {
  return {
    candidates: {
      vocabulary: [
        { id: 'vocab::学校', display: '学校', reading: 'がっこう', meaning: 'school', jlpt: 'N5', known: true },
        { id: 'vocab::図書館', display: '図書館', reading: 'としょかん', meaning: 'library', jlpt: 'N5', known: false }
      ],
      kanji: [{ id: 'kanji::学', display: '学', reading: 'ガク', meaning: 'study', jlpt: 'N5', known: false }],
      grammar: []
    },
    estimatedLevel: { level: 'N4', confidence: 0.72, stats: {} },
    stats: {}
  };
}

function historyFixture() {
  return {
    items: [
      { id: 1, estimatedLevel: 'N4', confidence: 0.72, createdAt: '2026-10-01T10:00:00.000Z', items: { total: 3, vocabulary: 2, kanji: 1, grammar: 0 } }
    ],
    pagination: { page: 1, limit: 10, total: 1, totalPages: 1 }
  };
}

// ---------------------------------------------------------------- helpers
function findButtonsByText(rootNode, text) {
  const found = [];
  const queue = [rootNode];
  while (queue.length) {
    const n = queue.shift();
    if (n.tagName === 'BUTTON' && textOf(n).includes(text)) found.push(n);
    queue.push(...(n.children || []));
  }
  return found;
}

async function mountAndAnalyze(harness, text = '学校に行く。') {
  const container = harness.doc.createElement('main');
  await harness.renderImmersion(container);
  await sleep(5);
  const textarea = container.querySelector('textarea');
  textarea.value = text;
  findButtonsByText(container, 'Analyze')[0].click();
  await sleep(5);
  return container;
}

// ---------------------------------------------------------------- tests
test('results render the three groups with jlpt and known tags', async () => {
  const harness = loadImmersionModule({ analyzePayload: analyzeFixture() });
  const container = await mountAndAnalyze(harness);
  const text = textOf(container);
  assert.match(text, /VOCABULARY · 2/);
  assert.match(text, /KANJI · 1/);
  assert.match(text, /GRAMMAR · 0/);
  assert.match(text, /学校/);
  assert.match(text, /がっこう/);
  assert.match(text, /In your collection/, 'known candidate carries the collection tag');
  assert.match(text, /No grammar found in this text/, 'empty group shows a compact note');
});

test('Select all / Clear act per group', async () => {
  const harness = loadImmersionModule({ analyzePayload: analyzeFixture() });
  const container = await mountAndAnalyze(harness);
  const vocabSection = container.querySelector('section[aria-label="Vocabulary"]');
  const selectAll = findButtonsByText(vocabSection, 'Select all')[0];
  selectAll.click();
  let boxes = vocabSection.querySelectorAll('input[type="checkbox"]');
  assert.ok(boxes.length === 2 && boxes.every((b) => b.checked), 'select all checks the group');
  const create = findButtonsByText(container, 'Create study session')[0];
  assert.equal(create.disabled, false, 'create enabled after selection');
  findButtonsByText(vocabSection, 'Clear')[0].click();
  boxes = vocabSection.querySelectorAll('input[type="checkbox"]');
  assert.ok(boxes.every((b) => !b.checked), 'clear unchecks the group');
  assert.equal(create.disabled, true, 'create disabled again after clear');
});

test('create is disabled until a selection, then navigates to reviewSessionUrl', async () => {
  const harness = loadImmersionModule({
    analyzePayload: analyzeFixture(),
    createPayload: { sessionId: 5, reviewSessionId: 77, createdCounts: { vocabulary: 1, kanji: 0, grammar: 0, reviewItems: 1 }, reviewSessionUrl: '/review?reviewSessionId=77' }
  });
  const container = await mountAndAnalyze(harness);
  const create = findButtonsByText(container, 'Create study session')[0];
  assert.equal(create.disabled, true, 'disabled with nothing selected');
  const firstBox = container.querySelector('section[aria-label="Vocabulary"]').querySelector('input[type="checkbox"]');
  firstBox.checked = true;
  firstBox.dispatchEvent({ type: 'change', target: firstBox });
  await sleep(2);
  assert.equal(create.disabled, false, 'enabled with a selection');
  create.click();
  await sleep(5);
  const createCalls = harness.apiCalls.filter((c) => c.fn === 'create');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].payload.text, '学校に行く。');
  assert.deepEqual(createCalls[0].payload.selectedItems.vocabularyIds, ['vocab::学校']);
  assert.equal(harness.fakeWindow.location.hash, '#review?reviewSessionId=77', 'navigation follows the returned URL');
});

test('analyze errors surface a toast and the button recovers', async () => {
  const harness = loadImmersionModule({ analyzeReject: new Error('analysis down') });
  const container = await mountAndAnalyze(harness);
  const analyze = findButtonsByText(container, 'Analyze')[0];
  assert.equal(analyze.disabled, false, 'button re-enabled after the error');
  assert.equal(harness.toasts.length, 1);
  assert.equal(harness.toasts[0].type, 'error');
  assert.match(harness.toasts[0].message, /analysis down/);
});

test('level badge renders the estimate only when a level is present', async () => {
  const withLevel = loadImmersionModule({ analyzePayload: analyzeFixture() });
  const containerA = await mountAndAnalyze(withLevel);
  assert.match(textOf(containerA), /Estimated level: N4 · 72%/);

  const withoutLevel = loadImmersionModule({
    analyzePayload: { ...analyzeFixture(), estimatedLevel: { level: null, confidence: 0, stats: {} } }
  });
  const containerB = await mountAndAnalyze(withoutLevel);
  assert.match(textOf(containerB), /Could not estimate a level/);
  assert.doesNotMatch(textOf(containerB), /Estimated level:/);
});

test('history rows render from the paginated payload', async () => {
  const harness = loadImmersionModule({ analyzePayload: analyzeFixture(), historyPayload: historyFixture() });
  const container = harness.doc.createElement('main');
  await harness.renderImmersion(container);
  await sleep(5);
  const text = textOf(container);
  assert.match(text, /Immersion history/);
  assert.match(text, /2026-10-01/);
  assert.match(text, /Estimated level: N4 · 72%/);
  assert.match(text, /3 items · 2 vocabulary · 1 kanji · 0 grammar/);
  const historyCall = harness.apiCalls.find((c) => c.fn === 'history');
  assert.equal(historyCall.params.limit, 10);
});

test('history fails open and a returnUrl shows the back link', async () => {
  const harness = loadImmersionModule({ historyReject: new Error('history down'), hash: '#immersion?returnUrl=/review' });
  const container = harness.doc.createElement('main');
  await harness.renderImmersion(container);
  await sleep(5);
  assert.match(textOf(container), /Back to Review/);
  assert.doesNotMatch(textOf(container), /Immersion history/, 'history stays hidden on failure');
});
