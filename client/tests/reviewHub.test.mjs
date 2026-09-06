// Review Hub (R-B) — INTRO→SETUP→CANDIDATES→REVIEWING→COMPLETE.
// Interaction tests use a FakeNode DOM double (levelEstimateControl pattern)
// with stubbed apiRequest/ui, driving the real src/pages/review.js source
// via source-transform (no Vite import.meta required). Static assertions
// cover copy/a11y/reduced-motion like productCopy/cleanupInteraction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const reviewSource = readSource('src/pages/review.js');
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
    this._rect = null;
  }
  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...names) => names.forEach((n) => self._classes.add(n)),
      remove: (...names) => names.forEach((n) => self._classes.delete(n)),
      contains: (n) => self._classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !self._classes.has(n) : Boolean(force);
        if (on) self._classes.add(n); else self._classes.delete(n);
        return on;
      }
    };
  }
  get childNodes() { return this.children; }
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
  append(...nodes) {
    for (const n of nodes) if (n) this.appendChild(n);
    return this;
  }
  prepend(child) {
    if (!child) return child;
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children = [child, ...this.children.filter((n) => n !== child)];
    return child;
  }
  removeChild(child) { this.children = this.children.filter((n) => n !== child); if (child) child.parentNode = null; return child; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes) {
    for (const c of [...this.children]) this.removeChild(c);
    // Flatten single array arg? review.js passes single node or none; handle both.
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
  focus() {
    this.focused = true;
    const doc = this.ownerDocument || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    if (doc && typeof doc === 'object') doc.activeElement = this;
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  matches(selector) {
    let text = String(selector).trim();
    if (!text) return false;
    let needChecked = false;
    if (text.endsWith(':checked')) {
      needChecked = true;
      text = text.slice(0, -':checked'.length);
    }
    // Extract attribute conditions [name="value"].
    const attrConds = [];
    const attrRe = /\[([\w-]+)(?:="([^"]*)")?\]/g;
    let m;
    while ((m = attrRe.exec(text)) !== null) {
      attrConds.push({ name: m[1], value: m[2] });
    }
    const withoutAttrs = text.replace(attrRe, '').trim();
    // Tag / class / id prefix.
    let tag = null;
    let cls = null;
    let id = null;
    if (withoutAttrs) {
      if (withoutAttrs.startsWith('.')) {
        cls = withoutAttrs.slice(1).split(/[:\s.[]/)[0];
      } else if (withoutAttrs.startsWith('#')) {
        id = withoutAttrs.slice(1).split(/[:\s.[]/)[0];
      } else if (withoutAttrs !== '*') {
        const tagMatch = withoutAttrs.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
        if (tagMatch) tag = tagMatch[1].toUpperCase();
        const classMatch = withoutAttrs.match(/\.([\w-]+)/);
        if (classMatch) cls = classMatch[1];
      }
    }
    if (tag && this.tagName !== tag) return false;
    if (cls && !this._classes.has(cls)) return false;
    if (id && this.getAttribute('id') !== id) return false;
    for (const cond of attrConds) {
      const actual = this.getAttribute(cond.name);
      // Fall back to properties for value/type/name when attribute missing
      // (e.g. value set via property only).
      let candidate = actual;
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
    if (needChecked && !this.checked) return false;
    return true;
  }
  closest(selector) {
    let n = this;
    while (n) { if (typeof n.matches === 'function' && n.matches(selector)) return n; n = n.parentNode; }
    return null;
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
  // document-level listeners (keydown for shortcuts)
  dispatchEvent(event) {
    const e = event || {};
    if (!e.target) e.target = this;
    if (typeof e.preventDefault !== 'function') e.preventDefault = () => {};
    for (const fn of [...(this._listeners.get(e.type) || [])]) fn(e);
    return true;
  }
}

const textOf = (node) => {
  if (!node) return '';
  const parts = [node.textContent || ''];
  for (const c of node.children || []) parts.push(textOf(c));
  return parts.join(' ');
};

function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') params.set(k, String(v).trim());
  });
  const q = params.toString();
  return q ? `?${q}` : '';
}

function makeUi(doc, toasts) {
  const element = (tagName, { className, text, attrs, dataset } = {}, children = []) => {
    const node = doc.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null) continue;
      node.setAttribute(k, String(v));
    }
    // Sync value/checked/disabled properties from attrs for inputs/buttons.
    if (node.getAttribute('value') != null && (node.value === '' || node.value == null)) {
      node.value = node.getAttribute('value');
    }
    // Preserve explicit value attr even when element() sets text? No-op.
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
  const loadingState = (label = 'Loading…') => {
    const d = doc.createElement('div'); d.textContent = String(label); return d;
  };
  const emptyState = ({ title = 'Nothing here yet', description = '' } = {}) => {
    const d = doc.createElement('div');
    const t = doc.createElement('p'); t.textContent = String(title); d.appendChild(t);
    if (description) { const p = doc.createElement('p'); p.textContent = String(description); d.appendChild(p); }
    return d;
  };
  const errorState = (error, retry) => {
    const d = doc.createElement('div');
    const p = doc.createElement('p'); p.textContent = String(error?.message || 'Error'); d.appendChild(p);
    if (typeof retry === 'function') {
      const b = doc.createElement('button'); b.textContent = 'Try again';
      b.addEventListener('click', () => retry());
      d.appendChild(b);
    }
    return d;
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
  return { element, pageHeader, loadingState, emptyState, errorState, showToast, withPendingAction };
}

function loadReviewModule({ candidatesPayload, sessionId = 99, gradeImpl, completePayload, gradeReject } = {}) {
  const doc = new FakeDocument();
  const toasts = [];
  const apiCalls = [];
  const ui = makeUi(doc, toasts);
  const apiRequest = async (url, opts = {}) => {
    apiCalls.push({ url, options: opts });
    if (url.startsWith('/api/review/candidates')) {
      if (typeof candidatesPayload === 'function') return candidatesPayload(url);
      return candidatesPayload ?? { groups: {} };
    }
    if (url === '/api/review/sessions' && (opts.method || 'GET') === 'POST') {
      return { id: sessionId };
    }
    if (url === '/api/review/grade' && (opts.method || 'GET') === 'POST') {
      if (gradeReject) throw gradeReject;
      if (typeof gradeImpl === 'function') return gradeImpl(url, opts);
      return { success: true };
    }
    const completeMatch = url.match(/^\/api\/review\/sessions\/(\d+)\/complete$/);
    if (completeMatch && (opts.method || 'GET') === 'POST') {
      if (typeof completePayload === 'function') return completePayload(url);
      return completePayload ?? { total: 0, byType: {}, byResult: {} };
    }
    throw new Error(`unexpected apiRequest ${url}`);
  };
  let code = reviewSource
    .replace(/import\s*\{[^}]+\}\s*from\s*['"]\.\.\/api['"];?/, '')
    .replace(/import\s*\{[^}]+\}\s*from\s*['"]\.\.\/ui['"];?/, '')
    .replace(/export\s+async\s+function\s+renderReview/, 'async function renderReview');
  code += '\nreturn { renderReview };';
  const factory = new Function(
    'apiRequest', 'queryString', 'element', 'emptyState', 'errorState', 'loadingState', 'pageHeader', 'showToast', 'withPendingAction', 'document', 'window',
    code
  );
  const fakeWindow = {
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id)
  };
  const { renderReview } = factory(
    apiRequest, queryString, ui.element, ui.emptyState, ui.errorState, ui.loadingState, ui.pageHeader, ui.showToast, ui.withPendingAction, doc, fakeWindow
  );
  return { doc, toasts, apiCalls, renderReview, ui };
}

// ---------------------------------------------------------------- fixtures
function candidateItem({ entityType, entityId, display, reading = null, meaning = 'meaning', jlpt = 'N5', strength = 'strong' }) {
  return { entityType, entityId, display, reading, meaning, jlpt, evidenceStrength: strength, sources: [{ label: 'Study session', context: 'Reading' }] };
}

function defaultCandidates() {
  return {
    groups: {
      kanji: { items: [candidateItem({ entityType: 'kanji', entityId: 1, display: '日', reading: 'ニチ', meaning: 'day' })], total: 1, truncated: false },
      vocabulary: { items: [candidateItem({ entityType: 'vocabulary', entityId: 2, display: '水', reading: 'みず', meaning: 'water' })], total: 1, truncated: false },
      grammar: { items: [candidateItem({ entityType: 'grammar', entityId: 3, display: '〜ても', reading: null, meaning: 'even if' })], total: 1, truncated: false }
    }
  };
}

function mixedStrengthCandidates() {
  return {
    groups: {
      kanji: {
        items: [
          candidateItem({ entityType: 'kanji', entityId: 11, display: '学', reading: 'ガク', meaning: 'study', strength: 'strong' }),
          candidateItem({ entityType: 'kanji', entityId: 12, display: '校', reading: 'コウ', meaning: 'school', strength: 'weak' })
        ],
        total: 2, truncated: false
      },
      vocabulary: { items: [candidateItem({ entityType: 'vocabulary', entityId: 21, display: '学校', reading: 'がっこう', meaning: 'school' })], total: 1, truncated: false },
      grammar: { items: [], total: 0, truncated: false }
    }
  };
}

// Helpers to drive the hub.
function findButtonsByText(root, text) {
  const found = [];
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    if (n.tagName === 'BUTTON' && textOf(n).includes(text)) found.push(n);
    queue.push(...(n.children || []));
  }
  return found;
}
function findFirstButtonByText(root, text) {
  return findButtonsByText(root, text)[0] || null;
}
function isVisible(node) {
  let n = node;
  while (n) { if (n.hidden) return false; n = n.parentNode; }
  return true;
}
function visibleButtonsByText(root, text) {
  return findButtonsByText(root, text).filter(isVisible);
}
function findInputs(root, predicate) {
  const found = [];
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    if (n.tagName === 'INPUT' && (!predicate || predicate(n))) found.push(n);
    queue.push(...(n.children || []));
  }
  return found;
}
async function clickAndSettle(node) {
  node.click();
  await sleep(10);
  await sleep(10);
}
async function submitFormAndSettle(form) {
  form.dispatchEvent({ type: 'submit', target: form, preventDefault() {} });
  await sleep(10);
  await sleep(10);
}
async function gotoSetup(harness) {
  const { doc, renderReview } = harness;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  await renderReview(container);
  const start = findFirstButtonByText(container, 'Start review');
  assert.ok(start, 'INTRO Start review exists');
  await clickAndSettle(start);
  return container;
}
async function gotoCandidates(harness, container) {
  const form = container.querySelector('form');
  assert.ok(form, 'SETUP form exists');
  await submitFormAndSettle(form);
  return container;
}

// ---------------------------------------------------------------- STATE MACHINE
test('Review Hub: INTRO→SETUP→CANDIDATES→REVIEWING→COMPLETE order', async () => {
  const harness = loadReviewModule({
    candidatesPayload: defaultCandidates(),
    completePayload: { total: 1, byType: { kanji: 1, vocabulary: 0, grammar: 0 }, byResult: { Good: 1, Hard: 0, Again: 0 } }
  });
  const { doc, renderReview, apiCalls } = harness;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  await renderReview(container);
  assert.match(textOf(container), /Want to review your JLPT study\?/, 'INTRO copy');
  assert.match(textOf(container), /Start review/, 'INTRO action');

  await clickAndSettle(findFirstButtonByText(container, 'Start review'));
  assert.match(textOf(container), /Find material/, 'SETUP title');

  await submitFormAndSettle(container.querySelector('form'));
  assert.equal(apiCalls.filter((c) => c.url.startsWith('/api/review/candidates')).length, 1, 'SETUP submit discovers candidates');
  // CANDIDATES: grouped sections visible.
  assert.match(textOf(container), /KANJI/, 'CANDIDATES kanji section');
  // Check a candidate, start review.
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  assert.ok(boxes.length >= 1);
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  const startButtons = visibleButtonsByText(container, 'Start review');
  // Footer Start review (CANDIDATES) is the visible one after intro hidden.
  const begin = startButtons[startButtons.length - 1];
  await clickAndSettle(begin);
  assert.ok(apiCalls.some((c) => c.url === '/api/review/sessions'), 'SESSION start creates session');
  assert.match(textOf(container), /of/, 'REVIEWING progress present');

  // Reveal + grade the single item, then complete.
  const reveal = findFirstButtonByText(container, 'Reveal answer');
  assert.ok(reveal, 'front has Reveal');
  await clickAndSettle(reveal);
  const good = findFirstButtonByText(container, 'Good');
  assert.ok(good, 'answer has grades');
  await clickAndSettle(good);
  await sleep(10);
  assert.ok(apiCalls.some((c) => c.url === '/api/review/grade'), 'grade sent');
  assert.ok(apiCalls.some((c) => /\/complete$/.test(c.url)), 'last grade triggers complete');
  assert.match(textOf(container), /Review complete/, 'COMPLETE heading');
});

// ---------------------------------------------------------------- SETUP defaults
test('Review Hub SETUP: Last 3 days checked by default; Today + Custom present; custom dates hidden until Custom', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  const presetLast3 = container.querySelector('input[name="review-preset"][value="last3"]');
  const presetToday = container.querySelector('input[name="review-preset"][value="today"]');
  const presetCustom = container.querySelector('input[name="review-preset"][value="custom"]');
  assert.ok(presetLast3 && presetToday && presetCustom, 'all three presets exist');
  assert.equal(presetLast3.checked, true, 'Last 3 days checked by default');
  assert.equal(presetToday.checked, false);
  // Type checkboxes all checked.
  const types = harness.doc.body.querySelectorAll('input[name="review-types"]');
  // container query for types (checked state covers all).
  const typeBoxes = findInputs(container, (n) => n.getAttribute('name') === 'review-types');
  assert.equal(typeBoxes.length, 3);
  for (const b of typeBoxes) assert.equal(b.checked, true, 'each type checked by default');
  // JLPT all checked.
  const jlptAll = container.querySelector('input[name="review-jlpt"][value="all"]');
  assert.ok(jlptAll);
  assert.equal(jlptAll.checked, true);
});

