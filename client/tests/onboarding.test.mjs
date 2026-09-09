// v5.1-A.2 new-user onboarding — gate, copy, payloads, a11y, motion.
// Pure-logic imports (firstExperience.js has zero imports, so it loads
// under node:test) plus static source assertions, following the
// levelEstimateControl / navigation test patterns. No DOM, servers, or
// network required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TARGET_LEVELS,
  STUDY_SOURCES,
  STUDY_SOURCE_VALUES,
  isValidFirstExperienceTarget,
  sanitizeStudySources,
  shouldShowOnboarding,
  resolveOnboardingVisibility,
  skipSetupPayload,
  buildOnboardingPayload,
  enterPlacement,
  renderFirstExperience
} from '../src/firstExperience.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- minimal element-factory double (ui.element signature) -----------------

function createHarness({ apiImpl } = {}) {
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
  const api = apiImpl || (async (path, options) => {
    log.apiCalls.push({ path, ...options });
    return { ok: true };
  });
  const deps = {
    el,
    api,
    navigate: (page) => log.navigations.push(page),
    notify: (message, type) => log.notices.push({ message, type }),
    onComplete: () => log.navigations.push('__complete__'),
    onEnterPlacement: () => log.navigations.push('__placement__')
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

async function click(node) {
  for (const fn of node.listeners.click || []) await fn();
}

async function walkToStep(container, step) {
  if (step >= 2) await click(findButton(container, 'Set up NippoTrack'));
  if (step >= 3) await click(findButton(container, 'Continue'));
  if (step >= 4) await click(findButton(container, 'Continue'));
}

// --- gate ------------------------------------------------------------------

test('gate: incomplete server state shows onboarding', () => {
  assert.equal(shouldShowOnboarding({ onboarding: { completed: false, studySources: [] } }), true);
  assert.equal(resolveOnboardingVisibility({ data: { onboarding: { completed: false } } }), true);
});

test('gate: completed onboarding never shows again', () => {
  assert.equal(shouldShowOnboarding({ onboarding: { completed: true, studySources: [] } }), false);
  assert.equal(resolveOnboardingVisibility({ data: { onboarding: { completed: true } } }), false);
});

test('gate: fail-open on fetch error or malformed shape', () => {
  assert.equal(resolveOnboardingVisibility({ error: new Error('network down') }), false);
  assert.equal(resolveOnboardingVisibility({ data: null }), false);
  assert.equal(resolveOnboardingVisibility({ data: {} }), false);
  assert.equal(resolveOnboardingVisibility({ data: { onboarding: {} } }), false);
  assert.equal(resolveOnboardingVisibility({}), false);
});

test('boot gate fails open: main.js wraps the fetch in try/catch and falls through', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes("await apiRequest('/api/first-experience', { notifyAuth: false })"), 'contract endpoint fetched without auth side effects');
  assert.ok(main.includes('firstExperience?.onboarding?.completed === false'), 'strict incomplete check');
  assert.ok(main.includes("await import('./firstExperience.js')"), 'lazy-loaded, out of the initial + public bundles');
  assert.ok(!main.match(/^import .*firstExperience/m), 'no static import of the onboarding module');
  const gate = main.slice(main.indexOf('/api/first-experience'));
  assert.ok(gate.includes('} catch {'), 'fetch failure caught');
});

test('navigate() guard keeps setup rendered so back/forward cannot break it', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes('firstExperienceSession?.active'), 'navigate consults the session');
  assert.ok(main.includes('firstExperienceSession.reshow()'), 'hash/back/forward re-show setup');
});

// --- exact copy, in order ----------------------------------------------------

