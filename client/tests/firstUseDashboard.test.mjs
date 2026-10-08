// v5.1-A.4 first-use dashboard — derived empty state over the normal dashboard.
// Pure-logic imports (firstUseDashboard.js only imports firstExperience.js,
// itself import-free, so it loads under node:test) plus static source
// assertions, following the onboarding/placement test patterns. No DOM,
// servers, or network required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRST_USE_COPY,
  FIRST_USE_ACTIONS,
  shouldShowFirstUseDashboard,
  formatFirstUseTarget,
  firstUseEstimateLabel,
  hasFirstUseEstimate,
  firstUseSourceLabels,
  renderFirstUseDashboard
} from '../src/firstUseDashboard.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

// --- fixtures ---------------------------------------------------------------
// Mirror the FIXED contracts: GET /api/dashboard returns
// vocabularyCount/kanjiCount/grammarCount/recentSessions[] (see
// server/src/controllers/dashboardController.js); GET /api/first-experience
// returns onboarding/placement/targetLevel (see src/firstExperience.js).
function emptyDashboard() {
  return {
    minutesToday: 0,
    minutesThisWeek: 0,
    vocabularyCount: 0,
    kanjiCount: 0,
    grammarCount: 0,
    recentSessions: [],
    weeklyActivity: [],
    studyDistribution: []
  };
}

function onboardedFx({ placement = { status: 'skipped', estimate: null, source: null }, targetLevel = null, studySources = [] } = {}) {
  return { onboarding: { completed: true, studySources }, placement, targetLevel };
}

function completedQuizFx({ estimate = 'N4', result = null } = {}) {
  return onboardedFx({ placement: { status: 'completed', estimate, source: 'quiz', completedAt: null, result } });
}

function completedSelfFx({ estimate = 'N4' } = {}) {
  return onboardedFx({ placement: { status: 'completed', estimate, source: 'self_reported', completedAt: null, result: null } });
}

// --- minimal element-factory double (ui.element signature) ------------------

function createHarness({ firstExperience = onboardedFx(), enterPlacement } = {}) {
  const log = { nodes: [], navigations: [], placements: [] };
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
      focus() { this.focused = true; }
    };
    const flat = (Array.isArray(children) ? children : [children]).flat(Infinity).filter(Boolean);
    flat.forEach((child) => node.appendChild(child));
    log.nodes.push(node);
    return node;
  }
  const container = el('main', {});
  const deps = {
    el,
    navigate: (page) => log.navigations.push(page),
    firstExperience,
    ...(enterPlacement ? { enterPlacement } : {})
  };
  if (enterPlacement) {
    const wrapped = deps.enterPlacement;
    deps.enterPlacement = (args) => {
      log.placements.push(args);
      return wrapped(args);
    };
  } else {
    deps.enterPlacement = (args) => log.placements.push(args);
  }
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

function findLink(container, label) {
  const matches = findAll(container, (node) => node.tag === 'a' && textOf(node) === label);
  assert.ok(matches.length > 0, `link "${label}" rendered`);
  return matches[matches.length - 1];
}

async function click(node) {
  for (const fn of node.listeners.click || []) await fn({ preventDefault() {} });
}

// --- condition matrix (pure derivation) -------------------------------------

test('first-use condition: onboarded + empty dashboard shows the starting state', () => {
  assert.equal(
    shouldShowFirstUseDashboard({ firstExperience: onboardedFx(), dashboard: emptyDashboard() }),
    true
  );
});

test('condition matrix: any durable data keeps the normal dashboard', () => {
  const fx = onboardedFx();
  const variants = {
    'first vocabulary word': { ...emptyDashboard(), vocabularyCount: 1 },
    'first kanji character': { ...emptyDashboard(), kanjiCount: 2 },
    'first grammar pattern': { ...emptyDashboard(), grammarCount: 1 },
    'first study session': {
      ...emptyDashboard(),
      recentSessions: [{ id_session: 1, session_date: '2026-09-08', category: 'Reading', duration_minutes: 20 }]
    }
  };
  for (const [label, dashboard] of Object.entries(variants)) {
    assert.equal(shouldShowFirstUseDashboard({ firstExperience: fx, dashboard }), false, label);
  }
});