test('Review Hub SETUP: Custom shows From/To dates', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  const custom = container.querySelector('input[name="review-preset"][value="custom"]');
  // Initially hidden (aria-hidden true on wrapper). Find From input wrapper via aria-label.
  const fromBefore = findInputs(container, (n) => n.getAttribute('aria-label') === 'From date')[0];
  assert.ok(fromBefore);
  let wrapper = fromBefore.parentNode;
  while (wrapper && !wrapper.getAttribute('aria-hidden')) wrapper = wrapper.parentNode;
  // The custom wrapper starts hidden.
  const customWrappers = [];
  {
    const queue = [container];
    while (queue.length) {
      const n = queue.shift();
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') customWrappers.push(n);
      queue.push(...(n.children || []));
    }
  }
  assert.ok(customWrappers.length >= 1, 'custom dates hidden initially');
  custom.checked = true;
  // Uncheck others to mimic radio group.
  for (const r of findInputs(container, (n) => n.getAttribute('name') === 'review-preset')) {
    if (r !== custom) r.checked = false;
  }
  custom.dispatchEvent({ type: 'change', target: custom });
  await sleep(5);
  // After change, aria-hidden should be false.
  const fromAfter = findInputs(container, (n) => n.getAttribute('aria-label') === 'From date')[0];
  let wrap2 = fromAfter;
  // Walk up to the custom container (has two date inputs).
  while (wrap2 && !(wrap2.children || []).some((c) => textOf(c).includes('From') || (c.children || []).length)) {
    // Fallback: check aria-hidden on ancestors.
    if (wrap2.getAttribute && wrap2.getAttribute('aria-hidden') === 'false') break;
    wrap2 = wrap2.parentNode;
    if (!wrap2 || wrap2 === container) break;
  }
  // Direct: find the wrapper that contains both From and To inputs.
  const allWraps = [];
  {
    const queue = [container];
    while (queue.length) {
      const n = queue.shift();
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'false') allWraps.push(n);
      queue.push(...(n.children || []));
    }
  }
  assert.ok(allWraps.length >= 1, 'custom dates shown after selecting Custom');
});

