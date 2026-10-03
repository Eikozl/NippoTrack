import { apiRequest, queryString } from '../api';
import { kanjiReferenceRoute } from '../kanjiReference';
import { element, emptyState, errorState, loadingState, openDetailModal, openDialog, pageHeader, showToast, withPendingAction } from '../ui';

const TYPE_ORDER = ['kanji', 'vocabulary', 'grammar'];
const TYPE_LABEL = { kanji: 'Kanji', vocabulary: 'Vocabulary', grammar: 'Grammar' };
const TYPE_HEADING = { kanji: 'KANJI', vocabulary: 'VOCABULARY', grammar: 'GRAMMAR' };
const JLPT_OPTIONS = ['all', 'N5', 'N4', 'N3', 'N2', 'N1'];
const GRADES = [
  { result: 'Again', hint: "I couldn't recall it" },
  { result: 'Hard', hint: 'I recalled it with difficulty' },
  { result: 'Good', hint: 'I recalled it comfortably' }
];

// V5.3a Review 2.0 — card types. The supported-types map mirrors the frozen
// server contract in server/src/services/reviewEngine.js (ENTITY_CARD_TYPES):
// preferences and rotation live client-side; the /due endpoint serves the
// authoritative mapping for API consumers.
const CARD_TYPES = ['recognition', 'recall', 'cloze', 'audio'];
const CARD_TYPE_LABEL = { recognition: 'Recognition', recall: 'Recall', cloze: 'Cloze', audio: 'Audio' };
const ENTITY_SUPPORTED_CARD_TYPES = {
  kanji: ['recognition', 'recall'],
  vocabulary: ['recognition', 'recall', 'cloze', 'audio'],
  grammar: ['recognition', 'cloze', 'audio']
};
const DEFAULT_CARD_PREFERENCES = { cardTypes: ['recognition'], weights: {}, engineMode: 'fixed' };

let activeReview = { sessionId: null, selected: [] };
let detachReviewKeys = null;

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayISO() {
  return toISODate(new Date());
}

function daysAgoISO(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toISODate(date);
}

function provenanceLine(item) {
  const first = Array.isArray(item.sources) && item.sources.length ? item.sources[0] : null;
  if (!first) return '';
  const label = first.label || '';
  const context = first.context || '';
  if (label && context) return `${label} — ${context}`;
  return label || context || '';
}

function isWeak(item) {
  return item.evidenceStrength === 'weak';
}

// Immersion hand-off: create-session redirects to `#review?reviewSessionId=…`.
function reviewSessionIdFromHash() {
  try {
    const hash = typeof window !== 'undefined' && window.location ? window.location.hash || '' : '';
    const queryIndex = hash.indexOf('?');
    if (queryIndex === -1) return null;
    return new URLSearchParams(hash.slice(queryIndex + 1)).get('reviewSessionId');
  } catch {
    return null;
  }
}

function itemKey(item) {
  return `${item.entityType}:${item.entityId}`;
}