test('all four screens render the exact contract copy, in order', () => {
  const source = readSource('src/firstExperience.js');
  // Per-screen ordered copy (source constructs buttons before the shell
  // call, so global file order != screen order; runtime order is covered
  // by the walkthrough test below).
  const screens = [
    ['FIRST SETUP', 'Welcome to NippoTrack.', 'Your Japanese learning is already yours.',
      'set up a starting point that makes sense for you.', 'Set up NippoTrack', 'Skip setup'],
    ['YOUR DIRECTION', 'Do you have a JLPT target?',
      'Choose one if the JLPT is part of your plan. You can change this later.',
      'No specific JLPT target',
      'This is your study target, not an estimate of your current level.'],
    ['HOW YOU STUDY', 'How do you usually study Japanese?',
      'Choose the sources that are already part of your routine.'],
    ['STARTING POINT', 'Want a quick starting estimate?',
      'Answer 10 short Japanese questions to get a useful starting reference.',
      'About 2 minutes', 'This is a starting estimate, not an official JLPT assessment.',
      'Take quick placement', 'Skip for now']
  ];
  const functions = ['function renderWelcome', 'function renderDirection', 'function renderSources', 'function renderStartingPoint'];
  screens.forEach((lines, index) => {
    // Presence per screen (source constructs buttons before the shell
    // call, so intra-screen file order != render order — render order is
    // asserted at runtime in the walkthrough test).
    const start = source.indexOf(functions[index]);
    const end = index + 1 < functions.length ? source.indexOf(functions[index + 1]) : source.length;
    assert.ok(start >= 0 && end > start, `render function located for screen ${index + 1}`);
    const slice = source.slice(start, end);
    for (const line of lines) {
      assert.ok(slice.includes(line), `screen ${index + 1} contains: "${line}"`);
    }
  });
  assert.ok(source.includes('`JLPT ${level}`'), 'JLPT options rendered from the N5..N1 band list (expansion proven at runtime)');
  assert.ok(source.includes('...TARGET_LEVELS.map'), 'options derive from the frozen band list');
  for (const label of ['Textbooks', 'Anime / drama', 'Manga', 'YouTube', 'Classes', 'Flashcards', 'Conversations', 'Apps', 'Personal notes', 'Other']) {
    assert.ok(source.includes(label), `source label present: ${label}`);
  }
});

test('wizard walkthrough renders the four screens in order at runtime', async () => {
  const { container, deps } = createHarness();
  renderFirstExperience(container, deps);
  const screenText = () => textOf(container);
  const expectInOrder = (lines) => {
    let cursor = -1;
    for (const line of lines) {
      const next = screenText().indexOf(line, cursor + 1);
      assert.ok(next > cursor, `rendered in order: "${line}"`);
      cursor = next;
    }
  };
  expectInOrder(['FIRST SETUP', 'Welcome to NippoTrack.',
    "Your Japanese learning is already yours. Let's set up a starting point that makes sense for you.",
    'Set up NippoTrack', 'Skip setup']);
  await click(findButton(container, 'Set up NippoTrack'));
  expectInOrder(['YOUR DIRECTION', 'Do you have a JLPT target?',
    'Choose one if the JLPT is part of your plan. You can change this later.',
    'JLPT N5', 'JLPT N1', 'No specific JLPT target',
    'This is your study target, not an estimate of your current level.',
    'Back', 'Continue']);
  await click(findButton(container, 'Continue'));
  expectInOrder(['HOW YOU STUDY', 'How do you usually study Japanese?',
    'Choose the sources that are already part of your routine.',
    'Textbooks', 'Anime / drama', 'Manga', 'YouTube', 'Classes',
    'Flashcards', 'Conversations', 'Apps', 'Personal notes', 'Other',
    'Back', 'Continue']);
  await click(findButton(container, 'Continue'));
  expectInOrder(['STARTING POINT', 'Want a quick starting estimate?',
    'Answer 10 short Japanese questions to get a useful starting reference.',
    'About 2 minutes', 'This is a starting estimate, not an official JLPT assessment.',
    'Take quick placement', 'Skip for now']);
});

// --- sources + targets -------------------------------------------------------

test('study source slugs/labels match the fixed contract allowlist', () => {
  assert.deepEqual(STUDY_SOURCE_VALUES, ['textbooks', 'anime-drama', 'manga', 'youtube', 'classes', 'flashcards', 'conversations', 'apps', 'notes', 'other']);
  assert.equal(STUDY_SOURCES.length, 10);
  assert.deepEqual(TARGET_LEVELS, ['N5', 'N4', 'N3', 'N2', 'N1']);
});

test('sources allowlist enforced client-side: unknown dropped, de-duplicated', () => {
  assert.deepEqual(sanitizeStudySources(['manga', 'evil', 'anime-drama', 'manga']), ['manga', 'anime-drama']);
  assert.deepEqual(sanitizeStudySources([]), []);
  assert.deepEqual(sanitizeStudySources(null), []);
  assert.deepEqual(sanitizeStudySources('manga'), []);
});