test('Review Hub SETUP: From>To invalid', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  const custom = container.querySelector('input[name="review-preset"][value="custom"]');
  custom.checked = true;
  for (const r of findInputs(container, (n) => n.getAttribute('name') === 'review-preset')) if (r !== custom) r.checked = false;
  custom.dispatchEvent({ type: 'change', target: custom });
  await sleep(5);
  const from = findInputs(container, (n) => n.getAttribute('aria-label') === 'From date')[0];
  const to = findInputs(container, (n) => n.getAttribute('aria-label') === 'To date')[0];
  from.value = '2026-09-10';
  to.value = '2026-09-01';
  const callsBefore = harness.apiCalls.length;
  await submitFormAndSettle(container.querySelector('form'));
  assert.match(textOf(container), /From date on or before/, 'From>To error');
  assert.equal(harness.apiCalls.length, callsBefore, 'invalid range does not call candidates');
});

test('Review Hub SETUP: To>today blocked', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  const custom = container.querySelector('input[name="review-preset"][value="custom"]');
  custom.checked = true;
  for (const r of findInputs(container, (n) => n.getAttribute('name') === 'review-preset')) if (r !== custom) r.checked = false;
  custom.dispatchEvent({ type: 'change', target: custom });
  await sleep(5);
  const from = findInputs(container, (n) => n.getAttribute('aria-label') === 'From date')[0];
  const to = findInputs(container, (n) => n.getAttribute('aria-label') === 'To date')[0];
  from.value = '2026-09-01';
  to.value = '2999-01-01';
  const callsBefore = harness.apiCalls.length;
  await submitFormAndSettle(container.querySelector('form'));
  assert.match(textOf(container), /To date on or before today/, 'future To blocked');
  assert.equal(harness.apiCalls.length, callsBefore);
});

