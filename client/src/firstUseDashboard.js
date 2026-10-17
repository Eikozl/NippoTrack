// v5.1-A.4 — First-use dashboard state.
//
// Calm starting state rendered INSTEAD of the normal dashboard when the
// learner is onboarded but has zero durable data. The condition is DERIVED
// client-side from the two FIXED backend contracts (no new flag, no
// account-age or login inference):
//
//   GET /api/dashboard
//     → { vocabularyCount, kanjiCount, grammarCount, recentSessions[], ... }
//   GET /api/first-experience
//     → { onboarding: { completed, studySources[] },
//         placement: { status, estimate, source }, targetLevel }
//
// First-use holds exactly when onboarding.completed === true AND at least
// one checklist action is still incomplete (see actionCompleted below).
// ANY fully-completed checklist falls through to the normal dashboard (untouched). This module only PRESENTS stored
// state: target/estimate/sources rows render verbatim from the server,
// the three action cards navigate through existing routes, and placement
// entry reuses the A.3 enterPlacement hook — no duplicate quiz, no hidden
// click-tracking writes of any kind (this module issues zero network
// writes; it does not even take an API caller).
//
// Zero static imports beyond firstExperience.js (itself import-free), so
// the pure helpers stay import-safe under node:test. DOM dependencies
// arrive injected; styling uses shared classes + tokens only
// (surface, button-secondary, button-ghost, eyebrow-free calm type,
// text-muted). No new palette, no hex colors.

import {
  STUDY_SOURCES,
  enterPlacement as enterPlacementFlow,
  isValidFirstExperienceTarget,
  placementEstimateFromState,
  placementResultFromState,
  placementResultNode,
  placementResultTitle,
  sanitizeStudySources,
  selfReportResultNode,
  selfReportResultTitle
} from './firstExperience.js';

const FIRST_USE_COPY = {
  heroTitle: 'Your Japanese starts here.',
  heroBody: "NippoTrack is ready. Start with something you're already learning.",
  panelTitle: 'Your starting point',
  targetLabel: 'Study target',
  noTarget: 'No specific JLPT target',
  estimateLabel: 'Starting estimate',
  startingLevelLabel: 'Starting level',
  quizSourceLabel: 'Quick Placement',
  selfReportedLabel: 'Self-reported',
  noEstimate: 'Not set',
  takePlacement: 'Take quick placement',
  sourcesLabel: 'Study sources',
  actionsTitle: 'Start with something real.',
  growthTitle: 'Your dashboard will grow with your study.',
  growthBody: 'As you collect, review, and log study time, your activity and progress will begin to appear here.'
};

// Existing routes only (main.js page keys): analyzer, vocabulary, sessions.
const FIRST_USE_ACTIONS = [
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
];

// DERIVED first-use condition (pure): onboarded AND at least one required
// action still incomplete. Each action below has its own durable-evidence
// state (no visit/click tracking — a page view never completes anything):
//
//   analyzer   → kept something from analysis (any collection count > 0)
//   vocabulary → vocabularyCount > 0
//   sessions   → recentSessions is non-empty
//
// The checklist stays visible while ANY action is incomplete and hides only
// when ALL are complete. Unknown/missing shapes fail OPEN to the normal
// dashboard (return false).
function actionCompleted(route, dashboard) {
  if (!dashboard || typeof dashboard !== 'object') return false;
  if (route === 'vocabulary') return Number(dashboard.vocabularyCount) > 0;
  if (route === 'sessions') {
    return Array.isArray(dashboard.recentSessions) && dashboard.recentSessions.length > 0;
  }
  if (route === 'analyzer') {
    return Number(dashboard.vocabularyCount) > 0
      || Number(dashboard.kanjiCount) > 0
      || Number(dashboard.grammarCount) > 0;
  }
  return false;
}

// Per-action checklist states, derived from the FIXED dashboard contract.
// Exported pure so tests can guard the "one action must not dismiss all"
// behavior without DOM.
function getFirstUseActionStates(dashboard = null) {
  return FIRST_USE_ACTIONS.map((action) => ({
    route: action.route,
    title: action.title,
    completed: actionCompleted(action.route, dashboard)
  }));
}

const DURABLE_COUNT_KEYS = ['vocabularyCount', 'kanjiCount', 'grammarCount'];

// Any durable datum sends the learner to the normal dashboard. The
// checklist above stays as the zero-data starting state (rendered by
// renderFirstUseDashboard) until every action completes — it is never
// removed, only shown at zero data.
function hasDashboardShape(dashboard) {
  return DURABLE_COUNT_KEYS.some((key) => dashboard[key] !== undefined);
}

