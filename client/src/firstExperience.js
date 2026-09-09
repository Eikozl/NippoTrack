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

// TODO(A.3) — PLACEMENT ENTRY HOOK. The A.3 agent owns the real placement
// flow: replace the body of this function (keep its name + signature) so
// "Take quick placement" routes into the placement experience instead of
// the dashboard. The wizard calls this AFTER the completion PUT succeeds,
// with the onboarding session already deactivated, so routing here can
// never re-trigger the setup gate.
function enterPlacement({ navigate } = {}) {
  if (typeof navigate === 'function') {
    navigate('dashboard');
    return;
  }
  if (typeof window !== 'undefined' && window.location) {
    window.location.hash = '#dashboard';
  }
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
  enterPlacement,
  renderFirstExperience
};