test('condition matrix: never inferred from placement, target, or malformed shapes', () => {
  const empty = emptyDashboard();
  // Completed placement + explicit target + empty data is STILL first-use:
  // placement/target are presentation inputs, never gates.
  assert.equal(shouldShowFirstUseDashboard({
    firstExperience: onboardedFx({
      placement: { status: 'completed', estimate: 'N5' },
      targetLevel: 'N1',
      studySources: ['manga']
    }),
    dashboard: empty
  }), true, 'placement/target do not force the normal dashboard');
  // Onboarding gate: only completed === true passes.
  assert.equal(shouldShowFirstUseDashboard({
    firstExperience: { onboarding: { completed: false, studySources: [] }, placement: { status: 'not_started', estimate: null }, targetLevel: null },
    dashboard: empty
  }), false, 'incomplete onboarding keeps the normal dashboard');
  assert.equal(shouldShowFirstUseDashboard({ firstExperience: {}, dashboard: empty }), false, 'missing onboarding fails open');
  assert.equal(shouldShowFirstUseDashboard({ firstExperience: null, dashboard: empty }), false, 'missing state fails open');
  assert.equal(shouldShowFirstUseDashboard({ firstExperience: onboardedFx(), dashboard: null }), false, 'missing dashboard fails open');
  assert.equal(shouldShowFirstUseDashboard({}), false, 'empty input fails open');
  // Missing/garbage counts fail open (never invent first-use).
  assert.equal(shouldShowFirstUseDashboard({ firstExperience: onboardedFx(), dashboard: { recentSessions: [] } }), false, 'missing counts fail open');
  assert.equal(shouldShowFirstUseDashboard({
    firstExperience: onboardedFx(),
    dashboard: { ...empty, vocabularyCount: 'many' }
  }), false, 'non-numeric counts fail open');
  assert.equal(shouldShowFirstUseDashboard({
    firstExperience: onboardedFx(),
    dashboard: { ...empty, recentSessions: null }
  }), false, 'non-array sessions fail open');
});

// --- stored-state derivation --------------------------------------------------

test('study target formats from stored state only', () => {
  assert.equal(formatFirstUseTarget('N3'), 'JLPT N3');
  assert.equal(formatFirstUseTarget('N1'), 'JLPT N1');
  assert.equal(formatFirstUseTarget(null), 'No specific JLPT target');
  assert.equal(formatFirstUseTarget(undefined), 'No specific JLPT target');
  assert.equal(formatFirstUseTarget('n3'), 'No specific JLPT target');
  assert.equal(formatFirstUseTarget('N9'), 'No specific JLPT target');
  assert.equal(formatFirstUseTarget(''), 'No specific JLPT target');
});

test('starting estimate reuses the stored placement result', () => {
  assert.equal(firstUseEstimateLabel(onboardedFx({ placement: { status: 'completed', estimate: 'N5', source: 'quiz' } })), 'N5 range');
  assert.equal(firstUseEstimateLabel(onboardedFx({ placement: { status: 'completed', estimate: 'N3', source: 'quiz' } })), 'N3 range');
  assert.equal(firstUseEstimateLabel(completedSelfFx({ estimate: 'N2' })), 'JLPT N2', 'self-report labels as the chosen level, never a range');
  assert.equal(firstUseEstimateLabel(onboardedFx()), 'Not set');
  assert.equal(firstUseEstimateLabel(onboardedFx({ placement: { status: 'not_started', estimate: null } })), 'Not set');
  assert.equal(firstUseEstimateLabel(onboardedFx({ placement: { status: 'completed', estimate: 'N9' } })), 'Not set');
  assert.equal(firstUseEstimateLabel({}), 'Not set');
  assert.equal(hasFirstUseEstimate(onboardedFx({ placement: { status: 'completed', estimate: 'N4' } })), true);
  assert.equal(hasFirstUseEstimate(onboardedFx()), false);
});