function dashboardShapeIsSound(dashboard) {
  const countsOk = DURABLE_COUNT_KEYS.every(
    (key) => dashboard[key] === undefined || Number.isFinite(Number(dashboard[key]))
  );
  const sessionsOk = !('recentSessions' in dashboard) || Array.isArray(dashboard.recentSessions);
  return countsOk && sessionsOk;
}

function hasAnyDurableData(dashboard) {
  const counts = DURABLE_COUNT_KEYS.some((key) => Number(dashboard[key]) > 0);
  const sessions = Array.isArray(dashboard.recentSessions) && dashboard.recentSessions.length > 0;
  return counts || sessions;
}

function shouldShowFirstUseDashboard({ firstExperience = null, dashboard = null } = {}) {
  if (firstExperience?.onboarding?.completed !== true) return false;
  if (!dashboard || typeof dashboard !== 'object') return false;
  // Missing-shape or garbage payloads fail open to the normal dashboard
  // (never invent first-use from malformed data).
  if (!hasDashboardShape(dashboard) || !dashboardShapeIsSound(dashboard)) return false;
  if (hasAnyDurableData(dashboard)) return false;
  return true;
}

// Stored study target, verbatim: a valid stored level renders as-is, any
// other shape (including null = no target chosen) renders the no-target
// line. Never derived, never matched against the estimate.
function formatFirstUseTarget(targetLevel) {
  return typeof targetLevel === 'string' && isValidFirstExperienceTarget(targetLevel)
    ? `JLPT ${targetLevel}`
    : FIRST_USE_COPY.noTarget;
}

// Stored starting-point label via the A.3 helper (no duplicate mapping):
// a completed quiz renders as a range, a completed self-report as the
// chosen JLPT level, anything else is unset.
function firstUseEstimateLabel(firstExperience) {
  const stored = placementResultFromState(firstExperience);
  if (!stored) return FIRST_USE_COPY.noEstimate;
  return stored.source === 'self_reported'
    ? selfReportResultTitle(stored.estimate)
    : placementResultTitle(stored.estimate);
}

function hasFirstUseEstimate(firstExperience) {
  return placementEstimateFromState(firstExperience) !== null;
}

// Stored study sources mapped to their display labels through the frozen
// A.2 allowlist (unknown slugs dropped, order kept). Empty → omit row.
function firstUseSourceLabels(studySources) {
  const labels = new Map(STUDY_SOURCES.map((source) => [source.value, source.label]));
  return sanitizeStudySources(studySources)
    .map((value) => labels.get(value))
    .filter(Boolean);
}