test('target validation accepts only null and exact N5..N1', () => {
  assert.equal(isValidFirstExperienceTarget(null), true);
  assert.equal(isValidFirstExperienceTarget('N3'), true);
  assert.equal(isValidFirstExperienceTarget('n3'), false);
  assert.equal(isValidFirstExperienceTarget('N6'), false);
  assert.equal(isValidFirstExperienceTarget(''), false);
  assert.equal(isValidFirstExperienceTarget(undefined), false);
  assert.throws(() => buildOnboardingPayload({ targetLevel: 'N6', studySources: [] }));
  assert.throws(() => buildOnboardingPayload({ targetLevel: null, studySources: [], placementStatus: 'completed' }));
});

// --- payloads -----------------------------------------------------------------

test('skip setup completes with no invented data', async () => {
  const { log, container, deps } = createHarness();
  renderFirstExperience(container, deps);
  await click(findButton(container, 'Skip setup'));
  await sleep(10);
  assert.equal(log.apiCalls.length, 1);
  assert.deepEqual(log.apiCalls[0], {
    path: '/api/first-experience/onboarding',
    method: 'PUT',
    body: { targetLevel: null, studySources: [] }
  });
  assert.deepEqual(skipSetupPayload(), { targetLevel: null, studySources: [] });
  assert.ok(log.navigations.includes('__complete__'), 'skip routes to dashboard via onComplete');
});

test('skip placement carries placementStatus skipped with chosen values', async () => {
  const { log, container, deps } = createHarness();
  renderFirstExperience(container, deps);
  await click(findButton(container, 'Set up NippoTrack'));
  await click(findButton(container, 'JLPT N3'));
  await click(findButton(container, 'Continue'));
  await click(findButton(container, 'Manga'));
  await click(findButton(container, 'Continue'));
  await click(findButton(container, 'Skip for now'));
  await sleep(10);
  assert.equal(log.apiCalls.length, 1);
  assert.deepEqual(log.apiCalls[0].body, {
    targetLevel: 'N3',
    studySources: ['manga'],
    placementStatus: 'skipped'
  });
  assert.ok(log.navigations.includes('__complete__'), 'skip routes to dashboard via onComplete');
});

test('take placement completes without placementStatus, then calls the A.3 hook', async () => {
  const { log, container, deps } = createHarness();
  renderFirstExperience(container, deps);
  await walkToStep(container, 4);
  await click(findButton(container, 'Take quick placement'));
  await sleep(10);
  assert.equal(log.apiCalls.length, 1);
  assert.deepEqual(log.apiCalls[0].body, { targetLevel: null, studySources: [] });
  assert.ok(!('placementStatus' in log.apiCalls[0].body), 'no placementStatus on the placement path');
  assert.ok(log.navigations.includes('__placement__'), 'A.3 hook invoked after completion');
});

test('save failure toasts and stays on the step (never traps, never loses choices)', async () => {
  const { log, container, deps } = createHarness({
    apiImpl: async (path, options) => {
      log.apiCalls.push({ path, ...options });
      throw new Error('Unable to save your setup. Please try again.');
    }
  });
  renderFirstExperience(container, deps);
  await click(findButton(container, 'Skip setup'));
  await sleep(10);
  assert.equal(log.notices.length, 1);
  assert.equal(log.notices[0].type, 'error');
  assert.ok(!log.navigations.includes('__complete__'), 'no navigation on failure');
  assert.ok(textOf(container).includes('Welcome to NippoTrack.'), 'still on screen 1 with choices intact');
});

// --- reload semantics ----------------------------------------------------------

test('reload semantics are server-driven: no half-progress persistence', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.includes('localStorage'), 'no local persistence');
  assert.ok(!source.includes('sessionStorage'), 'no session persistence');
  // A fresh render always starts at screen 1; only the server decides.
  const { container, deps } = createHarness();
  const session = renderFirstExperience(container, deps);
  assert.ok(textOf(container).includes('Welcome to NippoTrack.'));
  assert.equal(session.active, true);
  session.finish();
  assert.equal(session.active, false);
});

// --- keyboard / focus / step semantics ------------------------------------------

