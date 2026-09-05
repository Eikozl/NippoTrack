import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as controlModule from '../src/levelEstimateControl.js';

const {
  createLevelEstimateControl,
  LEVEL_ESTIMATE_MORPH_CLASS,
  levelControlLabel,
  renderLevelDetail
} = controlModule;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Circular-safe text dump for content assertions.
const textOf = (node) => {
  if (!node) return '';
  const parts = [node.textContent || ''];
  for (const child of node.children || []) parts.push(textOf(child));
  return parts.join(' ');
};

// Minimal DOM double: just enough for the injected element factory and the
// control's class/attribute/listener behavior.
class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc || null;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.attributes = new Map();
    this.dataset = {};
    this._classes = new Set();
    this._listeners = new Map();
    this.focused = false;
  }
  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...names) => names.forEach((name) => self._classes.add(name)),
      remove: (...names) => names.forEach((name) => self._classes.delete(name)),
      contains: (name) => self._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !self._classes.has(name) : Boolean(force);
        if (on) self._classes.add(name); else self._classes.delete(name);
        return on;
      }
    };
  }
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  hasAttribute(name) { return this.attributes.has(String(name)); }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  appendChild(child) {
    // Mirror real DOM reparenting: appending moves the node.
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    if (!this.children.includes(child)) this.children.push(child);
    return child;
  }
  prepend(child) {
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children = [child, ...this.children.filter((node) => node !== child)];
    return child;
  }
  removeChild(child) { this.children = this.children.filter((node) => node !== child); child.parentNode = null; return child; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes) { for (const child of [...this.children]) this.removeChild(child); nodes.filter(Boolean).forEach((node) => this.appendChild(node)); }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((fn) => fn !== handler));
  }
  dispatchEvent(event) {
    for (const fn of [...(this._listeners.get(event.type) || [])]) fn(event);
    return true;
  }
  focus() { this.focused = true; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
  matches(selector) {
    const text = String(selector);
    const idMatch = text.match(/#([\w-]+)/);
    if (idMatch && this.getAttribute('id') !== idMatch[1]) return false;
    const classMatch = text.match(/\.([\w-]+)/);
    if (classMatch && !this._classes.has(classMatch[1])) return false;
    const attrMatch = text.match(/\[([\w-]+)(?:="[^"]*")?\]/);
    if (attrMatch && !this.hasAttribute(attrMatch[1])) return false;
    const tagMatch = text.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
    if (tagMatch && !text.startsWith('.') && !text.startsWith('#') && !text.startsWith('[')) {
      if (this.tagName !== tagMatch[1].toUpperCase()) return false;
    }
    return true;
  }
  closest(selector) {
    let node = this;
    while (node) { if (typeof node.matches === 'function' && node.matches(selector)) return node; node = node.parentNode; }
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
  constructor() { super('#document', null); this.body = this.appendChild(new FakeNode('body', this)); }
  createElement(tag) { return new FakeNode(tag, this); }
}

class FakeWindow {
  constructor({ reducedMotion = false } = {}) {
    this._listeners = new Map();
    this._reducedMotion = reducedMotion;
    this.setTimeout = (fn, ms) => setTimeout(fn, ms);
    this.clearTimeout = (id) => clearTimeout(id);
  }
  matchMedia() { return { matches: this._reducedMotion }; }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((fn) => fn !== handler));
  }
  dispatchEvent(event) {
    for (const fn of [...(this._listeners.get(event.type) || [])]) fn(event);
    return true;
  }
  listenerTypes() { return [...this._listeners.keys()].filter((type) => (this._listeners.get(type) || []).length > 0); }
}

// Test element factory mirroring ui.js element(): tag + options + children.
function makeH(doc) {
  return (tagName, { className, text, attrs, dataset } = {}, children = []) => {
    const node = doc.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    Object.entries(attrs || {}).forEach(([name, value]) => {
      if (value !== undefined && value !== null) node.setAttribute(name, String(value));
    });
    Object.entries(dataset || {}).forEach(([name, value]) => { node.dataset[name] = String(value); });
    (Array.isArray(children) ? children : [children]).filter(Boolean).forEach((child) => node.appendChild(child));
    return node;
  };
}

const estimatedPayload = () => ({
  estimate: { level: 'N5', status: 'estimated', confidence: 'moderate', approachingBand: null },
  evidence: { eligibleKanji: 8, retainedKanji: 5, reviewedKanji: 8, exposureKanji: 2, collectedKanji: 12, unreviewedKanji: 4, classifiedEligibleKanji: 8, unclassifiedEligibleKanji: 0 },
  distribution: { N5: { eligible: 8, retained: 5 }, N4: { eligible: 0, retained: 0 }, N3: { eligible: 0, retained: 0 }, N2: { eligible: 0, retained: 0 }, N1: { eligible: 0, retained: 0 } },
  reasoning: ['8 reviewed kanji with reference JLPT classifications (5 reviewed more than once).'],
  limitations: ['Reference JLPT classifications come from the community OpenJLPT overlay, not an official JLPT syllabus.'],
  disclaimer: 'This is a JLT study estimate based on reviewed kanji only — not an official JLPT assessment, certification, or proof of passing.'
});

const insufficientPayload = () => ({
  estimate: { level: null, status: 'insufficient_evidence', confidence: null, approachingBand: null },
  evidence: { eligibleKanji: 2, retainedKanji: 0, reviewedKanji: 2, exposureKanji: 0, collectedKanji: 10, unreviewedKanji: 8, classifiedEligibleKanji: 2, unclassifiedEligibleKanji: 0 },
  distribution: { N5: { eligible: 2, retained: 0 }, N4: { eligible: 0, retained: 0 }, N3: { eligible: 0, retained: 0 }, N2: { eligible: 0, retained: 0 }, N1: { eligible: 0, retained: 0 } },
  reasoning: ['Only 2 reviewed kanji with a reference JLPT classification found (5 needed for an estimate).'],
  limitations: ['JLT study estimate only.'],
  disclaimer: 'This is a JLT study estimate based on reviewed kanji only — not an official JLPT assessment, certification, or proof of passing.'
});

function setup({ payload = estimatedPayload(), reducedMotion = false } = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow({ reducedMotion });
  const h = makeH(doc);
  let calls = 0;
  const fetchEstimate = async () => { calls += 1; return typeof payload === 'function' ? payload(calls) : payload; };
  const control = createLevelEstimateControl({ fetchEstimate, createElement: h, doc, win });
  const desktopHost = doc.createElement('div');
  const themeButton = doc.createElement('button');
  desktopHost.appendChild(themeButton);
  const mobileHost = doc.createElement('div');
  doc.body.appendChild(desktopHost);
  doc.body.appendChild(mobileHost);
  const desktopWrapper = control.mount(desktopHost);
  const mobileWrapper = control.mount(mobileHost);
  const morph = (wrapper) => wrapper.querySelector(`.${LEVEL_ESTIMATE_MORPH_CLASS}`);
  const face = (wrapper) => wrapper.querySelector('.level-estimate-face');
  const click = (node) => node.dispatchEvent({ type: 'click', target: node, stopPropagation() {} });
  return { doc, win, h, control, desktopHost, mobileHost, desktopWrapper, mobileWrapper, morph, face, click, fetchCalls: () => calls };
}

test('Header morph: no detached popup module or toggle remains', () => {
  assert.ok(!('LEVEL_ESTIMATE_PANEL_ID' in controlModule), 'old detached-panel contract is gone');
  assert.ok(!('PANEL_TRANSITION_MS' in controlModule), 'no JS timers drive the morph');
  const source = readSource('src/levelEstimateControl.js');
  assert.doesNotMatch(source, /setTimeout|clearTimeout/);
  assert.doesNotMatch(source, /level-estimate-panel|level-estimate-toggle|level-estimate-dot/);
});

test('Header morph: collapsed state shows the bare level, first in the header group', async () => {
  const { control, desktopHost, desktopWrapper, morph, face } = setup();
  await control.load();
  const node = morph(desktopWrapper);
  const button = face(desktopWrapper);
  assert.ok(node, 'same surface lives in the header host');
  assert.equal(desktopHost.firstElementChild, desktopWrapper, 'level control precedes theme/account controls');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.querySelector('[data-level-text]').textContent, 'N5');
  assert.equal(button.getAttribute('aria-label'), 'JLT estimated study level: N5');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.ok(button.getAttribute('aria-controls'), 'face controls the detail region');
  control.destroy();
});

test('Header morph: no decorative icon or glyph beside the level', async () => {
  const { control, desktopWrapper, face } = setup();
  await control.load();
  const button = face(desktopWrapper);
  const text = textOf(button);
  assert.doesNotMatch(text, /◎|◉|◍|⬤|●|◆|★|🎯/);
  assert.equal(button.querySelectorAll('svg').length, 0);
  assert.equal(button.querySelectorAll('[data-jlt-icon]').length, 0);
  // Only the title + value spans; the value is exactly the level.
  assert.equal(button.querySelector('[data-level-text]').textContent, 'N5');
  assert.match(text, /Estimated study level/);
  const source = readSource('src/levelEstimateControl.js');
  assert.doesNotMatch(source, /◎|icon\(/);
  control.destroy();
});

test('Header morph: insufficient evidence renders safely, never as a level', async () => {
  const { control, desktopWrapper, face, click, morph } = setup({ payload: insufficientPayload() });
  await control.load();
  const button = face(desktopWrapper);
  assert.equal(button.querySelector('[data-level-text]').textContent, '—');
  assert.equal(button.getAttribute('aria-label'), 'JLT estimated study level: not enough evidence yet');
  assert.equal(levelControlLabel(null), 'JLT estimated study level');
  click(button);
  assert.ok(control.isOpen());
  assert.ok(morph(desktopWrapper).classList.contains('is-open'));
  control.destroy();
});

test('Header morph: click expands THE SAME surface (no detached node)', async () => {
  const { control, desktopHost, desktopWrapper, face, morph, click, doc } = setup();
  await control.load();
  const nodeBefore = morph(desktopWrapper);
  assert.equal(nodeBefore.parentNode, desktopWrapper, 'morph is anchored in its header host');
  click(face(desktopWrapper));
  assert.ok(control.isOpen());
  // Same node, still anchored in the opening host, now morphed open.
  assert.equal(morph(desktopWrapper), nodeBefore);
  assert.equal(nodeBefore.parentNode, desktopWrapper, 'expansion reparents nothing');
  assert.ok(nodeBefore.classList.contains('is-open'));
  assert.equal(face(desktopWrapper).getAttribute('aria-expanded'), 'true');
  // No detached dropdown/popover/modal: the only morph surfaces are the two
  // header-anchored ones, and the open one is still inside its host.
  assert.equal(doc.body.querySelectorAll(`.${LEVEL_ESTIMATE_MORPH_CLASS}`).length, 2);
  assert.equal(nodeBefore.parentNode, desktopWrapper);
  const text = textOf(nodeBefore);
  assert.match(face(desktopWrapper).querySelector('[data-level-text]').textContent, /N5/);
  assert.match(text, /Moderate estimate confidence/);
  assert.match(text, /N5 · 8 reviewed/);
  assert.match(text, /not an official JLPT assessment/);
  assert.match(text, /OpenJLPT/);
  control.destroy();
});

test('Header morph: collapsing morphs back into the same compact surface', async () => {
  const { control, desktopWrapper, face, morph, click } = setup();
  await control.load();
  const nodeBefore = morph(desktopWrapper);
  click(face(desktopWrapper));
  assert.ok(nodeBefore.classList.contains('is-open'));
  click(face(desktopWrapper));
  assert.ok(!control.isOpen());
  assert.equal(morph(desktopWrapper), nodeBefore, 'still the same node');
  assert.ok(!nodeBefore.classList.contains('is-open'), 'morphed back synchronously (CSS handles motion)');
  assert.equal(face(desktopWrapper).getAttribute('aria-expanded'), 'false');
  assert.equal(face(desktopWrapper).querySelector('[data-level-text]').textContent, 'N5');
  control.destroy();
});

test('Header morph: click outside collapses', async () => {
  const { control, desktopWrapper, face, click, doc } = setup();
  await control.load();
  click(face(desktopWrapper));
  assert.ok(control.isOpen());
  doc.dispatchEvent({ type: 'click', target: doc.body });
  assert.ok(!control.isOpen());
  control.destroy();
});

test('Header morph: Escape collapses and returns focus to the face', async () => {
  const { control, desktopWrapper, face, click, doc } = setup();
  await control.load();
  const button = face(desktopWrapper);
  click(button);
  assert.ok(control.isOpen());
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.ok(!control.isOpen());
  assert.ok(button.focused, 'focus returns to the level face');
  control.destroy();
});

test('Header morph: face is a native button (keyboard activation works)', async () => {
  const { control, desktopWrapper, face } = setup();
  await control.load();
  const button = face(desktopWrapper);
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  control.destroy();
});

test('Header morph: reduced motion keeps instant state changes', async () => {
  const { control, desktopWrapper, face, morph, click } = setup({ reducedMotion: true });
  await control.load();
  click(face(desktopWrapper));
  assert.ok(morph(desktopWrapper).classList.contains('is-open'));
  click(face(desktopWrapper));
  assert.ok(!morph(desktopWrapper).classList.contains('is-open'));
  const css = readSource('src/styles.css');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.level-estimate-morph[\s\S]*?transition:\s*none/);
  assert.match(css, /grid-template-rows/);
  assert.match(css, /width:\s*min\(22rem,\s*calc\(100vw\s*-\s*2rem\)\)/);
  control.destroy();
});

test('Header morph: approaching band renders when the estimate has one', async () => {
  const { control, desktopWrapper, face, morph, click } = setup({
    payload: () => ({
      ...estimatedPayload(),
      estimate: { level: 'N4', status: 'estimated', confidence: 'low', approachingBand: 'N3' }
    })
  });
  await control.load();
  assert.equal(face(desktopWrapper).querySelector('[data-level-text]').textContent, 'N4');
  click(face(desktopWrapper));
  assert.match(textOf(morph(desktopWrapper)), /Approaching N3/);
  control.destroy();
});

test('Header morph: review completion refreshes, unrelated events do not', async () => {
  let level = 'N5';
  const { control, desktopWrapper, face, win, fetchCalls } = setup({ payload: () => ({ ...estimatedPayload(), estimate: { level, status: 'estimated', confidence: 'moderate', approachingBand: null } }) });
  await control.load();
  assert.equal(fetchCalls(), 1);
  // Analyzer analysis, unreviewed imports, and session writes must not refetch.
  win.dispatchEvent({ type: 'jlt-data-change' });
  win.dispatchEvent({ type: 'jlt-analyzer-change' });
  await sleep(10);
  assert.equal(fetchCalls(), 1);
  assert.deepEqual(win.listenerTypes().sort(), ['jlt-review-complete']);
  // A completed review creates review evidence: refetch and update the pill.
  level = 'N4';
  win.dispatchEvent({ type: 'jlt-review-complete' });
  await sleep(20);
  assert.equal(fetchCalls(), 2);
  assert.equal(face(desktopWrapper).querySelector('[data-level-text]').textContent, 'N4');
  control.destroy();
});

test('Header morph: fetch failure hides the control instead of guessing', async () => {
  const { control, desktopWrapper } = setup({ payload: async () => { throw new Error('offline'); } });
  await control.load();
  assert.ok(desktopWrapper.classList.contains('hidden'));
  assert.ok(!control.isLoaded());
  control.destroy();
});

test('Header morph: desktop and mobile never open together', async () => {
  const { control, desktopWrapper, mobileWrapper, face, morph, click } = setup();
  await control.load();
  assert.ok(face(desktopWrapper));
  assert.ok(face(mobileWrapper));
  assert.notEqual(
    face(desktopWrapper).getAttribute('aria-controls'),
    face(mobileWrapper).getAttribute('aria-controls'),
    'detail regions need unique ids'
  );
  click(face(desktopWrapper));
  assert.ok(morph(desktopWrapper).classList.contains('is-open'));
  click(face(mobileWrapper));
  assert.ok(!morph(desktopWrapper).classList.contains('is-open'), 'opening mobile collapses desktop');
  assert.ok(morph(mobileWrapper).classList.contains('is-open'));
  control.destroy();
});

test('Header morph: detail renderer covers copy without a browser', () => {
  const doc = new FakeDocument();
  const nodes = renderLevelDetail(makeH(doc), {
    status: 'estimated', headline: 'Estimated study level: N5', subline: 'sub', metricNote: 'note',
    bandRows: [{ band: 'N5', eligible: 1, retained: 0 }], evidenceLines: ['a'], notUsedLines: ['b'],
    limitationLines: ['c'], disclaimer: 'd'
  });
  assert.ok(nodes.length > 0);
});

test('Dashboard: estimate metric, estimate section, and Quick Add are gone', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.doesNotMatch(source, /Study level/);
  assert.doesNotMatch(source, /estimateSection|estimateMetric|levelEstimateModel|levelPayload/);
  assert.doesNotMatch(source, /quickAddPanel|Quick add session|quick-add-card/);
  assert.doesNotMatch(source, /\/api\/level\/estimate/);
  assert.doesNotMatch(source, /\/api\/sessions.*POST|POST.*\/api\/sessions/);
  assert.match(source, /metric\('review', 'Due reviews'/);
});

test('Sessions page: dedicated Add Session flow remains fully functional', () => {
  const source = readSource('src/pages/sessions.js');
  assert.match(source, /openSessionDialog/);
  assert.match(source, /text: 'Add session'/);
  assert.match(source, /addButton\.addEventListener\('click', \(\) => openSessionDialog\(\)\)/);
});
