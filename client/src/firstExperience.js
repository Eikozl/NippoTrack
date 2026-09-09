// v5.1-A.2 — First-experience (new-user onboarding) shell.
//
// Focused 4-screen setup shown INSTEAD of the normal workflow when the
// authenticated boot sees `onboarding.completed === false` on
// GET /api/first-experience. Implemented against the FIXED backend contract:
//
//   GET /api/first-experience
//     → { onboarding: { completed, studySources[] },
//         placement: { status: 'not_started' | 'skipped' | 'completed',
//                      estimate: null | 'N5'..'N1' },
//         targetLevel: null | 'N5'..'N1' }
//   PUT /api/first-experience/onboarding
//     { targetLevel: null | 'N5'..'N1', studySources: string[],
//       placementStatus?: 'skipped' }
//     → same shape as GET.
//
// Frontend rules for this module:
// - PRESENT server state; never derive completion client-side. The wizard
//   holds in-session state only (no half-progress persistence): a reload
//   before completion re-shows onboarding because the server is still
//   incomplete; after completion/skip the server is complete so it never
//   shows again.
// - Zero imports: every DOM/API dependency is injected, so the pure
//   helpers stay import-safe under node:test (same pattern as jlptTarget).
// - Styling uses shared classes + tokens only (button-primary,
//   button-secondary, button-ghost, surface, eyebrow, status-pill,
//   bg-vermilion/bg-stone, text-muted). No new palette, no hex colors.

const TARGET_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

const STUDY_SOURCES = [
  { value: 'textbooks', label: 'Textbooks' },
  { value: 'anime-drama', label: 'Anime / drama' },
  { value: 'manga', label: 'Manga' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'classes', label: 'Classes' },
  { value: 'flashcards', label: 'Flashcards' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'apps', label: 'Apps' },
  { value: 'notes', label: 'Personal notes' },
  { value: 'other', label: 'Other' }
];

const STUDY_SOURCE_VALUES = STUDY_SOURCES.map((source) => source.value);

function isValidFirstExperienceTarget(value) {
  return value === null || TARGET_LEVELS.includes(value);
}