test('study sources map slugs to frozen labels, dropping unknowns', () => {
  assert.deepEqual(firstUseSourceLabels(['manga', 'anime-drama']), ['Manga', 'Anime / drama']);
  assert.deepEqual(firstUseSourceLabels(['notes', 'evil', 'manga', 'manga']), ['Personal notes', 'Manga']);
  assert.deepEqual(firstUseSourceLabels([]), []);
  assert.deepEqual(firstUseSourceLabels(null), []);
  assert.deepEqual(firstUseSourceLabels(undefined), []);
});

// --- exact copy -----------------------------------------------------------------

test('copy constants match the brief verbatim', () => {
  assert.equal(FIRST_USE_COPY.heroTitle, 'Your Japanese starts here.');
  assert.equal(FIRST_USE_COPY.heroBody, "NippoTrack is ready. Start with something you're already learning.");
  assert.equal(FIRST_USE_COPY.panelTitle, 'Your starting point');
  assert.equal(FIRST_USE_COPY.noTarget, 'No specific JLPT target');
  assert.equal(FIRST_USE_COPY.noEstimate, 'Not set');
  assert.equal(FIRST_USE_COPY.takePlacement, 'Take quick placement');
  assert.ok(!('retakePlacement' in FIRST_USE_COPY), 'no re-entry copy key');
  assert.equal(FIRST_USE_COPY.actionsTitle, 'Start with something real.');
  assert.equal(FIRST_USE_COPY.growthTitle, 'Your dashboard will grow with your study.');
  assert.equal(FIRST_USE_COPY.growthBody, 'As you collect, review, and log study time, your activity and progress will begin to appear here.');
  assert.deepEqual(FIRST_USE_ACTIONS, [
    {
      title: 'Understand some Japanese',
      description: "Paste a sentence you've encountered and inspect it in context.",
      cta: 'Open Text Analyzer',
      route: 'analyzer'
    },
    {
      title: 'Keep a word',
      description: 'Add vocabulary you actually want to come back to.',
      cta: 'Add vocabulary',
      route: 'vocabulary'
    },
    {
      title: 'Log your study',
      description: 'Record the time you spent listening, reading, speaking, reviewing, or studying.',
      cta: 'Log a study session',
      route: 'sessions'
    }
  ]);
});

test('runtime render shows all four sections in order with exact copy', () => {
  const { container, deps } = createHarness();
  renderFirstUseDashboard(container, deps);
  const text = textOf(container);
  const ordered = [
    'Your Japanese starts here.',
    "NippoTrack is ready. Start with something you're already learning.",
    'Your starting point',
    'Study target',
    'No specific JLPT target',
    'Starting estimate',
    'Not set',
    'Take quick placement',
    'Start with something real.',
    'Understand some Japanese',
    "Paste a sentence you've encountered and inspect it in context.",
    'Open Text Analyzer',
    'Keep a word',
    'Add vocabulary you actually want to come back to.',
    'Add vocabulary',
    'Log your study',
    'Record the time you spent listening, reading, speaking, reviewing, or studying.',
    'Log a study session',
    'Your dashboard will grow with your study.',
    'As you collect, review, and log study time, your activity and progress will begin to appear here.'
  ];
  let cursor = -1;
  for (const line of ordered) {
    const next = text.indexOf(line, cursor + 1);
    assert.ok(next > cursor, `rendered in order: "${line}"`);
    cursor = next;
  }
});

// --- panel states -----------------------------------------------------------------

