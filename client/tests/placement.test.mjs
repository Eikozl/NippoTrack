// v5.1-A.3 quick placement — flow, payloads, copy, a11y, no-answer-leak.
// Pure-logic imports (firstExperience.js has zero static imports, so it
// loads under node:test) plus static source assertions, following the
// onboarding test pattern. No DOM, servers, or network required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLACEMENT_TOTAL,
  PLACEMENT_ESTIMATES,
  PLACEMENT_BANDS,
  PLACEMENT_SOURCES,
  SELF_REPORT_LEVELS,
  SELF_REPORT_PATH,
  PLACEMENT_COPY,
  PLACEMENT_SUBMIT_MIN_MS,
  isValidPlacementEstimate,
  isValidSelfReportLevel,
  normalizePlacementSource,
  buildSelfReportPayload,
  sanitizePlacementQuestions,
  sanitizePlacementResult,
  buildPlacementSubmitPayload,
  isPlacementAbstained,
  isPlacementResolved,
  placementQuestionLabel,
  placementAnsweredLabel,
  countPlacementAnswered,
  placementUnansweredIndexes,
  placementResultTitle,
  placementResultCopy,
  selfReportResultTitle,
  placementEstimateFromState,
  placementResultFromState,
  formatPlacementCompletedDate,
  placementBandRowText,
  placementBandSrText,
  placementBandDots,
  placementResultNode,
  selfReportResultNode,
  renderPlacement,
  enterPlacement
} from '../src/firstExperience.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- fixtures ---------------------------------------------------------------
// Mirrors the FIXED contract shape with the NippoTrack pool ID convention
// (n5_*/n4_*/n3_*): the server selects 10 per learner, so IDs vary per user
// and the client keeps them verbatim. Rogue keys prove the client allowlist:
// whatever extra material travels with the response never reaches state,
// payloads, or the DOM. (No correctness data lives client-side, ever.)
const PLACEMENT_FIXTURE_IDS = [
  'n5_01', 'n5_02', 'n4_01', 'n4_02', 'n3_01',
  'n3_02', 'n5_03', 'n4_03', 'n3_03', 'n3_04'
];
function buildQuestions() {
  const first = {
    id: 'n5_01',
    prompt: {
      text: '水をのみます。水のよみ方は？',
      reading: 'みずをのみます',
      translation: 'How do you read 水?'
    },
    options: [
      { id: 'a', text: 'みず', reading: 'みず', gloss: 'water' },
      { id: 'b', text: 'すい', reading: 'すい', gloss: 'water (on reading)' },
      { id: 'c', text: 'みす', reading: 'みす', gloss: 'to miss' },
      { id: 'd', text: 'むず', reading: 'むず', gloss: 'difficult (stem)' }
    ],
    level: 'N5',
    answer: 'a',
    isCorrect: [true, false, false, false]
  };
  const rest = PLACEMENT_FIXTURE_IDS.slice(1).map((id, offset) => {
    const number = offset + 2;
    return {
      id,
      prompt: {
        text: `これは質問${number}です。`,
        reading: `これはしつもん${number}です。`,
        translation: `This is question ${number}.`
      },
      options: ['あ', 'い', 'う', 'え'].map((kana, optionIndex) => ({
        id: ['a', 'b', 'c', 'd'][optionIndex],
        text: kana,
        reading: kana,
        gloss: `choice ${optionIndex + 1}`
      })),
      band: 'N4',
      correctOptionId: 'a'
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

// Stored breakdown fixture: server-computed counts only. The quiz bank
// covers N5/N4/N3 only, so fixtures carry exactly those three bands — the
// client never derives these and never renders N2/N1 rows.
function buildStoredResult({ totalCorrect = 6, bands = null } = {}) {
  return {
    totalCorrect,
    byBand: bands || {
      N5: { correct: 3, total: 4 },
      N4: { correct: 2, total: 3 },
      N3: { correct: 1, total: 3 }
    }
  };
}

function completedFx({ estimate = 'N4', source = null, result = null, completedAt = null } = {}) {
  return {
    onboarding: { completed: true, studySources: [] },
    placement: { status: 'completed', estimate, source, completedAt, result },
    targetLevel: null
  };
}

function completedQuizFx(options = {}) {
  return completedFx({ source: 'quiz', ...options });
}

function conflictError(message = 'Placement already completed.') {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function createApiMock({ questions = buildQuestions(), estimate = 'N3', source = 'quiz', result = null, fx = null, failQuestions = false, failSubmit = false, failSelfReport = false, failSkip = false, failFirstQuestions = false, submitConflict = false, selfReportConflict = false, questionsConflict = false } = {}) {
  const log = { calls: [], questionCalls: 0 };
  const api = async (path, options = {}) => {
    log.calls.push({ path, ...options });
    if (path === FX_PATH) return fx || notStartedFx();
    if (path === QUESTIONS_PATH) {
      log.questionCalls += 1;
      if (questionsConflict) throw conflictError();
      if (failQuestions || (failFirstQuestions && log.questionCalls === 1)) throw new Error('Network down.');
      return questions;
    }
    if (path === SUBMIT_PATH) {
      if (submitConflict) throw conflictError();
      if (failSubmit) throw new Error('Unable to save your answers. Please try again.');
      return { estimate, placement: { status: 'completed', estimate, source, ...(result ? { result } : {}) } };
    }
    if (path === SELF_REPORT_PATH) {
      if (selfReportConflict) throw conflictError();
      if (failSelfReport) throw new Error('Unable to save your starting level. Please try again.');
      return { estimate, placement: { status: 'completed', estimate, source: 'self_reported' } };
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

function createPlacementHarness({ apiImpl, estimate } = {}) {
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
  const mock = apiImpl || createApiMock({ estimate });
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

function hasButton(container, label) {
  return findAll(container, (node) => node.tag === 'button' && textOf(node) === label).length > 0;
}

function findButton(container, label) {
  const matches = findAll(container, (node) => node.tag === 'button' && textOf(node) === label);
  assert.ok(matches.length > 0, `button "${label}" rendered`);
  return matches[matches.length - 1];
}

async function click(node) {
  for (const fn of node.listeners.click || []) await fn();
}

async function clickExact(container, label) {
  await click(findButton(container, label));
  await sleep(5);
}

async function clickOption(container, optionText) {
  const matches = findAll(
    container,
    (node) => node.tag === 'button' && textOf(node).split(' ')[0] === optionText
  );
  assert.ok(matches.length > 0, `option "${optionText}" rendered`);
  await click(matches[0]);
  await sleep(5);
}

async function walkToReview(container) {
  for (let guard = 0; guard < 14; guard += 1) {
    if (hasButton(container, 'Finish placement')) return;
    if (hasButton(container, 'Review answers')) {
      await clickExact(container, 'Review answers');
      return;
    }
    await clickExact(container, 'Next');
  }
  throw new Error('could not reach the review screen');
}

// Entry screen: boot lands on the starting-point choice (questions only
// load after the learner picks the quiz card). The card carries a title
// plus a description, so lookup matches the leading title text.
async function enterQuiz(container) {
  const matches = [];
  const queue = [container];
  while (queue.length) {
    const node = queue.shift();
    if (node.tag === 'button' && textOf(node).startsWith('Get a quick estimate')) matches.push(node);
    queue.push(...(node.children || []));
  }
  assert.ok(matches.length > 0, 'button "Get a quick estimate" rendered');
  await click(matches[matches.length - 1]);
  await sleep(5);
}

// Full quiz loop: from the entry screen through all 10 questions to review.
async function answerAllAndReview(container, questions) {
  await enterQuiz(container);
  for (let index = 0; index < 10; index += 1) {
    await clickOption(container, questions[index].options[0].text);
    if (index < 9) await clickExact(container, 'Next');
    else await clickExact(container, 'Review answers');
  }
}

// --- exports -----------------------------------------------------------------

test('placement helpers are exported from firstExperience.js', () => {
  for (const fn of [renderPlacement, enterPlacement, sanitizePlacementQuestions,
    sanitizePlacementResult, buildPlacementSubmitPayload, isPlacementAbstained,
    isPlacementResolved, isValidPlacementEstimate,
    isValidSelfReportLevel, normalizePlacementSource, buildSelfReportPayload,
    placementQuestionLabel, placementAnsweredLabel, countPlacementAnswered,
    placementUnansweredIndexes, placementResultTitle, placementResultCopy,
    selfReportResultTitle, placementEstimateFromState, placementResultFromState,
    formatPlacementCompletedDate, placementBandRowText, placementBandSrText,
    placementBandDots, placementResultNode, selfReportResultNode]) {
    assert.equal(typeof fn, 'function');
  }
  assert.deepEqual(PLACEMENT_ESTIMATES, ['N5', 'N4', 'N3', 'N2', 'N1']);
  assert.deepEqual(PLACEMENT_BANDS, ['N5', 'N4', 'N3']);
  assert.deepEqual(SELF_REPORT_LEVELS, ['N5', 'N4', 'N3', 'N2', 'N1']);
  assert.deepEqual(PLACEMENT_SOURCES, ['quiz', 'self_reported']);
  assert.equal(SELF_REPORT_PATH, '/api/first-experience/placement/self-report');
  assert.equal(PLACEMENT_TOTAL, 10);
});

test('enterPlacement fails open to dashboard without a DOM container', () => {
  const calls = [];
  const session = enterPlacement({ navigate: (page) => calls.push(page) });
  assert.deepEqual(calls, ['dashboard']);
  assert.equal(session.active, false);
});

// --- pure helpers --------------------------------------------------------------

test('estimate validation accepts only exact N5..N1', () => {
  assert.equal(isValidPlacementEstimate('N4'), true);
  assert.equal(isValidPlacementEstimate('N1'), true);
  assert.equal(isValidPlacementEstimate('n4'), false);
  assert.equal(isValidPlacementEstimate('N6'), false);
  assert.equal(isValidPlacementEstimate(null), false);
  assert.equal(isValidPlacementEstimate(undefined), false);
});

test('self-report levels span N5..N1; sources normalize to quiz/self_reported/null', () => {
  assert.equal(isValidSelfReportLevel('N5'), true);
  assert.equal(isValidSelfReportLevel('N1'), true);
  assert.equal(isValidSelfReportLevel('n3'), false);
  assert.equal(isValidSelfReportLevel(null), false);
  assert.equal(normalizePlacementSource('quiz'), 'quiz');
  assert.equal(normalizePlacementSource('self_reported'), 'self_reported');
  assert.equal(normalizePlacementSource(null), null);
  assert.equal(normalizePlacementSource('unknown'), null);
  assert.equal(normalizePlacementSource(undefined), null);
  assert.deepEqual(buildSelfReportPayload({ level: 'N3' }), { level: 'N3' });
  assert.deepEqual(buildSelfReportPayload({ level: 'N1' }), { level: 'N1' });
  assert.throws(() => buildSelfReportPayload({ level: 'N9' }));
  assert.throws(() => buildSelfReportPayload({ level: null }));
  assert.throws(() => buildSelfReportPayload({}));
  assert.equal(selfReportResultTitle('N3'), 'JLPT N3');
});

test('labels and result copy use the exact contract wording', () => {
  assert.equal(placementQuestionLabel(0), 'Question 1 of 10');
  assert.equal(placementQuestionLabel(9), 'Question 10 of 10');
  assert.equal(placementAnsweredLabel(7), '7 of 10 answered');
  assert.equal(placementResultTitle('N4'), 'N4 range');
  assert.deepEqual(placementResultCopy('N4'), {
    eyebrow: 'STARTING ESTIMATE',
    title: 'N4 range',
    body: 'Use this as a starting reference, not a verdict on your Japanese.',
    note: 'This is a starting estimate, not an official JLPT assessment.'
  });
});

test('placementEstimateFromState only trusts a stored completed estimate', () => {
  assert.equal(placementEstimateFromState({ placement: { status: 'completed', estimate: 'N2' } }), 'N2');
  assert.equal(placementEstimateFromState({ placement: { status: 'not_started', estimate: null } }), null);
  assert.equal(placementEstimateFromState({ placement: { status: 'skipped', estimate: null } }), null);
  assert.equal(placementEstimateFromState({ placement: { status: 'completed', estimate: 'N9' } }), null);
  assert.equal(placementEstimateFromState({}), null);
  assert.equal(placementEstimateFromState(null), null);
});

// --- one-time result helpers -------------------------------------------------------

test('sanitizePlacementResult passes server counts through, rejects invention', () => {
  const stored = buildStoredResult();
  assert.deepEqual(sanitizePlacementResult(stored), stored, 'valid breakdown passes verbatim');
  assert.equal(sanitizePlacementResult(null), null, 'null stays null (self-reported and pre-breakdown rows)');
  assert.equal(sanitizePlacementResult(undefined), null);
  assert.equal(sanitizePlacementResult('N4'), null);
  assert.equal(sanitizePlacementResult([]), null);
  assert.equal(sanitizePlacementResult({ totalCorrect: 6 }), null, 'missing byBand rejected');
  assert.equal(sanitizePlacementResult({ totalCorrect: 11, byBand: stored.byBand }), null, 'total above 10 rejected');
  assert.equal(sanitizePlacementResult({ totalCorrect: -1, byBand: stored.byBand }), null, 'negative total rejected');
  const missingBand = { ...stored.byBand };
  delete missingBand.N3;
  assert.equal(sanitizePlacementResult({ totalCorrect: 6, byBand: missingBand }), null, 'missing band rejected, not zero-filled');
  const overBand = { ...stored.byBand, N5: { correct: 5, total: 4 } };
  assert.equal(sanitizePlacementResult({ totalCorrect: 6, byBand: overBand }), null, 'correct above total rejected');
  // Tolerant numeric form: bare correct counts render without a denominator.
  const numeric = sanitizePlacementResult({ totalCorrect: 6, byBand: { N5: 3, N4: 2, N3: 1 } });
  assert.deepEqual(numeric.byBand.N5, { correct: 3, total: null });
  assert.equal(sanitizePlacementResult({ totalCorrect: 6, byBand: { ...stored.byBand, N3: 'many' } }), null, 'non-numeric band rejected');
  // Unknown bands (present or future) are ignored, never rendered.
  const withExtra = sanitizePlacementResult({ totalCorrect: 6, byBand: { ...stored.byBand, N2: { correct: 1, total: 2 } } });
  assert.deepEqual(Object.keys(withExtra.byBand), ['N5', 'N4', 'N3'], 'extra bands stripped');
});

test('placementResultFromState carries estimate, source, date, and sanitized result', () => {
  const stored = buildStoredResult();
  assert.deepEqual(
    placementResultFromState(completedQuizFx({ estimate: 'N3', result: stored, completedAt: '2026-09-01T10:00:00.000Z' })),
    { estimate: 'N3', source: 'quiz', completedAt: '2026-09-01T10:00:00.000Z', result: stored }
  );
  // Self-reported rows carry no breakdown by design — and no source means
  // the legacy quiz presentation (null never invents a source).
  assert.deepEqual(
    placementResultFromState(completedFx({ estimate: 'N2', source: 'self_reported', completedAt: '2026-09-01T10:00:00.000Z' })),
    { estimate: 'N2', source: 'self_reported', completedAt: '2026-09-01T10:00:00.000Z', result: null }
  );
  assert.deepEqual(
    placementResultFromState(completedFx({ estimate: 'N4' })),
    { estimate: 'N4', source: null, completedAt: null, result: null },
    'pre-breakdown rows: null source and result, no invented breakdown'
  );
  assert.equal(placementResultFromState({ placement: { status: 'not_started', estimate: null } }), null);
  assert.equal(placementResultFromState({ placement: { status: 'skipped', estimate: null } }), null);
  assert.equal(placementResultFromState({ placement: { status: 'completed', estimate: 'N9' } }), null);
  assert.equal(placementResultFromState(null), null);
  // Malformed breakdown degrades to the estimate-only variant.
  const degraded = placementResultFromState(completedQuizFx({ estimate: 'N3', result: { totalCorrect: 99, byBand: {} } }));
  assert.deepEqual(degraded, { estimate: 'N3', source: 'quiz', completedAt: null, result: null });
});

test('completed-date formatting is date-only', () => {
  assert.equal(formatPlacementCompletedDate('2026-09-01T10:00:00.000Z'), '2026-09-01');
  assert.equal(formatPlacementCompletedDate('2026-09-01'), '2026-09-01');
  assert.equal(formatPlacementCompletedDate(null), null);
  assert.equal(formatPlacementCompletedDate(''), null);
});

test('band rows and dots mirror stored counts exactly', () => {
  assert.equal(placementBandRowText('N5', 3, 4), 'N5 — 3 of 4 correct');
  assert.equal(placementBandRowText('N3', 0, 3), 'N3 — 0 of 3 correct');
  assert.equal(placementBandRowText('N5', 3, null), 'N5 — 3 correct');
  assert.equal(placementBandDots(3, 4), '●●●○');
  assert.equal(placementBandDots(1, 3), '●○○');
  assert.equal(placementBandDots(0, 2), '○○');
  assert.equal(placementBandDots(2, null), '●●');
  assert.ok(placementBandSrText('N5', 3, 4).includes('N5'), 'sr text names the band');
  assert.deepEqual(PLACEMENT_COPY.quizResult, 'QUIZ RESULT');
  assert.equal(
    PLACEMENT_COPY.breakdownNote,
    'These questions are grouped by approximate difficulty. This result is a starting reference, not an official JLPT assessment.'
  );
});

test('quiz bank is N5/N4/N3 only: no N2/N1 band logic anywhere in the quiz path', () => {
  const source = readSource('src/firstExperience.js');
  const bandsLine = source.slice(source.indexOf('const PLACEMENT_BANDS'));
  assert.ok(bandsLine.startsWith("const PLACEMENT_BANDS = ['N5', 'N4', 'N3'];"), 'quiz bands are exactly N5/N4/N3');
  for (const fn of ['function sanitizePlacementResult', 'function placementResultNode']) {
    const slice = source.slice(source.indexOf(fn));
    const body = slice.slice(0, slice.indexOf('\n}\n') + 3);
    assert.ok(!body.includes('N2'), `${fn} carries no N2 band reference`);
    assert.ok(!body.includes('N1'), `${fn} carries no N1 band reference`);
  }
});

test('placementResultNode: semantic, text-first diagram with a11y hooks', () => {
  const { el } = createPlacementHarness();
  const node = placementResultNode(el, { estimate: 'N3', result: buildStoredResult() });
  assert.equal(node.getAttribute('tabindex'), '-1', 'view-focus hook on the wrapper');
  const h2 = findAll(node, (entry) => entry.tag === 'h2');
  assert.equal(h2.length, 1, 'single estimate heading');
  assert.equal(textOf(h2[0]), 'N3 range');
  assert.equal(h2[0].getAttribute('tabindex'), '-1', 'heading focusable for view moves');
  const lists = findAll(node, (entry) => entry.tag === 'ul');
  assert.equal(lists.length, 1, 'real list for the band rows');
  assert.equal(lists[0].getAttribute('aria-label'), 'Results by difficulty band');
  const rows = findAll(node, (entry) => entry.tag === 'li');
  assert.equal(rows.length, 3, 'one row per quiz band (N5/N4/N3 only)');
  const full = textOf(node);
  assert.ok(!full.match(/N2/), 'no N2 band row in the diagram');
  assert.ok(!full.match(/N1/), 'no N1 band row in the diagram');
  for (const row of rows) {
    assert.ok(row.className.includes('flex-col'), 'rows stack on mobile');
    assert.ok(row.className.includes('sm:flex-row'), 'rows settle side by side on wider screens');
    assert.ok(row.className.includes('min-w-0'), 'rows can shrink without overflow');
  }
  const dots = findAll(node, (entry) => /[●○]/.test(textOf(entry)) && entry.tag === 'span' && !entry.className.includes('visually-hidden'));
  assert.equal(dots.length, 3, 'one dot visual per row');
  for (const dot of dots) {
    assert.equal(dot.getAttribute('aria-hidden'), 'true', 'dots hidden from assistive tech');
  }
  const sr = findAll(node, (entry) => entry.className.includes('visually-hidden'));
  assert.equal(sr.length, 3, 'sr text per row');
  assert.ok(sr.every((entry) => /N[1-5] band/.test(textOf(entry))), 'sr text names each band');
  assert.equal(findAll(node, (entry) => entry.attributes.has('aria-live')).length, 0, 'no live-region chatter');
  assert.ok(!textOf(node).match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/), 'no Japanese copy, so no lang hooks required');
});

test('quiz result carries exactly one disclaimer', () => {
  const { el } = createPlacementHarness();
  for (const node of [
    placementResultNode(el, { estimate: 'N3', result: buildStoredResult() }),
    placementResultNode(el, { estimate: 'N3', result: null })
  ]) {
    const full = textOf(node);
    const count = full.split(PLACEMENT_COPY.breakdownNote).length - 1;
    assert.equal(count, 1, 'the single honest disclaimer appears exactly once');
    assert.ok(!full.includes(PLACEMENT_COPY.note), 'no second redundant disclaimer');
  }
});

test('placementResultNode null-result variant: estimate only, completed date optional', () => {
  const { el } = createPlacementHarness();
  const bare = placementResultNode(el, { estimate: 'N3', result: null });
  assert.ok(textOf(bare).includes('N3 range'), 'estimate shown');
  assert.equal(findAll(bare, (entry) => entry.tag === 'ul').length, 0, 'no band list');
  assert.ok(!textOf(bare).includes('QUIZ RESULT'), 'no breakdown heading');
  assert.ok(!textOf(bare).includes('Completed:'), 'no date line unless completedAt is passed');
  const dated = placementResultNode(el, { estimate: 'N3', result: null, completedAt: '2026-09-01T10:00:00.000Z' });
  assert.ok(textOf(dated).includes('Completed: 2026-09-01'), 'date-only completed line');
  const custom = placementResultNode(el, { estimate: 'N3', result: null, titleTag: 'h3' });
  assert.equal(findAll(custom, (entry) => entry.tag === 'h3').length, 1, 'embeddable heading level');
  assert.equal(findAll(custom, (entry) => entry.tag === 'h2').length, 0, 'no level jump for embeds');
  assert.throws(() => placementResultNode(el, { estimate: 'N9', result: null }), 'invalid estimate rejected');
  assert.throws(() => placementResultNode(null, { estimate: 'N3' }), 'element factory required');
});

test('selfReportResultNode: level only, never a score', () => {
  const { el } = createPlacementHarness();
  const node = selfReportResultNode(el, { estimate: 'N2' });
  assert.equal(node.getAttribute('tabindex'), '-1', 'view-focus hook on the wrapper');
  const full = textOf(node);
  assert.ok(full.includes('STARTING LEVEL'), 'self-report eyebrow');
  assert.ok(full.includes('JLPT N2'), 'chosen level shown');
  assert.ok(full.includes('Self-reported'), 'source pill shown');
  assert.ok(full.includes(PLACEMENT_COPY.selfResultBody), 'explanatory body shown');
  assert.ok(!full.match(/\/ 10 correct/), 'no score line');
  assert.ok(!full.match(/QUIZ RESULT/), 'no breakdown heading');
  assert.ok(!full.match(/[●○]/), 'no dots');
  assert.ok(!full.match(/%/), 'no percentages');
  assert.ok(!full.match(/N[45] —/), 'no band rows');
  assert.equal(findAll(node, (entry) => entry.tag === 'ul').length, 0, 'no band list');
  const dated = selfReportResultNode(el, { estimate: 'N2', completedAt: '2026-09-01T10:00:00.000Z', titleTag: 'h3' });
  assert.ok(textOf(dated).includes('Completed: 2026-09-01'), 'date-only completed line');
  assert.throws(() => selfReportResultNode(el, { estimate: 'N9' }), 'invalid level rejected');
  assert.throws(() => selfReportResultNode(null, { estimate: 'N2' }), 'element factory required');
});

test('settings starting-point block: restrained take-vs-result states, no re-entry', () => {
  const source = readSource('src/pages/settings.js');
  assert.ok(source.includes('Japanese starting point'), 'block heading');
  assert.ok(source.includes('Answer 10 short Japanese questions to establish a starting reference.'), 'take description');
  assert.ok(source.includes('Take quick placement'), 'take CTA reuses the placement label');
  assert.ok(source.includes('placementResultNode'), 'shared diagram, no copied scoring or rows');
  assert.ok(source.includes('placementResultFromState'), 'stored state presented, never derived');
  assert.ok(source.includes('enterPlacement'), 'same placement flow for existing accounts');
  assert.ok(!source.match(/retake/i), 'no re-entry wording');
  assert.ok(!source.match(/reset/i), 'no reset wording');
  assert.ok(!source.match(/repeat/i), 'no repeat wording');
  for (const marker of ['Profile', 'Learning', 'Account']) {
    assert.ok(source.includes(marker), `Settings section present: ${marker}`);
  }
  assert.ok(source.includes('notifyAuth: false'), 'stored read without auth side effects');
  assert.ok(source.includes('Starting point is unavailable right now.'), 'fetch failure keeps Settings usable');
});

test('result diagram forbids verdict language, percentages, and invented data', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.match(/you are n[1-5]/i), 'never "You are N"');
  assert.ok(!source.match(/mastery/i), 'no mastery language');
  assert.ok(!source.match(/readiness/i), 'no readiness language');
  assert.ok(!source.match(/pass rate|passing/i), 'no pass language');
  const nodeSource = source.slice(source.indexOf('function placementResultNode'));
  assert.ok(!nodeSource.includes('%'), 'no percentages in the diagram');
  for (const path of ['src/firstExperience.js', 'src/firstUseDashboard.js', 'src/pages/settings.js']) {
    assert.ok(!readSource(path).match(/retake/i), `no re-entry wording in ${path}`);
  }
  const clientGrep = ['src/firstExperience.js', 'src/firstUseDashboard.js', 'src/pages/settings.js', 'src/pages/dashboard.js']
    .map(readSource)
    .join('\n');
  assert.ok(!clientGrep.includes('Retake placement'), 'no user-facing re-entry string on any surface');
});

test('sanitize keeps display fields in API order and drops everything else', () => {
  const clean = sanitizePlacementQuestions(buildQuestions());
  assert.equal(clean.length, 10);
  assert.deepEqual(clean[0], {
    id: 'n5_01',
    prompt: {
      text: '水をのみます。水のよみ方は？',
      reading: 'みずをのみます',
      translation: 'How do you read 水?'
    },
    options: [
      { id: 'a', text: 'みず', reading: 'みず', gloss: 'water' },
      { id: 'b', text: 'すい', reading: 'すい', gloss: 'water (on reading)' },
      { id: 'c', text: 'みす', reading: 'みす', gloss: 'to miss' },
      { id: 'd', text: 'むず', reading: 'むず', gloss: 'difficult (stem)' }
    ]
  });
  assert.deepEqual(clean.map((question) => question.id), PLACEMENT_FIXTURE_IDS);
  for (const question of clean) {
    assert.deepEqual(Object.keys(question).sort(), ['id', 'options', 'prompt']);
    for (const option of question.options) {
      assert.deepEqual(Object.keys(option).sort(), ['gloss', 'id', 'reading', 'text']);
    }
  }
});

test('sanitize accepts a { questions } wrapper', () => {
  assert.equal(sanitizePlacementQuestions({ questions: buildQuestions() }).length, 10);
});

test('client accepts arbitrary stable IDs (per-user pool selection) and renders 10 verbatim', async () => {
  // Deterministic per-user selection: IDs vary per learner and carry no
  // sequence the client may assume — sanitize, submit, and review stay
  // ID-driven and keep API order verbatim.
  const ids = ['n5_07', 'n3_02', 'n4_11', 'n5_03', 'n3_09', 'n4_01', 'n3_05', 'n5_12', 'n4_06', 'n3_01'];
  const bank = ids.map((id, index) => ({
    id,
    prompt: {
      text: `問題${index + 1}：水をのみます。`,
      reading: `もんだい${index + 1}`,
      translation: `Pool question ${index + 1}.`
    },
    options: ['あ', 'い', 'う', 'え'].map((kana, optionIndex) => ({
      id: ['a', 'b', 'c', 'd'][optionIndex],
      text: kana,
      reading: kana,
      gloss: `choice ${optionIndex + 1}`
    }))
  }));
  const clean = sanitizePlacementQuestions(bank);
  assert.equal(clean.length, 10);
  assert.deepEqual(clean.map((question) => question.id), ids, 'API order kept verbatim');
  assert.deepEqual(clean[0].prompt, bank[0].prompt, 'prompts pass through verbatim');
  const answers = {};
  clean.forEach((question) => { answers[question.id] = 'c'; });
  const payload = buildPlacementSubmitPayload(clean, answers);
  assert.deepEqual(payload.answers.map((entry) => entry.questionId), ids, 'submit follows API order');
  assert.ok(payload.answers.every((entry) => entry.optionId === 'c'), 'chosen options preserved per ID');
  assert.equal(countPlacementAnswered(clean, answers), 10, 'counting is ID-driven');
  // Render path: the quiz screens run on the same arbitrary IDs.
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ questions: bank }) });
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  assert.ok(textOf(container).includes('問題1：水をのみます。'), 'first pool prompt renders verbatim');
  for (let index = 0; index < 10; index += 1) {
    await clickOption(container, bank[index].options[0].text);
    if (index < 9) await clickExact(container, 'Next');
    else await clickExact(container, 'Review answers');
  }
  assert.ok(textOf(container).includes('10 of 10 answered'), 'review counts all 10 arbitrary IDs');
  await clickExact(container, 'Finish placement');
  await sleep(650);
  const submitted = log.apiCalls.find((call) => call.path === SUBMIT_PATH);
  assert.deepEqual(submitted.body.answers.map((entry) => entry.questionId), ids, 'submitted IDs match the pool selection');
});

test('sanitize rejects malformed banks', () => {
  const questions = buildQuestions();
  assert.throws(() => sanitizePlacementQuestions(questions.slice(0, 9)));
  assert.throws(() => sanitizePlacementQuestions({ questions: [] }));
  assert.throws(() => sanitizePlacementQuestions(null));
  const threeOptions = buildQuestions();
  threeOptions[0] = { ...threeOptions[0], options: threeOptions[0].options.slice(0, 3) };
  assert.throws(() => sanitizePlacementQuestions(threeOptions));
  const noText = buildQuestions();
  noText[4] = { ...noText[4], prompt: { text: '', reading: '', translation: '' } };
  assert.throws(() => sanitizePlacementQuestions(noText));
  const dupIds = buildQuestions();
  dupIds[1] = { ...dupIds[0] };
  assert.throws(() => sanitizePlacementQuestions(dupIds));
});

test('submit payload follows API order with the chosen option per question', () => {
  const questions = sanitizePlacementQuestions(buildQuestions());
  const answers = {};
  questions.forEach((question, index) => {
    answers[question.id] = question.options[index % 4].id;
  });
  const payload = buildPlacementSubmitPayload(questions, answers);
  assert.equal(payload.answers.length, 10);
  assert.deepEqual(payload.answers.map((entry) => entry.questionId), PLACEMENT_FIXTURE_IDS);
  assert.deepEqual(Object.keys(payload), ['answers']);
  for (const entry of payload.answers) {
    assert.deepEqual(Object.keys(entry).sort(), ['optionId', 'questionId']);
  }
  assert.equal(payload.answers[0].optionId, 'a');
  assert.equal(payload.answers[1].optionId, 'b');
});

test('submit payload throws while anything is unanswered or unknown', () => {
  const questions = sanitizePlacementQuestions(buildQuestions());
  const answers = {};
  questions.forEach((question) => { answers[question.id] = 'a'; });
  assert.throws(() => buildPlacementSubmitPayload(questions, {}), /Answer all 10/);
  const partial = { ...answers };
  delete partial.n3_04;
  assert.throws(() => buildPlacementSubmitPayload(questions, partial), /Answer all 10/);
  assert.throws(() => buildPlacementSubmitPayload(questions, { ...answers, n4_01: 'z' }), /Answer all 10/);
  assert.throws(() => buildPlacementSubmitPayload(questions.slice(0, 9), answers));
});

test('answered counting ignores unknown option ids', () => {
  const questions = sanitizePlacementQuestions(buildQuestions());
  const answers = { n5_01: 'a', n5_02: 'z', n4_01: 'b' };
  assert.equal(countPlacementAnswered(questions, answers), 2);
  assert.deepEqual(placementUnansweredIndexes(questions, answers).slice(0, 3), [1, 3, 4]);
  assert.equal(placementUnansweredIndexes(questions, answers).length, 8);
});

// --- no-answer-leak --------------------------------------------------------------

test('client never sees levels or keys: module source carries no bank metadata', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.match(/answerKey|correctAnswer|isCorrect|correctOption/i), 'no answer-key identifiers');
  assert.ok(!source.includes('scorePlacement'), 'no client-side scoring function');
  assert.ok(!source.match(/\bscore\b/i), 'no scoring wording at all');
  // Display-only exception: byBand/totalCorrect are server-computed counts
  // the diagram presents verbatim — never derived from option ids. The
  // guards below prove no derivation exists.
  assert.ok(source.includes('byBand'), 'stored breakdown presented verbatim');
  assert.ok(!source.match(/options\.some.*correct|correct.*options\.some/i), 'counts never matched against options');
  assert.ok(source.includes(QUESTIONS_PATH), 'questions endpoint wired');
  assert.ok(source.includes(SUBMIT_PATH), 'submit endpoint wired');
  assert.ok(source.includes(SKIP_PATH), 'skip endpoint wired');
});

