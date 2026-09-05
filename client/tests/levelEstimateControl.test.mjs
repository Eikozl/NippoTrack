import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLevelEstimateControl,
  LEVEL_ESTIMATE_PANEL_ID,
  levelControlLabel,
  PANEL_TRANSITION_MS,
  renderLevelPanel
} from '../src/levelEstimateControl.js';

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
  const button = (wrapper) => wrapper.querySelector('.level-estimate-toggle');
  const click = (node) => node.dispatchEvent({ type: 'click', target: node, stopPropagation() {} });
  return { doc, win, h, control, desktopHost, mobileHost, desktopWrapper, mobileWrapper, button, click, fetchCalls: () => calls };
}

test('Header control: collapsed estimate button mounts first in the header group', async () => {
  const { control, desktopHost, desktopWrapper, button } = setup();
  await control.load();
  const toggle = button(desktopWrapper);
  assert.ok(toggle, 'collapsed button exists in the header');
  assert.equal(desktopHost.firstElementChild, desktopWrapper, 'level control precedes theme/account controls');
  assert.equal(toggle.querySelector('[data-level-text]').textContent, 'N5');
  assert.equal(toggle.getAttribute('aria-label'), 'JLT estimated study level: N5');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), LEVEL_ESTIMATE_PANEL_ID);
  control.destroy();
});

test('Header control: insufficient evidence renders safely, never as a level', async () => {
  const { control, desktopWrapper, button, click } = setup({ payload: insufficientPayload() });
  await control.load();
  const toggle = button(desktopWrapper);
  assert.equal(toggle.querySelector('[data-level-text]').textContent, '—');
  assert.equal(toggle.getAttribute('aria-label'), 'JLT estimated study level: not enough evidence yet');
  assert.equal(levelControlLabel(null), 'JLT estimated study level');
  click(toggle);
  await sleep(40);
  assert.ok(control.isOpen());
  control.destroy();
});

test('Header control: click expands the panel with full estimate content', async () => {
  const { control, desktopWrapper, button, click, doc } = setup();
  await control.load();
  const toggle = button(desktopWrapper);
  click(toggle);
  await sleep(40);
  assert.ok(control.isOpen());
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const panel = desktopWrapper.querySelector(`#${LEVEL_ESTIMATE_PANEL_ID}`);
  assert.ok(panel, 'single panel instance lives in the opening host');
  assert.equal(panel.getAttribute('role'), 'region');
  assert.ok(panel.classList.contains('is-open'));
  const text = textOf(panel);
  assert.match(panel.querySelector('h2').textContent, /N5/);
  assert.match(text, /Moderate estimate confidence/);
  assert.match(text, /N5 · 8 reviewed/);
  assert.match(text, /not an official JLPT assessment/);
  assert.match(text, /OpenJLPT/);
  assert.equal(doc.querySelectorAll(`#${LEVEL_ESTIMATE_PANEL_ID}`).length, 1);
  control.destroy();
});

test('Header control: second click collapses the panel', async () => {
  const { control, desktopWrapper, button, click } = setup();
  await control.load();
  const toggle = button(desktopWrapper);
  click(toggle);
  await sleep(40);
  assert.ok(control.isOpen());
  click(toggle);
  assert.ok(!control.isOpen());
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await sleep(PANEL_TRANSITION_MS + 50);
  assert.ok(desktopWrapper.querySelector(`#${LEVEL_ESTIMATE_PANEL_ID}`).classList.contains('hidden'));
  control.destroy();
});

test('Header control: click outside collapses the panel', async () => {
  const { control, desktopWrapper, button, click, doc } = setup();
  await control.load();
  click(button(desktopWrapper));
  await sleep(40);
  assert.ok(control.isOpen());
  doc.dispatchEvent({ type: 'click', target: doc.body });
  assert.ok(!control.isOpen());
  control.destroy();
});