test('skipped placement renders Not set with a subtle take-placement CTA', () => {
  const { container } = createHarness();
  const { deps } = createHarness({ firstExperience: onboardedFx() });
  renderFirstUseDashboard(container, deps);
  assert.ok(textOf(container).includes('Not set'), 'unset estimate shown');
  findButton(container, 'Take quick placement');
  assert.equal(findAll(container, (node) => node.tag === 'button' && /retake/i.test(textOf(node))).length, 0, 'no re-entry action without a stored estimate');
  assert.equal(findAll(container, (node) => node.tag === 'dt' && textOf(node) === 'Study sources').length, 0, 'sources row omitted when empty');
});

test('completed placement renders the condensed shared diagram with no action', () => {
  const fx = onboardedFx({ placement: { status: 'completed', estimate: 'N4', source: 'quiz' } });
  const { container, deps } = createHarness({ firstExperience: fx });
  renderFirstUseDashboard(container, deps);
  const text = textOf(container);
  assert.ok(text.includes('N4 range'), 'stored estimate shown as a range');
  assert.ok(text.includes('STARTING ESTIMATE'), 'shared diagram header shown');
  assert.ok(text.includes('Quick Placement'), 'quiz source line shown');
  assert.ok(!text.includes('QUIZ RESULT'), 'estimate-only variant without stored counts');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 0, 'no placement action of any kind once completed');
  assert.ok(!text.match(/retake/i), 'no re-entry wording anywhere');
});

test('completed placement with stored counts renders the breakdown verbatim', () => {
  const fx = onboardedFx({
    placement: {
      status: 'completed',
      estimate: 'N3',
      source: 'quiz',
      completedAt: null,
      result: {
        totalCorrect: 6,
        byBand: {
          N5: { correct: 3, total: 4 },
          N4: { correct: 2, total: 3 },
          N3: { correct: 1, total: 3 }
        }
      }
    }
  });
  const { container, deps } = createHarness({ firstExperience: fx });
  renderFirstUseDashboard(container, deps);
  const text = textOf(container);
  assert.ok(text.includes('QUIZ RESULT'), 'breakdown heading shown');
  assert.ok(text.includes('6 / 10 correct'), 'stored total shown verbatim');
  assert.ok(text.includes('N3 — 1 of 3 correct'), 'stored row shown, never hidden');
  assert.ok(!text.match(/N2/), 'no N2 row (quiz bank is N5/N4/N3)');
  assert.ok(!text.match(/N1/), 'no N1 row (quiz bank is N5/N4/N3)');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 0, 'still no placement action');
});

test('completed self-report renders the chosen level with no score and no action', () => {
  const { container, deps } = createHarness({ firstExperience: completedSelfFx({ estimate: 'N2' }) });
  renderFirstUseDashboard(container, deps);
  const text = textOf(container);
  assert.ok(text.includes('Starting level'), 'starting-level label shown');
  assert.ok(text.includes('JLPT N2'), 'chosen level shown');
  assert.ok(text.includes('Self-reported'), 'self-reported source shown');
  assert.ok(!text.includes('N2 range'), 'never rendered as a quiz range');
  assert.ok(!text.includes('QUIZ RESULT'), 'no breakdown section');
  assert.ok(!text.match(/\/ 10 correct/), 'no score line');
  assert.ok(!text.match(/[●○]/), 'no dots');
  assert.ok(!text.match(/%/), 'no percentages');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 0, 'no placement action of any kind once completed');
  assert.ok(!text.match(/retake/i), 'no re-entry wording anywhere');
});

test('target and estimate render side by side without implying a match', () => {
  const fx = onboardedFx({ placement: { status: 'completed', estimate: 'N5' }, targetLevel: 'N2' });
  const { container, deps } = createHarness({ firstExperience: fx });
  renderFirstUseDashboard(container, deps);
  const text = textOf(container);
  assert.ok(text.includes('JLPT N2'), 'stored target shown');
  assert.ok(text.includes('N5 range'), 'stored estimate shown');
  assert.doesNotMatch(text, /match/i, 'never implies the target should match the estimate');
  assert.doesNotMatch(text, /should be/i, 'no prescriptive wording');
});