export async function renderReview(container) {
  if (typeof detachReviewKeys === 'function') {
    try { detachReviewKeys(); } catch { /* noop */ }
    detachReviewKeys = null;
  }
  activeReview = { sessionId: null, selected: [] };

  const today = todayISO();
  const defaultFrom = daysAgoISO(3);

  let stage = 'INTRO';
  let lastSearch = null;
  let candidatesByKey = new Map();
  let selectedKeys = new Set();
  let queue = [];
  let currentIndex = 0;
  let revealed = false;
  let sessionId = null;
  let gradeButtons = [];
  let graded = [];
  let localDetach = null;

  // V5.3a hand-off: the Immersion page stores the server-resolved queue for
  // the freshly created OPEN review session (freshly enrolled items carry no
  // review_events, so date-range discovery cannot surface them yet). Consumed
  // exactly once; any mismatch falls back to the informational banner below.
  function tryResumeImmersionQueue() {
    const handoffSessionId = reviewSessionIdFromHash();
    if (!handoffSessionId) return false;
    try {
      const raw = typeof window !== 'undefined' && window.sessionStorage
        ? window.sessionStorage.getItem('jlt-immersion-review-queue')
        : null;
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      if (Number(parsed?.reviewSessionId) !== Number(handoffSessionId) || !items.length) return false;
      window.sessionStorage.removeItem('jlt-immersion-review-queue');
      sessionId = Number(handoffSessionId);
      queue = items;
      currentIndex = 0;
      revealed = false;
      graded = [];
      activeReview = { sessionId, selected: items };
      setStage('REVIEWING');
      renderCard();
      return true;
    } catch {
      return false;
    }
  }

  function detachKeys() {
    if (typeof localDetach === 'function') {
      try { localDetach(); } catch { /* noop */ }
    }
    localDetach = null;
    if (detachReviewKeys) detachReviewKeys = null;
  }

  const content = element('div');

  // Hero surface: INTRO copy on top, SETUP form expands below it.
  const heroSurface = element('div', { className: 'surface p-5 sm:p-8' });

  const introBlock = element('div', {}, [
    element('p', { className: 'eyebrow', text: 'Review' }),
    element('h2', { className: 'mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl', text: 'Want to review your JLPT study?', attrs: { tabindex: '-1' } }),
    element('p', { className: 'mt-3 max-w-2xl text-sm leading-6 text-muted', text: 'Revisit recent study activity with focused recall, one item at a time. Use self-assessment to note how each item felt and decide what to look at again.' })
  ]);
  // Immersion hand-off banner: when mounted via a create-session redirect,
  // announce the enrollment and let the normal flow take over. This page
  // intentionally does NOT bind grading to the redirected session id — its
  // sessions are created per search, and the Today range already surfaces
  // the freshly enrolled items, so nothing extra is routed anywhere.
  const fromImmersionId = reviewSessionIdFromHash();
  if (fromImmersionId) {
    introBlock.appendChild(element('p', {
      className: 'mt-4 rounded-xl border border-stone bg-paper px-3 py-2 text-sm leading-6 text-ink',
      text: 'Session created from your text — its items are enrolled for today. Start a review for Today to study them.',
      attrs: { role: 'status' }
    }));
  }

  const startWrap = element('div', { className: 'mt-5' });
  const startButton = element('button', { className: 'button-primary', text: 'Start review', attrs: { type: 'button' } });
  // Card-type preferences live only inside the review setup options (the Edit
  // control next to the card-type summary) — no shortcut button here.
  startWrap.append(startButton);

  // Setup form (hidden until SETUP).
  const setupWrap = element('div', { className: 'mt-6 overflow-hidden border-t border-stone pt-6 transition-all duration-200' });
  const backButton = element('button', { className: 'text-sm font-semibold text-vermilion hover:underline', text: 'Back', attrs: { type: 'button' } });
  const setupTitle = element('h2', { className: 'mt-2 text-lg font-semibold text-ink', text: 'Find material' });
  const setupForm = element('form', { className: 'mt-4 grid gap-5', attrs: { novalidate: '' } });

  // Date preset radio group.
  const presetFieldset = element('fieldset', { className: 'grid gap-2' });
  presetFieldset.appendChild(element('legend', { className: 'text-sm font-semibold text-ink', text: 'Date range' }));
  const presetOptions = element('div', { className: 'flex flex-wrap gap-2' });
  const presetRadios = [];
  [
    { value: 'today', label: 'Today' },
    { value: 'last3', label: 'Last 3 days' },
    { value: 'custom', label: 'Custom range' }
  ].forEach(({ value, label }) => {
    const radio = element('input', {
      className: 'size-4 accent-vermilion',
      attrs: { type: 'radio', name: 'review-preset', value, ...(value === 'last3' ? { checked: '' } : {}) }
    });
    presetRadios.push(radio);
    const pill = element('label', { className: 'inline-flex cursor-pointer items-center gap-2 rounded-xl border border-stone bg-paper px-3 py-2 text-sm font-medium text-ink' }, [
      radio,
      element('span', { text: label })
    ]);
    presetOptions.appendChild(pill);
  });
  presetFieldset.appendChild(presetOptions);

  // Custom From/To inputs.
  const fromInput = element('input', {
    className: 'field-control',
    attrs: { type: 'date', name: 'review-from', value: defaultFrom, max: today, 'aria-label': 'From date' }
  });
  const toInput = element('input', {
    className: 'field-control',
    attrs: { type: 'date', name: 'review-to', value: today, max: today, 'aria-label': 'To date' }
  });
  const customWrap = element('div', { className: 'hidden grid gap-3 sm:grid-cols-2', attrs: { 'aria-hidden': 'true' } }, [
    element('label', { className: 'field' }, [element('span', { text: 'From' }), fromInput]),
    element('label', { className: 'field' }, [element('span', { text: 'To' }), toInput])
  ]);

  // JLPT radio group.
  const jlptFieldset = element('fieldset', { className: 'grid gap-2' });
  jlptFieldset.appendChild(element('legend', { className: 'text-sm font-semibold text-ink', text: 'JLPT level' }));
  const jlptOptions = element('div', { className: 'flex flex-wrap gap-2' });
  JLPT_OPTIONS.forEach((value) => {
    const radio = element('input', {
      className: 'size-4 accent-vermilion',
      attrs: { type: 'radio', name: 'review-jlpt', value, ...(value === 'all' ? { checked: '' } : {}) }
    });
    const label = value === 'all' ? 'All' : value;
    jlptOptions.appendChild(element('label', { className: 'inline-flex cursor-pointer items-center gap-2 rounded-xl border border-stone bg-paper px-3 py-2 text-sm font-medium text-ink' }, [
      radio,
      element('span', { text: label })
    ]));
  });
  jlptFieldset.appendChild(jlptOptions);

  // Type checkboxes.
  const typesFieldset = element('fieldset', { className: 'grid gap-2' });
  typesFieldset.appendChild(element('legend', { className: 'text-sm font-semibold text-ink', text: 'Material types' }));
  const typesOptions = element('div', { className: 'flex flex-wrap gap-2' });
  TYPE_ORDER.forEach((value) => {
    const checkbox = element('input', {
      className: 'size-4 accent-vermilion',
      attrs: { type: 'checkbox', name: 'review-types', value, checked: '' }
    });
    typesOptions.appendChild(element('label', { className: 'inline-flex cursor-pointer items-center gap-2 rounded-xl border border-stone bg-paper px-3 py-2 text-sm font-medium text-ink' }, [
      checkbox,
      element('span', { text: TYPE_LABEL[value] })
    ]));
  });
  typesFieldset.appendChild(typesOptions);

  // V5.3a Review 2.0: active card-type summary next to the material types.
  const editCardTypesButton = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Edit', attrs: { type: 'button', 'aria-label': 'Edit card types' } });
  editCardTypesButton.addEventListener('click', () => { openCardTypeDialog(); });
  typesFieldset.appendChild(element('div', { className: 'mt-1 flex flex-wrap items-center gap-2' }, [
    element('span', { className: 'text-xs text-muted', text: 'Card types: Recognition', attrs: { 'data-card-type-summary': '' } }),
    editCardTypesButton
  ]));

  const formError = element('p', { className: 'hidden text-sm leading-6 text-red-700', attrs: { role: 'alert' } });
  const findButton = element('button', { className: 'button-primary w-full sm:w-auto', text: 'Find material', attrs: { type: 'submit' } });

  setupForm.append(presetFieldset, customWrap, jlptFieldset, typesFieldset, formError, element('div', {}, [findButton]));
  setupWrap.append(backButton, setupTitle, setupForm);
  setupWrap.hidden = true;

  heroSurface.append(introBlock, startWrap, setupWrap);

  // Summary bar shown during CANDIDATES.
  const summaryBar = element('div', { className: 'surface mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between' });
  const summaryText = element('p', { className: 'text-sm font-medium text-ink' });
  const editButton = element('button', { className: 'button-secondary shrink-0', text: 'Edit search', attrs: { type: 'button' } });
  summaryBar.append(summaryText, editButton);
  summaryBar.hidden = true;

  const candidatesBlock = element('div', { className: 'grid gap-4' });
  candidatesBlock.hidden = true;

  const reviewingBlock = element('div', { className: 'grid gap-4' });
  reviewingBlock.hidden = true;

  const completeBlock = element('div');
  completeBlock.hidden = true;

  // History over already-persisted sessions + events (read-only, fail-open).
  const historyBlock = element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': 'Recent review sessions' } });
  historyBlock.hidden = true;

  // Per-session modal cache (opened on click, not inline toggle).
  const sessionModalCache = new Map();
  // History speaks in the same result vocabulary as the completion summary.
  const RESULT_LABEL = { Good: 'comfortable', Hard: 'difficult', Again: 'revisit' };

  function formattedDate(dateIso) {
    if (!dateIso) return 'unknown date';
    const d = new Date(dateIso);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return d.toLocaleDateString(undefined, options);
  }

  function sessionTypeLabel(items) {
    const types = new Set(items.map((it) => it.entityType));
    if (types.size === 1) {
      const t = types.values().next().value;
      return t === 'kanji' ? 'Kanji' : t === 'vocabulary' ? 'Vocabulary' : 'Grammar';
    }
    return 'Mixed';
  }

  async function openSessionModal(session) {
    const sessionId = session?.id;
    if (sessionId === undefined || sessionId === null) return;
    let items = sessionModalCache.get(sessionId);
    if (!items) {
      try {
        const data = await apiRequest(`/api/review/sessions/${sessionId}`);
        items = Array.isArray(data?.items) ? data.items : [];
        sessionModalCache.set(sessionId, items);
      } catch {
        showToast('Could not load session items.', 'error');
        return;
      }
    }
    if (!items.length) {
      showToast('No items recorded in this session.', 'info');
      return;
    }

    // Title: "<Type> Review Session • <Month D, YYYY>" from the session row,
    // falling back to the first graded item when the row lacks a date.
    const type = sessionTypeLabel(items);
    const rawDate = session.startedAt || items[0]?.reviewedAt || null;
    const date = formattedDate(rawDate);

    const list = element('ul', { className: 'grid gap-2' }, items.map((item) => {
      // Kanji entries link straight to their reference page (stroke order
      // animation + readings). Multi-character displays stay plain text.
      const referenceHash = item.entityType === 'kanji' && typeof item.display === 'string'
        ? kanjiReferenceRoute(item.display)
        : null;
      const display = referenceHash
        ? element('a', {
          className: 'font-jp text-lg font-semibold text-ink underline decoration-stone underline-offset-4 hover:text-vermilion',
          text: item.display,
          attrs: { href: `#${referenceHash}`, 'aria-label': `Open kanji reference for ${item.display} (stroke order)` }
        })
        : element('p', { className: 'break-words font-jp font-medium text-ink', text: item.display });
      const reviewedAt = String(item.reviewedAt || '');
      const time = reviewedAt.slice(11, 16);
      const resultLabel = RESULT_LABEL[item.result] || item.result || '';
      const status = [resultLabel, time].filter(Boolean).join(' · ');
      return element('li', { className: 'rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm' }, [
        display,
        ...(item.reading ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: item.reading })] : []),
        ...(item.meaning ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: item.meaning })] : []),
        ...(status ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: status })] : [])
      ]);
    }));
    openDetailModal({
      title: `${type} Review Session • ${date}`,
      subtitle: `${items.length} item${items.length === 1 ? '' : 's'} reviewed`,
      content: [list]
    });
  }

  async function loadHistory() {
    try {
      const data = await apiRequest('/api/review/sessions?limit=10');
      const sessions = Array.isArray(data?.items) ? data.items : [];
      if (!sessions.length) {
        historyBlock.hidden = true;
        historyBlock.replaceChildren();
        return;
      }
      historyBlock.replaceChildren(
        element('h2', { className: 'font-semibold text-ink', text: 'Recent review sessions' }),
        element('p', { className: 'mt-1 text-sm text-muted', text: 'When you studied, how much you reviewed, and how it felt.' }),
        element('ul', { className: 'mt-4 grid gap-2' }, sessions.map((session) => {
          const date = String(session.startedAt || '').slice(0, 10);
          const summary = `${Number(session.total || 0)} items · ${Number(session.byResult?.Good || 0)} comfortable · ${Number(session.byResult?.Hard || 0)} difficult · ${Number(session.byResult?.Again || 0)} revisit`;
          const scope = `Kanji ${Number(session.byType?.kanji || 0)} · Vocabulary ${Number(session.byType?.vocabulary || 0)} · Grammar ${Number(session.byType?.grammar || 0)}`;
          const row = element('li', { className: 'cursor-pointer rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:border-vermilion', attrs: { role: 'button', tabindex: '0', 'aria-label': `Open details for session ${date || session.id}` } }, [
            element('p', { className: 'font-semibold text-ink', text: `${date || 'Session'}${session.completedAt ? ' · completed' : ' · in progress'}` }),
            element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: summary }),
            element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: scope })
          ]);
          row.addEventListener('click', () => { openSessionModal(session); });
          row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSessionModal(session); }
          });
          return row;
        }))
      );
      historyBlock.hidden = false;
    } catch {
      historyBlock.hidden = true;
    }
  }

  // Frequently difficult items (>=2 Again events each, read-only, fail-open).
  const difficultBlock = element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': 'Frequently difficult' } });
  difficultBlock.hidden = true;

  // V5.3a Review 2.0: detected error patterns (server heuristics, read-only,
  // fail-open like its siblings).
  const patternsBlock = element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': 'Detected patterns' } });
  patternsBlock.hidden = true;

  container.replaceChildren(element('section', {}, [
    pageHeader({ eyebrow: 'Recall', title: 'Review', description: 'Choose recent activity and review it at a steady pace.' }),
    heroSurface,
    summaryBar,
    candidatesBlock,
    reviewingBlock,
    completeBlock,
    historyBlock,
    difficultBlock,
    patternsBlock
  ]));

  async function loadDifficult() {
    try {
      const data = await apiRequest('/api/review/difficult');
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        difficultBlock.hidden = true;
        difficultBlock.replaceChildren();
        return;
      }
      difficultBlock.replaceChildren(
        element('h2', { className: 'font-semibold text-ink', text: 'Frequently difficult' }),
        element('p', { className: 'mt-1 text-sm text-muted', text: 'Items you have marked Again at least twice — worth another look.' }),
        element('ul', { className: 'mt-4 grid gap-2' }, items.map((item) => {
          const date = String(item.lastReviewedAt || '').slice(0, 10);
          const tally = `${Number(item.againCount || 0)} again of ${Number(item.totalEvents || 0)} reviews`;
          return element('li', { className: 'rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm' }, [
            element('p', { className: 'break-words font-jp font-semibold text-ink', text: item.display }),
            ...(item.reading ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: item.reading })] : []),
            ...(item.meaning ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: item.meaning })] : []),
            element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: date ? `${tally} · last reviewed ${date}` : tally })
          ]);
        }))
      );
      difficultBlock.hidden = false;
    } catch {
      difficultBlock.hidden = true;
    }
  }

  // ------------------------------------------------------------ Review 2.0

  // Preferences + focused-practice state (module-scoped to this render).
  let reviewPreferences = { cardTypes: [...DEFAULT_CARD_PREFERENCES.cardTypes], weights: {}, engineMode: 'fixed' };

  async function loadCardTypePreferences() {
    try {
      const data = await apiRequest('/api/review/types');
      const preferences = data?.userPreferences;
      if (preferences && Array.isArray(preferences.cardTypes) && preferences.cardTypes.length) {
        reviewPreferences = {
          cardTypes: preferences.cardTypes,
          weights: preferences.weights && typeof preferences.weights === 'object' ? preferences.weights : {},
          engineMode: preferences.engineMode || 'fixed'
        };
      }
      renderCardTypeSummary();
    } catch { /* fail-open: defaults keep Recognition cards */ }
  }

  function renderCardTypeSummary() {
    const summary = setupForm.querySelector('[data-card-type-summary]');
    if (summary) {
      summary.textContent = `Card types: ${reviewPreferences.cardTypes.map((type) => CARD_TYPE_LABEL[type] || type).join(', ')}`;
    }
  }