test('no hardcoded question bank in the module source', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.includes('q01'), 'no hardcoded question ids');
  assert.ok(!source.includes('水をのみます'), 'no hardcoded prompts');
  assert.ok(!source.includes('躊躇'), 'no hardcoded prompts');
  assert.ok(!source.includes('いそがしかったら'), 'no hardcoded options');
});

test('submit handoff is calm: bounded pause, no analysis wording', () => {
  assert.ok(PLACEMENT_SUBMIT_MIN_MS >= 300 && PLACEMENT_SUBMIT_MIN_MS <= 700, 'pause inside 300–700ms');
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.match(/analyz/i), 'never reads as machine analysis');
  assert.ok(!source.match(/evaluat/i), 'never reads as evaluation');
  assert.ok(source.includes('prefers-reduced-motion: reduce'), 'reduced-motion short-circuits the pause');
});

// --- loading / error ---------------------------------------------------------------

test('boot paints a calm loading state synchronously', () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  assert.ok(textOf(container).includes('Loading your placement…'), 'loading copy shown instantly');
  assert.ok(textOf(container).includes('Quick Japanese Placement'), 'workspace header shown instantly');
});

test('questions failure shows an error view with retry + exit', async () => {
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ failFirstQuestions: true }) });
  renderPlacement(container, deps);
  await sleep(25);
  assert.ok(textOf(container).includes('Where should we start?'), 'entry screen first — questions lazy-load');
  await enterQuiz(container);
  await sleep(25);
  assert.ok(textOf(container).includes('We could not load this view.'), 'error title shown');
  await clickExact(container, 'Try again');
  await sleep(25);
  assert.ok(textOf(container).includes('Question 1 of 10'), 'retry loads the quiz');
  assert.equal(log.apiCalls.filter((call) => call.path === QUESTIONS_PATH).length, 2);
});