test('Header control: Escape collapses and returns focus to the control', async () => {
  const { control, desktopWrapper, button, click, doc } = setup();
  await control.load();
  const toggle = button(desktopWrapper);
  click(toggle);
  await sleep(40);
  assert.ok(control.isOpen());
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.ok(!control.isOpen());
  assert.ok(toggle.focused, 'focus returns to the level control');
  control.destroy();
});

test('Header control: reduced motion collapses without waiting', async () => {
  const { control, desktopWrapper, button, click } = setup({ reducedMotion: true });
  await control.load();
  const toggle = button(desktopWrapper);
  click(toggle);
  await sleep(40);
  click(toggle);
  assert.ok(desktopWrapper.querySelector(`#${LEVEL_ESTIMATE_PANEL_ID}`).classList.contains('hidden'));
  const css = readSource('src/styles.css');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.level-estimate-panel/);
  control.destroy();
});

test('Header control: approaching band renders when the estimate has one', async () => {
  const { control, desktopWrapper, button, click } = setup({
    payload: () => ({
      ...estimatedPayload(),
      estimate: { level: 'N4', status: 'estimated', confidence: 'low', approachingBand: 'N3' }
    })
  });
  await control.load();
  const toggle = button(desktopWrapper);
  assert.equal(toggle.querySelector('[data-level-text]').textContent, 'N4');
  click(toggle);
  await sleep(40);
  assert.match(textOf(desktopWrapper.querySelector(`#${LEVEL_ESTIMATE_PANEL_ID}`)), /Approaching N3/);
  control.destroy();
});

test('Header control: review completion refreshes, unrelated events do not', async () => {
  let level = 'N5';
  const { control, desktopWrapper, button, win, fetchCalls } = setup({ payload: () => ({ ...estimatedPayload(), estimate: { level, status: 'estimated', confidence: 'moderate', approachingBand: null } }) });
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
  assert.equal(button(desktopWrapper).querySelector('[data-level-text]').textContent, 'N4');
  control.destroy();
});

test('Header control: fetch failure hides the control instead of guessing', async () => {
  const { control, desktopWrapper, button } = setup({ payload: async () => { throw new Error('offline'); } });
  await control.load();
  assert.ok(desktopWrapper.classList.contains('hidden'));
  assert.ok(!control.isLoaded());
  control.destroy();
});

test('Header control: desktop and mobile share one panel instance', async () => {
  const { control, desktopWrapper, mobileWrapper, button, click, doc } = setup();
  await control.load();
  assert.ok(button(desktopWrapper));
  assert.ok(button(mobileWrapper));
  click(button(desktopWrapper));
  await sleep(40);
  assert.equal(doc.querySelectorAll(`#${LEVEL_ESTIMATE_PANEL_ID}`).length, 1);
  assert.ok(desktopWrapper.querySelector(`#${LEVEL_ESTIMATE_PANEL_ID}`));
  click(button(desktopWrapper));
  await sleep(PANEL_TRANSITION_MS + 50);
  click(button(mobileWrapper));
  await sleep(40);
  assert.equal(doc.querySelectorAll(`#${LEVEL_ESTIMATE_PANEL_ID}`).length, 1);
  assert.ok(mobileWrapper.querySelector(`#${LEVEL_ESTIMATE_PANEL_ID}`), 'panel reparents to the opening host');
  control.destroy();
});

test('Header control: panel renderer covers copy without a browser', () => {
  const doc = new FakeDocument();
  const nodes = renderLevelPanel(makeH(doc), {
    status: 'estimated', headline: 'Estimated study level: N5', subline: 'sub', metricNote: 'note',
    bandRows: [{ band: 'N5', eligible: 1, retained: 0 }], evidenceLines: ['a'], notUsedLines: ['b'],
    limitationLines: ['c'], disclaimer: 'd'
  });
  assert.ok(nodes.length > 0);
});

test('Dashboard: estimate metric, estimate section, and Quick Add are gone', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.doesNotMatch(source, /Study level/);
  assert.doesNotMatch(source, /estimateSection|levelEstimateModel|levelPayload/);
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
