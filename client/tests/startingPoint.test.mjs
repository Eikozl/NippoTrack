// Starting-point UX rework — entry screen, self-report flow, per-source
// results, settings states, header fallback. Pure-logic imports
// (firstExperience.js is import-free; levelEstimateControl.js only imports
// firstExperience.js + levelEstimate.js, both DOM-free) plus static source
// assertions. No DOM, servers, or network required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLACEMENT_COPY,
  SELF_REPORT_PATH,
  buildSelfReportPayload,
  isValidSelfReportLevel,
  normalizePlacementSource,
  placementResultFromState,
  renderPlacement,
  selfReportResultNode,
  selfReportResultTitle
} from '../src/firstExperience.js';
import { FIRST_USE_COPY } from '../src/firstUseDashboard.js';
import {
  STARTING_LEVEL_TITLE,
  createLevelEstimateControl,
  levelControlLabel,
  levelControlShortText,
  renderStartingLevelDetail,
  startingPointLabel,
  startingPointShortText
} from '../src/levelEstimateControl.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- fixtures ---------------------------------------------------------------

function buildQuestions() {
  const ids = ['n5_01', 'n5_02', 'n4_01', 'n4_02', 'n3_01', 'n3_02', 'n5_03', 'n4_03', 'n3_03', 'n3_04'];
  const first = {
    id: 'n5_01',
    prompt: { text: '水をのみます。水のよみ方は？', reading: 'みずをのみます', translation: 'How do you read 水?' },
    options: [
      { id: 'a', text: 'みず', reading: 'みず', gloss: 'water' },
      { id: 'b', text: 'すい', reading: 'すい', gloss: 'water (on reading)' },
      { id: 'c', text: 'みす', reading: 'みす', gloss: 'to miss' },
      { id: 'd', text: 'むず', reading: 'むず', gloss: 'difficult (stem)' }
    ]
  };
  const rest = ids.slice(1).map((id, offset) => {
    const number = offset + 2;
    return {
      id,
      prompt: { text: `これは質問${number}です。`, reading: `これはしつもん${number}です。`, translation: `This is question ${number}.` },
      options: ['あ', 'い', 'う', 'え'].map((kana, optionIndex) => ({
        id: ['a', 'b', 'c', 'd'][optionIndex], text: kana, reading: kana, gloss: `choice ${optionIndex + 1}`
      }))
    };
  });
  return [first, ...rest];
}

const QUESTIONS_PATH = '/api/first-experience/placement/questions';
const SUBMIT_PATH = '/api/first-experience/placement/submit';
const SKIP_PATH = '/api/first-experience/placement/skip';
const FX_PATH = '/api/first-experience';

function notStartedFx() {
  return {
    onboarding: { completed: true, studySources: [] },
    placement: { status: 'not_started', estimate: null, source: null },
    targetLevel: null
  };
}

function completedSelfFx({ estimate = 'N2' } = {}) {
  return {
    onboarding: { completed: true, studySources: [] },
    placement: { status: 'completed', estimate, source: 'self_reported', completedAt: null, result: null },
    targetLevel: null
  };
}

function completedQuizFx({ estimate = 'N3', result = null } = {}) {
  return {
    onboarding: { completed: true, studySources: [] },
    placement: { status: 'completed', estimate, source: 'quiz', completedAt: null, result },
    targetLevel: null
  };
}