test('Review Hub SETUP: >=1 type required', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  for (const b of findInputs(container, (n) => n.getAttribute('name') === 'review-types')) {
    b.checked = false;
    b.dispatchEvent({ type: 'change', target: b });
  }
  await sleep(5);
  const callsBefore = harness.apiCalls.length;
  await submitFormAndSettle(container.querySelector('form'));
  assert.match(textOf(container), /at least one material type/, 'type requirement error');
  assert.equal(harness.apiCalls.length, callsBefore);
});

test('Review Hub SETUP: JLPT/type values sent to candidates', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  // Select N5 + only kanji.
  const jlptN5 = container.querySelector('input[name="review-jlpt"][value="N5"]');
  assert.ok(jlptN5);
  for (const r of findInputs(container, (n) => n.getAttribute('name') === 'review-jlpt')) r.checked = false;
  jlptN5.checked = true;
  jlptN5.dispatchEvent({ type: 'change', target: jlptN5 });
  for (const b of findInputs(container, (n) => n.getAttribute('name') === 'review-types')) {
    const want = b.getAttribute('value') === 'kanji';
    b.checked = want;
    b.dispatchEvent({ type: 'change', target: b });
  }
  await sleep(5);
  await submitFormAndSettle(container.querySelector('form'));
  const cand = harness.apiCalls.find((c) => c.url.startsWith('/api/review/candidates'));
  assert.ok(cand, 'candidates called');
  assert.match(cand.url, /jlpt=N5/, 'JLPT sent');
  assert.match(cand.url, /types=kanji/, 'types sent');
  assert.match(cand.url, /from=/, 'from sent');
  assert.match(cand.url, /to=/, 'to sent');
});