// Client-side allowlist: drop unknown slugs, de-duplicate, keep the
// order of first appearance. Never invent data the user did not choose.
function sanitizeStudySources(values) {
  if (!Array.isArray(values)) return [];
  const allowed = new Set(STUDY_SOURCE_VALUES);
  const seen = new Set();
  const clean = [];
  for (const value of values) {
    const slug = String(value);
    if (!allowed.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    clean.push(slug);
  }
  return clean;
}

// Server-driven visibility: show ONLY when the server explicitly reports
// incomplete. Missing/malformed shapes never gate (fail open).
function shouldShowOnboarding(data) {
  return data?.onboarding?.completed === false;
}

// Reload/fetch semantics in one place: any fetch failure fails OPEN to
// the normal app (never trap the user behind setup).
function resolveOnboardingVisibility({ data = null, error = null } = {}) {
  if (error) return false;
  return shouldShowOnboarding(data);
}

// Screen 1 secondary action: mark completed with NO invented data.
function skipSetupPayload() {
  return { targetLevel: null, studySources: [] };
}

function buildOnboardingPayload({ targetLevel = null, studySources = [], placementStatus } = {}) {
  if (!isValidFirstExperienceTarget(targetLevel)) {
    throw new Error('Invalid JLPT target level.');
  }
  const payload = { targetLevel, studySources: sanitizeStudySources(studySources) };
  if (placementStatus !== undefined) {
    if (placementStatus !== 'skipped') throw new Error('Invalid placement status.');
    payload.placementStatus = placementStatus;
  }
  return payload;
}

// v5.1-A.3 — Starting point (quick placement quiz + self-reported level).
//
// Focused workspace rendered into the normal content area with the shell
// chrome reused, entered through enterPlacement() after the A.2 wizard
// completes. Implemented against the FIXED backend contract:
//
//   GET /api/first-experience
//     → { placement: { status: 'not_started' | 'skipped' | 'completed',
//                        estimate: null | 'N5'..'N1',
//                        source: null | 'quiz' | 'self_reported',
//                        completedAt?: string | null,
//                        result?: { totalCorrect,
//                                   byBand: { N5, N4, N3 } } | null }, ... }
//   GET /api/first-experience/placement/questions
//     → [{ id, prompt: { text, reading, translation },
//            options: [{ id, text, reading, gloss }] × 4 }] (order kept)
//     → 409 when a completed placement already exists (either source; the
//        client falls back to the stored GET state, never a new quiz).
//   POST /api/first-experience/placement/submit
//     { answers: [{ questionId, optionId: string | null }] × 10 }
//     (optionId null = an "I don't know" abstention: accepted with zero
//     credit and the denominator staying 10; unknown ids, wrong-question
//     ids, and blank ids are rejected — scoring stays server-side)
//     → { estimate: 'N5'..'N3' (quiz ceiling),
//         placement: { status: 'completed', estimate, source: 'quiz',
//                      completedAt?: string, result?: {...} | null } }
//     → 409 when a completed placement already exists (one-time result;
//        the client falls back to the stored GET state, never a new quiz).
//   POST /api/first-experience/placement/self-report
//     { level: 'N5'..'N1' }
//     → { estimate, placement: { status: 'completed', estimate,
//                                source: 'self_reported', completedAt } }
//        (counts stay null — a self-report has no breakdown, ever)
//     → 409 when a completed placement already exists (same fallback).
//   GET /api/first-experience
//     → { placement: { status, estimate, source, completedAt?: string | null,
//                      result?: { totalCorrect, byBand: { N5, N4, N3 } } | null },
//         ... }
//     `result` carries server-computed counts only ({ correct, total } per
//     band); self-reported rows and older rows carry result null.
//   POST /api/first-experience/placement/skip → 200 (status skipped; a
//     completed row stays completed)
//
// One-time semantics: once completed (either source), entering placement
// renders the stored result view directly. There is no re-entry path
// anywhere — no button, no re-fetch of questions, no quiz re-render for
// completed learners.
//
// Frontend rules for this section:
// - PRESENT server material only. Questions render verbatim from the API
//   (Japanese kept under lang="ja"); the estimate comes from the submit /
//   self-report response or the stored first-experience state. This module
//   never stores per-question levels, never marks any selection, and never
//   turns answers into a level on its own — only the server maps answers
//   to an estimate, and only the server grades.
// - In-session state only (no half-progress persistence): a reload before
//   submitting restarts at the entry screen because the server still reports
//   not_started/skipped; once completed, entering placement shows the
//   stored result view instead of a new quiz.
// - Zero static imports (same pattern as A.2): DOM/API dependencies arrive
//   injected, with document/dynamic-import fallbacks inside enterPlacement
//   so the browser entry keeps working when only `navigate` is wired.
// - Shared classes + tokens only (button-primary, button-secondary,
//   button-ghost, surface, eyebrow, skeleton, visually-hidden,
//   bg-vermilion/bg-stone, text-muted, font-jp, border-stone,
//   error-panel). No new palette, no hex colors.

const PLACEMENT_TOTAL = 10;
const PLACEMENT_ESTIMATES = ['N5', 'N4', 'N3', 'N2', 'N1'];
// Self-reported starting levels share the full JLPT range (the quiz
// estimate itself ceilings at N3 server-side; the client never caps — it
// only presents what the server returns).
const SELF_REPORT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const PLACEMENT_SOURCES = ['quiz', 'self_reported'];
const SELF_REPORT_PATH = '/api/first-experience/placement/self-report';
// Calm submit handoff: steady without ever reading as automated reasoning.
// Reduced-motion clients skip the pause and render the result at once.
const PLACEMENT_SUBMIT_MIN_MS = 400;

const PLACEMENT_COPY = {
  eyebrow: 'QUICK PLACEMENT',
  title: 'Quick Japanese Placement',
  intro: 'Answer each question with your best guess. You can change an answer before finishing.',
  note: 'This is a starting estimate, not an official JLPT assessment.',
  entryEyebrow: 'STARTING POINT',
  entryTitle: 'Where should we start?',
  entryBody: 'Choose the option that best fits what you already know about your Japanese.',
  entryQuizTitle: 'Get a quick estimate',
  entryQuizBody: 'Answer 10 short Japanese questions to get a starting reference.',
  entrySelfTitle: 'I already know my level',
  entrySelfBody: 'If you already have a reliable idea of your current JLPT level, you can set your starting point yourself.',
  entrySkip: 'Skip for now',
  entryNote: 'This is a starting reference, not an official JLPT assessment.',
  selfEyebrow: 'STARTING POINT',
  selfTitle: "What's your current level?",
  selfBody: 'Choose the level that best represents where you are starting.',
  selfOptionsLabel: 'JLPT starting level options',
  selfChooseHint: 'Choose a level to continue.',
  selfNote: 'This is a self-reported starting level. NippoTrack may form a different evidence-based estimate later as you review material.',
  selfSubmit: 'Use this starting level',
  selfBack: 'Back',
  selfSaving: 'Saving…',
  selfFailed: 'Unable to save your starting level. Please try again.',
  selfResultEyebrow: 'STARTING LEVEL',
  selfResultPill: 'Self-reported',
  selfResultBody: "You chose this as your starting point. NippoTrack's evidence-based study estimate may change as you review material.",
  quizSourceLabel: 'Quick Placement',
  exit: 'Exit for now',
  leaving: 'Leaving…',
  previous: 'Previous',
  next: 'Next',
  toReview: 'Review answers',
  finish: 'Finish placement',
  backToQuestions: 'Back to questions',
  retry: 'Try again',
  change: 'Change',
  loading: 'Loading your placement…',
  submitting: 'Saving your answers…',
  reviewTitle: 'Review your answers',
  reviewBody: 'Change anything before finishing. Answer all 10 to finish.',
  notAnswered: 'Not answered',
  notAnsweredHint: 'Not answered yet — you can keep going and review it later.',
  abstain: "I don't know",
  needAllHint: 'Answer all 10 questions to finish placement.',
  loadFailedTitle: 'We could not load this view.',
  resultEyebrow: 'STARTING ESTIMATE',
  resultBody: 'Use this as a starting reference, not a verdict on your Japanese.',
  goDashboard: 'Go to dashboard',
  quizResult: 'QUIZ RESULT',
  breakdownLabel: 'Results by difficulty band',
  breakdownNote: 'These questions are grouped by approximate difficulty. This result is a starting reference, not an official JLPT assessment.',
  completedLabel: 'Completed',
  alreadySaved: 'Your previous answers are already saved. Showing your stored result.',
  skipFailed: 'Unable to record your exit. Continuing to the dashboard.',
  submitFailed: 'Unable to save your answers. Please try again.'
};

function placementAnsweredLabel(answered) {
  return `${answered} of 10 answered`;
}

function isValidPlacementEstimate(value) {
  return PLACEMENT_ESTIMATES.includes(value);
}

function placementQuestionLabel(index) {
  return `Question ${index + 1} of ${PLACEMENT_TOTAL}`;
}

function placementResultTitle(estimate) {
  return `${estimate} range`;
}

function placementResultCopy(estimate) {
  return {
    eyebrow: PLACEMENT_COPY.resultEyebrow,
    title: placementResultTitle(estimate),
    body: PLACEMENT_COPY.resultBody,
    note: PLACEMENT_COPY.note
  };
}

// Server-driven result shortcut: a stored completed placement renders the
// result view directly instead of a new quiz. One-time by design — no
// re-entry path exists for completed learners.
function placementEstimateFromState(data) {
  const placement = data?.placement;
  if (!placement || placement.status !== 'completed') return null;
  return isValidPlacementEstimate(placement.estimate) ? placement.estimate : null;
}

// v5.1-A.5 — One-time starting-point result (shared read-only diagrams).
//
// The backend owns every number: a quiz `result` is { totalCorrect, byBand }
// where each band holds a server-computed { correct, total } pair (or,
// tolerantly, a bare correct count when the total is unknown — rendered
// without a denominator, never with an invented one). The quiz bank covers
// N5/N4/N3 only, so the diagram renders exactly those three rows — never
// N2/N1, never a five-band breakdown. This module NEVER maps answers
// to bands, never counts correctness from option ids, and never derives a
// level: it only presents stored counts verbatim as text plus supplementary
// dots. Self-reported rows carry result null by design (no breakdown, ever);
// pre-breakdown quiz rows are also null and render the estimate-only
// variant (no zeros invented).
//
// Shared by the placement result screen, the first-use dashboard, and the
// settings "Japanese starting point" block — one implementation, no copies.

const PLACEMENT_BANDS = ['N5', 'N4', 'N3'];
const PLACEMENT_RESULT_DOT_FILLED = '●';
const PLACEMENT_RESULT_DOT_EMPTY = '○';
const PLACEMENT_RESULT_DOT_CAP = 25;

// Allowlist shaping for the stored breakdown: a valid { totalCorrect,
// byBand } object passes through verbatim; anything malformed (wrong types,
// out-of-range counts, missing bands) yields null so callers fall back to
// the estimate-only variant instead of rendering invented numbers. Only the
// quiz bands N5/N4/N3 are read; any other band keys the server may send
// (present or future) are ignored, never rendered.
function sanitizePlacementResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const totalCorrect = result.totalCorrect;
  if (!Number.isInteger(totalCorrect) || totalCorrect < 0 || totalCorrect > PLACEMENT_TOTAL) return null;
  const byBand = result.byBand;
  if (!byBand || typeof byBand !== 'object' || Array.isArray(byBand)) return null;
  const bands = {};
  for (const band of PLACEMENT_BANDS) {
    const entry = byBand[band];
    if (Number.isInteger(entry)) {
      if (entry < 0 || entry > PLACEMENT_TOTAL) return null;
      bands[band] = { correct: entry, total: null };
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const { correct, total } = entry;
      if (!Number.isInteger(correct) || correct < 0) return null;
      if (!Number.isInteger(total) || total <= 0 || total > PLACEMENT_TOTAL) return null;
      if (correct > total) return null;
      bands[band] = { correct, total };
    } else {
      return null;
    }
  }
  return { totalCorrect, byBand: bands };
}

// Stored source shaping: 'quiz' | 'self_reported' pass through; anything
// else (including the null on pre-source-tracking rows) yields null so
// callers fall back to the quiz presentation. Never invented.
function normalizePlacementSource(value) {
  return PLACEMENT_SOURCES.includes(value) ? value : null;
}

function isValidSelfReportLevel(value) {
  return SELF_REPORT_LEVELS.includes(value);
}

// Self-report payload in one place: { level } with the full JLPT range.
// Throws on anything else so callers keep the learner on the chooser.
function buildSelfReportPayload({ level } = {}) {
  if (!isValidSelfReportLevel(level)) {
    throw new Error('Choose a starting level from N5 to N1.');
  }
  return { level };
}