// Renders the first-use state into `container`. Deps: { el, navigate,
// enterPlacement?, firstExperience }. Navigation goes through the injected
// `navigate` (existing routes); placement entry defaults to the imported
// A.3 hook. Issues zero network writes — handlers only navigate or enter
// the placement flow.
function renderFirstUseDashboard(container, deps = {}) {
  const { el, navigate, firstExperience = null } = deps;
  if (typeof el !== 'function') throw new Error('First-use dashboard requires an element factory.');
  const enterPlacementImpl = typeof deps.enterPlacement === 'function' ? deps.enterPlacement : enterPlacementFlow;
  const go = typeof navigate === 'function'
    ? navigate
    : (page) => {
      if (typeof window !== 'undefined' && window.location) window.location.hash = `#${page}`;
    };
  const runPlacement = () => {
    enterPlacementImpl({ navigate: go });
  };

  const targetRow = el('div', {}, [
    el('dt', { className: 'text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: FIRST_USE_COPY.targetLabel }),
    el('dd', { className: 'mt-1 text-sm font-semibold text-ink', text: formatFirstUseTarget(firstExperience?.targetLevel) })
  ]);
  // One-time starting point: not_started/skipped keep the Take CTA on the
  // same A.3 flow; a completed quiz renders the condensed shared diagram
  // with its Quick Placement source line; a completed self-report renders
  // the chosen level with its Self-reported source line. No placement
  // action of any kind once completed, whichever the source.
  const storedPlacement = placementResultFromState(firstExperience);
  const estimateRow = storedPlacement?.source === 'self_reported'
    ? el('div', {}, [
      el('dt', { className: 'text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: FIRST_USE_COPY.startingLevelLabel }),
      el('dd', { className: 'mt-2 min-w-0' }, [
        selfReportResultNode(el, {
          estimate: storedPlacement.estimate,
          titleTag: 'h3',
          titleClassName: 'font-display mt-2 text-xl font-semibold tracking-tight text-ink'
        })
      ])
    ])
    : storedPlacement
      ? el('div', {}, [
        el('dt', { className: 'text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: FIRST_USE_COPY.estimateLabel }),
        el('dd', { className: 'mt-1 min-w-0' }, [
          el('p', { className: 'text-xs text-muted', text: FIRST_USE_COPY.quizSourceLabel }),
          el('div', { className: 'mt-2' }, [
            placementResultNode(el, {
              estimate: storedPlacement.estimate,
              result: storedPlacement.result,
              titleTag: 'h3',
              titleClassName: 'font-display mt-2 text-xl font-semibold tracking-tight text-ink'
            })
          ])
        ])
      ])
      : el('div', {}, [
      el('dt', { className: 'text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: FIRST_USE_COPY.estimateLabel }),
      el('dd', { className: 'mt-1 text-sm font-semibold text-ink', text: firstUseEstimateLabel(firstExperience) }),
      (() => {
        const take = el('button', {
          className: 'button-ghost mt-2 justify-start px-0',
          text: FIRST_USE_COPY.takePlacement,
          attrs: { type: 'button' }
        });
        take.addEventListener('click', runPlacement);
        return take;
      })()
    ]);
  const sourceLabels = firstUseSourceLabels(firstExperience?.onboarding?.studySources);
  const rows = sourceLabels.length
    ? [...[targetRow, estimateRow], el('div', {}, [
      el('dt', { className: 'text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: FIRST_USE_COPY.sourcesLabel }),
      el('dd', { className: 'mt-1 text-sm font-semibold text-ink', text: sourceLabels.join(', ') })
    ])]
    : [targetRow, estimateRow];

  const panel = el('article', {
    className: 'surface min-w-0 p-5 sm:p-6',
    attrs: { 'aria-labelledby': 'first-use-starting-point' }
  }, [
    el('h2', { className: 'font-semibold text-ink', text: FIRST_USE_COPY.panelTitle, attrs: { id: 'first-use-starting-point' } }),
    el('dl', { className: 'mt-5 grid gap-4' }, rows)
  ]);

  const cardNodes = FIRST_USE_ACTIONS.map((action) => {
    const done = actionCompleted(action.route, deps.dashboard);
    const link = el('a', {
      className: 'button-secondary mt-4 w-full',
      text: action.cta,
      attrs: { href: `#${action.route}` }
    });
    link.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      go(action.route);
    });
    return el('article', { className: 'first-use-card surface min-w-0 p-5' }, [
      el('div', { className: 'flex items-start justify-between gap-3' }, [
        el('h3', { className: 'break-words font-semibold text-ink', text: action.title }),
        done ? el('span', { className: 'status-pill shrink-0', text: 'Done', attrs: { 'aria-label': `${action.title}: done` } }) : null
      ]),
      el('p', { className: 'mt-1 break-words text-sm leading-6 text-muted', text: action.description }),
      link
    ]);
  });
  const actions = el('section', { className: 'min-w-0', attrs: { 'aria-labelledby': 'first-use-actions' } }, [
    el('h2', { className: 'font-semibold text-ink', text: FIRST_USE_COPY.actionsTitle, attrs: { id: 'first-use-actions' } }),
    el('div', { className: 'first-use-cards mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-1' }, cardNodes)
  ]);

  const hero = el('header', {}, [
    el('h1', { className: 'font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl', text: FIRST_USE_COPY.heroTitle }),
    el('p', { className: 'mt-2 max-w-2xl text-sm leading-6 text-muted', text: FIRST_USE_COPY.heroBody })
  ]);
  const growth = el('section', { className: 'mt-8 max-w-2xl', attrs: { 'aria-labelledby': 'first-use-growth' } }, [
    el('h2', { className: 'font-semibold text-ink', text: FIRST_USE_COPY.growthTitle, attrs: { id: 'first-use-growth' } }),
    el('p', { className: 'mt-2 text-sm leading-6 text-muted', text: FIRST_USE_COPY.growthBody })
  ]);

  container.replaceChildren(el('div', { className: 'first-use-screen' }, [
    hero,
    el('div', { className: 'mt-6 grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]' }, [panel, actions]),
    growth
  ]));
}

export {
  FIRST_USE_COPY,
  FIRST_USE_ACTIONS,
  actionCompleted,
  getFirstUseActionStates,
  shouldShowFirstUseDashboard,
  formatFirstUseTarget,
  firstUseEstimateLabel,
  hasFirstUseEstimate,
  firstUseSourceLabels,
  renderFirstUseDashboard
};