// ---------------------------------------------------------------- CANDIDATES
test('Review Hub CANDIDATES: 3 grouped sections rendered', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const text = textOf(container);
  assert.match(text, /KANJI/, 'kanji heading');
  assert.match(text, /VOCABULARY/, 'vocab heading');
  assert.match(text, /GRAMMAR/, 'grammar heading');
  // Sections carry aria-labels.
  const sections = [];
  {
    const queue = [container];
    while (queue.length) {
      const n = queue.shift();
      if (n.tagName === 'SECTION' && n.getAttribute('aria-label')) sections.push(n.getAttribute('aria-label'));
      queue.push(...(n.children || []));
    }
  }
  assert.ok(sections.includes('Kanji'));
  assert.ok(sections.includes('Vocabulary'));
  assert.ok(sections.includes('Grammar'));
});

test('Review Hub CANDIDATES: zero-results empty state', async () => {
  const harness = loadReviewModule({ candidatesPayload: { groups: {} } });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  assert.match(textOf(container), /No material found/, 'empty state title');
  assert.match(textOf(container), /widening the date range/, 'empty state hint');
});

test('Review Hub CANDIDATES: weak Recent additions in <details>, unchecked, Select-all excludes weak', async () => {
  const harness = loadReviewModule({ candidatesPayload: mixedStrengthCandidates() });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  // <details> present with Recent additions summary.
  let details = null;
  let summaryText = '';
  {
    const queue = [container];
    while (queue.length) {
      const n = queue.shift();
      if (n.tagName === 'DETAILS') details = n;
      if (n.tagName === 'SUMMARY') summaryText += textOf(n) + ' ';
      queue.push(...(n.children || []));
    }
  }
  assert.ok(details, 'weak items in <details>');
  assert.match(summaryText, /Recent additions/, 'details summary labels weak');
  // Weak checkbox unchecked initially.
  const allBoxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  // Identify weak box by its key suffix :12 (kanji 12 is weak).
  const weakBox = allBoxes.find((b) => String(b.dataset.key || '').endsWith(':12'));
  assert.ok(weakBox, 'weak checkbox found');
  assert.equal(weakBox.checked, false, 'weak unchecked by default');
  // Strong Select-all excludes weak.
  const selectAll = findFirstButtonByText(container, 'Select all');
  assert.ok(selectAll, 'Select all present');
  await clickAndSettle(selectAll);
  // After Select all (first section's button targets studied only), weak stays unchecked.
  // There may be multiple Select all buttons (one per section + weak-specific).
  // Click the first section's Select all; weak must remain unchecked.
  assert.equal(weakBox.checked, false, 'strong Select-all excludes weak');
  // Weak-specific select checks weak.
  const weakSelect = findFirstButtonByText(container, 'Select all recent additions');
  assert.ok(weakSelect, 'weak select-all present');
  await clickAndSettle(weakSelect);
  assert.equal(weakBox.checked, true, 'weak select-all checks weak');
});

test('Review Hub CANDIDATES: Start disabled at 0 selection', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  // Footer begin button is the last Start review.
  const starts = visibleButtonsByText(container, 'Start review');
  const begin = starts[starts.length - 1];
  assert.ok(begin);
  assert.ok(begin.hasAttribute('disabled'), 'Start disabled at 0');
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  assert.ok(!begin.hasAttribute('disabled'), 'Start enabled after selection');
  boxes[0].checked = false;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  assert.ok(begin.hasAttribute('disabled'), 'Start disabled again at 0');
});

// ---------------------------------------------------------------- SESSION
test('Review Hub SESSION: start creates ONLY review_session (no grade/enroll at selection or start)', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const afterCandidates = harness.apiCalls.length;
  assert.equal(harness.apiCalls.filter((c) => c.url === '/api/review/grade').length, 0, 'no grade at discovery');
  // Selection alone issues no writes.
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  assert.equal(harness.apiCalls.length, afterCandidates, 'selection issues zero api calls');
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  const sessionCalls = harness.apiCalls.filter((c) => c.url === '/api/review/sessions');
  assert.equal(sessionCalls.length, 1, 'start creates exactly one session');
  assert.deepEqual(Object.keys(sessionCalls[0].options.body || {}).sort(), ['sourceFrom', 'sourceTo'].sort(), 'session body is source range only');
  assert.equal(harness.apiCalls.filter((c) => c.url === '/api/review/grade').length, 0, 'no grade at start');
});