// Full stored starting point for completed learners:
// { estimate, source, completedAt, result } or null when not completed.
// completedAt stays a raw string (the renderer trims it to a date); result
// is sanitized and is always null for self-reported rows (by design) and
// for pre-breakdown quiz rows. Reads placement.result first, then a
// top-level result as a fallback for forward-compatible GET shapes.
function placementResultFromState(data) {
  const placement = data?.placement;
  if (!placement || placement.status !== 'completed') return null;
  if (!isValidPlacementEstimate(placement.estimate)) return null;
  const rawCompletedAt = placement.completedAt;
  const completedAt = typeof rawCompletedAt === 'string' && rawCompletedAt.trim()
    ? rawCompletedAt.trim()
    : null;
  const source = normalizePlacementSource(placement.source);
  const rawResult = placement.result !== undefined && placement.result !== null
    ? placement.result
    : (data?.result !== undefined ? data.result : null);
  return {
    estimate: placement.estimate,
    source,
    completedAt,
    result: rawResult == null ? null : sanitizePlacementResult(rawResult)
  };
}

// Date-only display for the stored completion timestamp ("Completed:
// 2026-09-01"). Returns null when absent so callers omit the line.
function formatPlacementCompletedDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, 10);
}

// Per-band row text. Text carries the meaning (understandable without
// color); dots are supplementary decoration.
function placementBandRowText(band, correct, total) {
  return total == null
    ? `${band} — ${correct} correct`
    : `${band} — ${correct} of ${total} correct`;
}

// Screen-reader text per row describing the supplementary dots. The visible
// row text already states the counts; this labels the dot visual itself.
function placementBandSrText(band, correct, total) {
  return total == null
    ? `${band} band, ${correct} dots filled`
    : `${band} band, ${correct} of ${total} dots filled`;
}

// Supplementary dots for a band row (aria-hidden at the call site).
function placementBandDots(correct, total) {
  const filledCount = Math.max(0, Math.min(Number.isInteger(correct) ? correct : 0, PLACEMENT_RESULT_DOT_CAP));
  const filled = PLACEMENT_RESULT_DOT_FILLED.repeat(filledCount);
  if (total == null) return filled;
  const emptyCount = Math.max(0, Math.min(total - filledCount, PLACEMENT_RESULT_DOT_CAP));
  return filled + PLACEMENT_RESULT_DOT_EMPTY.repeat(emptyCount);
}

// Shared compact read-only QUIZ result diagram. Renders the estimate
// header, the stored breakdown when present (null-result variant otherwise:
// estimate + completed state, no invented zeros), and exactly ONE honest
// note. No verdict-style claims and no percentages. Text-first: rows are
// real text in a real list; dots are aria-hidden. Callers pass completedAt
// only where the "Completed: <date>" line belongs (settings); the placement
// result screen omits it by never supplying one.
function placementResultNode(el, options = {}) {
  const {
    estimate,
    result = null,
    completedAt = null,
    titleTag = 'h2',
    quizTag = 'h3',
    titleClassName = 'font-display mt-2 text-3xl font-semibold tracking-tight text-ink'
  } = options;
  if (typeof el !== 'function') throw new Error('Placement result requires an element factory.');
  if (!isValidPlacementEstimate(estimate)) throw new Error('Placement result requires a stored estimate.');
  const clean = result == null ? null : sanitizePlacementResult(result);
  const children = [
    el('p', { className: 'eyebrow', text: PLACEMENT_COPY.resultEyebrow }),
    el(titleTag, {
      className: titleClassName,
      text: placementResultTitle(estimate),
      attrs: { tabindex: '-1' }
    }),
    el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: PLACEMENT_COPY.resultBody })
  ];
  const completedDate = formatPlacementCompletedDate(completedAt);
  if (completedDate) {
    children.push(el('p', {
      className: 'mt-2 text-xs font-semibold text-muted',
      text: `${PLACEMENT_COPY.completedLabel}: ${completedDate}`
    }));
  }
  if (clean) {
    const rows = PLACEMENT_BANDS.map((band) => {
      const entry = clean.byBand[band];
      return el('li', {
        className: 'flex min-w-0 flex-col gap-1 rounded-xl border border-stone p-3 sm:flex-row sm:items-center sm:justify-between'
      }, [
        el('span', { className: 'min-w-0 break-words text-sm font-semibold text-ink', text: placementBandRowText(band, entry.correct, entry.total) }),
        el('span', {
          className: 'shrink-0 text-sm tracking-[0.2em] text-muted',
          text: placementBandDots(entry.correct, entry.total),
          attrs: { 'aria-hidden': 'true' }
        }),
        el('span', { className: 'visually-hidden', text: placementBandSrText(band, entry.correct, entry.total) })
      ]);
    });
    children.push(
      el(quizTag, { className: 'eyebrow mt-5', text: PLACEMENT_COPY.quizResult }),
      el('p', { className: 'mt-2 text-sm font-semibold text-ink', text: `${clean.totalCorrect} / ${PLACEMENT_TOTAL} correct` }),
      el('ul', { className: 'mt-3 grid min-w-0 gap-2', attrs: { 'aria-label': PLACEMENT_COPY.breakdownLabel } }, rows)
    );
  }
  children.push(
    el('p', { className: 'mt-4 text-xs leading-5 text-muted', text: PLACEMENT_COPY.breakdownNote })
  );
  const node = el('div', { className: 'placement-result min-w-0' }, children);
  // View-focus hook: result views focus the wrapper (tabindex -1) so focus
  // moves with the SPA view change; the title heading above stays the
  // screen-reader heading.
  node.setAttribute('tabindex', '-1');
  return node;
}

function selfReportResultTitle(estimate) {
  return `JLPT ${estimate}`;
}

// Shared compact read-only SELF-REPORTED result. No totals, no dots, no
// percentages, no breakdown — the learner chose this level, so there is
// nothing to grade. Same view-focus hook and completed-date convention as
// the quiz diagram; the body states plainly that the evidence-based study
// estimate may diverge later.
function selfReportResultNode(el, options = {}) {
  const {
    estimate,
    completedAt = null,
    titleTag = 'h2',
    titleClassName = 'font-display mt-2 text-3xl font-semibold tracking-tight text-ink'
  } = options;
  if (typeof el !== 'function') throw new Error('Self-reported result requires an element factory.');
  if (!isValidSelfReportLevel(estimate)) throw new Error('Self-reported result requires a chosen level.');
  const children = [
    el('p', { className: 'eyebrow', text: PLACEMENT_COPY.selfResultEyebrow }),
    el(titleTag, {
      className: titleClassName,
      text: selfReportResultTitle(estimate),
      attrs: { tabindex: '-1' }
    }),
    el('p', { className: 'mt-3' }, [
      el('span', { className: 'status-pill', text: PLACEMENT_COPY.selfResultPill })
    ]),
    el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: PLACEMENT_COPY.selfResultBody })
  ];
  const completedDate = formatPlacementCompletedDate(completedAt);
  if (completedDate) {
    children.push(el('p', {
      className: 'mt-2 text-xs font-semibold text-muted',
      text: `${PLACEMENT_COPY.completedLabel}: ${completedDate}`
    }));
  }
  const node = el('div', { className: 'placement-result min-w-0' }, children);
  node.setAttribute('tabindex', '-1');
  return node;
}

// Allowlist shaping: keep ONLY the display fields the quiz renders, in API
// order. Anything else sent along (present or future) never reaches state,
// the submit payload, or the DOM.
function sanitizePlacementQuestions(data) {
  const list = Array.isArray(data) ? data : data?.questions;
  if (!Array.isArray(list) || list.length !== PLACEMENT_TOTAL) {
    throw new Error('Placement questions are unavailable right now.');
  }
  const seenQuestions = new Set();
  return list.map((entry) => {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const prompt = entry?.prompt || {};
    const text = typeof prompt.text === 'string' ? prompt.text : '';
    const reading = typeof prompt.reading === 'string' ? prompt.reading : '';
    const translation = typeof prompt.translation === 'string' ? prompt.translation : '';
    const options = entry?.options;
    if (!id || seenQuestions.has(id) || !text || !Array.isArray(options) || options.length !== 4) {
      throw new Error('Placement questions are unavailable right now.');
    }
    seenQuestions.add(id);
    const seenOptions = new Set();
    const cleanOptions = options.map((option) => {
      const optionId = typeof option?.id === 'string' ? option.id.trim() : '';
      const optionText = typeof option?.text === 'string' ? option.text : '';
      const optionReading = typeof option?.reading === 'string' ? option.reading : '';
      const optionGloss = typeof option?.gloss === 'string' ? option.gloss : '';
      if (!optionId || seenOptions.has(optionId) || !optionText) {
        throw new Error('Placement questions are unavailable right now.');
      }
      seenOptions.add(optionId);
      return { id: optionId, text: optionText, reading: optionReading, gloss: optionGloss };
    });
    return { id, prompt: { text, reading, translation }, options: cleanOptions };
  });
}