// --- question flow --------------------------------------------------------------------

test('ten-question flow: header copy, progress, prev/next, focus per question', async () => {
  const { container, deps, log } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  assert.ok(textOf(container).includes('Quick Japanese Placement'), 'workspace title');
  assert.ok(textOf(container).includes('Answer each question with your best guess. You can change an answer before finishing.'), 'guidance copy');
  assert.ok(textOf(container).includes('This is a starting estimate, not an official JLPT assessment.'), 'disclaimer note');
  assert.ok(textOf(container).includes('Question 1 of 10'), 'first question label');
  assert.ok(!textOf(container).match(/N[1-5]/), 'header shows no level labels');
  const prev = findAll(container, (node) => node.tag === 'button' && textOf(node) === 'Previous').at(-1);
  assert.equal(prev.disabled, true, 'Previous disabled on the first question');
  assert.ok(log.focused, 'question heading takes focus');
  await clickOption(container, 'みず');
  await clickExact(container, 'Next');
  assert.ok(textOf(container).includes('Question 2 of 10'), 'advanced to question 2');
  assert.ok(textOf(container).includes('Question 2 of 10') && log.focused && textOf(log.focused).includes('Question 2 of 10'), 'focus follows the question');
  await clickExact(container, 'Previous');
  assert.ok(textOf(container).includes('Question 1 of 10'), 'Previous returns without losing the pick');
  const pressed = findAll(container, (node) => node.tag === 'button' && node.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1, 'the saved pick stays pressed');
});