test('Review Hub SESSION: front hides reading/meaning; Reveal exposes', async () => {
  const harness = loadReviewModule({
    candidatesPayload: {
      groups: {
        kanji: { items: [candidateItem({ entityType: 'kanji', entityId: 91, display: 'FRONT91', reading: 'READ91', meaning: 'MEAN91' })], total: 1, truncated: false },
        vocabulary: { items: [], total: 0, truncated: false },
        grammar: { items: [], total: 0, truncated: false }
      }
    }
  });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  const findArticle = () => {
    const queue = [container];
    while (queue.length) {
      const n = queue.shift();
      if (n.tagName === 'ARTICLE') return n;
      queue.push(...(n.children || []));
    }
    return null;
  };
  const frontArticle = findArticle();
  assert.ok(frontArticle, 'reviewing card present');
  const frontText = textOf(frontArticle);
  assert.match(frontText, /FRONT91/, 'front shows display');
  assert.ok(!frontText.includes('READ91'), 'front hides reading');
  assert.ok(!frontText.includes('MEAN91'), 'front hides meaning');
  const reveal = findFirstButtonByText(container, 'Reveal answer');
  assert.ok(reveal);
  await clickAndSettle(reveal);
  const answerArticle = findArticle();
  const answerText = textOf(answerArticle);
  assert.match(answerText, /READ91/, 'reveal exposes reading');
  assert.match(answerText, /MEAN91/, 'reveal exposes meaning');
  assert.ok(findFirstButtonByText(container, 'Good'), 'grades appear after reveal');
});

test('Review Hub SESSION: grade sends {entityType,entityId,result,reviewSessionId}', async () => {
  let seenBody = null;
  const harness = loadReviewModule({
    candidatesPayload: defaultCandidates(),
    sessionId: 77,
    gradeImpl: (url, opts) => { seenBody = opts.body; return { success: true }; },
    completePayload: { total: 1, byType: { kanji: 1, vocabulary: 0, grammar: 0 }, byResult: { Good: 1, Hard: 0, Again: 0 } }
  });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  await clickAndSettle(findFirstButtonByText(container, 'Good'));
  await sleep(10);
  assert.ok(seenBody, 'grade body captured');
  assert.equal(seenBody.entityType, 'kanji');
  assert.equal(seenBody.entityId, 1);
  assert.equal(seenBody.result, 'Good');
  assert.equal(seenBody.reviewSessionId, 77);
});

test('Review Hub SESSION: failed grade does NOT advance and keeps card', async () => {
  const harness = loadReviewModule({
    candidatesPayload: {
      groups: {
        kanji: { items: [candidateItem({ entityType: 'kanji', entityId: 1, display: '日', reading: 'r1', meaning: 'm1' })], total: 1, truncated: false },
        vocabulary: { items: [candidateItem({ entityType: 'vocabulary', entityId: 2, display: '水', reading: 'r2', meaning: 'm2' })], total: 1, truncated: false },
        grammar: { items: [], total: 0, truncated: false }
      }
    },
    gradeReject: new Error('network down'),
    completePayload: { total: 2, byType: { kanji: 1, vocabulary: 1, grammar: 0 }, byResult: { Good: 2, Hard: 0, Again: 0 } }
  });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  for (const b of boxes) { b.checked = true; b.dispatchEvent({ type: 'change', target: b }); }
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  const before = textOf(container);
  assert.match(before, /1 of/, 'starts at 1');
  await clickAndSettle(findFirstButtonByText(container, 'Good'));
  await sleep(10);
  const after = textOf(container);
  // Still on first card (display 日), progress unchanged, complete not called.
  assert.match(after, /1 of/, 'failed grade does not advance');
  assert.match(after, /日/, 'keeps card');
  assert.equal(harness.apiCalls.filter((c) => /\/complete$/.test(c.url)).length, 0, 'no complete on failure');
  assert.equal(harness.toasts.length, 1, 'failure toasts');
});

test('Review Hub SESSION: success advances; progress N / total correct; last grade completes', async () => {
  const harness = loadReviewModule({
    candidatesPayload: {
      groups: {
        kanji: { items: [candidateItem({ entityType: 'kanji', entityId: 1, display: '日', reading: 'r1', meaning: 'm1' })], total: 1, truncated: false },
        vocabulary: { items: [candidateItem({ entityType: 'vocabulary', entityId: 2, display: '水', reading: 'r2', meaning: 'm2' })], total: 1, truncated: false },
        grammar: { items: [], total: 0, truncated: false }
      }
    },
    sessionId: 55,
    completePayload: { total: 2, byType: { kanji: 1, vocabulary: 1, grammar: 0 }, byResult: { Good: 1, Hard: 1, Again: 0 } }
  });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  for (const b of boxes) { b.checked = true; b.dispatchEvent({ type: 'change', target: b }); }
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  assert.match(textOf(container), /1 \/ 2/, 'progress 1 / 2');
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  await clickAndSettle(findFirstButtonByText(container, 'Good'));
  await sleep(10);
  assert.match(textOf(container), /2 \/ 2/, 'progress advances to 2 / 2');
  assert.match(textOf(container), /水/, 'second card shown');
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  await clickAndSettle(findFirstButtonByText(container, 'Hard'));
  await sleep(15);
  assert.ok(harness.apiCalls.some((c) => /\/sessions\/55\/complete/.test(c.url)), 'last grade triggers complete');
  assert.match(textOf(container), /Review complete/, 'complete after last grade');
});