function conflictError(message = 'Placement already completed.') {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function createApiMock({ questions = buildQuestions(), fx = null, failSubmit = false, failSelfReport = false, failSkip = false, submitConflict = false, selfReportConflict = false, questionsConflict = false, selfEstimate = 'N3' } = {}) {
  const log = { calls: [] };
  const api = async (path, options = {}) => {
    log.calls.push({ path, ...options });
    if (path === FX_PATH) return fx || notStartedFx();
    if (path === QUESTIONS_PATH) {
      if (questionsConflict) throw conflictError();
      return questions;
    }
    if (path === SUBMIT_PATH) {
      if (submitConflict) throw conflictError();
      if (failSubmit) throw new Error('Unable to save your answers. Please try again.');
      throw new Error('Unexpected quiz submit in this test.');
    }
    if (path === SELF_REPORT_PATH) {
      if (selfReportConflict) throw conflictError();
      if (failSelfReport) throw new Error('Unable to save your starting level. Please try again.');
      return { estimate: selfEstimate, placement: { status: 'completed', estimate: selfEstimate, source: 'self_reported' } };
    }
    if (path === SKIP_PATH) {
      if (failSkip) throw new Error('Skip failed.');
      return { placement: { status: 'skipped', estimate: null } };
    }
    throw new Error(`Unexpected API path: ${path}`);
  };
  return { log, api };
}

// --- minimal element-factory double (ui.element signature) ------------------

function createPlacementHarness({ apiImpl } = {}) {
  const log = { nodes: [], focused: null, apiCalls: [], navigations: [], notices: [] };
  function el(tag, opts = {}, children = []) {
    const node = {
      tag,
      className: opts.className || '',
      textContent: opts.text ?? '',
      attributes: new Map(Object.entries(opts.attrs || {}).map(([key, value]) => [key, String(value)])),
      dataset: { ...(opts.dataset || {}) },
      children: [],
      listeners: {},
      focused: false,
      disabled: false,
      setAttribute(key, value) { this.attributes.set(key, String(value)); },
      getAttribute(key) { return this.attributes.get(key); },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...nodes) { this.children = nodes.flat(Infinity).filter(Boolean); },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      focus() { this.focused = true; log.focused = node; }
    };
    const flat = (Array.isArray(children) ? children : [children]).flat(Infinity).filter(Boolean);
    flat.forEach((child) => node.appendChild(child));
    log.nodes.push(node);
    return node;
  }
  const container = el('main', {});
  const mock = apiImpl || createApiMock();
  const api = mock.api || mock;
  const deps = {
    el,
    api: (path, options) => {
      log.apiCalls.push({ path, ...options });
      return api(path, options);
    },
    navigate: (page) => log.navigations.push(page),
    notify: (message, type) => log.notices.push({ message, type })
  };
  return { log, el, container, deps };
}

function textOf(node) {
  if (!node) return '';
  const parts = [node.textContent || ''];
  for (const child of node.children || []) parts.push(textOf(child));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
}

function findButton(container, label) {
  const matches = findAll(container, (node) => node.tag === 'button' && textOf(node) === label);
  assert.ok(matches.length > 0, `button "${label}" rendered`);
  return matches[matches.length - 1];
}

// Entry cards carry a title plus a description, so card lookup matches the
// leading title text rather than the whole button.
function findCard(container, title) {
  const matches = findAll(container, (node) => node.tag === 'button' && textOf(node).startsWith(title));
  assert.ok(matches.length > 0, `card "${title}" rendered`);
  return matches[matches.length - 1];
}

async function click(node) {
  for (const fn of node.listeners.click || []) await fn();
}

async function clickCard(container, title) {
  await click(findCard(container, title));
  await sleep(5);
}

async function clickExact(container, label) {
  await click(findButton(container, label));
  await sleep(5);
}

// --- entry screen -----------------------------------------------------------

test('entry screen renders the exact starting-point choice before questions load', async () => {
  const { container, deps, log } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  const text = textOf(container);
  const ordered = [
    'STARTING POINT',
    'Where should we start?',
    'Choose the option that best fits what you already know about your Japanese.',
    'Get a quick estimate',
    'Answer 10 short Japanese questions to get a starting reference.',
    'I already know my level',
    'If you already have a reliable idea of your current JLPT level, you can set your starting point yourself.',
    'Skip for now',
    'This is a starting reference, not an official JLPT assessment.'
  ];
  let cursor = -1;
  for (const line of ordered) {
    const next = text.indexOf(line, cursor + 1);
    assert.ok(next > cursor, `rendered in order: "${line}"`);
    cursor = next;
  }
  const h1 = findAll(container, (node) => node.tag === 'h1');
  assert.equal(h1.length, 1, 'single H1');
  assert.equal(textOf(h1[0]), 'Where should we start?');
  // Both cards are real buttons on the shared primitives.
  for (const label of ['Get a quick estimate', 'I already know my level']) {
    const card = findCard(container, label);
    assert.equal(card.tag, 'button');
    assert.equal(card.getAttribute('type'), 'button');
    assert.ok(card.className.includes('button-'), '44px shared button primitive');
  }
  assert.ok(!text.match(/JLPT N[1-5]/), 'no level labels on the entry screen');
  assert.deepEqual(log.apiCalls.map((call) => call.path), [FX_PATH], 'boot reads stored state only — questions lazy-load');
});