test('Next stays available when unanswered, and the gap is tracked', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  await clickExact(container, 'Next');
  assert.ok(textOf(container).includes('Question 2 of 10'), 'Next works without an answer');
  await walkToReview(container);
  assert.ok(textOf(container).includes('0 of 10 answered'), 'unanswered track shown in review');
  const finish = findAll(container, (node) => node.tag === 'button' && textOf(node) === 'Finish placement').at(-1);
  assert.equal(finish.disabled, true, 'Finish waits for all 10');
  assert.ok(textOf(container).includes('Answer all 10 questions to finish placement.'), 'finish hint shown');
});

test('options expose pressed state, Japanese lang hooks, and a hidden progress text', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  const group = findAll(container, (node) => node.getAttribute('role') === 'group').at(-1);
  assert.ok(group, 'options grouped with a label');
  assert.equal(group.getAttribute('aria-label'), 'Options for question 1');
  const unpressed = findAll(container, (node) => node.tag === 'button' && node.getAttribute('aria-pressed') === 'false');
  assert.ok(unpressed.length >= 4, 'options start unpressed');
  const japanese = findAll(container, (node) => node.getAttribute('lang') === 'ja');
  assert.ok(japanese.length >= 5, 'prompt, reading, and options carry lang="ja"');
  assert.ok(japanese.some((node) => textOf(node).includes('水をのみます')), 'prompt renders verbatim');
  const dots = findAll(container, (node) => node.getAttribute('aria-hidden') === 'true');
  assert.ok(dots.length > 0, 'visual progress is hidden from assistive tech');
  const sr = findAll(container, (node) => node.className.includes('visually-hidden'));
  assert.ok(sr.some((node) => textOf(node) === 'Question 1 of 10'), 'screen-reader progress text present');
  assert.equal(findAll(container, (node) => node.attributes.has('aria-live')).length, 0, 'no live-region chatter');
  await clickOption(container, 'みず');
  assert.equal(findAll(container, (node) => node.tag === 'button' && node.getAttribute('aria-pressed') === 'true').length, 1, 'pick presses exactly one option');
});