// Abstention state machine (per question, in-session only):
//   answers[questionId] = optionId string → one option picked
//                       = null            → abstained ("I don't know")
//                       = undefined/other → unanswered
// Picking an option overwrites an abstention; abstaining overwrites the
// pick. Prev/next never touch answers, so both survive navigation. The
// client never grades — it only shapes the submit payload.
function isPlacementAbstained(value) {
  return value === null;
}

function isPlacementPick(question, value) {
  return typeof value === 'string'
    && !!question
    && Array.isArray(question.options)
    && question.options.some((option) => option.id === value);
}

// Resolved = submittable: a real pick OR an abstention. Unknown option
// ids and missing entries stay unanswered (never invented into a pick).
function isPlacementResolved(question, value) {
  return isPlacementAbstained(value) || isPlacementPick(question, value);
}

function countPlacementAnswered(questions, answers) {
  if (!Array.isArray(questions)) return 0;
  const picks = answers || {};
  return questions.filter((question) => isPlacementResolved(question, picks[question.id])).length;
}

function placementUnansweredIndexes(questions, answers) {
  const picks = answers || {};
  const open = [];
  (questions || []).forEach((question, index) => {
    if (!isPlacementResolved(question, picks[question.id])) open.push(index);
  });
  return open;
}

// Submit shape in one place: API order, chosen option per question, null
// for abstentions. Throws while anything is unanswered (missing, blank,
// or unknown option id) so callers route back to review with a hint.
function buildPlacementSubmitPayload(questions, answers) {
  if (!Array.isArray(questions) || questions.length !== PLACEMENT_TOTAL) {
    throw new Error('Placement questions are unavailable right now.');
  }
  const picks = answers || {};
  const shaped = questions.map((question) => {
    const value = picks[question.id];
    if (isPlacementAbstained(value)) return { questionId: question.id, optionId: null };
    if (!isPlacementPick(question, value)) {
      throw new Error('Answer all 10 questions to finish placement.');
    }
    return { questionId: question.id, optionId: value };
  });
  return { answers: shaped };
}