const CARD_TYPE_DESCRIPTIONS = {
  recognition: 'See the word or kanji, then recall its reading and meaning.',
  recall: 'See the meaning, then recall the word or kanji.',
  cloze: 'Fill in the missing word from a real example sentence.',
  audio: 'Hear the word spoken aloud, then recall it. Needs a Japanese voice on your device.'
};

  function openCardTypeDialog() {
    const rows = CARD_TYPES.map((type) => {
      const checked = reviewPreferences.cardTypes.includes(type);
      const weight = Math.round(Number(reviewPreferences.weights?.[type] ?? 50));
      const checkbox = element('input', {
        className: 'size-4 accent-vermilion',
        attrs: { type: 'checkbox', name: `card-type-${type}`, ...(checked ? { checked: '' } : {}) }
      });
      const slider = element('input', {
        className: 'w-full',
        attrs: { type: 'range', name: `card-weight-${type}`, min: '0', max: '100', step: '10', value: String(weight), 'aria-label': `${CARD_TYPE_LABEL[type]} weight` }
      });
      const readout = element('span', { className: 'text-xs text-muted', text: `${weight}%` });
      slider.addEventListener('input', () => { readout.textContent = `${slider.value}%`; });
      return element('div', { className: 'grid gap-1' }, [
        element('label', { className: 'flex items-center gap-2 text-sm font-medium text-ink' }, [checkbox, element('span', { text: CARD_TYPE_LABEL[type] })]),
        element('p', { className: 'text-xs leading-5 text-muted', text: CARD_TYPE_DESCRIPTIONS[type] || '' }),
        element('div', { className: 'flex items-center gap-2' }, [slider, readout])
      ]);
    });
    openDialog({
      title: 'Card types',
      description: 'Pick how cards are presented and weight the rotation. Weights are relative; disabled types never appear. Some types only fit some materials: kanji supports recognition and recall, audio needs vocabulary and a Japanese voice on your device — anything unsupported falls back to recognition.',
      content: rows,
      submitLabel: 'Save',
      onSubmit: async () => {
        const cardTypes = [];
        const weights = {};
        for (const type of CARD_TYPES) {
          const checkbox = document.querySelector(`input[name="card-type-${type}"]`);
          const slider = document.querySelector(`input[name="card-weight-${type}"]`);
          if (checkbox?.checked) cardTypes.push(type);
          if (slider) weights[type] = Number(slider.value) || 0;
        }
        if (!cardTypes.length) {
          showToast('Pick at least one card type.', 'error');
          return;
        }
        const saved = await apiRequest('/api/review/preferences', { method: 'PUT', body: { cardTypes, weights } });
        const preferences = saved?.userPreferences;
        if (preferences) {
          reviewPreferences = {
            cardTypes: preferences.cardTypes,
            weights: preferences.weights || {},
            engineMode: preferences.engineMode || 'fixed'
          };
        }
        renderCardTypeSummary();
        showToast('Card type preferences saved.');
      }
    });
  }

  // Deterministic weighted rotation: position % expanded pool. Falls back to
  // recognition when an entity supports none of the enabled types.
  function pickCardType(item) {
    const supported = ENTITY_SUPPORTED_CARD_TYPES[item.entityType] || ['recognition'];
    const enabled = reviewPreferences.cardTypes.filter((type) => supported.includes(type));
    if (!enabled.length) return 'recognition';
    const weights = reviewPreferences.weights || {};
    const pool = [];
    for (const type of enabled) {
      const slots = Math.max(1, Math.round(Number(weights[type] ?? 50) / 10));
      for (let index = 0; index < slots; index += 1) pool.push(type);
    }
    return pool[currentIndex % pool.length] || enabled[0];
  }

  // Cloze needs a real sentence; fetched lazily per card (bounded, user-paced)
  // with a recognition fallback so the card never blocks on missing data.
  async function fetchClozeSentence(item) {
    try {
      const path = item.entityType === 'grammar' ? `/api/grammar/${item.entityId}` : `/api/vocabulary/${item.entityId}`;
      const detail = await apiRequest(path);
      const sentence = Array.isArray(detail?.examples) && detail.examples[0]?.sentence
        ? detail.examples[0].sentence
        : (typeof detail?.example === 'string' && detail.example ? detail.example : null);
      if (!sentence) return null;
      return sentence.includes(item.display) ? sentence.replaceAll(item.display, '＿＿') : sentence;
    } catch { return null; }
  }

  // Audio cards speak through the device's own speech engine (Web Speech API):
  // no audio files, no network, no dependencies. Picks an installed Japanese
  // voice when one is listed, slows the rate slightly for learners, and says
  // so out loud via toast when the platform cannot speak at all.
  function speakDisplay(text) {
    try {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        showToast('Audio is not supported in this browser.', 'error');
        return;
      }
      const synthesis = window.speechSynthesis;
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 0.9;
      try {
        const voices = typeof synthesis.getVoices === 'function' ? synthesis.getVoices() : [];
        const japanese = voices.find((voice) => String(voice?.lang || '').toLowerCase().replace('_', '-').startsWith('ja'));
        if (japanese) utterance.voice = japanese;
      } catch { /* voice picking is best-effort; lang still guides the platform */ }
      utterance.onerror = () => { showToast('Audio playback is unavailable on this device right now.', 'error'); };
      synthesis.cancel();
      synthesis.speak(utterance);
    } catch {
      showToast('Audio playback is unavailable on this device right now.', 'error');
    }
  }

  async function loadPatterns() {
    try {
      const data = await apiRequest('/api/review/patterns');
      const patterns = Array.isArray(data?.items) ? data.items : [];
      if (!patterns.length) {
        patternsBlock.hidden = true;
        patternsBlock.replaceChildren();
        return;
      }
      patternsBlock.replaceChildren(
        element('h2', { className: 'font-semibold text-ink', text: 'Detected patterns' }),
        element('p', { className: 'mt-1 text-sm text-muted', text: 'Recurring trouble spots from your recent reviews.' }),
        element('ul', { className: 'mt-4 grid gap-2' }, patterns.map((pattern) => {
          const displays = (pattern.affectedItems || []).map((entry) => entry.display).filter(Boolean);
          const practiceButton = element('button', {
            className: 'button-secondary mt-2 min-h-8 px-2.5 py-1 text-xs',
            text: 'Practice these',
            attrs: { type: 'button', 'aria-label': `Open setup focused on ${pattern.patternType}` }
          });
          practiceButton.addEventListener('click', () => {
            const target = (pattern.affectedItems || []).find((entry) => entry.entityType)?.entityType || 'vocabulary';
            const boxes = setupForm.querySelectorAll('input[name="review-types"]');
            boxes.forEach?.((box) => { box.checked = box.value === target; });
            startButton.click();
          });
          return element('li', { className: 'rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm' }, [
            element('p', { className: 'font-semibold text-ink', text: pattern.patternType }),
            ...(displays.length ? [element('p', { className: 'mt-0.5 break-words font-jp text-xs leading-5 text-muted', text: displays.join(' · ') })] : []),
            ...(pattern.suggestedAction ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: pattern.suggestedAction })] : []),
            practiceButton
          ]);
        }))
      );
      patternsBlock.hidden = false;
    } catch {
      patternsBlock.hidden = true;
    }
  }

  function currentPreset() {
    const checked = setupForm.querySelector('input[name="review-preset"]:checked');
    return checked ? checked.value : 'last3';
  }

  function currentJlpt() {
    const checked = setupForm.querySelector('input[name="review-jlpt"]:checked');
    return checked ? checked.value : 'all';
  }

  function currentTypes() {
    return Array.from(setupForm.querySelectorAll('input[name="review-types"]:checked')).map((node) => node.value);
  }

  function syncCustomVisibility() {
    const isCustom = currentPreset() === 'custom';
    customWrap.classList.toggle('hidden', !isCustom);
    customWrap.setAttribute('aria-hidden', String(!isCustom));
  }

  function showFormError(message) {
    if (!message) {
      formError.textContent = '';
      formError.classList.add('hidden');
      return;
    }
    formError.textContent = message;
    formError.classList.remove('hidden');
  }

  function presetLabel(preset, from, to) {
    if (preset === 'today') return 'Today';
    if (preset === 'last3') return 'Last 3 days';
    return `${from} to ${to}`;
  }

  function summaryLabel(search) {
    const jlptLabel = search.jlpt === 'all' ? 'All levels' : search.jlpt;
    let typesLabel;
    if (search.types.length === 3) typesLabel = '3 types';
    else if (search.types.length === 1) typesLabel = TYPE_LABEL[search.types[0]] || search.types[0];
    else typesLabel = search.types.map((type) => TYPE_LABEL[type] || type).join(' + ');
    return `${search.presetLabel} · ${jlptLabel} · ${typesLabel}`;
  }

  function setStage(next) {
    stage = next;
    heroSurface.hidden = !(next === 'INTRO' || next === 'SETUP');
    startWrap.hidden = next !== 'INTRO';
    setupWrap.hidden = next !== 'SETUP';
    summaryBar.hidden = next !== 'CANDIDATES';
    candidatesBlock.hidden = next !== 'CANDIDATES';
    reviewingBlock.hidden = next !== 'REVIEWING';
    completeBlock.hidden = next !== 'COMPLETE';
    // History and difficult visibility is driven by loadHistory/loadDifficult
    // (fail-open: hidden when empty or unavailable); leaving INTRO only
    // ever hides them.
    if (next !== 'INTRO') {
      historyBlock.hidden = true;
      difficultBlock.hidden = true;
    }
    if (next !== 'REVIEWING') detachKeys();
  }

  startButton.addEventListener('click', () => {
    showFormError('');
    setStage('SETUP');
    syncCustomVisibility();
  });

  backButton.addEventListener('click', () => {
    showFormError('');
    setStage('INTRO');
  });

  editButton.addEventListener('click', () => {
    // Keep every control value so the search can be refined.
    showFormError('');
    setStage('SETUP');
    syncCustomVisibility();
  });

  presetRadios.forEach((radio) => radio.addEventListener('change', syncCustomVisibility));
  syncCustomVisibility();

  setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    showFormError('');
    const preset = currentPreset();
    const jlpt = currentJlpt();
    const types = currentTypes();
    if (!types.length) {
      showFormError('Choose at least one material type.');
      return;
    }
    let from;
    let to;
    if (preset === 'today') {
      from = todayISO();
      to = todayISO();
    } else if (preset === 'last3') {
      from = daysAgoISO(3);
      to = todayISO();
    } else {
      from = (fromInput.value || '').slice(0, 10);
      to = (toInput.value || '').slice(0, 10);
      if (!from || !to) {
        showFormError('Choose From and To dates.');
        return;
      }
      if (from > to) {
        showFormError('Choose a From date on or before the To date.');
        return;
      }
      if (to > todayISO()) {
        showFormError('Choose a To date on or before today.');
        return;
      }
    }
    const search = { preset, presetLabel: presetLabel(preset, from, to), from, to, jlpt, types: [...types] };
    lastSearch = search;
    summaryText.textContent = summaryLabel(search);
    setStage('CANDIDATES');
    loadCandidates();
  });

  async function loadCandidates() {
    if (!lastSearch) return;
    selectedKeys = new Set();
    candidatesByKey = new Map();
    candidatesBlock.replaceChildren(loadingState('Finding material…'));
    try {
      const data = await apiRequest(`/api/review/candidates${queryString({
        from: lastSearch.from,
        to: lastSearch.to,
        jlpt: lastSearch.jlpt,
        types: lastSearch.types.join(',')
      })}`);
      renderCandidates(data);
    } catch (error) {
      candidatesBlock.replaceChildren(errorState(error, loadCandidates));
    }
  }

  function renderCandidates(data) {
    const groups = data?.groups || {};
    const orderedTypes = TYPE_ORDER.filter((type) => lastSearch.types.includes(type));
    let grandTotal = 0;
    orderedTypes.forEach((type) => {
      const group = groups[type] || {};
      const items = Array.isArray(group.items) ? group.items : [];
      grandTotal += items.length;
    });
    if (!grandTotal) {
      candidatesBlock.replaceChildren(emptyState({
        title: 'No material found',
        description: 'Try widening the date range or including more types.'
      }));
      return;
    }

    candidatesBlock.replaceChildren();
    const footer = element('div', { className: 'surface review-sticky-footer flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between' });
    const countNote = element('p', { className: 'text-sm text-muted', text: '0 selected', attrs: { 'aria-live': 'polite' } });
    // Start review button: normal review from selected date-range candidates.
    const startReviewBtn = element('button', { className: 'button-primary', text: 'Start review', attrs: { type: 'button', disabled: '' } });
    // Start immersed review button: opens the immersion page to create a review from user text.
    const startImmersedReviewBtn = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Start immersed review', attrs: { type: 'button', 'aria-label': 'Start a review from user text' } });
    const startActions = element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center' }, [startReviewBtn, startImmersedReviewBtn]);
    footer.append(countNote, startActions);

    function refreshFooter() {
      countNote.textContent = `${selectedKeys.size} selected`;
      if (selectedKeys.size > 0) startReviewBtn.removeAttribute('disabled');
      else startReviewBtn.setAttribute('disabled', '');
    }

    function registerCheckbox(checkbox, item) {
      checkbox.addEventListener('change', () => {
        const key = itemKey(item);
        if (checkbox.checked) selectedKeys.add(key);
        else selectedKeys.delete(key);
        refreshFooter();
      });
    }

    orderedTypes.forEach((type) => {
      const group = groups[type] || {};
      const items = Array.isArray(group.items) ? group.items : [];
      if (!items.length) return;
      items.forEach((item) => candidatesByKey.set(itemKey(item), item));
      const studied = items.filter((item) => !isWeak(item));
      const weak = items.filter((item) => isWeak(item));
      const total = typeof group.total === 'number' ? group.total : items.length;

      const section = element('section', { className: 'surface p-5 sm:p-6', attrs: { 'aria-label': TYPE_LABEL[type] } });
      const headingRow = element('div', { className: 'flex flex-wrap items-center justify-between gap-3' }, [
        element('h2', { className: 'text-sm font-bold uppercase tracking-[0.12em] text-ink', text: `${TYPE_HEADING[type]} · ${total}` })
      ]);
      const listActions = element('div', { className: 'flex flex-wrap gap-2' });
      const selectAllButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Select all', attrs: { type: 'button' } });
      const clearButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Clear', attrs: { type: 'button' } });
      listActions.append(selectAllButton, clearButton);

      const list = element('ul', { className: 'mt-4 grid gap-2' });
      const studiedBoxes = [];
      studied.forEach((item) => {
        const checkbox = element('input', { className: 'mt-1 size-4 shrink-0 accent-vermilion', attrs: { type: 'checkbox' } });
        checkbox.dataset.key = itemKey(item);
        studiedBoxes.push(checkbox);
        registerCheckbox(checkbox, item);
        const line = provenanceLine(item);
        const meta = [item.reading, item.meaning].filter(Boolean).join(' — ');
        list.appendChild(element('li', {}, [
          element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:bg-paper' }, [
            checkbox,
            element('span', { className: 'min-w-0' }, [
              element('span', { className: 'block break-words font-jp font-semibold text-ink', text: item.display }),
              ...(line ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: line })] : []),
              ...(meta ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: meta })] : []),
              ...(item.jlpt ? [element('span', { className: 'status-pill mt-1.5', text: item.jlpt })] : [])
            ])
          ])
        ]));
      });

      selectAllButton.addEventListener('click', () => {
        studiedBoxes.forEach((checkbox) => {
          if (!checkbox.checked) {
            checkbox.checked = true;
            selectedKeys.add(checkbox.dataset.key);
          }
        });
        refreshFooter();
      });
      clearButton.addEventListener('click', () => {
        section.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
          checkbox.checked = false;
          selectedKeys.delete(checkbox.dataset.key);
        });
        refreshFooter();
      });

      section.append(headingRow, listActions);
      section.appendChild(list);
      if (group.truncated) {
        section.appendChild(element('p', { className: 'mt-3 text-xs leading-5 text-muted', text: 'Showing the first results — narrow the date range for a smaller set.' }));
      }

      if (weak.length) {
        const weakBoxes = [];
        const weakList = element('ul', { className: 'mt-2 grid gap-2' });
        weak.forEach((item) => {
          const checkbox = element('input', { className: 'mt-1 size-4 shrink-0 accent-vermilion', attrs: { type: 'checkbox' } });
          checkbox.dataset.key = itemKey(item);
          weakBoxes.push(checkbox);
          registerCheckbox(checkbox, item);
          const line = provenanceLine(item);
          weakList.appendChild(element('li', {}, [
            element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:bg-paper' }, [
              checkbox,
              element('span', { className: 'min-w-0' }, [
                element('span', { className: 'block break-words font-jp font-semibold text-ink', text: item.display }),
                ...(line ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: line })] : [])
              ])
            ])
          ]));
        });
        const weakSelectAll = element('button', { className: 'button-secondary mt-2 min-h-9 px-3 py-1.5 text-sm', text: 'Select all recent additions', attrs: { type: 'button' } });
        weakSelectAll.addEventListener('click', () => {
          weakBoxes.forEach((checkbox) => {
            if (!checkbox.checked) {
              checkbox.checked = true;
              selectedKeys.add(checkbox.dataset.key);
            }
          });
          refreshFooter();
        });
        const details = element('details', { className: 'mt-4 rounded-xl border border-stone bg-paper/40 p-3' }, [
          element('summary', { className: 'cursor-pointer text-sm font-semibold text-muted', text: `Recent additions (${weak.length}) — added, not proven study` }),
          element('p', { className: 'mt-2 text-xs leading-5 text-muted', text: 'These were added in this period. Include them only if you want to look at them now.' }),
          weakSelectAll,
          weakList
        ]);
        section.appendChild(details);
      }

      candidatesBlock.appendChild(section);
    });

    candidatesBlock.appendChild(footer);
    refreshFooter();

    startReviewBtn.addEventListener('click', () => {
      if (!selectedKeys.size) return;
      const picked = [];
      TYPE_ORDER.forEach((type) => {
        const group = (data.groups || {})[type] || {};
        (Array.isArray(group.items) ? group.items : []).forEach((item) => {
          if (selectedKeys.has(itemKey(item))) {
            picked.push({
              entityType: item.entityType,
              entityId: item.entityId,
              display: item.display,
              reading: item.reading,
              meaning: item.meaning
            });
          }
        });
      });
      if (!picked.length) return;
      withPendingAction(startReviewBtn, async () => {
        const session = await apiRequest('/api/review/sessions', {
          method: 'POST',
          body: { sourceFrom: lastSearch.from, sourceTo: lastSearch.to }
        });
        sessionId = session.id;
        queue = picked;
        currentIndex = 0;
        revealed = false;
        graded = [];
        activeReview = { sessionId, selected: picked };
        setStage('REVIEWING');
        renderCard();
      }, { pendingLabel: 'Starting…' }).catch((error) => {
        showToast(error?.message || 'Unable to start the review.', 'error');
      });
    });

    // Start immersed review button: navigate to immersion page.
    startImmersedReviewBtn.addEventListener('click', () => {
      window.location.hash = '#immersion?returnUrl=/review';
    });
  }

  function attachGradeKeys() {
    const handler = (event) => {
      if (!['1', '2', '3'].includes(event.key)) return;
      const tag = document.activeElement?.tagName;
      if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (stage !== 'REVIEWING' || !revealed) return;
      const target = gradeButtons[Number(event.key) - 1];
      if (target && !target.disabled) {
        event.preventDefault();
        target.click();
      }
    };
    document.addEventListener('keydown', handler);
    localDetach = () => document.removeEventListener('keydown', handler);
    detachReviewKeys = localDetach;
  }

  function renderCard() {
    detachKeys();
    attachGradeKeys();
    revealed = false;
    gradeButtons = [];
    const total = queue.length;
    const item = queue[currentIndex];
    reviewingBlock.replaceChildren();

    const progress = element('p', {
      className: 'text-sm font-semibold text-muted',
      text: `${currentIndex + 1} of ${total}`,
      attrs: { 'aria-live': 'polite' }
    });
    const counter = element('span', { className: 'text-xs font-semibold text-muted', text: `${currentIndex + 1} / ${total}` });
    // Thin determinate track mirrors the announced progress visually only
    // (text labels carry meaning; color never acts alone).
    const track = element('div', { className: 'review-progress-track mt-3', attrs: { 'aria-hidden': 'true' } }, [
      element('div', { className: 'review-progress-fill', attrs: { style: `width: ${total ? Math.round(((currentIndex + 1) / total) * 100) : 0}%` } })
    ]);

    // V5.3a Review 2.0: pick the presentation for THIS card. Recognition is
    // the frozen default (and the fallback whenever richer data is missing).
    const cardType = (() => {
      const picked = pickCardType(item);
      if (picked === 'recall' && !item.meaning) return 'recognition';
      return picked;
    })();
    const typePill = element('span', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: CARD_TYPE_LABEL[cardType] || cardType, attrs: { 'aria-label': `Card type ${CARD_TYPE_LABEL[cardType] || cardType}` } });
    const frontText = cardType === 'recall' ? item.meaning : cardType === 'audio' ? 'Listen and recall' : item.display;
    const title = element('h2', { className: 'mt-2 break-words text-3xl font-semibold tracking-tight text-ink', text: frontText, attrs: { tabindex: '-1' } });
    const card = element('article', { className: 'surface review-card p-5 sm:p-8' }, [
      element('div', { className: 'flex items-start justify-between gap-3' }, [progress, counter]),
      track,
      typePill,
      title
    ]);

    const body = element('div', { className: 'mt-5 border-t border-stone pt-5' });
    card.appendChild(body);

    function renderFront() {
      body.replaceChildren();
      if (cardType === 'audio') {
        const playButton = element('button', { className: 'button-secondary min-h-10 px-4 py-2 text-sm', text: 'Play audio', attrs: { type: 'button', 'aria-label': `Play ${item.display}` } });
        playButton.addEventListener('click', () => { speakDisplay(item.display); });
        body.appendChild(element('div', { className: 'mb-3' }, [playButton]));
      }
      if (cardType === 'cloze') {
        const sentenceLine = element('p', { className: 'mb-3 break-words text-base leading-8 text-ink', text: 'Loading sentence…', attrs: { lang: 'ja' } });
        body.appendChild(sentenceLine);
        fetchClozeSentence(item).then((sentence) => {
          if (!sentence) {
            // Fail-open: no sentence available -> recognition fallback.
            sentenceLine.replaceChildren(element('span', { text: item.display }));
            return;
          }
          sentenceLine.textContent = sentence;
        });
      }
      const revealButton = element('button', { className: 'button-primary', text: 'Reveal answer', attrs: { type: 'button' } });
      revealButton.addEventListener('click', () => {
        revealed = true;
        renderAnswer();
      });
      body.appendChild(revealButton);
    }

    function renderAnswer() {
      body.replaceChildren();
      if (cardType !== 'recognition') {
        body.appendChild(element('p', { className: 'font-jp text-2xl font-semibold text-ink', text: item.display }));
      }
      if (item.reading) body.appendChild(element('p', { className: 'text-sm text-muted', text: item.reading }));
      if (item.meaning) body.appendChild(element('p', { className: 'mt-2 text-base leading-7 text-ink', text: item.meaning }));
      body.appendChild(element('p', { className: 'mt-5 text-sm font-semibold text-ink', text: 'How did recall feel?' }));
      const grades = element('div', { className: 'mt-3 grid gap-2 sm:grid-cols-3' });
      GRADES.forEach(({ result, hint }, gradeIndex) => {
        const button = element('button', { className: 'button-secondary flex-col gap-1 px-4 py-3 text-center', attrs: { type: 'button', 'aria-keyshortcuts': String(gradeIndex + 1) } }, [
          element('span', { className: 'block text-sm font-semibold', text: result }),
          element('span', { className: 'block text-xs font-normal leading-5 text-muted', text: hint })
        ]);
        button.addEventListener('click', () => {
          withPendingAction(button, async () => {
            await apiRequest('/api/review/grade', {
              method: 'POST',
              body: { entityType: item.entityType, entityId: item.entityId, result, reviewSessionId: sessionId }
            });
            graded.push({ ...item, result });
            if (currentIndex + 1 < total) {
              currentIndex += 1;
              renderCard();
            } else {
              await finishReview();
            }
          }, { pendingLabel: 'Saving…' }).catch((error) => {
            showToast(error?.message || 'Unable to save this response.', 'error');
          });
        });
        gradeButtons.push(button);
        grades.appendChild(button);
      });
      body.appendChild(grades);
      body.appendChild(element('p', { className: 'mt-3 text-xs text-muted', text: 'Shortcuts: 1 Again · 2 Hard · 3 Good' }));
    }

    reviewingBlock.appendChild(card);
    renderFront();
    title.focus({ preventScroll: true });
  }

  async function finishReview() {
    reviewingBlock.replaceChildren(loadingState('Wrapping up…'));
    try {
      const summary = await apiRequest(`/api/review/sessions/${sessionId}/complete`, { method: 'POST' });
      renderComplete(summary);
    } catch (error) {
      reviewingBlock.replaceChildren(errorState(error, finishReview));
    }
  }

  function renderComplete(summary) {
    detachKeys();
    setStage('COMPLETE');
    completeBlock.replaceChildren();
    const total = Number(summary?.total || 0);
    const byType = summary?.byType || {};
    const byResult = summary?.byResult || {};
    const kanjiCount = Number(byType.kanji || 0);
    const vocabCount = Number(byType.vocabulary || 0);
    const grammarCount = Number(byType.grammar || 0);
    const goodCount = Number(byResult.Good || 0);
    const hardCount = Number(byResult.Hard || 0);
    const againCount = Number(byResult.Again || 0);
    // Retry uses this session's own graded items (Again/Hard only), so the
    // repeat set is exactly what felt difficult — no parallel bookkeeping.
    const failed = graded.filter((entry) => entry.result === 'Again' || entry.result === 'Hard');

    const heading = element('h1', { className: 'text-2xl font-semibold tracking-tight text-ink sm:text-3xl', text: 'Review complete', attrs: { tabindex: '-1' } });
    const card = element('div', { className: 'surface p-5 sm:p-8' }, [
      heading,
      element('p', { className: 'mt-3 text-sm leading-6 text-muted', text: `${total} items reviewed` }),
      element('ul', { className: 'mt-4 grid gap-1.5 text-sm font-medium text-ink' }, [
        element('li', { text: `${kanjiCount} Kanji` }),
        element('li', { text: `${vocabCount} Vocabulary` }),
        element('li', { text: `${grammarCount} Grammar` })
      ]),
      element('ul', { className: 'mt-4 grid gap-1.5 border-t border-stone pt-4 text-sm leading-6 text-muted' }, [
        element('li', { text: `${goodCount} felt comfortable` }),
        element('li', { text: `${hardCount} felt difficult` }),
        element('li', { text: `${againCount} should be revisited` })
      ]),
      element('div', { className: 'mt-6 flex flex-col gap-2 sm:flex-row' }, [
        element('button', { className: 'button-primary', text: 'Back to Review', attrs: { type: 'button' } }),
        ...(failed.length ? [element('button', { className: 'button-secondary', text: `Repeat failed (${failed.length})`, attrs: { type: 'button' } })] : []),
        element('a', { className: 'button-secondary', text: 'Go to Dashboard', attrs: { href: '#dashboard' } })
      ])
    ]);
    const buttons = card.querySelectorAll('button');
    const resetButton = buttons[0];
    const repeatButton = failed.length ? buttons[1] : null;
    if (repeatButton) {
      repeatButton.addEventListener('click', () => {
        if (!lastSearch || !failed.length) return;
        // A fresh session groups the retry (the completed one is closed);
        // items are the already-graded failed subset — no duplicates.
        withPendingAction(repeatButton, async () => {
          const session = await apiRequest('/api/review/sessions', {
            method: 'POST',
            body: { sourceFrom: lastSearch.from, sourceTo: lastSearch.to }
          });
          sessionId = session.id;
          queue = failed.map(({ result, ...rest }) => rest);
          currentIndex = 0;
          revealed = false;
          graded = [];
          activeReview = { sessionId, selected: queue };
          setStage('REVIEWING');
          renderCard();
        }, { pendingLabel: 'Starting…' }).catch((error) => {
          showToast(error?.message || 'Unable to start the review.', 'error');
        });
      });
    }
    resetButton.addEventListener('click', () => {
      // Reset to a fresh INTRO so a new round starts from defaults.
      setupForm.querySelector('input[name="review-preset"][value="last3"]').checked = true;
      setupForm.querySelector('input[name="review-jlpt"][value="all"]').checked = true;
      setupForm.querySelectorAll('input[name="review-types"]').forEach((node) => { node.checked = true; });
      fromInput.value = daysAgoISO(3);
      toInput.value = todayISO();
      showFormError('');
      syncCustomVisibility();
      lastSearch = null;
      queue = [];
      currentIndex = 0;
      revealed = false;
      sessionId = null;
      graded = [];
      selectedKeys = new Set();
      candidatesByKey = new Map();
      activeReview = { sessionId: null, selected: [] };
      candidatesBlock.replaceChildren();
      reviewingBlock.replaceChildren();
      setStage('INTRO');
      loadHistory();
      loadDifficult();
      loadPatterns();
    });
    completeBlock.appendChild(card);
    heading.focus({ preventScroll: true });
  }

  setStage('INTRO');
  loadHistory();
  loadDifficult();
  loadCardTypePreferences();
  loadPatterns();
  tryResumeImmersionQueue();
}