// ---------------------------------------------------------------- COMPLETE
test('Review Hub COMPLETE: server byType/byResult rendered', async () => {
  const harness = loadReviewModule({
    candidatesPayload: defaultCandidates(),
    completePayload: { total: 4, byType: { kanji: 1, vocabulary: 2, grammar: 1 }, byResult: { Good: 2, Hard: 1, Again: 1 } }
  });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  await clickAndSettle(findFirstButtonByText(container, 'Good'));
  await sleep(15);
  const text = textOf(container);
  assert.match(text, /4 items reviewed/);
  assert.match(text, /1 Kanji/);
  assert.match(text, /2 Vocabulary/);
  assert.match(text, /1 Grammar/);
  assert.match(text, /2 felt comfortable/);
  assert.match(text, /1 felt difficult/);
  assert.match(text, /1 should be revisited/);
});

test('Review Hub COMPLETE: forbidden gamification words absent (source + rendered)', async () => {
  const forbidden = ['correct', 'incorrect', 'passed', 'failed', 'mastered', 'XP', 'confetti', 'badge', 'streak'];
  for (const word of forbidden) {
    // Source must not contain the word as a standalone user-facing token.
    // Case-sensitive for XP; case-insensitive otherwise via lower check.
    if (word === 'XP') {
      assert.ok(!reviewSource.includes('XP'), 'no XP in review.js');
    } else {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(reviewSource), `no "${word}" in review.js`);
    }
  }
  // Rendered COMPLETE also avoids them.
  const harness = loadReviewModule({
    candidatesPayload: defaultCandidates(),
    completePayload: { total: 1, byType: { kanji: 1, vocabulary: 0, grammar: 0 }, byResult: { Good: 1, Hard: 0, Again: 0 } }
  });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  await clickAndSettle(findFirstButtonByText(container, 'Good'));
  await sleep(15);
  const text = textOf(container).toLowerCase();
  for (const word of ['correct', 'incorrect', 'passed', 'failed', 'mastered', 'confetti', 'badge', 'streak']) {
    assert.ok(!text.includes(word), `rendered COMPLETE has no "${word}"`);
  }
  assert.ok(!textOf(container).includes('XP'), 'rendered COMPLETE has no XP');
});

// ---------------------------------------------------------------- A11Y
test('Review Hub A11Y: focus moves to card heading on advance + completion heading', async () => {
  const harness = loadReviewModule({
    candidatesPayload: {
      groups: {
        kanji: { items: [candidateItem({ entityType: 'kanji', entityId: 1, display: '日', reading: 'r1', meaning: 'm1' })], total: 1, truncated: false },
        vocabulary: { items: [candidateItem({ entityType: 'vocabulary', entityId: 2, display: '水', reading: 'r2', meaning: 'm2' })], total: 1, truncated: false },
        grammar: { items: [], total: 0, truncated: false }
      }
    },
    completePayload: { total: 2, byType: { kanji: 1, vocabulary: 1, grammar: 0 }, byResult: { Good: 2, Hard: 0, Again: 0 } }
  });
  const { doc } = harness;
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  for (const b of boxes) { b.checked = true; b.dispatchEvent({ type: 'change', target: b }); }
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  // First card heading focused.
  assert.equal(doc.activeElement?.tagName, 'H2', 'card heading focused on open');
  assert.match(doc.activeElement?.textContent || '', /日/);
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  await clickAndSettle(findFirstButtonByText(container, 'Good'));
  await sleep(10);
  assert.equal(doc.activeElement?.tagName, 'H2', 'card heading focused on advance');
  assert.match(doc.activeElement?.textContent || '', /水/);
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  await clickAndSettle(findFirstButtonByText(container, 'Good'));
  await sleep(15);
  assert.equal(doc.activeElement?.tagName, 'H1', 'completion heading focused');
  assert.match(doc.activeElement?.textContent || '', /Review complete/);
});

test('Review Hub A11Y: aria-live progress; Reveal is native keyboard-operable button', async () => {
  const harness = loadReviewModule({ candidatesPayload: defaultCandidates() });
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  boxes[0].checked = true;
  boxes[0].dispatchEvent({ type: 'change', target: boxes[0] });
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  const reveal = findFirstButtonByText(container, 'Reveal answer');
  assert.ok(reveal);
  assert.equal(reveal.tagName, 'BUTTON', 'Reveal is native button');
  assert.equal(reveal.getAttribute('type'), 'button');
  // Progress has aria-live polite.
  let liveFound = false;
  {
    const queue = [container];
    while (queue.length) {
      const n = queue.shift();
      if (n.getAttribute && n.getAttribute('aria-live') === 'polite' && textOf(n).match(/of/)) liveFound = true;
      queue.push(...(n.children || []));
    }
  }
  assert.ok(liveFound, 'progress exposes aria-live="polite"');
  // Source also carries the guard for keyboard shortcuts.
  assert.match(reviewSource, /aria-live.*polite|polite.*aria-live|'aria-live'/, 'source sets aria-live');
});