// --- review + submit ---------------------------------------------------------------------

test('full flow submits all 10 in order and shows the estimate-only result', async () => {
  const questions = buildQuestions();
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ questions, estimate: 'N3' }) });
  renderPlacement(container, deps);
  await sleep(25);
  await answerAllAndReview(container, questions);
  assert.ok(textOf(container).includes('Review your answers'), 'review screen reached');
  assert.ok(textOf(container).includes('10 of 10 answered'), 'complete count shown');
  await clickExact(container, 'Finish placement');
  assert.ok(textOf(container).includes('Saving your answers…'), 'calm submit transition');
  await sleep(650);
  const submitted = log.apiCalls.find((call) => call.path === SUBMIT_PATH);
  assert.ok(submitted, 'submit posted');
  assert.deepEqual(submitted.body, {
    answers: questions.map((question) => ({ questionId: question.id, optionId: 'a' }))
  });
  const result = textOf(container);
  assert.ok(result.includes('STARTING ESTIMATE'), 'result eyebrow');
  assert.ok(result.includes('N3 range'), 'estimate rendered as a range');
  assert.ok(result.includes('Use this as a starting reference, not a verdict on your Japanese.'), 'result body');
  assert.ok(result.includes('These questions are grouped by approximate difficulty. This result is a starting reference, not an official JLPT assessment.'), 'the single honest disclaimer');
  assert.ok(!result.includes('This is a starting estimate, not an official JLPT assessment.'), 'no second redundant disclaimer');
  // Null-result variant: the submit response carries no breakdown, so no
  // counts are shown and none are invented.
  assert.ok(!result.includes('QUIZ RESULT'), 'no breakdown section without stored counts');
  assert.ok(!result.match(/\/ 10 correct/), 'no invented total');
  assert.ok(hasButton(container, 'Go to dashboard'), 'primary action');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 1, 'Go to dashboard is the ONLY action');
  await clickExact(container, 'Go to dashboard');
  assert.ok(log.navigations.includes('dashboard'), 'dashboard handoff');
});