test('entry quiz path loads the questions; self path opens the chooser; skip leaves', async () => {
  const quiz = createPlacementHarness();
  renderPlacement(quiz.container, quiz.deps);
  await sleep(25);
  await clickCard(quiz.container, 'Get a quick estimate');
  await sleep(25);
  assert.ok(textOf(quiz.container).includes('Question 1 of 10'), 'quiz card loads the questions');
  assert.ok(quiz.log.apiCalls.some((call) => call.path === QUESTIONS_PATH), 'questions fetched after the choice');

  const self = createPlacementHarness();
  renderPlacement(self.container, self.deps);
  await sleep(25);
  await clickCard(self.container, 'I already know my level');
  await sleep(5);
  assert.ok(textOf(self.container).includes("What's your current level?"), 'self card opens the chooser');
  assert.ok(!self.log.apiCalls.some((call) => call.path === QUESTIONS_PATH), 'chooser fetches no questions');

  const skip = createPlacementHarness();
  renderPlacement(skip.container, skip.deps);
  await sleep(25);
  await clickExact(skip.container, 'Skip for now');
  await sleep(15);
  assert.deepEqual(skip.log.apiCalls.find((call) => call.path === SKIP_PATH), { path: SKIP_PATH, method: 'POST' });
  assert.ok(skip.log.navigations.includes('dashboard'), 'skip lands on the dashboard');
});

// --- self-report flow --------------------------------------------------------

test('self-report chooser: N5..N1 radio-style options, submit gated on a pick', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await clickCard(container, 'I already know my level');
  await sleep(5);
  const text = textOf(container);
  assert.ok(text.includes("What's your current level?"), 'H1');
  assert.ok(text.includes('Choose the level that best represents where you are starting.'), 'body');
  assert.ok(text.includes('This is a self-reported starting level. NippoTrack may form a different evidence-based estimate later as you review material.'), 'honest note');
  assert.ok(text.includes('Choose a level to continue.'), 'empty hint');
  const options = findAll(container, (node) => node.tag === 'button' && /^JLPT N[1-5]$/.test(textOf(node)));
  assert.equal(options.length, 5, 'five level options');
  for (const option of options) {
    assert.equal(option.getAttribute('aria-pressed'), 'false', 'options start unpressed');
    assert.equal(option.getAttribute('type'), 'button', 'real buttons');
    assert.ok(option.className.includes('button-'), '44px shared primitive');
  }
  const submit = findButton(container, 'Use this starting level');
  assert.equal(submit.disabled, true, 'submit waits for a pick');
  assert.ok(findButton(container, 'Back'), 'back action present');
});

test('self-report select + submit posts { level } and renders the self result', async () => {
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ selfEstimate: 'N3' }) });
  renderPlacement(container, deps);
  await sleep(25);
  await clickCard(container, 'I already know my level');
  await sleep(5);
  await clickExact(container, 'JLPT N3');
  await sleep(5);
  const pressed = findAll(container, (node) => node.tag === 'button' && node.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1, 'exactly one level pressed');
  assert.equal(textOf(pressed[0]), 'JLPT N3');
  assert.ok(!textOf(container).includes('Choose a level to continue.'), 'hint clears once chosen');
  assert.equal(findButton(container, 'Use this starting level').disabled, false, 'submit enabled after a pick');
  await clickExact(container, 'Use this starting level');
  await sleep(25);
  const posted = log.apiCalls.find((call) => call.path === SELF_REPORT_PATH);
  assert.ok(posted, 'self-report posted');
  assert.deepEqual(posted.body, { level: 'N3' }, 'payload carries only the chosen level');
  const result = textOf(container);
  assert.ok(result.includes('STARTING LEVEL'), 'self-result eyebrow');
  assert.ok(result.includes('JLPT N3'), 'chosen level shown');
  assert.ok(result.includes('Self-reported'), 'source shown');
  assert.ok(result.includes(PLACEMENT_COPY.selfResultBody), 'explanatory body shown');
  assert.ok(!result.match(/\/ 10 correct/), 'no score');
  assert.ok(!result.match(/[●○]/), 'no dots');
  assert.ok(!result.match(/QUIZ RESULT/), 'no quiz breakdown');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 1, 'Go to dashboard is the ONLY action');
  await clickExact(container, 'Go to dashboard');
  assert.ok(log.navigations.includes('dashboard'), 'dashboard handoff');
});