test('Review Hub A11Y: 1/2/3 shortcuts guarded (require revealed, REVIEWING, non-input focus)', async () => {
  // Static guards present.
  assert.match(reviewSource, /if\s*\(\s*stage\s*!==\s*'REVIEWING'\s*\|\|\s*!revealed\s*\)\s*return/, 'shortcuts require revealed REVIEWING');
  assert.match(reviewSource, /INPUT\|TEXTAREA\|SELECT/, 'shortcuts ignore form focus');
  // Behavioral: no-fire when focus in input; fires when body focused and revealed.
  const harness = loadReviewModule({
    candidatesPayload: {
      groups: {
        kanji: { items: [candidateItem({ entityType: 'kanji', entityId: 1, display: '日', reading: 'r1', meaning: 'm1' })], total: 1, truncated: false },
        vocabulary: { items: [candidateItem({ entityType: 'vocabulary', entityId: 2, display: '水', reading: 'r2', meaning: 'm2' })], total: 1, truncated: false },
        grammar: { items: [], total: 0, truncated: false }
      }
    },
    completePayload: { total: 2, byType: { kanji: 1, vocabulary: 1, grammar: 0 }, byResult: { Good: 2, Hard: 0, Again: 0 } }
  });
  const { doc } = harness;
  const container = await gotoSetup(harness);
  await gotoCandidates(harness, container);
  const boxes = findInputs(container, (n) => n.getAttribute('type') === 'checkbox');
  for (const b of boxes) { b.checked = true; b.dispatchEvent({ type: 'change', target: b }); }
  await sleep(5);
  const starts = visibleButtonsByText(container, 'Start review');
  await clickAndSettle(starts[starts.length - 1]);
  // Before reveal, shortcut must not fire.
  const gradesBefore = harness.apiCalls.filter((c) => c.url === '/api/review/grade').length;
  doc.activeElement = doc.body;
  doc.dispatchEvent({ type: 'keydown', key: '3', preventDefault() {} });
  await sleep(10);
  assert.equal(harness.apiCalls.filter((c) => c.url === '/api/review/grade').length, gradesBefore, 'no shortcut before reveal');
  // Reveal, then focus in input blocks shortcut.
  await clickAndSettle(findFirstButtonByText(container, 'Reveal answer'));
  const fakeInput = doc.createElement('input');
  fakeInput.tagName = 'INPUT';
  doc.activeElement = fakeInput;
  // Ensure tagName is INPUT (FakeNode uppercases).
  assert.equal(doc.activeElement.tagName, 'INPUT');
  doc.dispatchEvent({ type: 'keydown', key: '3', preventDefault() {} });
  await sleep(10);
  assert.equal(harness.apiCalls.filter((c) => c.url === '/api/review/grade').length, gradesBefore, 'no shortcut when focus in input');
  // Body focus fires.
  doc.activeElement = doc.body;
  doc.body.tagName = 'BODY';
  doc.dispatchEvent({ type: 'keydown', key: '3', preventDefault() {} });
  await sleep(15);
  assert.equal(harness.apiCalls.filter((c) => c.url === '/api/review/grade').length, gradesBefore + 1, 'shortcut grades when revealed + body focused');
});

test('Review Hub A11Y + motion: no custom keyframes (reduced-motion static assert)', () => {
  assert.ok(!reviewSource.includes('@keyframes'), 'no custom keyframes in review.js');
  // CSS must not introduce review-specific animation that ignores reduced motion.
  const css = readSource('src/styles.css');
  // If review styles exist they must respect reduced motion; absence also passes.
  if (/review/.test(css)) {
    assert.ok(/prefers-reduced-motion/.test(css), 'review styles respect reduced motion when present');
  }
});

test('Review Hub endpoints: uses candidates/sessions/grade/complete contracts only (static)', () => {
  assert.ok(reviewSource.includes('/api/review/candidates'), 'GET candidates contract');
  assert.ok(reviewSource.includes('/api/review/sessions'), 'sessions contract');
  assert.ok(reviewSource.includes('/api/review/grade'), 'grade contract');
  assert.ok(reviewSource.includes('/complete'), 'complete contract');
  assert.match(reviewSource, /entityType.*entityId.*result.*reviewSessionId|reviewSessionId/);
  // Grade payload keys exact.
  assert.match(reviewSource, /body:\s*\{\s*entityType:\s*item\.entityType,\s*entityId:\s*item\.entityId,\s*result,\s*reviewSessionId:\s*sessionId\s*\}/);
  // Session creation sends only the source range (no enrollment payload).
  assert.match(reviewSource, /body:\s*\{\s*sourceFrom:\s*lastSearch\.from,\s*sourceTo:\s*lastSearch\.to\s*\}/);
  // No legacy auto-enroll references on the client.
  assert.ok(!reviewSource.includes('createReviewItem'), 'no createReviewItem reference on client');
});