test('submit response breakdown renders stored values verbatim', async () => {
  const questions = buildQuestions();
  const stored = buildStoredResult();
  const { container, deps } = createPlacementHarness({ apiImpl: createApiMock({ questions, estimate: 'N3', result: stored }) });
  renderPlacement(container, deps);
  await sleep(25);
  await answerAllAndReview(container, questions);
  await clickExact(container, 'Finish placement');
  await sleep(650);
  const result = textOf(container);
  assert.ok(result.includes('N3 range'), 'estimate shown');
  assert.ok(result.includes('QUIZ RESULT'), 'breakdown heading shown');
  assert.ok(result.includes('6 / 10 correct'), 'stored total shown verbatim');
  for (const [band, entry] of Object.entries(stored.byBand)) {
    assert.ok(result.includes(`${band} — ${entry.correct} of ${entry.total} correct`), `${band} row verbatim`);
  }
  assert.ok(!result.match(/N2/), 'no N2 row in the result');
  assert.ok(!result.match(/N1/), 'no N1 row in the result');
  // Dots mirror the counts exactly: 6 filled, 4 empty across the three rows.
  const dots = findAll(container, (node) => node.getAttribute('aria-hidden') === 'true' && /[●○]/.test(textOf(node)));
  const dotText = dots.map(textOf).join('');
  assert.equal([...dotText].filter((char) => char === '●').length, 6, 'filled dots equal stored correct count');
  assert.equal([...dotText].filter((char) => char === '○').length, 4, 'empty dots equal stored remainder');
  assert.doesNotMatch(result, /%/);
});

test('result copy never promises a verdict', async () => {
  const { container, deps } = createPlacementHarness({ apiImpl: createApiMock({ estimate: 'N3' }) });
  renderPlacement(container, deps);
  await sleep(25);
  await answerAllAndReview(container, buildQuestions());
  await clickExact(container, 'Finish placement');
  await sleep(650);
  const result = textOf(container);
  assert.doesNotMatch(result, /you are n[1-5]/i);
  assert.doesNotMatch(result, /\bready\b/i);
  assert.doesNotMatch(result, /\bpass\b/i);
  assert.doesNotMatch(result, /%/);
  assert.doesNotMatch(placementResultCopy('N3').title, /you are/i);
});

test('review lists picks and Change overwrites the stored answer', async () => {
  const questions = buildQuestions();
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ questions, estimate: 'N5' }) });
  renderPlacement(container, deps);
  await sleep(25);
  await answerAllAndReview(container, questions);
  assert.ok(textOf(container).includes('みず'), 'first pick listed in review');
  const changes = findAll(container, (node) => node.tag === 'button' && textOf(node) === 'Change');
  assert.equal(changes.length, 10, 'every answer is changeable');
  await click(changes[0]);
  await sleep(5);
  assert.ok(textOf(container).includes('Question 1 of 10'), 'Change returns to that question');
  await clickOption(container, 'すい');
  await walkToReview(container);
  await clickExact(container, 'Finish placement');
  await sleep(650);
  const submitted = log.apiCalls.find((call) => call.path === SUBMIT_PATH);
  assert.equal(submitted.body.answers[0].optionId, 'b', 'changed pick overwrites');
  assert.ok(textOf(container).includes('N5 range'), 'resubmitted estimate shown');
});

test('submit failure toasts and returns to review with picks intact', async () => {
  const questions = buildQuestions();
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ questions, failSubmit: true }) });
  renderPlacement(container, deps);
  await sleep(25);
  await answerAllAndReview(container, questions);
  await clickExact(container, 'Finish placement');
  await sleep(650);
  assert.equal(log.notices.length, 1, 'failure toasted');
  assert.equal(log.notices[0].type, 'error');
  assert.ok(textOf(container).includes('Review your answers'), 'back in review, nothing lost');
  assert.ok(textOf(container).includes('10 of 10 answered'), 'picks intact');
});

// --- skip / exit ----------------------------------------------------------------------------

test('Exit posts the skip shape and leaves for the dashboard', async () => {
  const { container, deps, log } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  await clickExact(container, 'Exit for now');
  await sleep(15);
  const skipped = log.apiCalls.find((call) => call.path === SKIP_PATH);
  assert.deepEqual(skipped, { path: SKIP_PATH, method: 'POST' });
  assert.ok(log.navigations.includes('dashboard'), 'dashboard handoff after skip');
});

test('skip failure still leaves, with an error toast (fail-open)', async () => {
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ failSkip: true }) });
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  await clickExact(container, 'Exit for now');
  await sleep(15);
  assert.ok(log.navigations.includes('dashboard'), 'leave happens despite the API error');
  assert.equal(log.notices.length, 1);
  assert.equal(log.notices[0].type, 'error');
});

// --- one-time result: no re-entry, 409 fallbacks -------------------------------------------

test('completed learners see the stored result directly, with no quiz path', async () => {
  const fx = completedQuizFx({ estimate: 'N3', result: buildStoredResult() });
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ fx }) });
  renderPlacement(container, deps);
  await sleep(25);
  const text = textOf(container);
  assert.ok(text.includes('N3 range'), 'stored estimate shown without a new quiz');
  assert.ok(text.includes('QUIZ RESULT'), 'stored breakdown shown');
  assert.ok(text.includes('6 / 10 correct'), 'stored total shown');
  assert.ok(!text.match(/N2/), 'no N2 row');
  assert.ok(!text.match(/N1/), 'no N1 row');
  assert.equal(log.apiCalls.filter((call) => call.path === QUESTIONS_PATH).length, 0, 'no questions fetched');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 1, 'only Go to dashboard');
  assert.ok(!text.match(/retake/i), 'no re-entry wording anywhere');
  assert.ok(!text.includes('Question 1 of 10'), 'quiz never renders');
});

test('completed pre-breakdown rows render estimate-only, with no invented zeros', async () => {
  const fx = completedFx({ estimate: 'N4', result: null });
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ fx }) });
  renderPlacement(container, deps);
  await sleep(25);
  const text = textOf(container);
  assert.ok(text.includes('N4 range'), 'estimate shown');
  assert.ok(!text.includes('QUIZ RESULT'), 'no breakdown section');
  assert.ok(!text.match(/0 of|0 \/ 10/), 'no invented zeros');
  assert.ok(!text.match(/N5 —/), 'no band rows');
  assert.equal(log.apiCalls.filter((call) => call.path === QUESTIONS_PATH).length, 0, 'no questions fetched');
});

test('submit race: 409 mid-flow falls back to the stored result + notice', async () => {
  const questions = buildQuestions();
  let completed = false;
  const stored = buildStoredResult();
  const api = async (path, options = {}) => {
    if (path === FX_PATH) {
      return completed
        ? completedQuizFx({ estimate: 'N5', result: stored })
        : { onboarding: { completed: true, studySources: [] }, placement: { status: 'not_started', estimate: null, source: null }, targetLevel: null };
    }
    if (path === QUESTIONS_PATH) return questions;
    if (path === SUBMIT_PATH) {
      completed = true;
      throw conflictError();
    }
    if (path === SKIP_PATH) return { placement: { status: 'skipped', estimate: null } };
    throw new Error(`Unexpected API path: ${path}`);
  };
  const { container, deps, log } = createPlacementHarness({ apiImpl: { api, log: { calls: [] } } });
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  assert.ok(textOf(container).includes('Question 1 of 10'), 'quiz starts while not completed');
  for (let index = 0; index < 10; index += 1) {
    await clickOption(container, questions[index].options[0].text);
    if (index < 9) await clickExact(container, 'Next');
    else await clickExact(container, 'Review answers');
  }
  await clickExact(container, 'Finish placement');
  await sleep(650);
  const text = textOf(container);
  assert.ok(text.includes('N5 range'), 'stored estimate shown after the race');
  assert.ok(text.includes('6 / 10 correct'), 'stored breakdown shown after the race');
  assert.ok(text.includes(PLACEMENT_COPY.alreadySaved), 'calm notice shown, not an error');
  assert.equal(log.notices.length, 0, 'no error toast on the already-completed race');
  assert.equal(findAll(container, (node) => node.tag === 'button').length, 1, 'only Go to dashboard');
});