// Renders the placement workspace into `container` (normally #app-content,
// reusing the app shell chrome). Returns a session handle mirroring the
// A.2 shape: { active, reshow(), finish() }.
function renderPlacement(container, deps = {}) {
  const { el, api, navigate, notify = () => {} } = deps;
  if (typeof el !== 'function') throw new Error('Placement requires an element factory.');
  if (typeof api !== 'function') throw new Error('Placement requires an API caller.');

  const state = {
    phase: 'loading',
    questions: [],
    index: 0,
    answers: {},
    estimate: null,
    source: null,
    result: null,
    selfLevel: null,
    notice: null,
    failure: null
  };
  let active = true;
  let busy = false;

  function goDashboard() {
    active = false;
    if (typeof navigate === 'function') navigate('dashboard');
    else if (typeof window !== 'undefined' && window.location) window.location.hash = '#dashboard';
  }

  // Reduced-motion clients get every transition instantly.
  function calmPauseSkipped() {
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
    } catch {
      // Fall through to the pause.
    }
    return false;
  }

  function wait(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  function focusNode(node) {
    if (node && typeof node.focus === 'function') node.focus();
  }

  function paint(panelChildren, focusTarget) {
    const panel = el('section', {
      // Placement breathes on desktop/tablet (md 42rem, lg 48rem); mobile stays at max-w-xl.
      className: 'placement surface mx-auto w-full max-w-xl p-6 sm:p-8 md:max-w-2xl lg:max-w-3xl',
      attrs: { 'aria-label': PLACEMENT_COPY.title }
    }, panelChildren);
    container.replaceChildren(el('div', { className: 'first-exp-screen' }, [panel]));
    focusNode(focusTarget);
  }

  function skeletonRows() {
    return el('div', { className: 'mt-5 grid gap-2', attrs: { 'aria-hidden': 'true' } }, [
      el('div', { className: 'skeleton h-5 w-2/3' }),
      el('div', { className: 'skeleton h-11 w-full' }),
      el('div', { className: 'skeleton h-11 w-full' }),
      el('div', { className: 'skeleton h-11 w-full' })
    ]);
  }

  function renderLoading(message) {
    paint([
      el('p', { className: 'eyebrow', text: PLACEMENT_COPY.eyebrow }),
      el('h2', { className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink', text: PLACEMENT_COPY.title }),
      skeletonRows(),
      el('p', { className: 'mt-4 text-sm text-muted', text: message })
    ], null);
  }

  function exitButton() {
    const button = el('button', { className: 'button-ghost w-full', text: PLACEMENT_COPY.exit, attrs: { type: 'button' } });
    button.addEventListener('click', () => { void exitPlacement(button); });
    return button;
  }

  // Fail-open exit: the skip POST is best-effort; whatever happens, the
  // learner lands on the dashboard (with a toast when it failed). A 409
  // (already completed elsewhere) stays silent — the stored state is
  // already safe, so there is nothing to warn about.
  async function exitPlacement(button) {
    if (busy) return;
    busy = true;
    if (button) {
      button.disabled = true;
      button.textContent = PLACEMENT_COPY.leaving;
    }
    try {
      await api('/api/first-experience/placement/skip', { method: 'POST' });
    } catch (error) {
      if (!error || error.status !== 409) notify(PLACEMENT_COPY.skipFailed, 'error');
    } finally {
      busy = false;
    }
    goDashboard();
  }

  // A completed starting point (either source) refreshes header-level
  // surfaces: the header control shows the starting level while review
  // evidence is still insufficient. Best-effort — never blocks navigation.
  function announceStartingPointChanged() {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('jlt-starting-point-change'));
      }
    } catch {
      // Never trap placement on a broadcast failure.
    }
  }

  // ENTRY SCREEN: the choice comes before any question loads. Both cards
  // are real buttons; skipping is fail-open to the dashboard.
  function renderEntry() {
    state.phase = 'entry';
    const heading = el('h1', {
      className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink',
      text: PLACEMENT_COPY.entryTitle,
      attrs: { tabindex: '-1' }
    });
    const quizCard = el('button', {
      className: 'button-secondary w-full',
      attrs: { type: 'button' }
    }, [el('span', { className: 'block w-full min-w-0 text-left' }, [
      el('span', { className: 'block text-base font-semibold break-words', text: PLACEMENT_COPY.entryQuizTitle }),
      el('span', { className: 'mt-1 block text-xs font-normal leading-5 text-muted break-words', text: PLACEMENT_COPY.entryQuizBody })
    ])]);
    quizCard.addEventListener('click', () => {
      if (busy) return;
      void loadQuestions();
    });
    const selfCard = el('button', {
      className: 'button-secondary w-full',
      attrs: { type: 'button' }
    }, [el('span', { className: 'block w-full min-w-0 text-left' }, [
      el('span', { className: 'block text-base font-semibold break-words', text: PLACEMENT_COPY.entrySelfTitle }),
      el('span', { className: 'mt-1 block text-xs font-normal leading-5 text-muted break-words', text: PLACEMENT_COPY.entrySelfBody })
    ])]);
    selfCard.addEventListener('click', () => {
      if (busy) return;
      renderSelfReport();
    });
    const skip = el('button', { className: 'button-ghost w-full', text: PLACEMENT_COPY.entrySkip, attrs: { type: 'button' } });
    skip.addEventListener('click', () => { void exitPlacement(skip); });
    paint([
      el('p', { className: 'eyebrow', text: PLACEMENT_COPY.entryEyebrow }),
      heading,
      el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: PLACEMENT_COPY.entryBody }),
      el('div', { className: 'mt-5 grid min-w-0 gap-2' }, [quizCard, selfCard]),
      el('div', { className: 'mt-2' }, [skip]),
      el('p', { className: 'mt-4 text-xs leading-5 text-muted', text: PLACEMENT_COPY.entryNote })
    ], heading);
  }

  // SELF-REPORT FLOW: the learner picks their own JLPT starting level.
  // Nothing is graded here — the choice POSTs as { level } and the server
  // completes the starting point with source 'self_reported' and no counts.
  function renderSelfReport() {
    state.phase = 'selfReport';
    const heading = el('h1', {
      className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink',
      text: PLACEMENT_COPY.selfTitle,
      attrs: { tabindex: '-1' }
    });
    const options = SELF_REPORT_LEVELS.map((level) => {
      const selected = state.selfLevel === level;
      const button = el('button', {
        className: `w-full ${selected ? 'button-primary' : 'button-secondary'}`,
        text: `JLPT ${level}`,
        attrs: { type: 'button', 'aria-pressed': String(selected) }
      });
      button.addEventListener('click', () => {
        if (busy) return;
        state.selfLevel = level;
        renderSelfReport();
      });
      return button;
    });
    const submit = el('button', { className: 'button-primary w-full sm:w-auto', text: PLACEMENT_COPY.selfSubmit, attrs: { type: 'button' } });
    submit.disabled = !isValidSelfReportLevel(state.selfLevel) || busy;
    submit.addEventListener('click', () => { void submitSelfReport(submit); });
    const back = el('button', { className: 'button-secondary w-full sm:w-auto', text: PLACEMENT_COPY.selfBack, attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      if (busy) return;
      renderEntry();
    });
    paint([
      el('p', { className: 'eyebrow', text: PLACEMENT_COPY.selfEyebrow }),
      heading,
      el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: PLACEMENT_COPY.selfBody }),
      el('div', { className: 'mt-5 grid min-w-0 gap-2 sm:grid-cols-2', attrs: { role: 'group', 'aria-label': PLACEMENT_COPY.selfOptionsLabel } }, options),
      ...(!isValidSelfReportLevel(state.selfLevel) ? [el('p', { className: 'mt-3 text-xs leading-5 text-muted', text: PLACEMENT_COPY.selfChooseHint })] : []),
      el('p', { className: 'mt-4 text-xs leading-5 text-muted', text: PLACEMENT_COPY.selfNote }),
      el('div', { className: 'mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' }, [back, submit])
    ], heading);
  }

  // Fail-open self-report submit: failures toast and stay on the chooser
  // with the pick intact. A 409 (completed elsewhere) falls back to the
  // stored result — whichever source it carries — with a calm notice.
  async function submitSelfReport(button) {
    if (busy) return;
    let payload;
    try {
      payload = buildSelfReportPayload({ level: state.selfLevel });
    } catch (error) {
      notify(error?.message || PLACEMENT_COPY.selfFailed, 'error');
      return;
    }
    busy = true;
    if (button) {
      button.disabled = true;
      button.textContent = PLACEMENT_COPY.selfSaving;
    }
    try {
      const data = await api(SELF_REPORT_PATH, { method: 'POST', body: payload });
      const estimate = data?.estimate || data?.placement?.estimate || state.selfLevel;
      if (!isValidPlacementEstimate(estimate)) throw new Error(PLACEMENT_COPY.selfFailed);
      if (!active) return;
      state.estimate = estimate;
      state.source = normalizePlacementSource(data?.placement?.source ?? data?.source) || 'self_reported';
      state.result = null;
      state.notice = null;
      state.phase = 'result';
      announceStartingPointChanged();
      renderResult();
    } catch (error) {
      if (!active) return;
      if (error && error.status === 409) {
        const stored = await loadStoredPlacement();
        if (!active) return;
        if (stored) {
          state.estimate = stored.estimate;
          state.source = stored.source;
          state.result = stored.result;
          state.notice = PLACEMENT_COPY.alreadySaved;
          state.phase = 'result';
          announceStartingPointChanged();
          renderResult();
          return;
        }
      }
      notify(error?.message || PLACEMENT_COPY.selfFailed, 'error');
      state.phase = 'selfReport';
      renderSelfReport();
    } finally {
      busy = false;
    }
  }

  function renderQuestion() {
    const question = state.questions[state.index];
    const label = placementQuestionLabel(state.index);
    const picked = state.answers[question.id];
    const abstained = isPlacementAbstained(picked);
    const resolved = abstained || isPlacementPick(question, picked);
    const heading = el('h2', {
      className: 'font-display mt-5 text-xl font-semibold tracking-tight text-ink',
      text: label,
      attrs: { tabindex: '-1' }
    });
    const dots = state.questions.map((entry) => el('span', {
      className: `h-1.5 min-w-0 flex-1 rounded-full ${isPlacementResolved(entry, state.answers[entry.id]) ? 'bg-vermilion' : 'bg-stone'}`
    }));
    const optionButtons = question.options.map((option) => {
      const selected = picked === option.id;
      const subClass = `block text-xs font-normal break-words ${selected ? 'opacity-80' : 'text-muted'}`;
      const lines = [
        el('span', { className: 'block text-base font-semibold break-words', text: option.text, attrs: { lang: 'ja' } })
      ];
      if (option.reading) lines.push(el('span', { className: subClass, text: option.reading, attrs: { lang: 'ja' } }));
      // English gloss intentionally not rendered: options answer from Japanese knowledge, not from reading the gloss.
      const button = el('button', {
        className: `w-full ${selected ? 'button-primary' : 'button-secondary'}`,
        attrs: { type: 'button', 'aria-pressed': String(selected) }
      }, [el('span', { className: 'block w-full min-w-0 text-left' }, lines)]);
      button.addEventListener('click', () => {
        if (busy) return;
        state.answers[question.id] = option.id;
        renderQuestion();
      });
      return button;
    });
    // Abstention: a visually SECONDARY control, separated from the four
    // Japanese choices by spacing plus a divider — never a fifth option
    // card. Ghost token only (min-h-11 target, focus-visible outline, and
    // dark/light colors all inherited); the pressed state is exposed via
    // aria-pressed plus a non-color underline cue. Picking it clears the
    // option pick (mutual exclusion lives in answers, one value per key).
    const abstainButton = el('button', {
      className: `button-ghost w-full${abstained ? ' underline' : ''}`,
      text: PLACEMENT_COPY.abstain,
      attrs: { type: 'button', 'aria-pressed': String(abstained) }
    });
    abstainButton.addEventListener('click', () => {
      if (busy) return;
      state.answers[question.id] = null;
      renderQuestion();
    });
    const prev = el('button', { className: 'button-secondary w-full sm:w-auto', text: PLACEMENT_COPY.previous, attrs: { type: 'button' } });
    prev.disabled = state.index === 0 || busy;
    prev.addEventListener('click', () => {
      if (busy || state.index === 0) return;
      state.index -= 1;
      renderQuestion();
    });
    const last = state.index === state.questions.length - 1;
    const next = el('button', { className: 'button-primary w-full sm:w-auto', text: last ? PLACEMENT_COPY.toReview : PLACEMENT_COPY.next, attrs: { type: 'button' } });
    next.addEventListener('click', () => {
      if (busy) return;
      if (last) {
        state.phase = 'review';
        renderReview();
        return;
      }
      state.index += 1;
      renderQuestion();
    });
    paint([
      el('p', { className: 'eyebrow', text: PLACEMENT_COPY.eyebrow }),
      el('h1', { className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink', text: PLACEMENT_COPY.title }),
      el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: PLACEMENT_COPY.intro }),
      el('p', { className: 'mt-2 text-xs leading-5 text-muted', text: PLACEMENT_COPY.note }),
      heading,
      el('div', { className: 'mt-3' }, [
        el('div', { className: 'flex items-center gap-1.5', attrs: { 'aria-hidden': 'true' } }, dots),
        el('p', { className: 'visually-hidden', text: label })
      ]),
      el('div', { className: 'mt-4 grid min-w-0 gap-1.5' }, [
        el('p', { className: 'font-jp min-w-0 text-lg font-semibold leading-8 text-ink break-words', text: question.prompt.text, attrs: { lang: 'ja' } }),
        ...(question.prompt.reading ? [el('p', { className: 'min-w-0 text-sm leading-6 text-muted break-words', text: question.prompt.reading, attrs: { lang: 'ja' } })] : []),
        ...(question.prompt.translation ? [el('p', { className: 'min-w-0 text-sm leading-6 text-muted break-words', text: question.prompt.translation })] : [])
      ]),
      el('div', { className: 'mt-4 grid gap-2 md:grid-cols-2', attrs: { role: 'group', 'aria-label': `Options for question ${state.index + 1}` } }, optionButtons),
      el('div', { className: 'mt-3 border-t border-stone pt-3' }, [abstainButton]),
      ...(!resolved ? [el('p', { className: 'mt-3 text-xs leading-5 text-muted', text: PLACEMENT_COPY.notAnsweredHint })] : []),
      el('div', { className: 'mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' }, [prev, next]),
      el('div', { className: 'mt-2' }, [exitButton()])
    ], heading);
  }

  function renderReview() {
    const heading = el('h2', {
      className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink',
      text: PLACEMENT_COPY.reviewTitle,
      attrs: { tabindex: '-1' }
    });
    const answered = countPlacementAnswered(state.questions, state.answers);
    const complete = answered === PLACEMENT_TOTAL && state.questions.length === PLACEMENT_TOTAL;
    const rows = state.questions.map((entry, position) => {
      const value = state.answers[entry.id];
      const chosen = entry.options.find((option) => option.id === value);
      // Three-way display: picked answer text, a neutral "I don't know"
      // (muted like an unanswered row — never an error treatment), or the
      // not-answered-yet state for still-open questions.
      const answerNode = chosen
        ? el('span', { className: 'block text-sm font-semibold text-ink break-words', text: chosen.text, attrs: { lang: 'ja' } })
        : isPlacementAbstained(value)
          ? el('span', { className: 'block text-sm text-muted', text: PLACEMENT_COPY.abstain })
          : el('span', { className: 'block text-sm text-muted', text: PLACEMENT_COPY.notAnswered });
      const change = el('button', {
        className: 'button-secondary w-full sm:w-auto',
        text: PLACEMENT_COPY.change,
        attrs: { type: 'button', 'aria-label': `Change answer for question ${position + 1}` }
      });
      change.addEventListener('click', () => {
        if (busy) return;
        state.index = position;
        state.phase = 'question';
        renderQuestion();
      });
      return el('div', { className: 'flex min-w-0 flex-col gap-2 rounded-xl border border-stone p-3 sm:flex-row sm:items-center sm:justify-between' }, [
        el('div', { className: 'min-w-0' }, [
          el('p', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: `Question ${position + 1}` }),
          answerNode
        ]),
        change
      ]);
    });
    const back = el('button', { className: 'button-secondary w-full sm:w-auto', text: PLACEMENT_COPY.backToQuestions, attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      if (busy) return;
      state.phase = 'question';
      renderQuestion();
    });
    const finish = el('button', { className: 'button-primary w-full sm:w-auto', text: PLACEMENT_COPY.finish, attrs: { type: 'button' } });
    finish.disabled = !complete || busy;
    finish.addEventListener('click', () => { void submitPlacement(); });
    paint([
      el('p', { className: 'eyebrow', text: PLACEMENT_COPY.eyebrow }),
      el('h1', { className: 'font-display mt-2 text-xl font-semibold tracking-tight text-ink', text: PLACEMENT_COPY.title }),
      heading,
      el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: PLACEMENT_COPY.reviewBody }),
      el('p', { className: 'mt-3 text-sm font-semibold text-ink', text: placementAnsweredLabel(answered) }),
      el('div', { className: 'mt-3 grid min-w-0 gap-2' }, rows),
      ...(!complete ? [el('p', { className: 'mt-3 text-xs leading-5 text-muted', text: PLACEMENT_COPY.needAllHint })] : []),
      el('div', { className: 'mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' }, [back, finish]),
      el('div', { className: 'mt-2' }, [exitButton()])
    ], heading);
  }

  function renderSubmitting() {
    paint([
      el('p', { className: 'eyebrow', text: PLACEMENT_COPY.eyebrow }),
      el('h2', { className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink', text: PLACEMENT_COPY.title }),
      skeletonRows(),
      el('p', { className: 'mt-4 text-sm text-muted', text: PLACEMENT_COPY.submitting })
    ], null);
  }

  // Stored-state read in one place: never throws (fail-open to null), so
  // completed races and 409 fallbacks share it.
  async function loadStoredPlacement() {
    try {
      return placementResultFromState(await api('/api/first-experience'));
    } catch {
      return null;
    }
  }

  async function submitPlacement() {
    if (busy) return;
    let payload;
    try {
      payload = buildPlacementSubmitPayload(state.questions, state.answers);
    } catch (error) {
      notify(error?.message || PLACEMENT_COPY.submitFailed, 'error');
      state.phase = 'review';
      renderReview();
      return;
    }
    busy = true;
    state.phase = 'submitting';
    renderSubmitting();
    const started = Date.now();
    try {
      const data = await api('/api/first-experience/placement/submit', { method: 'POST', body: payload });
      const estimate = data?.estimate || data?.placement?.estimate;
      if (!isValidPlacementEstimate(estimate)) throw new Error('The placement result was unclear. Please try again.');
      if (!calmPauseSkipped()) {
        const remaining = PLACEMENT_SUBMIT_MIN_MS - (Date.now() - started);
        if (remaining > 0) await wait(remaining);
      }
      if (!active) return;
      // Present the server's stored breakdown when it travels with the
      // response; otherwise the estimate-only variant (never invented).
      const stored = placementResultFromState({
        placement: {
          status: 'completed',
          estimate,
          source: data?.placement?.source ?? data?.source ?? 'quiz',
          completedAt: data?.placement?.completedAt ?? data?.completedAt ?? null,
          result: data?.placement?.result ?? data?.result ?? null
        }
      });
      state.estimate = estimate;
      state.source = normalizePlacementSource(data?.placement?.source ?? data?.source) || 'quiz';
      state.result = stored ? stored.result : null;
      state.notice = null;
      state.phase = 'result';
      announceStartingPointChanged();
      renderResult();
    } catch (error) {
      if (!active) return;
      // Already-completed race (409): another submit landed first. Show the
      // stored result with a calm notice — never an error crash, never a
      // new quiz. Only when the stored read itself fails do we toast and
      // return to review with picks intact.
      if (error && error.status === 409) {
        const stored = await loadStoredPlacement();
        if (!active) return;
        if (stored) {
          state.estimate = stored.estimate;
          state.source = stored.source;
          state.result = stored.result;
          state.notice = PLACEMENT_COPY.alreadySaved;
          state.phase = 'result';
          announceStartingPointChanged();
          renderResult();
          return;
        }
      }
      notify(error?.message || PLACEMENT_COPY.submitFailed, 'error');
      state.phase = 'review';
      renderReview();
    } finally {
      busy = false;
    }
  }

  // One-time result view: the shared diagram for the completed source
  // (quiz breakdown or self-reported level) plus the primary dashboard
  // action only. Completed learners get no quiz path of any kind.
  function renderResult() {
    const resultNode = state.source === 'self_reported'
      ? selfReportResultNode(el, { estimate: state.estimate })
      : placementResultNode(el, { estimate: state.estimate, result: state.result });
    const go = el('button', { className: 'button-primary w-full', text: PLACEMENT_COPY.goDashboard, attrs: { type: 'button' } });
    go.addEventListener('click', goDashboard);
    paint([
      ...(state.notice ? [el('p', { className: 'mt-0 text-sm leading-6 text-muted', text: state.notice })] : []),
      resultNode,
      el('div', { className: 'mt-6 grid gap-2' }, [go])
    ], resultNode);
  }

  function renderError() {
    const heading = el('h2', {
      className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink',
      text: PLACEMENT_COPY.loadFailedTitle,
      attrs: { tabindex: '-1' }
    });
    const retry = el('button', { className: 'button-primary w-full sm:w-auto', text: PLACEMENT_COPY.retry, attrs: { type: 'button' } });
    retry.addEventListener('click', () => {
      if (busy) return;
      void loadQuestions();
    });
    const panel = el('section', {
      className: 'placement surface error-panel mx-auto w-full max-w-xl p-6 sm:p-8 md:max-w-2xl lg:max-w-3xl',
      attrs: { 'aria-label': PLACEMENT_COPY.title }
    }, [
      heading,
      el('p', { className: 'error-panel-detail mt-2 text-sm text-red-700', text: state.failure?.message || 'Unexpected error.' }),
      el('div', { className: 'mt-6 flex flex-col gap-2 sm:flex-row sm:items-center' }, [retry, exitButton()])
    ]);
    container.replaceChildren(el('div', { className: 'first-exp-screen' }, [panel]));
    focusNode(heading);
  }

  function renderCurrent() {
    if (state.phase === 'entry') renderEntry();
    else if (state.phase === 'selfReport') renderSelfReport();
    else if (state.phase === 'question' && state.questions.length) renderQuestion();
    else if (state.phase === 'review' && state.questions.length) renderReview();
    else if (state.phase === 'result' && state.estimate) renderResult();
    else if (state.phase === 'error') renderError();
    else if (state.phase === 'submitting') renderSubmitting();
    else if (state.phase === 'loading') renderLoading(PLACEMENT_COPY.loading);
    else renderEntry();
  }

  async function boot() {
    state.phase = 'loading';
    renderLoading(PLACEMENT_COPY.loading);
    // A stored completed placement short-circuits to the result view, so
    // completed learners never re-fetch questions or re-render the quiz.
    // Everyone else lands on the entry choice — questions only load after
    // the learner picks the quiz card.
    const stored = await loadStoredPlacement();
    if (!active) return;
    if (stored) {
      state.estimate = stored.estimate;
      state.source = stored.source;
      state.result = stored.result;
      state.notice = null;
      state.phase = 'result';
      renderResult();
      return;
    }
    renderEntry();
  }

  // Quiz path loader: runs when the learner picks "Get a quick estimate"
  // on the entry screen (or retries after a questions failure). A 409 here
  // means completion landed elsewhere — fall back to the stored result of
  // whichever source it carries, never an error view.
  async function loadQuestions() {
    if (busy) return;
    state.phase = 'loading';
    renderLoading(PLACEMENT_COPY.loading);
    try {
      state.questions = sanitizePlacementQuestions(await api('/api/first-experience/placement/questions'));
    } catch (error) {
      if (!active) return;
      // Completed between the state read and the questions fetch (409):
      // fall back to the stored result instead of an error view, so a
      // completed learner never sees a quiz or a crash.
      if (error && error.status === 409) {
        const raced = await loadStoredPlacement();
        if (!active) return;
        if (raced) {
          state.estimate = raced.estimate;
          state.source = raced.source;
          state.result = raced.result;
          state.notice = PLACEMENT_COPY.alreadySaved;
          state.phase = 'result';
          renderResult();
          return;
        }
      }
      state.failure = error;
      state.phase = 'error';
      renderError();
      return;
    }
    if (!active) return;
    state.answers = {};
    state.index = 0;
    state.phase = 'question';
    renderQuestion();
  }

  void boot();

  return {
    get active() { return active; },
    reshow() { if (active) renderCurrent(); },
    finish() { active = false; }
  };
}

// Minimal element factory for the self-wired browser entry below. Mirrors
// the subset of ui.element that renderPlacement uses (no translations;
// Japanese renders verbatim either way).
function fallbackPlacementEl(tagName, { className, text, attrs, dataset } = {}, children = []) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  for (const [name, value] of Object.entries(dataset || {})) {
    node.dataset[name] = String(value);
  }
  const flat = (Array.isArray(children) ? children : [children]).flat(Infinity).filter(Boolean);
  for (const child of flat) node.appendChild(child);
  return node;
}