test('keyboard + focus: real buttons, visible focus target, step semantics, no live-region spam', async () => {
  const { log, container, deps } = createHarness();
  renderFirstExperience(container, deps);
  const assertStep = (step) => {
    const section = findAll(container, (node) => node.tag === 'section').at(-1);
    assert.ok(section, `step ${step} section rendered`);
    assert.equal(section.getAttribute('aria-label'), `Step ${step} of 4`);
    const current = findAll(container, (node) => node.getAttribute('aria-current') === 'step');
    assert.equal(current.length, 1, `exactly one aria-current step on screen ${step}`);
    const buttons = findAll(container, (node) => node.tag === 'button');
    assert.ok(buttons.length > 0, `step ${step} has buttons`);
    for (const button of buttons) {
      assert.equal(button.getAttribute('type'), 'button', 'real buttons (no accidental submits)');
      assert.ok(button.className.includes('button-'), '44px shared button primitive');
    }
    const liveRegions = findAll(container, (node) => node.attributes.has('aria-live'));
    assert.equal(liveRegions.length, 0, 'no aria-live spam inside the wizard');
  };
  assertStep(1);
  await click(findButton(container, 'Set up NippoTrack'));
  assertStep(2);
  await click(findButton(container, 'Continue'));
  assertStep(3);
  await click(findButton(container, 'Continue'));
  assertStep(4);
  assert.ok(log.focused, 'a heading receives focus on step change');
  assert.ok(['H1', 'H2'].includes(String(log.focused.tag).toUpperCase()), 'focus lands on the step heading');
});

test('option toggles expose pressed state for assistive tech', async () => {
  const { container, deps } = createHarness();
  renderFirstExperience(container, deps);
  await click(findButton(container, 'Set up NippoTrack'));
  assert.equal(findButton(container, 'JLPT N5').getAttribute('aria-pressed'), 'false');
  await click(findButton(container, 'JLPT N5'));
  assert.equal(findButton(container, 'JLPT N5').getAttribute('aria-pressed'), 'true');
  await click(findButton(container, 'Continue'));
  assert.equal(findButton(container, 'Manga').getAttribute('aria-pressed'), 'false');
  await click(findButton(container, 'Manga'));
  assert.equal(findButton(container, 'Manga').getAttribute('aria-pressed'), 'true');
});

// --- motion / responsive / tokens -------------------------------------------------

test('motion: subtle enter transition with reduced-motion fallback', () => {
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.first-exp-screen'), 'wizard enter class present');
  assert.ok(css.includes('@keyframes first-exp-enter'), 'fade/translate keyframes present');
  const reduced = css.slice(css.indexOf('.first-exp-screen'));
  assert.ok(reduced.includes('prefers-reduced-motion'), 'reduced-motion makes the transition instant');
});

test('responsive: centered, bounded focused panel (never a tiny modal)', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(source.includes('mx-auto w-full max-w-xl'), 'centered panel capped near one column');
  assert.ok(source.includes('p-6 sm:p-8'), 'breathing room that scales up, not an over-tall mobile sheet');
  assert.ok(source.includes('sm:grid-cols-2'), 'sources grid adapts to narrow viewports');
});

test('frozen foundation: no new palette in the module or its styles', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.match(/#[0-9a-fA-F]{3,8}\b/), 'no hex colors in the module');
  const css = readSource('src/styles.css');
  const block = css.slice(css.indexOf('v5.1-A.2 first-experience'));
  assert.ok(block.length > 0, 'onboarding styles grouped in one additive block');
  assert.ok(!block.match(/#[0-9a-fA-F]{3,8}\b/), 'no hex colors in the onboarding styles');
});

// --- A.3 hook + bundle hygiene -----------------------------------------------------

test('enterPlacement (A.3): fails open to dashboard without a DOM container', () => {
  const calls = [];
  const session = enterPlacement({ navigate: (page) => calls.push(page) });
  assert.deepEqual(calls, ['dashboard']);
  assert.equal(session.active, false);
});

test('enterPlacement (A.3): placement flow wired to the fixed contract', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(source.includes('/api/first-experience/placement/questions'), 'questions endpoint wired');
  assert.ok(source.includes('/api/first-experience/placement/submit'), 'submit endpoint wired');
  assert.ok(source.includes('/api/first-experience/placement/skip'), 'skip endpoint wired');
  assert.ok(!source.includes('TODO(A.3)'), 'handoff implemented, marker retired');
});

test('no public-bundle import of the onboarding module', () => {
  for (const path of ['src/landing/landing.js', 'src/landing/howItWorks.js', 'src/landing/sections.js', 'src/landing/routing.js']) {
    assert.ok(!readSource(path).includes('firstExperience'), `${path} stays public-safe`);
  }
});