test('409 on questions falls back to the stored result (no error view)', async () => {
  const fx = completedQuizFx({ estimate: 'N3', result: buildStoredResult() });
  let fxCalls = 0;
  const api = async (path) => {
    if (path === FX_PATH) {
      fxCalls += 1;
      // First read races ahead of completion; the questions fetch 409s.
      return fxCalls === 1 ? notStartedFx() : fx;
    }
    if (path === QUESTIONS_PATH) throw conflictError();
    throw new Error(`Unexpected API path: ${path}`);
  };
  const { container, deps } = createPlacementHarness({ apiImpl: { api } });
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(25);
  const text = textOf(container);
  assert.ok(text.includes('N3 range'), 'stored estimate shown');
  assert.ok(text.includes('6 / 10 correct'), 'stored breakdown shown');
  assert.ok(!text.includes('We could not load this view.'), 'no error view for completed learners');
});

// --- state, motion, layout --------------------------------------------------------------------------

test('reload semantics: in-session answers only, sessions stay independent', async () => {
  const first = createPlacementHarness();
  renderPlacement(first.container, first.deps);
  await sleep(25);
  await enterQuiz(first.container);
  await sleep(5);
  await clickOption(first.container, 'みず');
  const second = createPlacementHarness();
  renderPlacement(second.container, second.deps);
  await sleep(25);
  assert.equal(countPlacementAnswered(
    sanitizePlacementQuestions(buildQuestions()), { n5_01: 'a' }), 1, 'counting helper is pure');
  assert.ok(!textOf(second.container).includes('10 of 10 answered'), 'fresh session starts clean');
  const source = readSource('src/firstExperience.js');
  assert.ok(!source.includes('localStorage'), 'no local persistence');
  assert.ok(!source.includes('sessionStorage'), 'no session persistence');
});

test('responsive shell and frozen tokens: roomier desktop/tablet, stacked mobile, no new palette', () => {
  const source = readSource('src/firstExperience.js');
  assert.ok(source.includes('mx-auto w-full max-w-xl'), 'mobile base stays capped near one column');
  assert.ok(source.includes('md:max-w-2xl'), 'tablet breathes wider');
  assert.ok(source.includes('lg:max-w-3xl'), 'desktop is clearly roomier');
  assert.ok(source.includes('md:grid-cols-2'), 'options use horizontal room on tablet-up');
  assert.ok(source.includes('flex-col gap-2 sm:flex-row'), 'controls stack on narrow viewports');
  assert.ok(source.includes('break-words'), 'long Japanese wraps instead of overflowing');
  assert.ok(!source.match(/#[0-9a-fA-F]{3,8}\b/), 'no hex colors in the module');
  assert.ok(source.includes('button-primary') && source.includes('button-secondary') && source.includes('button-ghost'), 'existing button primitives only');
  assert.ok(source.includes('visually-hidden'), 'token screen-reader helper reused');
});

test('answer options render Japanese + reading but never the English gloss', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  const text = textOf(container);
  for (const gloss of ['water', 'water (on reading)', 'to miss', 'difficult (stem)']) {
    assert.ok(!text.includes(gloss), `gloss "${gloss}" not rendered on option cards`);
  }
  const japanese = findAll(container, (node) => node.getAttribute('lang') === 'ja');
  assert.ok(japanese.length >= 5, 'prompt, reading, and options still carry lang="ja"');
  const group = findAll(container, (node) => node.getAttribute('role') === 'group').at(-1);
  const buttons = findAll(group, (node) => node.tag === 'button');
  assert.equal(buttons.length, 4, 'four option cards render without gloss lines');
});

test('placement copy constants match the brief verbatim', () => {
  assert.equal(PLACEMENT_COPY.title, 'Quick Japanese Placement');
  assert.equal(PLACEMENT_COPY.intro, 'Answer each question with your best guess. You can change an answer before finishing.');
  assert.equal(PLACEMENT_COPY.note, 'This is a starting estimate, not an official JLPT assessment.');
  assert.equal(PLACEMENT_COPY.abstain, "I don't know");
});

// --- abstention ("I don't know") -------------------------------------------------
// FIXED contract: submit answers carry { questionId, optionId: string |
// null }; null is an accepted abstention (zero credit, denominator stays
// 10), while unknown/""/wrong-question ids are rejected server-side. The
// client shapes that payload and presents the three states — it never
// grades, never derives levels, and never persists half-progress.

function findAbstainButton(container) {
  const matches = findAll(container, (node) => node.tag === 'button' && textOf(node) === PLACEMENT_COPY.abstain);
  assert.ok(matches.length > 0, '"I don\'t know" abstention control rendered');
  return matches[matches.length - 1];
}

async function clickAbstain(container) {
  await click(findAbstainButton(container));
  await sleep(5);
}

function pressedOptions(container) {
  const group = findAll(container, (node) => node.getAttribute('role') === 'group').at(-1);
  assert.ok(group, 'options group rendered');
  return findAll(group, (node) => node.tag === 'button' && node.getAttribute('aria-pressed') === 'true');
}

test('abstention predicates: null is abstained and resolved; unknowns stay open', () => {
  const questions = sanitizePlacementQuestions(buildQuestions());
  const first = questions[0];
  assert.equal(isPlacementAbstained(null), true, 'null marks the abstention');
  assert.equal(isPlacementAbstained('a'), false, 'a pick is not an abstention');
  assert.equal(isPlacementAbstained(undefined), false, 'missing is not an abstention');
  assert.equal(isPlacementAbstained(''), false, 'blank is not an abstention');
  assert.equal(isPlacementResolved(first, null), true, 'abstention is submittable');
  assert.equal(isPlacementResolved(first, 'a'), true, 'valid pick is submittable');
  assert.equal(isPlacementResolved(first, undefined), false, 'missing stays open');
  assert.equal(isPlacementResolved(first, 'z'), false, 'unknown ids stay open');
  assert.equal(isPlacementResolved(first, ''), false, 'blank ids stay open');
  const answers = { n5_01: 'a', n5_02: null, n4_01: 'z' };
  assert.equal(countPlacementAnswered(questions, answers), 2, 'picks + abstentions count; unknowns do not');
  assert.deepEqual(placementUnansweredIndexes(questions, answers).slice(0, 4), [2, 3, 4, 5]);
  assert.equal(placementUnansweredIndexes(questions, answers).length, 8);
});

test('abstain control renders on every question, secondary and separated from the four options', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  for (let index = 0; index < 10; index += 1) {
    const group = findAll(container, (node) => node.getAttribute('role') === 'group').at(-1);
    assert.ok(group, `question ${index + 1}: options group rendered`);
    assert.equal(findAll(group, (node) => node.tag === 'button').length, 4, `question ${index + 1}: exactly four option cards`);
    const abstain = findAbstainButton(container);
    assert.equal(findAll(group, (node) => node === abstain).length, 0, 'abstention lives outside the options group');
    // Visually secondary: ghost token only — never the primary/secondary
    // choice styling the four Japanese options share.
    assert.ok(abstain.className.includes('button-ghost'), 'ghost (text-like) control');
    assert.ok(!abstain.className.includes('button-primary'), 'never primary choice styling');
    assert.ok(!abstain.className.includes('button-secondary'), 'never secondary choice styling');
    assert.ok(abstain.className.includes('w-full'), 'full-width stacking on mobile');
    // Separated: spacing plus a divider between the option grid and the control.
    assert.ok(
      findAll(container, (node) => node.className.split(' ').includes('border-t')).length > 0,
      'divider separation from the option grid'
    );
    assert.equal(abstain.tag, 'button', 'real button');
    assert.equal(abstain.getAttribute('type'), 'button', 'no form submit');
    assert.equal(abstain.getAttribute('aria-pressed'), 'false', 'starts unpressed');
    assert.equal(abstain.getAttribute('lang'), undefined, 'English label carries no lang="ja"');
    assert.equal(textOf(abstain), "I don't know", 'exact label');
    if (index < 9) await clickExact(container, 'Next');
  }
});