test('self-report back returns to the entry choice', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await clickCard(container, 'I already know my level');
  await sleep(5);
  await clickExact(container, 'JLPT N5');
  await sleep(5);
  await clickExact(container, 'Back');
  await sleep(5);
  assert.ok(textOf(container).includes('Where should we start?'), 'back lands on the entry screen');
  assert.ok(textOf(container).includes('Get a quick estimate'), 'quiz path still available');
});

test('self-report failure toasts and stays on the chooser with the pick intact', async () => {
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ failSelfReport: true }) });
  renderPlacement(container, deps);
  await sleep(25);
  await clickCard(container, 'I already know my level');
  await sleep(5);
  await clickExact(container, 'JLPT N4');
  await sleep(5);
  await clickExact(container, 'Use this starting level');
  await sleep(25);
  assert.equal(log.notices.length, 1, 'failure toasted');
  assert.equal(log.notices[0].type, 'error');
  assert.ok(!log.navigations.includes('dashboard'), 'fail-open: no navigation');
  assert.ok(textOf(container).includes("What's your current level?"), 'still on the chooser');
  const pressed = findAll(container, (node) => node.tag === 'button' && node.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1, 'pick intact');
  assert.equal(textOf(pressed[0]), 'JLPT N4');
});

test('self-report 409 falls back to the stored result of whichever source it carries', async () => {
  const quizStored = completedQuizFx({
    estimate: 'N3',
    result: { totalCorrect: 6, byBand: { N5: { correct: 3, total: 4 }, N4: { correct: 2, total: 3 }, N3: { correct: 1, total: 3 } } }
  });
  let fxCalls = 0;
  const api = async (path, options = {}) => {
    if (path === FX_PATH) {
      fxCalls += 1;
      return fxCalls === 1 ? notStartedFx() : quizStored;
    }
    if (path === SELF_REPORT_PATH) throw conflictError();
    if (path === QUESTIONS_PATH) throw conflictError();
    throw new Error(`Unexpected API path: ${path}`);
  };
  const { container, deps, log } = createPlacementHarness({ apiImpl: { api } });
  renderPlacement(container, deps);
  await sleep(25);
  await clickCard(container, 'I already know my level');
  await sleep(5);
  await clickExact(container, 'JLPT N3');
  await sleep(5);
  await clickExact(container, 'Use this starting level');
  await sleep(25);
  const text = textOf(container);
  assert.ok(text.includes('N3 range'), 'stored quiz estimate shown after the race');
  assert.ok(text.includes('6 / 10 correct'), 'stored breakdown shown after the race');
  assert.ok(text.includes(PLACEMENT_COPY.alreadySaved), 'calm notice, not an error');
  assert.equal(log.notices.length, 0, 'no error toast on the already-completed race');
});

test('completed self-report boots straight to the self result (no quiz path)', async () => {
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ fx: completedSelfFx({ estimate: 'N2' }) }) });
  renderPlacement(container, deps);
  await sleep(25);
  const text = textOf(container);
  assert.ok(text.includes('STARTING LEVEL'), 'self-result eyebrow');
  assert.ok(text.includes('JLPT N2'), 'chosen level shown');
  assert.ok(text.includes('Self-reported'), 'source shown');
  assert.ok(!text.includes('Where should we start?'), 'no entry screen');
  assert.ok(!text.includes('Question 1 of 10'), 'quiz never renders');
  assert.equal(log.apiCalls.filter((call) => call.path === QUESTIONS_PATH).length, 0, 'no questions fetched');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 1, 'only Go to dashboard');
});