test('sources row appears only when sources exist, as joined labels', () => {
  const withSources = createHarness({
    firstExperience: onboardedFx({ studySources: ['manga', 'anime-drama'] })
  });
  renderFirstUseDashboard(withSources.container, withSources.deps);
  assert.ok(textOf(withSources.container).includes('Manga, Anime / drama'), 'labels joined');
  const empty = createHarness();
  renderFirstUseDashboard(empty.container, empty.deps);
  assert.ok(!textOf(empty.container).includes('Study sources'), 'row omitted when empty');
});

// --- navigation: real routes, zero writes --------------------------------------------

test('action cards navigate through existing routes with zero placement calls', async () => {
  const { log, container, deps } = createHarness();
  renderFirstUseDashboard(container, deps);
  await click(findLink(container, 'Open Text Analyzer'));
  await click(findLink(container, 'Add vocabulary'));
  await click(findLink(container, 'Log a study session'));
  assert.deepEqual(log.navigations, ['analyzer', 'vocabulary', 'sessions']);
  assert.equal(log.placements.length, 0, 'card clicks never enter placement');
});

test('take-quick-placement CTA reuses the A.3 flow with the router', async () => {
  const { log, container, deps } = createHarness();
  renderFirstUseDashboard(container, deps);
  await click(findButton(container, 'Take quick placement'));
  assert.equal(log.placements.length, 1, 'placement entered once');
  assert.equal(typeof log.placements[0].navigate, 'function', 'router handed to the A.3 hook');
  assert.deepEqual(log.navigations, [], 'no route change from the CTA itself');
});

test('completed placement offers no placement path (one-time result)', async () => {
  const fx = onboardedFx({ placement: { status: 'completed', estimate: 'N3' } });
  const { log, container, deps } = createHarness({ firstExperience: fx });
  renderFirstUseDashboard(container, deps);
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 0, 'no buttons at all once completed');
  assert.equal(log.placements.length, 0, 'nothing enters the placement flow');
  assert.ok(!textOf(container).match(/retake/i), 'no re-entry wording');
});