// Minimal toast fallback so the self-wired entry still surfaces the
// fail-open skip notice without depending on ui.js.
function fallbackPlacementNotify(message, type = 'success') {
  try {
    if (typeof document === 'undefined') return;
    const region = document.getElementById('toast-region');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = 'pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg toast-panel';
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = String(message);
    region.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 3600);
  } catch {
    // Never trap placement on a toast failure.
  }
}

// A.3 PLACEMENT ENTRY HOOK (owned since A.3; replaces the A.2 stub that
// routed straight to the dashboard). Starts the placement workspace after
// the onboarding PUT succeeds. Extra fields are optional so the A.2 call
// shape ({ navigate }) keeps working: the container resolves from the app
// shell and the API caller lazy-loads, both only in a real browser.
// Without a usable container (tests, non-DOM use) it fails open to the
// dashboard, exactly like A.2 did.
function enterPlacement({ navigate, container, api, notify, el } = {}) {
  const goDashboard = () => {
    if (typeof navigate === 'function') navigate('dashboard');
    else if (typeof window !== 'undefined' && window.location) window.location.hash = '#dashboard';
  };
  if (typeof el !== 'function' && typeof document === 'undefined') {
    goDashboard();
    return { get active() { return false; }, reshow() {}, finish() {} };
  }
  const root = container
    || (typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('app-content')
      : null);
  if (!root) {
    goDashboard();
    return { get active() { return false; }, reshow() {}, finish() {} };
  }
  const apiCaller = typeof api === 'function'
    ? api
    : (path, options) => import('./api.js').then((module) => module.apiRequest(path, options));
  return renderPlacement(root, {
    el: typeof el === 'function' ? el : fallbackPlacementEl,
    api: apiCaller,
    navigate: typeof navigate === 'function' ? navigate : () => goDashboard(),
    notify: typeof notify === 'function' ? notify : fallbackPlacementNotify
  });
}