test('409 on questions falls back to a stored self-report (no error view)', async () => {
  const fx = completedSelfFx({ estimate: 'N1' });
  let fxCalls = 0;
  const api = async (path) => {
    if (path === FX_PATH) {
      fxCalls += 1;
      return fxCalls === 1 ? notStartedFx() : fx;
    }
    if (path === QUESTIONS_PATH) throw conflictError();
    throw new Error(`Unexpected API path: ${path}`);
  };
  const { container, deps } = createPlacementHarness({ apiImpl: { api } });
  renderPlacement(container, deps);
  await sleep(25);
  await clickCard(container, 'Get a quick estimate');
  await sleep(25);
  const text = textOf(container);
  assert.ok(text.includes('JLPT N1'), 'stored self-report shown');
  assert.ok(text.includes('Self-reported'), 'source shown');
  assert.ok(!text.includes('We could not load this view.'), 'no error view for completed learners');
});

// --- dashboard copy ----------------------------------------------------------

test('dashboard starting-point copy covers both sources', () => {
  assert.equal(FIRST_USE_COPY.startingLevelLabel, 'Starting level');
  assert.equal(FIRST_USE_COPY.quizSourceLabel, 'Quick Placement');
  assert.equal(FIRST_USE_COPY.selfReportedLabel, 'Self-reported');
  assert.equal(FIRST_USE_COPY.estimateLabel, 'Starting estimate');
});

// --- settings states (static: settings.js is browser-bundled) ---------------

test('settings starting-point block branches per source with no re-entry', () => {
  const source = readSource('src/pages/settings.js');
  assert.ok(source.includes('selfReportResultNode'), 'shared self-report node, no copied rows');
  assert.ok(source.includes("stored.source === 'self_reported'"), 'source branch presented from stored state');
  assert.ok(source.includes('placementResultNode'), 'quiz diagram reused for quiz rows');
  assert.ok(source.includes('Take quick placement'), 'take CTA for uncompleted learners');
  assert.ok(!source.match(/retake/i), 'no re-entry wording');
  assert.ok(!source.match(/reset/i), 'no reset wording');
  assert.ok(!source.match(/repeat/i), 'no repeat wording');
});