test('mutual exclusion: picking an option clears the abstention and vice versa', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  assert.ok(textOf(container).includes(PLACEMENT_COPY.notAnsweredHint), 'fresh question invites an answer');
  await clickOption(container, 'みず');
  assert.equal(pressedOptions(container).length, 1, 'one option picked');
  assert.equal(findAbstainButton(container).getAttribute('aria-pressed'), 'false', 'abstention clear after a pick');
  await clickAbstain(container);
  assert.equal(pressedOptions(container).length, 0, 'pick cleared by the abstention');
  assert.equal(findAbstainButton(container).getAttribute('aria-pressed'), 'true', 'abstention pressed');
  assert.ok(findAbstainButton(container).className.includes('underline'), 'pressed cue is not color-only');
  assert.ok(!textOf(container).includes(PLACEMENT_COPY.notAnsweredHint), 'resolved question hides the unanswered hint');
  await clickOption(container, 'すい');
  assert.equal(findAbstainButton(container).getAttribute('aria-pressed'), 'false', 're-picking clears the abstention');
  assert.equal(pressedOptions(container).length, 1, 'exactly one option pressed again');
});

test('review renders picked, abstained, and unanswered distinctly; finish waits for open rows', async () => {
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  await clickOption(container, 'みず');
  await clickExact(container, 'Next');
  await clickAbstain(container);
  await walkToReview(container);
  const text = textOf(container);
  assert.ok(text.includes('みず'), 'picked answer text listed');
  assert.ok(text.includes(PLACEMENT_COPY.abstain), 'abstention listed');
  assert.ok(text.includes(PLACEMENT_COPY.notAnswered), 'open rows still marked not-answered');
  assert.ok(text.includes('2 of 10 answered'), 'picks + abstentions count as answered');
  const abstainRows = findAll(container, (node) => node.tag === 'span' && textOf(node) === PLACEMENT_COPY.abstain);
  assert.ok(abstainRows.length > 0, 'abstention row rendered');
  for (const row of abstainRows) {
    assert.ok(row.className.includes('text-muted'), 'neutral muted treatment');
    assert.ok(!row.className.match(/red|error/), 'never an error treatment');
    assert.equal(row.getAttribute('lang'), undefined, 'English label needs no lang hook');
  }
  const finish = findAll(container, (node) => node.tag === 'button' && textOf(node) === 'Finish placement').at(-1);
  assert.equal(finish.disabled, true, 'finish waits while rows are open');
  assert.ok(text.includes(PLACEMENT_COPY.needAllHint), 'finish hint shown');
});

test('submit payload carries optionId:null for abstentions and valid ids for picks', () => {
  const questions = sanitizePlacementQuestions(buildQuestions());
  const answers = {};
  questions.forEach((question, index) => {
    answers[question.id] = index % 2 === 0 ? null : 'b';
  });
  const payload = buildPlacementSubmitPayload(questions, answers);
  assert.equal(payload.answers.length, 10);
  assert.deepEqual(payload.answers.map((entry) => entry.questionId), PLACEMENT_FIXTURE_IDS);
  payload.answers.forEach((entry, index) => {
    assert.deepEqual(Object.keys(entry).sort(), ['optionId', 'questionId'], 'null entries keep both keys');
    assert.equal(entry.optionId, index % 2 === 0 ? null : 'b');
  });
  // Anything still open keeps throwing — null never masks a gap.
  assert.throws(() => buildPlacementSubmitPayload(questions, {}), /Answer all 10/);
  assert.throws(() => buildPlacementSubmitPayload(questions, { ...answers, n3_04: undefined }), /Answer all 10/);
  assert.throws(() => buildPlacementSubmitPayload(questions, { ...answers, n4_01: 'z' }), /Answer all 10/);
  assert.throws(() => buildPlacementSubmitPayload(questions, { ...answers, n4_01: '' }), /Answer all 10/);
  assert.equal(countPlacementAnswered(questions, answers), 10, 'all resolved');
  assert.deepEqual(placementUnansweredIndexes(questions, answers), [], 'nothing open');
});

test('prev/next preserve abstention; abstain-all submits ten nulls', async () => {
  const questions = buildQuestions();
  const { container, deps, log } = createPlacementHarness({ apiImpl: createApiMock({ questions, estimate: 'N4' }) });
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  await clickAbstain(container);
  await clickExact(container, 'Next');
  assert.ok(textOf(container).includes('Question 2 of 10'), 'moved on');
  await clickExact(container, 'Previous');
  assert.ok(textOf(container).includes('Question 1 of 10'), 'back on Q1');
  assert.equal(findAbstainButton(container).getAttribute('aria-pressed'), 'true', 'abstention survived navigation');
  assert.equal(pressedOptions(container).length, 0, 'no option picked up along the way');
  for (let index = 0; index < 10; index += 1) {
    await clickAbstain(container);
    if (index < 9) await clickExact(container, 'Next');
    else await clickExact(container, 'Review answers');
  }
  assert.ok(textOf(container).includes('10 of 10 answered'), 'abstentions complete the set');
  const finish = findAll(container, (node) => node.tag === 'button' && textOf(node) === 'Finish placement').at(-1);
  assert.equal(finish.disabled, false, 'finish enabled with ten abstentions');
  await clickExact(container, 'Finish placement');
  await sleep(650);
  const submitted = log.apiCalls.find((call) => call.path === SUBMIT_PATH);
  assert.ok(submitted, 'submit posted');
  assert.deepEqual(submitted.body.answers.map((entry) => entry.questionId), PLACEMENT_FIXTURE_IDS);
  assert.ok(submitted.body.answers.every((entry) => entry.optionId === null), 'every answer abstained as null');
  assert.ok(textOf(container).includes('N4 range'), 'server estimate presented, never derived');
});

test('fresh sessions reload the same server-assigned set with no carried abstention', async () => {
  const bank = buildQuestions();
  const first = createPlacementHarness({ apiImpl: createApiMock({ questions: bank }) });
  renderPlacement(first.container, first.deps);
  await sleep(25);
  await enterQuiz(first.container);
  await sleep(5);
  assert.ok(textOf(first.container).includes('水をのみます'), 'first session serves the assigned set');
  await clickAbstain(first.container);
  assert.equal(findAbstainButton(first.container).getAttribute('aria-pressed'), 'true', 'first session abstained');
  const second = createPlacementHarness({ apiImpl: createApiMock({ questions: bank }) });
  renderPlacement(second.container, second.deps);
  await sleep(25);
  await enterQuiz(second.container);
  await sleep(5);
  assert.ok(textOf(second.container).includes('水をのみます'), 'same server-assigned set reloaded');
  assert.equal(findAbstainButton(second.container).getAttribute('aria-pressed'), 'false', 'abstentions never persist across sessions');
  assert.equal(countPlacementAnswered(sanitizePlacementQuestions(bank), {}), 0, 'fresh session resolves nothing');
});

test('abstention a11y: shared ghost token carries the 44px target and focus ring; no gloss or romaji added', async () => {
  const css = readSource('src/styles.css');
  const ghostRule = css.match(/\.button-ghost\s*\{[^}]*\}/);
  assert.ok(ghostRule, 'ghost token defined');
  assert.ok(ghostRule[0].includes('min-h-11'), '44px target from the shared token (no new sizing)');
  assert.ok(css.includes('.button-ghost:focus-visible'), 'visible focus from the shared token');
  const { container, deps } = createPlacementHarness();
  renderPlacement(container, deps);
  await sleep(25);
  await enterQuiz(container);
  await sleep(5);
  const abstain = findAbstainButton(container);
  assert.equal(abstain.tag, 'button', 'real button: keyboard reachable by default');
  assert.ok(abstain.className.includes('button-ghost'), 'inherits the token target, focus ring, and dark/light colors');
  assert.ok(abstain.getAttribute('aria-pressed') !== null, 'selected state exposed');
  assert.ok(!abstain.className.match(/animate|transition/), 'no motion added (reduced-motion has nothing to tame)');
  assert.ok(readSource('src/firstExperience.js').includes('prefers-reduced-motion: reduce'), 'calm-handoff reduced-motion path intact');
  // No leakage: the control adds English only — no romaji, no gloss lines.
  assert.equal(textOf(abstain), "I don't know");
  const text = textOf(container);
  for (const gloss of ['water', 'water (on reading)', 'to miss', 'difficult (stem)']) {
    assert.ok(!text.includes(gloss), `gloss "${gloss}" still hidden`);
  }
  assert.ok(!text.match(/wakarimasen|shirimasen/i), 'no romaji added');
});