function stepLabel(step) {
  return `Step ${step} of 4`;
}

// Renders the 4-screen wizard into `container` (normally #app-content,
// reusing the app shell chrome). Returns a session handle for the boot
// gate in main.js: { active, reshow(), finish() }.
function renderFirstExperience(container, deps = {}) {
  const { el, api, navigate, notify = () => {}, onComplete = () => {}, onEnterPlacement = null } = deps;
  if (typeof el !== 'function') throw new Error('First-experience setup requires an element factory.');
  if (typeof api !== 'function') throw new Error('First-experience setup requires an API caller.');

  const state = { step: 1, targetLevel: null, studySources: [], saving: false };
  let active = true;

  function progress(step) {
    return el('div', { className: 'mb-5' }, [
      el('ol', { className: 'flex items-center gap-1.5', attrs: { 'aria-label': 'Setup progress' } }, [1, 2, 3, 4].map((number) => el('li', {
        className: `h-1.5 flex-1 rounded-full ${number === step ? 'bg-vermilion' : 'bg-stone'}`,
        attrs: number === step ? { 'aria-current': 'step' } : {}
      }))),
      el('p', { className: 'mt-2 text-xs font-medium text-muted', text: stepLabel(step) })
    ]);
  }

  function shell({ step, eyebrow, title, titleTag = 'h2', body, children }) {
    const heading = el(titleTag, {
      className: 'font-display mt-2 text-2xl font-semibold tracking-tight text-ink',
      text: title,
      attrs: { tabindex: '-1' }
    });
    const panel = el('section', {
      className: 'first-exp surface mx-auto w-full max-w-xl p-6 sm:p-8',
      attrs: { 'aria-label': stepLabel(step) }
    }, [
      progress(step),
      el('p', { className: 'eyebrow', text: eyebrow }),
      heading,
      el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: body }),
      ...children
    ]);
    container.replaceChildren(el('div', { className: 'first-exp-screen' }, [panel]));
    if (typeof heading.focus === 'function') heading.focus();
  }

  function toggleButton({ label, selected, onSelect }) {
    const button = el('button', {
      className: `first-exp-option w-full ${selected ? 'button-primary' : 'button-secondary'}`,
      text: label,
      attrs: { type: 'button', 'aria-pressed': String(selected) }
    });
    button.addEventListener('click', () => {
      if (state.saving) return;
      onSelect();
    });
    return button;
  }

  function backContinue({ onBack, onNext, nextLabel = 'Continue' }) {
    const back = el('button', { className: 'button-secondary w-full sm:w-auto', text: 'Back', attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      if (state.saving) return;
      onBack();
    });
    const next = el('button', { className: 'button-primary w-full sm:w-auto', text: nextLabel, attrs: { type: 'button' } });
    next.addEventListener('click', () => {
      if (state.saving) return;
      onNext();
    });
    return el('div', { className: 'mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' }, [back, next]);
  }

  // Runs a completion PUT with button-level pending feedback. Failures
  // toast + restore (never trap, never lose the in-session choices).
  async function persist(button, payload, onOk) {
    if (state.saving) return;
    state.saving = true;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await api('/api/first-experience/onboarding', { method: 'PUT', body: payload });
      onOk();
    } catch (error) {
      state.saving = false;
      button.disabled = false;
      button.textContent = original;
      notify(error?.message || 'Unable to save your setup. Please try again.', 'error');
    }
  }

  function renderWelcome() {
    const primary = el('button', { className: 'button-primary w-full', text: 'Set up NippoTrack', attrs: { type: 'button' } });
    primary.addEventListener('click', () => {
      if (state.saving) return;
      state.step = 2;
      render();
    });
    const secondary = el('button', { className: 'button-ghost w-full', text: 'Skip setup', attrs: { type: 'button' } });
    secondary.addEventListener('click', () => {
      void persist(secondary, skipSetupPayload(), () => onComplete());
    });
    shell({
      step: 1,
      eyebrow: 'FIRST SETUP',
      title: 'Welcome to NippoTrack.',
      titleTag: 'h1',
      body: 'Your Japanese learning is already yours. Let\'s set up a starting point that makes sense for you.',
      children: [el('div', { className: 'mt-6 grid gap-2' }, [primary, secondary])]
    });
  }

  function renderDirection() {
    const options = [
      ...TARGET_LEVELS.map((level) => toggleButton({
        label: `JLPT ${level}`,
        selected: state.targetLevel === level,
        onSelect: () => { state.targetLevel = level; render(); }
      })),
      toggleButton({
        label: 'No specific JLPT target',
        selected: state.targetLevel === null,
        onSelect: () => { state.targetLevel = null; render(); }
      })
    ];
    shell({
      step: 2,
      eyebrow: 'YOUR DIRECTION',
      title: 'Do you have a JLPT target?',
      body: 'Choose one if the JLPT is part of your plan. You can change this later.',
      children: [
        el('div', { className: 'mt-5 grid gap-2', attrs: { role: 'group', 'aria-label': 'JLPT target options' } }, options),
        el('p', { className: 'mt-4 text-xs leading-5 text-muted', text: 'This is your study target, not an estimate of your current level.' }),
        backContinue({ onBack: () => { state.step = 1; render(); }, onNext: () => { state.step = 3; render(); } })
      ]
    });
  }

  function renderSources() {
    const selected = new Set(state.studySources);
    const options = STUDY_SOURCES.map((source) => toggleButton({
      label: source.label,
      selected: selected.has(source.value),
      onSelect: () => {
        const next = new Set(state.studySources);
        if (next.has(source.value)) next.delete(source.value);
        else next.add(source.value);
        state.studySources = STUDY_SOURCES
          .map((entry) => entry.value)
          .filter((value) => next.has(value));
        render();
      }
    }));
    shell({
      step: 3,
      eyebrow: 'HOW YOU STUDY',
      title: 'How do you usually study Japanese?',
      body: 'Choose the sources that are already part of your routine.',
      children: [
        el('div', { className: 'mt-5 grid gap-2 sm:grid-cols-2', attrs: { role: 'group', 'aria-label': 'Study source options' } }, options),
        backContinue({ onBack: () => { state.step = 2; render(); }, onNext: () => { state.step = 4; render(); } })
      ]
    });
  }

  function renderStartingPoint() {
    const take = el('button', { className: 'button-primary w-full', text: 'Take quick placement', attrs: { type: 'button' } });
    take.addEventListener('click', () => {
      const payload = buildOnboardingPayload({ targetLevel: state.targetLevel, studySources: state.studySources });
      void persist(take, payload, () => {
        if (typeof onEnterPlacement === 'function') onEnterPlacement();
        else enterPlacement({ navigate });
      });
    });
    const skip = el('button', { className: 'button-ghost w-full', text: 'Skip for now', attrs: { type: 'button' } });
    skip.addEventListener('click', () => {
      const payload = buildOnboardingPayload({
        targetLevel: state.targetLevel,
        studySources: state.studySources,
        placementStatus: 'skipped'
      });
      void persist(skip, payload, () => onComplete());
    });
    shell({
      step: 4,
      eyebrow: 'STARTING POINT',
      title: 'Want a quick starting estimate?',
      body: 'Answer 10 short Japanese questions to get a useful starting reference.',
      children: [
        el('div', { className: 'mt-4' }, [el('span', { className: 'status-pill', text: 'About 2 minutes' })]),
        el('p', { className: 'mt-4 text-xs leading-5 text-muted', text: 'This is a starting estimate, not an official JLPT assessment.' }),
        el('div', { className: 'mt-6 grid gap-2' }, [take, skip])
      ]
    });
  }

  function render() {
    if (!active) return;
    if (state.step === 1) renderWelcome();
    else if (state.step === 2) renderDirection();
    else if (state.step === 3) renderSources();
    else renderStartingPoint();
  }

  render();

  return {
    get active() { return active; },
    reshow() { render(); },
    finish() { active = false; }
  };
}

export {
  TARGET_LEVELS,
  STUDY_SOURCES,
  STUDY_SOURCE_VALUES,
  isValidFirstExperienceTarget,
  sanitizeStudySources,
  shouldShowOnboarding,
  resolveOnboardingVisibility,
  skipSetupPayload,
  buildOnboardingPayload,
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
  enterPlacement,
  renderFirstExperience
};