test('take reuses enterPlacement: import asserted, no duplicate implementation', () => {
  const source = readSource('src/firstUseDashboard.js');
  assert.ok(source.includes("from './firstExperience.js'"), 'extends A.2/A.3 via their exports');
  assert.ok(source.includes('enterPlacement'), 'A.3 hook reused');
  assert.ok(!source.includes('/api/first-experience/placement'), 'no placement endpoints touched');
  assert.ok(!source.includes('placement/questions') && !source.includes('placement/submit') && !source.includes('placement/skip'), 'no quiz flow duplicated');
  assert.ok(!source.match(/\['N5'/), 'no redefined level band list');
  assert.ok(!source.includes('localStorage') && !source.includes('sessionStorage'), 'no persistence duplicated');
});

test('no hidden tracking writes anywhere in the module', () => {
  const source = readSource('src/firstUseDashboard.js');
  for (const token of ['POST', 'PUT', 'PATCH', 'DELETE', 'fetch(', 'apiRequest', 'sendBeacon', 'XMLHttpRequest']) {
    assert.ok(!source.includes(token), `no network-write surface: ${token}`);
  }
  const allBindings = [...source.matchAll(/\.addEventListener\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(allBindings, ['click', 'click'], 'every listener is an audited click binding');
  const clickBindings = (source.match(/\.addEventListener\('click'/g) || []).length;
  assert.equal(clickBindings, 2, 'click logic in exactly two places: card links + placement CTA');
});

// --- a11y ------------------------------------------------------------------------------

test('a11y: semantic headings, real controls, labelled rows, calm assistive surface', () => {
  const fx = onboardedFx({
    placement: { status: 'completed', estimate: 'N4' },
    targetLevel: 'N3',
    studySources: ['manga']
  });
  const { log, container, deps } = createHarness({ firstExperience: fx });
  renderFirstUseDashboard(container, deps);
  // Heading order: one h1, then h2 sections, then h3 cards.
  const h1 = findAll(container, (node) => node.tag === 'h1');
  assert.equal(h1.length, 1, 'single page heading');
  assert.equal(textOf(h1[0]), 'Your Japanese starts here.');
  assert.deepEqual(
    findAll(container, (node) => node.tag === 'h2').map(textOf),
    ['Your starting point', 'Start with something real.', 'Your dashboard will grow with your study.']
  );
  assert.deepEqual(
    findAll(container, (node) => node.tag === 'h3').map(textOf),
    ['N4 range', 'Understand some Japanese', 'Keep a word', 'Log your study']
  );
  // Every interactive node is a real button or link — no clickable divs.
  // Completed state: exactly the 3 card links, zero buttons, zero placement path.
  const interactive = log.nodes.filter((node) => (node.listeners.click || []).length > 0);
  assert.equal(interactive.length, 3, 'exactly three interactive controls once completed: the card links');
  for (const node of interactive) {
    assert.ok(['a', 'button'].includes(node.tag), `real control, not a clickable ${node.tag}`);
  }
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 0, 'no buttons once completed');
  for (const link of findAll(container, (node) => node.tag === 'a')) {
    assert.ok(String(link.getAttribute('href') || '').startsWith('#'), 'links carry real destinations');
  }
  for (const link of findAll(container, (node) => node.tag === 'a')) {
    assert.ok(link.className.includes('button-'), '44px shared primitive on card links');
  }
  // Take state keeps the single CTA on the shared 44px primitive.
  const take = createHarness();
  renderFirstUseDashboard(take.container, take.deps);
  const ctas = findAll(take.container, (node) => node.tag === 'button');
  assert.equal(ctas.length, 1, 'single Take CTA before completion');
  assert.equal(ctas[0].getAttribute('type'), 'button', 'real button, no accidental submit');
  assert.ok(ctas[0].className.includes('button-'), '44px shared button primitive');
  // Screen-reader hooks: labelled panel/actions sections, dt/dd rows.
  assert.deepEqual(
    findAll(container, (node) => node.tag === 'dt').map(textOf),
    ['Study target', 'Starting estimate', 'Study sources']
  );
  assert.ok(findAll(container, (node) => (node.getAttribute('aria-labelledby') || '').startsWith('first-use-')).length >= 2, 'sections labelled by their headings');
  assert.equal(findAll(container, (node) => node.attributes.has('aria-live')).length, 0, 'no live-region chatter');
  assert.doesNotMatch(textOf(container), /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/, 'no Japanese copy, so no lang hooks required');
});

test('render requires an element factory and tolerates a missing router', () => {
  const { container } = createHarness();
  assert.throws(() => renderFirstUseDashboard(container, {}), /element factory/);
  assert.doesNotThrow(() => renderFirstUseDashboard(container, { el: createHarness().el, firstExperience: onboardedFx() }), 'hash fallback covers a missing navigate');
});

// --- motion / responsive / frozen tokens --------------------------------------------------

test('motion: initial reveal + tiny stagger on the 3 cards only, reduced-motion instant', () => {
  const css = readSource('src/styles.css');
  const block = css.slice(css.indexOf('v5.1-A.4 first-use dashboard'));
  assert.ok(block.length > 0, 'first-use styles grouped in one additive block');
  assert.ok(block.includes('.first-use-screen'), 'initial reveal class present');
  assert.ok(block.includes('@keyframes first-use-enter'), 'single enter keyframes');
  assert.ok(block.includes('.first-use-cards > .first-use-card:nth-child(2)') && block.includes('70ms'), 'second card stagger');
  assert.ok(block.includes('.first-use-cards > .first-use-card:nth-child(3)') && block.includes('140ms'), 'third card stagger');
  assert.ok(!block.includes('nth-child(4)'), 'stagger covers exactly the 3 cards');
  assert.ok(block.includes('prefers-reduced-motion') && block.includes('animation: none'), 'reduced-motion renders instantly');
  assert.ok(!block.includes('infinite') && !block.includes('animation-iteration-count'), 'no loops, no confetti');
});

test('responsive hooks: calm asymmetric desktop, tablet step, single-column mobile', () => {
  const source = readSource('src/firstUseDashboard.js');
  assert.ok(source.includes('grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'), 'desktop asymmetric calm composition');
  assert.ok(source.includes('sm:grid-cols-3 lg:grid-cols-1'), 'tablet interpolation, calm desktop stack');
  assert.ok(source.includes('first-use-cards mt-4 grid gap-3'), 'mobile single column base');
  assert.ok(source.includes('break-words'), 'long copy wraps instead of overflowing');
  assert.ok(source.includes('min-w-0'), 'grid children can shrink on narrow viewports');
  assert.ok(!source.match(/w-\[\d+px/) && !source.match(/min-w-\[\d/), 'no fixed pixel widths');
  // Breakpoint ladder verified statically via the sm:/lg: hooks above: the
  // fluid grid + wrapping copy hold 1440/1280/1024/768/414/390/375/360/320
  // with no viewport-specific overrides to drift.
});

test('frozen foundation: shared primitives + tokens only, themes follow automatically', () => {
  const source = readSource('src/firstUseDashboard.js');
  assert.ok(!source.match(/#[0-9a-fA-F]{3,8}\b/), 'no hex colors in the module');
  for (const token of ['surface', 'button-secondary', 'button-ghost', 'text-muted', 'text-ink', 'font-display']) {
    assert.ok(source.includes(token), `shared primitive reused: ${token}`);
  }
  const css = readSource('src/styles.css');
  const block = css.slice(css.indexOf('v5.1-A.4 first-use dashboard'));
  assert.ok(!block.match(/#[0-9a-fA-F]{3,8}\b/), 'no hex colors in the first-use styles');
});

// --- dashboard wiring (static: dashboard.js is browser-bundled, not node-safe) ---------------

test('dashboard wiring: lazy first-use branch, fail-open, normal snapshot untouched', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes("await import('../firstUseDashboard.js')"), 'first-use module lazy-loaded, out of the initial bundle');
  assert.ok(!source.match(/^import .*firstUseDashboard/m), 'no static import of the first-use module');
  assert.ok(source.includes('shouldShowFirstUseDashboard'), 'derived condition consulted');
  assert.ok(source.includes('renderFirstUseDashboard'), 'first-use renderer consulted');
  assert.ok(source.includes('/api/first-experience') && source.includes('notifyAuth: false'), 'stored state fetched without auth side effects');
  assert.ok(source.includes('Fail open to the normal dashboard'), 'fetch trouble falls through to normal');
  assert.ok(source.includes('isEmptyDashboardSnapshot'), 'cheap pre-check guards the extra fetch');
  for (const marker of ['Recent sessions', 'Activity calendar', 'Active goals', 'View detailed analytics in Statistics']) {
    assert.ok(source.includes(marker), `normal dashboard intact: ${marker}`);
  }
  // The first-use wiring branch (empty-snapshot gate → first-experience
  // fetch → first-use render) issues zero writes; unrelated dashboard
  // surfaces (Study-Now session POST, etc.) are out of this audit.
  const branchStart = source.indexOf('v5.1-A.4 first-use state');
  const branchEnd = source.indexOf('Fail open to the normal dashboard', branchStart);
  assert.ok(branchStart !== -1 && branchEnd > branchStart, 'first-use wiring block located');
  const branch = source.substring(branchStart, branchEnd);
  assert.ok(!branch.includes("method: 'POST'") && !branch.includes('method: "POST"'), 'first-use branch posts nothing');
  assert.ok(!branch.includes("method: 'PUT'") && !branch.includes('method: "PUT"'), 'first-use branch puts nothing');
});