// --- header fallback ---------------------------------------------------------

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
      contains: (name) => self._classes.has(name)
    };
  }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  appendChild(child) {
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
  matches(selector) {
    const text = String(selector);
    const classMatch = text.match(/\.([\w-]+)/);
    if (classMatch && !this._classes.has(classMatch[1])) return false;
    const attrMatch = text.match(/\[([\w-]+)(?:="[^"]*")?\]/);
    if (attrMatch && !this.attributes.has(attrMatch[1])) return false;
    const tagMatch = text.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
    if (tagMatch && !text.startsWith('.') && !text.startsWith('#') && !text.startsWith('[')) {
      if (this.tagName !== tagMatch[1].toUpperCase()) return false;
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
  constructor() { super('#document', null); this.body = this.appendChild(new FakeNode('body', this)); }
  createElement(tag) { return new FakeNode(tag, this); }
}

class FakeWindow {
  constructor() {
    this._listeners = new Map();
  }
  matchMedia() { return { matches: false }; }
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
}

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
  evidence: { eligibleKanji: 8, reviewedKanji: 8, collectedKanji: 12 },
  distribution: {},
  reasoning: ['8 reviewed kanji with reference JLPT classifications.'],
  limitations: ['JLT study estimate only.'],
  disclaimer: 'This is a JLT study estimate based on reviewed kanji only.'
});

const insufficientPayload = () => ({
  estimate: { level: null, status: 'insufficient_evidence', confidence: null, approachingBand: null },
  evidence: { eligibleKanji: 2, reviewedKanji: 2, collectedKanji: 10 },
  distribution: {},
  reasoning: ['Only 2 reviewed kanji found (5 needed).'],
  limitations: ['JLT study estimate only.'],
  disclaimer: 'This is a JLT study estimate based on reviewed kanji only.'
});

function quizStartingFx() {
  return {
    onboarding: { completed: true, studySources: [] },
    placement: {
      status: 'completed', estimate: 'N4', source: 'quiz', completedAt: null,
      result: { totalCorrect: 6, byBand: { N5: { correct: 3, total: 4 }, N4: { correct: 2, total: 3 }, N3: { correct: 1, total: 3 } } }
    },
    targetLevel: null
  };
}

function selfStartingFx() {
  return {
    onboarding: { completed: true, studySources: [] },
    placement: { status: 'completed', estimate: 'N2', source: 'self_reported', completedAt: null, result: null },
    targetLevel: null
  };
}

function setupHeader({ payload = insufficientPayload(), starting = null, startingFails = false } = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow();
  const h = makeH(doc);
  const counts = { estimate: 0, starting: 0 };
  const control = createLevelEstimateControl({
    fetchEstimate: async () => { counts.estimate += 1; return typeof payload === 'function' ? payload() : payload; },
    fetchStartingPoint: async () => {
      counts.starting += 1;
      if (startingFails) throw new Error('offline');
      return starting;
    },
    createElement: h,
    doc,
    win
  });
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const wrapper = control.mount(host);
  const face = () => wrapper.querySelector('.level-estimate-face');
  const morph = () => wrapper.querySelector('.level-estimate-morph');
  const click = (node) => node.dispatchEvent({ type: 'click', target: node, stopPropagation() {} });
  return { control, wrapper, face, morph, click, counts, win };
}

const headerTextOf = (node) => {
  if (!node) return '';
  const parts = [node.textContent || ''];
  for (const child of node.children || []) parts.push(headerTextOf(child));
  return parts.join(' ');
};

test('header fallback labels are presentation-only and never evidence wording', () => {
  assert.equal(STARTING_LEVEL_TITLE, 'Starting level');
  assert.equal(startingPointLabel({ estimate: 'N4', source: 'quiz' }), 'Starting level: N4 range, Quick Placement');
  assert.equal(startingPointLabel({ estimate: 'N2', source: 'self_reported' }), 'Starting level: N2, self-reported');
  assert.equal(startingPointLabel({ estimate: 'N4', source: null }), 'Starting level: N4 range, Quick Placement');
  assert.equal(startingPointLabel(null), null);
  assert.equal(startingPointLabel({ estimate: 'N9', source: 'quiz' }), null);
  assert.equal(startingPointShortText({ estimate: 'N4', source: 'quiz' }), 'N4');
  assert.equal(startingPointShortText({ estimate: 'N2', source: 'self_reported' }), 'N2');
  assert.equal(startingPointShortText(null), null);
  // Legacy signatures keep working without a starting point.
  assert.equal(levelControlLabel(null), 'JLT estimated study level');
  assert.equal(levelControlShortText(null), '—');
});

test('header fallback: insufficient evidence + quiz starting level', async () => {
  const { control, face, morph, click, counts } = setupHeader({ starting: quizStartingFx() });
  await control.load();
  assert.equal(counts.estimate, 1);
  assert.equal(counts.starting, 1, 'starting point fetched while evidence is insufficient');
  const button = face();
  assert.equal(button.querySelector('[data-level-text]').textContent, 'N4');
  assert.equal(button.querySelector('.level-estimate-title').textContent, 'Starting level');
  assert.equal(button.getAttribute('aria-label'), 'Starting level: N4 range, Quick Placement');
  click(button);
  assert.ok(control.isOpen());
  const detail = headerTextOf(morph());
  assert.ok(detail.includes('N4 range'), 'estimate shown');
  assert.ok(detail.includes('Quick Placement'), 'source shown');
  assert.ok(detail.includes(PLACEMENT_COPY.breakdownNote), 'honest note shown');
  assert.ok(!detail.includes('Estimated study level'), 'never labelled as the evidence estimate');
  assert.ok(!headerTextOf(button).includes('Estimated study level'), 'face never carries the evidence name');
  control.destroy();
});

test('header fallback: insufficient evidence + self-reported starting level', async () => {
  const { control, face, morph, click } = setupHeader({ starting: selfStartingFx() });
  await control.load();
  const button = face();
  assert.equal(button.querySelector('[data-level-text]').textContent, 'N2');
  assert.equal(button.querySelector('.level-estimate-title').textContent, 'Starting level');
  assert.equal(button.getAttribute('aria-label'), 'Starting level: N2, self-reported');
  click(button);
  const detail = headerTextOf(morph());
  assert.ok(detail.includes('JLPT N2'), 'chosen level shown');
  assert.ok(detail.includes('Self-reported'), 'source shown');
  assert.ok(detail.includes(PLACEMENT_COPY.selfResultBody), 'explanatory body shown');
  assert.ok(!detail.includes('Estimated study level'), 'never labelled as the evidence estimate');
  control.destroy();
});

test('header fallback: real evidence always wins over the starting level', async () => {
  const { control, face, morph, click, counts } = setupHeader({ payload: estimatedPayload(), starting: quizStartingFx() });
  await control.load();
  assert.equal(counts.starting, 0, 'no starting-point fetch once evidence exists');
  const button = face();
  assert.equal(button.querySelector('[data-level-text]').textContent, 'N5');
  assert.equal(button.querySelector('.level-estimate-title').textContent, 'Estimated study level');
  assert.equal(button.getAttribute('aria-label'), 'JLT estimated study level: N5');
  click(button);
  const detail = headerTextOf(morph());
  assert.ok(!detail.includes('Starting level'), 'starting level untouched while evidence shows');
  control.destroy();
});

test('header fallback: no starting level keeps the legacy insufficient state', async () => {
  const { control, face } = setupHeader({ starting: null });
  await control.load();
  assert.equal(face().querySelector('[data-level-text]').textContent, '—');
  assert.equal(face().getAttribute('aria-label'), 'JLT estimated study level: not enough evidence yet');
  assert.equal(face().querySelector('.level-estimate-title').textContent, 'Estimated study level');
  control.destroy();

  const failing = setupHeader({ startingFails: true });
  await failing.control.load();
  assert.equal(failing.face().querySelector('[data-level-text]').textContent, '—', 'starting fetch failure degrades to no fallback');
  failing.control.destroy();
});

test('header fallback detail renderer covers copy without a browser', () => {
  const doc = new FakeDocument();
  const nodes = renderStartingLevelDetail(makeH(doc), { estimate: 'N4', source: 'quiz' });
  assert.ok(nodes.length > 0);
  const self = renderStartingLevelDetail(makeH(doc), { estimate: 'N2', source: 'self_reported' });
  assert.ok(headerTextOf({ textContent: '', children: self }).includes('JLPT N2'));
});

test('header refreshes on starting-point changes only while evidence is insufficient', async () => {
  const waiting = setupHeader({ starting: null });
  await waiting.control.load();
  assert.equal(waiting.counts.estimate, 1);
  waiting.win.dispatchEvent({ type: 'jlt-starting-point-change' });
  await sleep(20);
  assert.equal(waiting.counts.estimate, 2, 'insufficient header reloads after a starting-point change');
  waiting.control.destroy();

  const evidenced = setupHeader({ payload: estimatedPayload(), starting: quizStartingFx() });
  await evidenced.control.load();
  assert.equal(evidenced.counts.estimate, 1);
  evidenced.win.dispatchEvent({ type: 'jlt-starting-point-change' });
  await sleep(20);
  assert.equal(evidenced.counts.estimate, 1, 'evidenced header ignores starting-point changes');
  evidenced.control.destroy();
});

// --- contract hygiene ---------------------------------------------------------

test('no client scoring: grades stay server-side on every new path', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.match(/answerKey|correctAnswer|isCorrect|correctOption/i), 'no answer-key identifiers');
  assert.ok(!source.includes('scorePlacement'), 'no client-side scoring function');
  assert.ok(!source.match(/\bscore\b/i), 'no scoring wording at all');
  assert.ok(source.includes(SELF_REPORT_PATH), 'self-report endpoint wired');
  assert.ok(source.includes('/api/first-experience/placement/submit'), 'submit endpoint wired');
  assert.ok(source.includes('/api/first-experience/placement/questions'), 'questions endpoint wired');
  assert.ok(source.includes('jlt-starting-point-change'), 'header refresh broadcast wired');
});

test('frozen foundation: new screens reuse tokens, real controls, no hex', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.match(/#[0-9a-fA-F]{3,8}\b/), 'no hex colors in the module');
  for (const token of ['button-primary', 'button-secondary', 'button-ghost', 'eyebrow', 'status-pill', 'text-muted', 'visually-hidden']) {
    assert.ok(source.includes(token), `shared primitive reused: ${token}`);
  }
});
