import { apiRequest, queryString } from '../api';
import { kanjiReferenceRoute } from '../kanjiReference';
import { icon } from '../icons';
import { element, emptyState, errorState, loadingState, openDetailModal, openDialog, confirmDialog, pageHeader, setActionPending, showToast, withPendingAction } from '../ui';
import { mountKanjiWriting } from '../kanjiWriting.js';

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
const DEFAULT_CARD_PREFERENCES = { cardTypes: ['recognition'], weights: {}, engineMode: 'fixed', autoPick: true, speechRate: 1 };
// Discrete playback speeds offered beside every speaker button.
const SPEECH_RATES = [0.25, 0.5, 1, 1.5];
const MIN_SPEECH_RATE = 0.25;
const MAX_SPEECH_RATE = 1.5;

function sanitizeSpeechRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= MIN_SPEECH_RATE && rate <= MAX_SPEECH_RATE
    ? rate
    : DEFAULT_CARD_PREFERENCES.speechRate;
}

let activeReview = { sessionId: null, selected: [] };
let detachReviewKeys = null;

// Audio playback defenses (Web Speech API pitfalls):
// - Keep a live utterance reference so Chrome cannot collect it mid-speech.
// - Warm the voice list (getVoices is empty until voiceschanged fires).
// - Defer speak after cancel so the utterance is not dropped.
// - Surface a missing Japanese voice with guidance instead of silence.
let activeUtterance = null;
let cachedVoices = null;
let voicesWarmAttached = false;
let pendingSpeakTimer = null;

function warmCachedVoices() {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const synthesis = window.speechSynthesis;
    try {
      const initial = typeof synthesis.getVoices === 'function' ? synthesis.getVoices() : [];
      if (Array.isArray(initial) && initial.length) cachedVoices = initial.slice();
    } catch { /* initial read is best-effort */ }
    if (voicesWarmAttached) return;
    voicesWarmAttached = true;
    const refresh = () => {
      try {
        const voices = typeof synthesis.getVoices === 'function' ? synthesis.getVoices() : [];
        if (Array.isArray(voices) && voices.length) cachedVoices = voices.slice();
      } catch { /* refresh is best-effort */ }
    };
    try {
      if (typeof synthesis.addEventListener === 'function') {
        synthesis.addEventListener('voiceschanged', refresh, { once: true });
      } else if (synthesis && typeof synthesis.onvoiceschanged !== 'undefined') {
        const prev = synthesis.onvoiceschanged;
        try {
          synthesis.onvoiceschanged = (...args) => {
            try { if (typeof prev === 'function') prev(...args); } catch { /* prior handler is best-effort */ }
            refresh();
          };
        } catch { /* attach is best-effort */ }
      }
    } catch { /* listener attach is best-effort */ }
  } catch { /* warm-up never blocks review */ }
}

function readVoices(synthesis) {
  try {
    if (Array.isArray(cachedVoices) && cachedVoices.length) return cachedVoices;
  } catch { /* cache read is best-effort */ }
  try {
    const live = typeof synthesis.getVoices === 'function' ? synthesis.getVoices() : [];
    if (Array.isArray(live) && live.length) {
      try { cachedVoices = live.slice(); } catch { /* cache store is best-effort */ }
      return live;
    }
    return Array.isArray(live) ? live : [];
  } catch { return Array.isArray(cachedVoices) ? cachedVoices : []; }
}

function findJapaneseVoice(voices) {
  try {
    const list = Array.isArray(voices) ? voices : [];
    return list.find((voice) => String(voice?.lang || '').toLowerCase().replace('_', '-').startsWith('ja')) || null;
  } catch { return null; }
}

function hasJapaneseVoice(voices) {
  return Boolean(findJapaneseVoice(voices));
}

// Live-first voice read for the audio-card probe: a fresh install (or a
// list that finished loading) must be visible immediately instead of
// hiding behind a stale cache. Falls back to the cache when unreadable.
function readVoicesLive(synthesis) {
  try {
    if (synthesis && typeof synthesis.getVoices === 'function') {
      const voices = synthesis.getVoices();
      if (Array.isArray(voices) && voices.length) {
        try { cachedVoices = voices.slice(); } catch { /* cache store is best-effort */ }
        return voices;
      }
    }
  } catch { /* fall through to the cache */ }
  return readVoices(synthesis);
}

function japaneseVoiceGuidance() {
  return 'No Japanese voice found on this device — install one in your system settings to hear audio.';
}

// Browsers load the voice list asynchronously: getVoices() is often [] on
// first read even when voices ARE installed, and voiceschanged can fire with
// a partial list first. Never judge an unloaded list — wait for a non-empty
// one (or the timeout) and only then decide whether Japanese is missing.
const VOICE_LOAD_TIMEOUT_MS = 2500;

function waitForVoices(synthesis, timeoutMs = VOICE_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (voices) => {
      if (done) return;
      done = true;
      resolve(Array.isArray(voices) ? voices : []);
    };
    const readNow = () => {
      try {
        const voices = typeof synthesis.getVoices === 'function' ? synthesis.getVoices() : [];
        return Array.isArray(voices) ? voices : [];
      } catch {
        return [];
      }
    };
    const current = readNow();
    if (current.length) {
      try { cachedVoices = current.slice(); } catch { /* cache store is best-effort */ }
      finish(current);
      return;
    }
    const clearTimer = (timer) => {
      try {
        if (typeof window !== 'undefined' && window && typeof window.clearTimeout === 'function') window.clearTimeout(timer);
        else clearTimeout(timer);
      } catch { /* timer clear is best-effort */ }
    };
    const scheduleTimer = (fn, ms) => {
      try {
        if (typeof window !== 'undefined' && window && typeof window.setTimeout === 'function') return window.setTimeout(fn, ms);
      } catch { /* fall through to global */ }
      return setTimeout(fn, ms);
    };
    let timer = null;
    const cleanup = () => {
      if (timer !== null) { clearTimer(timer); timer = null; }
      try { synthesis.removeEventListener('voiceschanged', onChange); } catch { /* detach is best-effort */ }
    };
    const onChange = () => {
      let voices = [];
      try {
        voices = typeof synthesis.getVoices === 'function' ? synthesis.getVoices() : [];
        if (Array.isArray(voices) && voices.length) {
          try { cachedVoices = voices.slice(); } catch { /* cache store is best-effort */ }
        }
      } catch { /* read is best-effort */ }
      if (Array.isArray(voices) && voices.length) { cleanup(); finish(voices); }
    };
    timer = scheduleTimer(() => { cleanup(); finish(readNow()); }, timeoutMs);
    try {
      if (typeof synthesis.addEventListener === 'function') {
        synthesis.addEventListener('voiceschanged', onChange);
      } else {
        cleanup();
        finish(readNow());
      }
    } catch {
      cleanup();
      finish(readNow());
    }
  });
}

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

// V5.7 multiple-choice recognition (deterministic, no AI, zero queries).
// Distractors come from the in-memory session queue only (same entity type,
// same JLPT band when both sides carry one): same-user wording, plausible
// by construction, never cross-user. FNV-1a + mulberry32 shuffle is stable
// for the same card in the same session and varies across cards.
function hashSeedString(text) {
  let hash = 2166136261;
  const input = String(text || '');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normOptionText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildRecognitionOptions(item, queue, seedText) {
  const wantMeaning = String(item?.meaning || '').trim();
  const wantDisplay = String(item?.display || '').trim();
  if (!wantMeaning || !item?.entityType) return null;
  const seen = new Set([normOptionText(wantMeaning)]);
  const pool = [];
  const banded = [];
  for (const entry of Array.isArray(queue) ? queue : []) {
    if (!entry || entry.entityType !== item.entityType) continue;
    if (Number(entry.entityId) === Number(item.entityId)) continue;
    const meaning = String(entry.meaning || '').trim();
    if (!meaning || seen.has(normOptionText(meaning))) continue;
    if (wantDisplay && normOptionText(entry.display) === normOptionText(wantDisplay)) continue;
    seen.add(normOptionText(meaning));
    pool.push({ meaning });
    if (item.jlpt && entry.jlpt && entry.jlpt === item.jlpt) banded.push({ meaning });
  }
  // Same JLPT band only when it yields a full set; otherwise same-type pool.
  // Fewer than 3 usable distractors → null and the card keeps its reveal flow.
  const source = banded.length >= 3 ? banded : pool;
  if (source.length < 3) return null;
  const options = [{ meaning: wantMeaning, answer: true }, ...source.slice(0, 3).map((entry) => ({ meaning: entry.meaning, answer: false }))];
  const rand = mulberry32(hashSeedString(seedText));
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { options };
}

// V5.7 performance classification: mistakes feed the existing suggested
// grade only — scheduling stays with Again/Hard/Good via the normal handler.
function suggestedGradeForMistakes(mistakes) {
  if (mistakes <= 1) return 'Good';
  if (mistakes === 2) return 'Hard';
  return 'Again';
}

// V5.6 Completion Pass: session-creation responses carry batched per-item
// context (same helper shape as the dashboard auto-session). Merge it into
// the client queue so cards render Context blocks with zero extra requests.
function applySessionContext(queueItems, session) {
  const byKey = new Map((Array.isArray(session?.items) ? session.items : []).map((entry) => [`${entry.entityType}:${entry.entityId}`, entry.context]));
  for (const item of queueItems) {
    const context = byKey.get(`${item.entityType}:${item.entityId}`);
    if (context) item.context = context;
  }
  return queueItems;
}

// Relative day label for honest history ("Last failed 4 days ago").
// Unparseable input yields null and the line is hidden — never "NaN days".
function daysAgoText(iso) {
  try {
    const then = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(then)) return null;
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const days = Math.round((Date.parse(todayKey + 'T00:00:00Z') - then) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  } catch { return null; }
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
  try { warmCachedVoices(); } catch { /* warm-up is best-effort */ }

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
  let recognitionOptionButtons = [];
  let graded = [];
  let localDetach = null;

  // V5.3a hand-off: the Immersion page stores the server-resolved queue for
  // the freshly created OPEN review session (freshly enrolled items carry no
  // review_events, so date-range discovery cannot surface them yet). Consumed
  // exactly once; any mismatch falls back to the informational banner below.
  // V5.6: the Study Now dashboard uses the same mechanism with its own key
  // ('jlt-study-now-queue', due items oldest-first). Either key resumes
  // straight into REVIEWING — no setup step.
  function tryResumeImmersionQueue() {
    const handoffSessionId = reviewSessionIdFromHash();
    if (!handoffSessionId) return false;
    try {
      const store = typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
      if (!store) return false;
      const raw = store.getItem('jlt-study-now-queue') || store.getItem('jlt-immersion-review-queue');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      if (Number(parsed?.reviewSessionId) !== Number(handoffSessionId) || !items.length) return false;
      try {
        store.removeItem('jlt-study-now-queue');
        store.removeItem('jlt-immersion-review-queue');
      } catch { /* removal is best-effort */ }
      sessionId = Number(handoffSessionId);
      queue = items;
      currentIndex = 0;
      revealed = false;
      graded = [];
      lastPickedByKey.clear();
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
    element('p', { className: 'mt-3 max-w-2xl text-sm leading-6 text-muted', text: 'Short recall now saves re-study later. Again, Hard and Good only set timing — pick how each item felt and keep going.' })
  ]);
  // Immersion hand-off banner: when mounted via a create-session redirect,
  // announce the enrollment and let the normal flow take over. This page
  // intentionally does NOT bind grading to the redirected session id — its
  // sessions are created per search, and the Today range already surfaces
  // the freshly enrolled items, so nothing extra is routed anywhere.
  const fromImmersionId = reviewSessionIdFromHash();
  if (fromImmersionId) {
    // V5.6: Study Now hand-offs carry &from=study-now — same auto-resume,
    // different origin copy. Unknown values keep the immersion wording.
    let fromParam = null;
    try {
      const hash = typeof window !== 'undefined' && window.location ? window.location.hash || '' : '';
      const queryIndex = hash.indexOf('?');
      if (queryIndex !== -1) fromParam = new URLSearchParams(hash.slice(queryIndex + 1)).get('from');
    } catch { fromParam = null; }
    introBlock.appendChild(element('p', {
      className: 'mt-4 rounded-xl border border-stone bg-paper px-3 py-2 text-sm leading-6 text-ink',
      text: fromParam === 'study-now'
        ? 'Your due items are queued — starting your session now.'
        : 'Session created from your text — its items are enrolled for today. Start a review for Today to study them.',
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
    if (Number.isNaN(d.getTime())) return 'unknown date';
    // Pinned to US English ("September 1, 2026"): history dates stay put
    // no matter the device locale.
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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
    // In-progress sessions offer Retake: resume the same open session where
    // the user left off (persisted queue minus already-graded items).
    const actions = [];
    if (!session.completedAt) {
      const retakeButton = element('button', {
        className: 'button-primary',
        text: 'Retake',
        attrs: { type: 'button', 'aria-label': `Resume session from ${date} where you left off` }
      });
      retakeButton.addEventListener('click', () => { retakeSession(session, closeSessionModal); });
      actions.push(retakeButton);
    }
    const closeSessionModal = openDetailModal({
      title: `${type} Review Session • ${date}`,
      subtitle: `${items.length} item${items.length === 1 ? '' : 's'} reviewed`,
      content: [list],
      actions
    });
  }

  // Retake: resume an unfinished session exactly where the user left off.
  // The persisted queue minus already-graded items becomes the new queue on
  // the SAME open session, so finishing completes it instead of duplicating
  // history. Already-graded Again/Hard items seed the repeat-failed subset.
  async function retakeSession(session, closeModal) {
    let data = null;
    try {
      data = await apiRequest(`/api/review/sessions/${session.id}/items`);
    } catch (error) {
      showToast(error?.message || 'Could not load the session queue.', 'error');
      return;
    }
    const stored = Array.isArray(data?.items) ? data.items : [];
    const remaining = stored.filter((entry) => !entry.lastResult);
    // Reconstructed queues (open sessions whose original selection was never
    // persisted: pre-queue sessions, the no-items path, target-less
    // immersion) resume from candidate discovery over the session's source
    // range — say so honestly instead of pretending the queue was stored.
    const reconstructed = data?.reconstructed === true;
    const rangeLabel = (() => {
      const from = data?.sourceFrom || session.sourceFrom || null;
      const to = data?.sourceTo || session.sourceTo || null;
      return from && to ? `${from} to ${to}` : null;
    })();
    if (!remaining.length) {
      if (stored.length) {
        showToast('Nothing left to retake in this session.', 'info');
      } else if (reconstructed) {
        showToast(rangeLabel ? `Original selection wasn't saved for this older session — nothing new found in ${rangeLabel}.` : `Original selection wasn't saved for this older session — nothing new found to resume.`, 'info');
      } else {
        showToast('No items recorded in this session.', 'info');
      }
      return;
    }
    sessionId = session.id;
    queue = remaining.map(({ lastResult, position, ...rest }) => rest);
    currentIndex = 0;
    revealed = false;
    graded = stored
      .filter((entry) => entry.lastResult === 'Again' || entry.lastResult === 'Hard')
      .map(({ lastResult, position, ...rest }) => ({ ...rest, result: lastResult }));
    lastPickedByKey.clear();
    activeReview = { sessionId, selected: queue };
    lastSearch = { from: session.sourceFrom || null, to: session.sourceTo || null };
    if (typeof closeModal === 'function') { try { closeModal(); } catch { /* already closed */ } }
    setStage('REVIEWING');
    renderCard();
    showToast(reconstructed && rangeLabel ? `Original selection wasn't saved for this older session — resumed from ${rangeLabel} with ${remaining.length} remaining item${remaining.length === 1 ? '' : 's'}.` : `Resumed with ${remaining.length} remaining item${remaining.length === 1 ? '' : 's'}.`);
  }

  let historyHasContent = false;
  function clearHistoryButton() {
    const button = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Clear history', attrs: { type: 'button', 'aria-label': 'Clear all review history' } });
    button.addEventListener('click', () => {
      confirmDialog({
        title: 'Clear review history?',
        description: 'This permanently deletes all your review sessions. This cannot be undone.',
        confirmLabel: 'Clear all',
        onConfirm: async () => {
          await apiRequest('/api/review/sessions', { method: 'DELETE' });
          sessionModalCache.clear();
          showToast('Review history cleared.');
          await loadHistory();
        }
      });
    });
    return button;
  }
  async function loadHistory() {
    if (!historyHasContent) {
      historyBlock.replaceChildren(loadingState('Loading…'));
      historyBlock.hidden = false;
    }
    try {
      const data = await apiRequest('/api/review/sessions?limit=10');
      const sessions = Array.isArray(data?.items) ? data.items : [];
      const header = element('div', { className: 'flex items-center justify-between gap-3' }, [
        element('h2', { className: 'font-semibold text-ink', text: 'Recent review sessions' }),
        element('div', { className: 'flex gap-2' }, [
          reloadSectionButton('Reload recent review sessions', loadHistory),
          clearHistoryButton()
        ])
      ]);
      if (!sessions.length) {
        historyBlock.replaceChildren(
          header,
          element('p', { className: 'mt-1 text-sm text-muted', text: 'When you studied, how much you reviewed, and how it felt.' }),
          element('p', { className: 'mt-2 text-sm text-muted', text: 'No review sessions yet. Finish a review to see it here.' })
        );
        historyBlock.hidden = false;
        historyHasContent = true;
        return;
      }
      historyBlock.replaceChildren(
        header,
        element('p', { className: 'mt-1 text-sm text-muted', text: 'When you studied, how much you reviewed, and how it felt.' }),
        element('ul', { className: 'mt-4 grid gap-2', attrs: { role: 'list' } }, sessions.map((session) => {
          const iso = String(session.startedAt || '');
          const date = session.startedAt ? formattedDate(session.startedAt) : '';
          const summary = `${Number(session.total || 0)} items · ${Number(session.byResult?.Good || 0)} comfortable · ${Number(session.byResult?.Hard || 0)} difficult · ${Number(session.byResult?.Again || 0)} revisit`;
          const scope = `Kanji ${Number(session.byType?.kanji || 0)} · Vocabulary ${Number(session.byType?.vocabulary || 0)} · Grammar ${Number(session.byType?.grammar || 0)}`;
          const deleteButton = element('button', { className: 'icon-button icon-button--danger shrink-0', attrs: { type: 'button', 'aria-label': `Delete session ${date || session.id}` } }, [icon('trash', { size: 18 })]);
          deleteButton.addEventListener('click', (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            confirmDialog({
              title: 'Delete this session?',
              description: `This permanently deletes the session${date ? ` from ${date}` : ''} and its queued items. This cannot be undone.`,
              onConfirm: async () => {
                await apiRequest(`/api/review/sessions/${session.id}`, { method: 'DELETE' });
                sessionModalCache.delete(session.id);
                showToast('Session deleted.');
                await loadHistory();
              }
            });
          });
          const row = element('li', { className: 'flex cursor-pointer items-start gap-2 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:border-vermilion', attrs: { role: 'button', tabindex: '0', 'aria-label': `Open details for session ${date || session.id}` } }, [
            element('div', { className: 'min-w-0 flex-1' }, [
              element('p', { className: 'font-semibold text-ink' }, [
                ...(date ? [element('time', { text: date, attrs: { dateTime: iso } })] : [element('span', { text: 'Session' })]),
                element('span', { text: session.completedAt ? ' · completed' : ' · in progress' })
              ]),
              element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: summary }),
              element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: scope })
            ]),
            deleteButton
          ]);
          row.addEventListener('click', () => { openSessionModal(session); });
          row.addEventListener('keydown', (event) => {
            try {
              if (event.target && event.target !== row && typeof event.target.closest === 'function' && event.target.closest('button')) return;
            } catch { /* target guard is best-effort */ }
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSessionModal(session); }
          });
          return row;
        }))
      );
      historyBlock.hidden = false;
      historyHasContent = true;
    } catch (error) {
      if (historyHasContent) {
        showToast(error?.message || 'Unable to refresh this section.', 'error');
        return;
      }
      historyBlock.replaceChildren(errorState(error, loadHistory));
      historyBlock.hidden = false;
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

  // Small section-reload affordance: re-runs the loader, staying on the
  // previous content with a toast when a refresh fails (fail-open).
  function reloadSectionButton(label, onReload) {
    const button = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Reload', attrs: { type: 'button', 'aria-label': label } });
    button.addEventListener('click', () => {
      showToast('Refreshing…');
      onReload();
    });
    return button;
  }

  let difficultHasContent = false;
  async function loadDifficult() {
    if (!difficultHasContent) {
      difficultBlock.replaceChildren(loadingState('Loading…'));
      difficultBlock.hidden = false;
    }
    try {
      const data = await apiRequest('/api/review/difficult');
      const items = Array.isArray(data?.items) ? data.items : [];
      const header = element('div', { className: 'flex items-center justify-between gap-3' }, [
        element('h2', { className: 'font-semibold text-ink', text: 'Frequently difficult' }),
        reloadSectionButton('Reload frequently difficult items', loadDifficult)
      ]);
      const description = element('p', { className: 'mt-1 text-sm text-muted', text: 'Items you have marked Again at least twice — worth another look.' });
      if (!items.length) {
        difficultBlock.replaceChildren(
          header,
          description,
          element('p', { className: 'mt-2 text-sm text-muted', text: 'No frequently difficult items yet. Keep reviewing to populate this section.' })
        );
        difficultBlock.hidden = false;
        difficultHasContent = true;
        return;
      }
      difficultBlock.replaceChildren(
        header,
        description,
        element('ul', { className: 'mt-4 grid gap-2', attrs: { role: 'list' } }, items.map((item) => {
          const iso = String(item.lastReviewedAt || '');
          const date = iso ? formattedDate(iso) : '';
          const tally = `${Number(item.againCount || 0)} again of ${Number(item.totalEvents || 0)} reviews`;
          return element('li', { className: 'rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm' }, [
            element('p', { className: 'break-words font-jp font-semibold text-ink', text: item.display }),
            ...(item.reading ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: item.reading })] : []),
            ...(item.meaning ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: item.meaning })] : []),
            element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted' }, [
              element('span', { text: tally }),
              ...(date ? [element('span', { text: ' · last reviewed ' }), element('time', { text: date, attrs: { dateTime: iso } })] : [])
            ])
          ]);
        }))
      );
      difficultBlock.hidden = false;
      difficultHasContent = true;
    } catch (error) {
      if (difficultHasContent) {
        showToast(error?.message || 'Unable to refresh this section.', 'error');
        return;
      }
      difficultBlock.replaceChildren(errorState(error, loadDifficult));
      difficultBlock.hidden = false;
    }
  }

  // ------------------------------------------------------------ Review 2.0

  // Preferences + focused-practice state (module-scoped to this render).
  let reviewPreferences = { cardTypes: [...DEFAULT_CARD_PREFERENCES.cardTypes], weights: {}, engineMode: 'fixed', autoPick: true, speechRate: DEFAULT_CARD_PREFERENCES.speechRate };

  // Every rendered speed selector, kept in sync when any of them changes.
  const speechRateSelects = [];

  function currentSpeechRate() {
    return sanitizeSpeechRate(reviewPreferences.speechRate);
  }

  function syncSpeechRateSelects(rate) {
    for (const select of speechRateSelects) {
      try {
        if (!select || !select.isConnected) continue;
        select.value = String(rate);
      } catch { /* detached nodes are best-effort */ }
    }
  }

  // Applies instantly for the next utterance and persists in the background;
  // a failed save restores the previous rate instead of lying about it.
  async function applySpeechRate(changedSelect) {
    const previous = currentSpeechRate();
    const rate = sanitizeSpeechRate(changedSelect ? changedSelect.value : previous);
    reviewPreferences.speechRate = rate;
    syncSpeechRateSelects(rate);
    try {
      const saved = await apiRequest('/api/review/preferences', {
        method: 'PUT',
        body: {
          cardTypes: reviewPreferences.cardTypes,
          weights: reviewPreferences.weights || {},
          autoPick: reviewPreferences.autoPick !== false,
          speechRate: rate
        }
      });
      const preferences = saved?.userPreferences;
      reviewPreferences.speechRate = sanitizeSpeechRate(preferences ? preferences.speechRate : rate);
      syncSpeechRateSelects(reviewPreferences.speechRate);
    } catch (error) {
      reviewPreferences.speechRate = previous;
      syncSpeechRateSelects(previous);
      showToast(error?.message || 'Could not save voice speed.', 'error');
    }
  }

  // Per-item last presentation in this session (anti-repeat guard).
  const lastPickedByKey = new Map();

  async function loadCardTypePreferences() {
    try {
      const data = await apiRequest('/api/review/types');
      const preferences = data?.userPreferences;
      if (preferences && Array.isArray(preferences.cardTypes) && preferences.cardTypes.length) {
        reviewPreferences = {
          cardTypes: preferences.cardTypes,
          weights: preferences.weights && typeof preferences.weights === 'object' ? preferences.weights : {},
          engineMode: preferences.engineMode || 'fixed',
          autoPick: preferences.autoPick !== false,
          speechRate: sanitizeSpeechRate(preferences.speechRate)
        };
      } else if (preferences) {
        reviewPreferences.autoPick = preferences.autoPick !== false;
        reviewPreferences.speechRate = sanitizeSpeechRate(preferences.speechRate);
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
    const previewVoiceButton = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Preview Japanese voice', attrs: { type: 'button', 'aria-label': 'Preview how audio cards sound on this device' } });
    previewVoiceButton.addEventListener('click', () => { speakDisplay('日本語のテストです。よろしくおねがいします。'); });
    const autoOn = reviewPreferences.autoPick !== false;
    const autoCheckbox = element('input', {
      className: 'size-4 accent-vermilion',
      attrs: { type: 'checkbox', name: 'card-auto-pick', ...(autoOn ? { checked: '' } : {}) }
    });
    const autoBlock = element('div', { className: 'grid gap-1 sm:col-span-2' }, [
      element('label', { className: 'flex items-center gap-2 text-sm font-medium text-ink' }, [
        autoCheckbox,
        element('span', { text: 'Automatic card choice (recommended)' })
      ]),
      element('p', { className: 'text-xs leading-5 text-muted', text: 'Let review pick the best presentation for each item. Turn off to use weighted rotation only.' })
    ]);
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
      content: [
        element('div', { className: 'grid gap-1 sm:col-span-2' }, [
          previewVoiceButton,
          element('p', { className: 'text-xs leading-5 text-muted', text: 'Hear how audio cards sound on this device. If nothing plays, install a Japanese voice in your system settings.' })
        ]),
        autoBlock,
        ...rows
      ],
      submitLabel: 'Save',
      onSubmit: async (form, close) => {
        const cardTypes = [];
        const weights = {};
        const autoInput = form.querySelector('input[name="card-auto-pick"]');
        const autoPick = autoInput ? Boolean(autoInput.checked) : reviewPreferences.autoPick !== false;
        for (const type of CARD_TYPES) {
          const checkbox = form.querySelector(`input[name="card-type-${type}"]`);
          const slider = form.querySelector(`input[name="card-weight-${type}"]`);
          if (checkbox?.checked) cardTypes.push(type);
          if (slider) weights[type] = Number(slider.value) || 0;
        }
        const submitButton = form.querySelector('button[type="submit"]');
        if (!cardTypes.length) {
          showToast('Pick at least one card type.', 'error');
          if (submitButton) setActionPending(submitButton, false);
          return;
        }
        const saved = await apiRequest('/api/review/preferences', { method: 'PUT', body: { cardTypes, weights, autoPick, speechRate: currentSpeechRate() } });
        const preferences = saved?.userPreferences;
        if (preferences) {
          reviewPreferences = {
            cardTypes: preferences.cardTypes,
            weights: preferences.weights || {},
            engineMode: preferences.engineMode || 'fixed',
            autoPick: preferences.autoPick !== false,
            speechRate: sanitizeSpeechRate(preferences.speechRate)
          };
        } else {
          reviewPreferences.autoPick = autoPick;
          reviewPreferences.speechRate = speechRate;
        }
        renderCardTypeSummary();
        showToast('Card type preferences saved.');
        // Release the Saving… state, flash confirmation on the button itself,
        // then close — the button must never spin forever.
        if (submitButton) {
          setActionPending(submitButton, false);
          submitButton.disabled = true;
          submitButton.textContent = '✓ Saved';
          window.setTimeout(() => { close(); }, 1000);
        } else {
          close();
        }
      }
    });
  }

  // Practice-only typed-answer helpers (never grade; grading stays with
  // the Again/Hard/Good buttons). Layers: display text equality, then
  // reading/kana equality, then the expected display is shown with a hint.
  function foldKana(value) {
    return String(value || '').replace(/[\u30A1-\u30F6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }
  function normForMatch(value) {
    return foldKana(String(value || '').trim().toLowerCase()).replace(/\s+/g, '');
  }
  function matchTypedAnswer(typed, item) {
    const raw = String(typed || '').trim();
    if (!raw) return { empty: true };
    const want = String(item.display || '').trim();
    if (raw === want) return { matched: true, layer: 'display' };
    const wantReading = String(item.reading || '').trim();
    if (wantReading && normForMatch(raw) === normForMatch(wantReading)) return { matched: true, layer: 'reading' };
    if (want && normForMatch(raw) === normForMatch(want)) return { matched: true, layer: 'reading' };
    return { matched: false };
  }
  function hintForItem(item) {
    const want = String(item.display || '');
    const first = want.slice(0, 1);
    return first ? `Starts with \u201C${first}\u201D \u00B7 ${want.length} characters` : `${want.length} characters`;
  }

  // Weight factor for rule slots: default 50 gives x1, ratios stay relative.
  function weightFactor(type) {
    const raw = Number(reviewPreferences.weights?.[type] ?? 50);
    const safe = Number.isFinite(raw) ? raw : 50;
    return Math.max(1, Math.round(safe / 50));
  }
  // Frozen rotation used when automatic choice is off and as the final
  // fallback inside automatic choice. Position % expanded pool.
  function legacyRotationPick(item, index) {
    const supported = ENTITY_SUPPORTED_CARD_TYPES[item.entityType] || ['recognition'];
    const enabled = reviewPreferences.cardTypes.filter((type) => supported.includes(type));
    if (!enabled.length) return 'recognition';
    const weights = reviewPreferences.weights || {};
    const pool = [];
    for (const type of enabled) {
      const slots = Math.max(1, Math.round(Number(weights[type] ?? 50) / 10));
      for (let slotIndex = 0; slotIndex < slots; slotIndex += 1) pool.push(type);
    }
    return pool[index % pool.length] || enabled[0];
  }
  function withAntiRepeat(key, candidate, enabled) {
    const prev = lastPickedByKey.get(key);
    if (prev !== candidate || enabled.length < 2) {
      lastPickedByKey.set(key, candidate);
      return candidate;
    }
    const alt = enabled.find((entry) => entry !== candidate) || candidate;
    lastPickedByKey.set(key, alt);
    return alt;
  }
  // Automatic presentation choice. Deterministic for the same queue, index,
  // and preferences. Falls back to recognition when nothing enabled fits.
  // Rules in order: needing-work recall, fresh recognition, grammar cloze,
  // then weighted rotation. Rule slots are 3 x weight factor.
  function pickCardType(item, index = currentIndex) {
    const supported = ENTITY_SUPPORTED_CARD_TYPES[item.entityType] || ['recognition'];
    const enabled = reviewPreferences.cardTypes.filter((type) => supported.includes(type));
    if (!enabled.length) return 'recognition';
    if (reviewPreferences.autoPick === false) {
      return legacyRotationPick(item, index);
    }
    const key = itemKey(item);
    const needingWork = item.lastResult === 'Again' || item.lastResult === 'Hard' || item.evidenceStrength === 'weak';
    if (needingWork) {
      if (item.entityType === 'vocabulary' && enabled.includes('recall') && enabled.includes('audio')) {
        const parity = (index % 2 === 0) ? 'recall' : 'audio';
        const slots = 3 * weightFactor(parity);
        const pool = Array(slots).fill(parity);
        const chosen = pool[index % pool.length] || parity;
        return withAntiRepeat(key, chosen, enabled);
      }
      if (enabled.includes('recall')) {
        const slots = 3 * weightFactor('recall');
        const pool = Array(slots).fill('recall');
        const chosen = pool[index % pool.length] || 'recall';
        return withAntiRepeat(key, chosen, enabled);
      }
    }
    const isFresh = item.lastResult == null;
    if (isFresh && enabled.includes('recognition')) {
      const slots = 3 * weightFactor('recognition');
      const pool = Array(slots).fill('recognition');
      const chosen = pool[index % pool.length] || 'recognition';
      return withAntiRepeat(key, chosen, enabled);
    }
    if (item.entityType === 'grammar' && enabled.includes('cloze')) {
      const slots = 3 * weightFactor('cloze');
      const pool = Array(slots).fill('cloze');
      const chosen = pool[index % pool.length] || 'cloze';
      return withAntiRepeat(key, chosen, enabled);
    }
    const rotated = legacyRotationPick(item, index);
    return withAntiRepeat(key, rotated, enabled);
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
      try { warmCachedVoices(); } catch { /* warm-up is best-effort */ }
      const utterance = new window.SpeechSynthesisUtterance(text);
      activeUtterance = utterance;
      utterance.lang = 'ja-JP';
      utterance.rate = currentSpeechRate();
      const clearIfCurrent = () => { if (activeUtterance === utterance) activeUtterance = null; };
      try {
        utterance.onend = () => { clearIfCurrent(); };
      } catch { /* handler attach is best-effort */ }
      try {
        utterance.onerror = () => {
          clearIfCurrent();
          try {
            const voices = readVoices(synthesis);
            if (voices.length && !hasJapaneseVoice(voices)) {
              showToast(japaneseVoiceGuidance(), 'error');
            } else {
              showToast('Audio playback is unavailable on this device right now.', 'error');
            }
          } catch {
            showToast('Audio playback is unavailable on this device right now.', 'error');
          }
        };
      } catch { /* handler attach is best-effort */ }
      const beginSpeaking = (voicesConfirmed) => {
        if (activeUtterance !== utterance) return;
        let picked = null;
        try {
          const voices = readVoices(synthesis);
          picked = findJapaneseVoice(voices);
          if (picked) utterance.voice = picked;
        } catch { /* voice picking is best-effort; lang still guides the platform */ }
        if (!picked && voicesConfirmed) {
          try {
            const check = readVoices(synthesis);
            if (check.length && !hasJapaneseVoice(check)) {
              showToast(japaneseVoiceGuidance(), 'error');
            }
          } catch { /* guidance is best-effort */ }
        }
        try { synthesis.cancel(); } catch { /* stop is best-effort */ }
        try {
          if (pendingSpeakTimer !== null && pendingSpeakTimer !== undefined) {
            try {
              if (typeof window !== 'undefined' && window && typeof window.clearTimeout === 'function') window.clearTimeout(pendingSpeakTimer);
              else if (typeof clearTimeout === 'function') clearTimeout(pendingSpeakTimer);
            } catch { /* timer clear is best-effort */ }
            pendingSpeakTimer = null;
          }
        } catch { /* timer clear is best-effort */ }
        const schedule = (typeof window !== 'undefined' && window && typeof window.setTimeout === 'function')
          ? window.setTimeout.bind(window)
          : setTimeout;
        pendingSpeakTimer = schedule(() => {
          pendingSpeakTimer = null;
          if (activeUtterance !== utterance) return;
          try {
            synthesis.speak(utterance);
          } catch {
            clearIfCurrent();
            showToast('Audio playback is unavailable on this device right now.', 'error');
          }
        }, 80);
      };
      const cached = readVoices(synthesis);
      if (cached.length) {
        beginSpeaking(true);
        return;
      }
      // List not loaded yet: never declare absence on it. Wait briefly; an
      // empty list at timeout means "unknown", not "missing".
      waitForVoices(synthesis).then((voices) => {
        if (activeUtterance !== utterance) return;
        if (!voices.length) {
          showToast('Voice list has not loaded yet — try again in a moment.', 'error');
          clearIfCurrent();
          return;
        }
        beginSpeaking(true);
      });
    } catch {
      showToast('Audio playback is unavailable on this device right now.', 'error');
    }
  }

  // Tri-state probe for audio cards: 'ready' when a Japanese voice is
  // listed, 'missing' when speech is absent or a loaded list has none,
  // 'unknown' while the list has not loaded (never judged as missing).
  function audioVoiceStatus() {
    try {
      if (typeof window === 'undefined' || !window.speechSynthesis) return 'missing';
    } catch { return 'missing'; }
    try { warmCachedVoices(); } catch { /* warm-up is best-effort */ }
    let voices = [];
    try {
      voices = readVoicesLive(window.speechSynthesis);
    } catch { return 'unknown'; }
    if (!Array.isArray(voices) || voices.length === 0) return 'unknown';
    return hasJapaneseVoice(voices) ? 'ready' : 'missing';
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
        element('ul', { className: 'mt-4 grid gap-2', attrs: { role: 'list' } }, patterns.map((pattern) => {
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
              meaning: item.meaning,
              ...(item.evidenceStrength ? { evidenceStrength: item.evidenceStrength } : {}),
              ...(item.lastResult ? { lastResult: item.lastResult } : {}),
              ...(Array.isArray(item.sources) ? { sources: item.sources.slice(0, 5) } : {})
            });
          }
        });
      });
      if (!picked.length) return;
      withPendingAction(startReviewBtn, async () => {
        const session = await apiRequest('/api/review/sessions', {
          method: 'POST',
          body: {
            sourceFrom: lastSearch.from,
            sourceTo: lastSearch.to,
            items: picked.map(({ entityType, entityId }) => ({ entityType, entityId }))
          }
        });
        sessionId = session.id;
        queue = applySessionContext(picked, session);
        currentIndex = 0;
        revealed = false;
        graded = [];
        lastPickedByKey.clear();
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
      const tag = document.activeElement?.tagName;
      if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (stage !== 'REVIEWING') return;
      // V5.7: 1-4 picks a recognition option while the answer is hidden;
      // 1-3 grades once revealed. Mutually exclusive by the revealed flag.
      if (!revealed && ['1', '2', '3', '4'].includes(event.key) && recognitionOptionButtons.length) {
        const target = recognitionOptionButtons[Number(event.key) - 1];
        if (target && !target.disabled) {
          event.preventDefault();
          target.click();
        }
        return;
      }
      if (!['1', '2', '3'].includes(event.key)) return;
      if (!revealed) return;
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
    recognitionOptionButtons = [];
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
      const picked = pickCardType(item, currentIndex);
      if (picked === 'recall' && !item.meaning) return 'recognition';
      return picked;
    })();
    const typePill = element('span', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: CARD_TYPE_LABEL[cardType] || cardType, attrs: { 'aria-label': `Card type ${CARD_TYPE_LABEL[cardType] || cardType}` } });
    const frontText = cardType === 'recall' ? item.meaning : cardType === 'audio' ? 'Listen and recall' : item.display;
    const title = element('h2', { className: 'mt-2 break-words text-3xl font-semibold tracking-tight text-ink', text: frontText, attrs: { tabindex: '-1' } });
    // Speaker lives beside the heading so the front/answer toggle never removes it,
    // with the discrete speed selector right after it. All selectors stay in
    // sync; changing any of them applies instantly and persists in background.
    // On audio cards the button label never names the word: announcing it
    // would hand out the answer the listening exercise is asking for.
    const speakerLabel = cardType === 'audio' ? 'Play audio' : `Play ${item.display}`;
    const speakerButton = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': speakerLabel } }, [icon('volume', { size: 20 })]);
    // Prefer the recorded kana reading: device TTS guesses kanji readings
    // (often on'yomi or outright wrong for jukujikun like 大人), while kana
    // is pronounced exactly as saved. Falls back to the display text.
    speakerButton.addEventListener('click', () => { speakDisplay(item.reading || item.display); });
    const speedSelect = element('select', {
      className: 'rounded-lg border border-stone bg-paper px-1.5 py-1 text-xs font-semibold text-muted',
      attrs: { 'aria-label': 'Voice speed', 'data-speech-rate': '' }
    }, SPEECH_RATES.map((rate) => element('option', {
      text: `${rate}×`,
      attrs: { value: String(rate), ...(rate === currentSpeechRate() ? { selected: '' } : {}) }
    })));
    speedSelect.addEventListener('change', () => { applySpeechRate(speedSelect); });
    speechRateSelects.push(speedSelect);
    const titleRow = element('div', { className: 'mt-2 flex items-center gap-2' }, [title, speakerButton, speedSelect]);
    // V5.6 context-rich review: collapsed "why" never disrupts recall speed.
    // Only true signals are shown — due date is implicit, lastResult and
    // provenanceLine come from the candidate payload, never fabricated.
    // Why = reason + honest history (with dates when the batch knows them).
    const context = item.context && typeof item.context === 'object' ? item.context : null;
    const whyLines = [];
    if (item.lastResult === 'Again' || item.lastResult === 'Hard') {
      const failedAgo = context?.lastFailedAt ? daysAgoText(context.lastFailedAt) : null;
      whyLines.push(`Last marked ${item.lastResult === 'Again' ? 'Again — worth another look' : 'Hard — recalled with difficulty'}${failedAgo ? ` (${failedAgo})` : ''}.`);
    } else if (Number(context?.againCount) > 0) {
      whyLines.push(`Marked Again ${context.againCount} time${context.againCount === 1 ? '' : 's'} before.`);
    }
    const provenance = provenanceLine(item);
    if (provenance) whyLines.push(`Seen in: ${provenance}.`);
    const whyDetails = whyLines.length ? element('details', { className: 'mt-3 rounded-xl border border-stone bg-paper/60 px-3 py-2' }, [
      element('summary', { className: 'cursor-pointer text-xs font-semibold text-muted', text: 'Why am I reviewing this?' }),
      element('p', { className: 'mt-1.5 text-xs leading-5 text-muted', text: whyLines.join(' ') })
    ]) : null;
    // V5.6 Completion Pass: real learning content, collapsed by default so
    // the recall hot path stays fast (and recall/audio fronts never leak the
    // answer — the learner opens this deliberately). History lives in Why
    // above; this block renders ONLY when there is actual content (an owned
    // example sentence or recorded encounters), so it can never merely
    // repeat Why.
    const contextLines = [];
    if (context?.example?.sentence) {
      contextLines.push(`You saw this in: ${context.example.sentence}`);
      if (context.example.translation) contextLines.push(`Translation: ${context.example.translation}`);
    }
    if (Number(context?.encounters?.count) > 0) {
      const seenAgo = context.encounters.lastAt ? daysAgoText(context.encounters.lastAt) : null;
      contextLines.push(`Seen ${context.encounters.count} time${context.encounters.count === 1 ? '' : 's'} in your words and writings${seenAgo ? ` — last ${seenAgo}` : ''}.`);
    }
    const contextDetails = contextLines.length ? element('details', { className: 'mt-2 rounded-xl border border-stone bg-paper/60 px-3 py-2' }, [
      element('summary', { className: 'cursor-pointer text-xs font-semibold text-muted', text: 'Context' }),
      ...contextLines.map((line) => element('p', { className: 'mt-1.5 break-words text-xs leading-5 text-muted', text: line }))
    ]) : null;
    const card = element('article', { className: 'surface review-card p-5 sm:p-8' }, [
      element('div', { className: 'flex items-start justify-between gap-3' }, [progress, counter]),
      track,
      typePill,
      titleRow,
      ...(whyDetails ? [whyDetails] : []),
      ...(contextDetails ? [contextDetails] : [])
    ]);

    const body = element('div', { className: 'mt-5 border-t border-stone pt-5' });
    const frontWrap = element('div', { className: 'grid gap-3' });
    const answerWrap = element('div', { className: 'grid gap-3' });
    answerWrap.hidden = true;
    body.append(frontWrap, answerWrap);
    card.appendChild(body);

    // Practice-only typed-answer state (grading stays with Again/Hard/Good).
    let checkState = null;
    // V5.7 recognition practice state: option picks feed the suggested
    // grade only. Grading itself stays self-assessed via the buttons below.
    let recognitionPicks = 0;
    let recognitionMistakes = 0;
    let recognitionResolved = false;
    let recognitionSuggested = null;
    let recognitionOptions = null;
    // Concealed (audio) cards lock Reveal until the heard word is typed —
    // but this is memory practice, not an exam. After MAX_CONCEALED_TRIES
    // failed tries the lock opens so nobody gets stuck without a voice
    // reading the words correctly (device TTS misreads happen).
    const MAX_CONCEALED_TRIES = 4;
    let concealedTries = 0;
    let clozeBlank = null;
    let clozeFilled = null;
    let filledLine = null;

    const frontResult = element('p', { className: 'text-sm leading-6 text-ink', attrs: { 'aria-live': 'polite' } });
    frontResult.hidden = true;
    const answerResult = element('p', { className: 'text-sm leading-6 text-ink', attrs: { 'aria-live': 'polite' } });
    answerResult.hidden = true;

    function showCheck(state) {
      checkState = state;
      if (!state) {
        frontResult.hidden = true;
        frontResult.textContent = '';
        answerResult.hidden = true;
        answerResult.textContent = '';
        return;
      }
      if (state.matched) {
        frontResult.hidden = false;
        frontResult.textContent = 'That matches! Reveal to review the details and grade yourself.';
        answerResult.hidden = false;
        answerResult.textContent = 'That matches! Grade yourself below.';
      } else {
        const want = String(item.display || '');
        const hint = hintForItem(item);
        frontResult.hidden = false;
        frontResult.textContent = `Not quite \u2014 answer: ${want} (${hint})`;
        answerResult.hidden = false;
        answerResult.textContent = `Your try: \u201C${state.typed}\u201D \u2014 answer: ${want} (${hint})`;
      }
    }

    function buildAnswerInput(options = {}) {
      const concealMismatch = Boolean(options && options.conceal);
      const onMatch = typeof options.onMatch === 'function' ? options.onMatch : null;
      const answerInput = element('input', {
        className: 'field-control',
        attrs: { type: 'text', 'aria-label': 'Type the answer', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }
      });
      const checkButton = element('button', { className: 'button-secondary min-h-10 px-4 py-2 text-sm', text: 'Check', attrs: { type: 'button' } });
      const confirmMatch = () => {
        showCheck({ matched: true, typed: String(answerInput.value || '').trim() });
        if (onMatch) onMatch();
      };
      const runCheck = () => {
        const typed = answerInput.value || '';
        if (!String(typed).trim()) {
          checkState = null;
          frontResult.hidden = false;
          frontResult.textContent = 'Type something first.';
          answerResult.hidden = false;
          answerResult.textContent = 'Type something first.';
          return;
        }
        const verdict = matchTypedAnswer(typed, item);
        if (verdict.empty) return;
        if (verdict.matched) {
          confirmMatch();
        } else if (concealMismatch) {
          // Listening exercise: never disclose the word here; the locked
          // Reveal stays shut until the heard word is typed — or until the
          // tries run out, so a misheard word can never trap the learner.
          concealedTries += 1;
          const triesLeft = MAX_CONCEALED_TRIES - concealedTries;
          frontResult.hidden = false;
          answerResult.hidden = false;
          if (triesLeft <= 0) {
            revealButton.removeAttribute('disabled');
            frontResult.textContent = 'Not quite — after 4 tries, reveal the answer and grade yourself honestly.';
            answerResult.textContent = 'Not quite — after 4 tries, reveal the answer and grade yourself honestly.';
          } else {
            frontResult.textContent = `Not quite — listen again (${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left before reveal).`;
            answerResult.textContent = `Not quite — listen again (${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left before reveal).`;
          }
        } else {
          showCheck({ matched: false, typed: String(typed).trim() });
        }
      };
      checkButton.addEventListener('click', runCheck);
      answerInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          checkButton.click();
        }
      });
      if (onMatch) {
        // Unlock as soon as the heard word is typed; Check stays for
        // explicit feedback and keyboard users.
        answerInput.addEventListener('input', () => {
          const verdict = matchTypedAnswer(answerInput.value || '', item);
          if (!verdict.empty && verdict.matched) confirmMatch();
        });
      }
      const row = element('div', { className: 'flex flex-col gap-2 sm:flex-row' }, [answerInput, checkButton]);
      return { answerInput, checkButton, row };
    }

    const revealButton = element('button', { className: 'button-primary', text: 'Reveal answer', attrs: { type: 'button' } });
    let answerBuilt = false;
    function buildAnswer() {
      if (answerBuilt) return;
      answerBuilt = true;
    if (cardType === 'cloze') {
      filledLine = element('p', { className: 'break-words text-base leading-8 text-ink', text: clozeFilled || String(item.display || ''), attrs: { lang: 'ja' } });
        answerWrap.appendChild(filledLine);
      }
      if (cardType !== 'recognition') {
        answerWrap.appendChild(element('p', { className: 'font-jp text-2xl font-semibold text-ink', text: item.display }));
      }
      if (item.reading) answerWrap.appendChild(element('p', { className: 'text-sm text-muted', text: item.reading }));
      if (item.meaning) answerWrap.appendChild(element('p', { className: 'mt-2 text-base leading-7 text-ink', text: item.meaning }));
      answerWrap.appendChild(answerResult);
      // V5.7 suggested grade: named pill + labeled button, every grade
      // still clickable (override wins) and grading posts exactly once.
      if (recognitionSuggested) {
        const tryNote = recognitionResolved
          ? `picked on try ${recognitionPicks}`
          : `after ${recognitionPicks} ${recognitionPicks === 1 ? 'try' : 'tries'}`;
        answerWrap.appendChild(element('p', { className: 'mt-5 text-sm leading-6 text-muted', text: `Suggested: ${recognitionSuggested} — ${tryNote}. How did recall feel?` }));
      } else {
        answerWrap.appendChild(element('p', { className: 'mt-5 text-sm font-semibold text-ink', text: 'How did recall feel?' }));
      }
      const grades = element('div', { className: 'mt-3 grid gap-2 sm:grid-cols-3' });
      GRADES.forEach(({ result, hint }, gradeIndex) => {
        const button = element('button', { className: 'button-secondary flex-col gap-1 px-4 py-3 text-center', attrs: { type: 'button', 'aria-keyshortcuts': String(gradeIndex + 1), ...(result === recognitionSuggested ? { 'aria-label': `${result} (suggested)` } : {}) } }, [
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
      answerWrap.appendChild(grades);
      answerWrap.appendChild(element('p', { className: 'mt-3 text-xs text-muted', text: 'Shortcuts: 1 Again · 2 Hard · 3 Good' }));
    }
    revealButton.addEventListener('click', () => {
      revealed = true;
      // V5.7: multiple-choice performance becomes a suggested grade —
      // 0-1 mistakes Good, 2 Hard, 3+ Again — only when the learner actually
      // played the options. Direct reveals keep plain self-grading.
      if (cardType === 'recognition' && recognitionPicks > 0) {
        recognitionSuggested = suggestedGradeForMistakes(recognitionMistakes);
      }
      buildAnswer();
      frontWrap.hidden = true;
      answerWrap.hidden = false;
      if (cardType === 'cloze' && clozeFilled && filledLine) {
        filledLine.textContent = clozeFilled;
      }
    });

    // Kanji cards (recognition and recall) can open the handwriting
    // overlay: order-only practice, grading stays with the buttons.
    const singleKanji = item.entityType === 'kanji' && typeof item.display === 'string' && /^\p{Script=Han}$/u.test(item.display);
    const appendStrokePractice = () => {
      if (!singleKanji) return;
      const practiceButton = element('button', { className: 'button-secondary min-h-10 px-4 py-2 text-sm', text: 'Practice strokes', attrs: { type: 'button' } });
      practiceButton.addEventListener('click', () => {
        const holder = element('div', { className: 'grid gap-3' });
        const closePractice = openDialog({
          title: `Practice strokes: ${item.display}`,
          description: 'Trace in stroke order. Practice only — nothing is graded.',
          content: [holder],
          submitLabel: 'Done',
          onSubmit: async (form, closeDialog) => { closeDialog(); }
        });
        mountKanjiWriting(holder, { character: item.display, onDone: closePractice });
      });
      frontWrap.append(practiceButton);
    };

    if (cardType === 'cloze') {
      const sentenceLine = element('p', { className: 'mb-3 break-words text-base leading-8 text-ink', text: 'Loading sentence…', attrs: { lang: 'ja' } });
      frontWrap.appendChild(sentenceLine);
      const built = buildAnswerInput();
      frontWrap.append(built.row, frontResult, revealButton);
      fetchClozeSentence(item).then((sentence) => {
        if (!sentence) {
          sentenceLine.textContent = String(item.display || '');
          clozeBlank = String(item.display || '');
          clozeFilled = String(item.display || '');
          if (filledLine) filledLine.textContent = clozeFilled;
          return;
        }
        sentenceLine.textContent = sentence;
        clozeBlank = sentence;
        const want = String(item.display || '');
        clozeFilled = sentence.includes('＿＿') ? sentence.replaceAll('＿＿', want) : sentence;
        if (filledLine) filledLine.textContent = clozeFilled;
      });
    } else if (cardType === 'recall') {
      const built = buildAnswerInput();
      frontWrap.append(built.row, frontResult);
      appendStrokePractice();
      frontWrap.append(revealButton);
    } else if (cardType === 'audio') {
      // No Japanese voice on the device: the listening task is impossible,
      // so the card is presented as plain recognition instead, with a way
      // back once a voice shows up.
      const renderAudioGated = () => {
        showCheck(null);
        title.textContent = 'Listen and recall';
        revealButton.setAttribute('disabled', '');
        const built = buildAnswerInput({
          conceal: true,
          onMatch: () => { revealButton.removeAttribute('disabled'); }
        });
        frontWrap.replaceChildren();
        frontWrap.append(
          element('p', { className: 'text-sm leading-6 text-muted', text: 'Tap the speaker to hear it, then type what you hear.' }),
          built.row,
          frontResult,
          revealButton
        );
      };
      const confirmVoicesInBackground = () => {
        // The voice list may still be loading: confirm in the background
        // and only step down a card that is still on its front.
        const myIndex = currentIndex;
        const myItem = item;
        try {
          waitForVoices(window.speechSynthesis).then((voices) => {
            if (revealed || currentIndex !== myIndex || queue[myIndex] !== myItem) return;
            if (Array.isArray(voices) && voices.length && !hasJapaneseVoice(voices)) {
              renderAudioAsRecognition();
            }
          });
        } catch { /* stepping down is best-effort */ }
      };
      const renderAudioAsRecognition = () => {
        title.textContent = String(item.display || '');
        revealButton.removeAttribute('disabled');
        const recheckButton = element('button', { className: 'button-secondary min-h-10 px-4 py-2 text-sm', text: 'Check for audio again', attrs: { type: 'button' } });
        recheckButton.addEventListener('click', () => {
          const status = audioVoiceStatus();
          if (status === 'missing') {
            showToast('Still no Japanese voice — install one in your system settings, then check again.', 'error');
            return;
          }
          // A voice turned up (or the list is still loading): back to the
          // listening exercise, confirming a genuinely empty list later.
          renderAudioGated();
          if (status === 'unknown') confirmVoicesInBackground();
        });
        frontWrap.replaceChildren();
        frontWrap.append(
          element('p', { className: 'text-sm font-semibold leading-6 text-ink', text: 'No Japanese voice on this device — this card is shown as recognition so you can still review it.' }),
          recheckButton,
          revealButton
        );
      };
      if (audioVoiceStatus() === 'missing') {
        renderAudioAsRecognition();
      } else {
        // Gated listen-and-recall: Reveal stays locked until the heard
        // word is typed (practice only; grading stays with the buttons).
        renderAudioGated();
        if (audioVoiceStatus() === 'unknown') confirmVoicesInBackground();
      }
    } else {
      appendStrokePractice();
      // V5.7 multiple-choice recognition: deterministic options from the
      // in-memory queue (zero queries). Fewer than 3 usable distractors →
      // the card keeps its plain reveal flow, never padded with nonsense.
      recognitionOptions = buildRecognitionOptions(item, queue, `${sessionId}:${item.entityType}:${item.entityId}:${currentIndex}`);
      if (recognitionOptions) {
        frontWrap.appendChild(element('p', { className: 'mt-4 text-sm font-semibold leading-6 text-ink', text: `Which meaning fits “${item.display}”? Pick one.` }));
        const optionList = element('div', { className: 'mt-2 grid gap-2', attrs: { role: 'group', 'aria-label': 'Meaning options' } });
        recognitionOptions.options.forEach((option, optionIndex) => {
          const optionButton = element('button', {
            className: 'button-secondary min-h-11 justify-start break-words px-4 py-2.5 text-left text-sm',
            text: option.meaning,
            attrs: { type: 'button', 'aria-keyshortcuts': String(optionIndex + 1) }
          });
          optionButton.addEventListener('click', () => pickRecognitionOption(optionIndex));
          recognitionOptionButtons.push(optionButton);
          optionList.appendChild(optionButton);
        });
        frontWrap.appendChild(optionList);
        frontWrap.appendChild(frontResult);
      }
      frontWrap.appendChild(revealButton);
    }

    function pickRecognitionOption(optionIndex) {
      if (revealed || recognitionResolved || !recognitionOptions) return;
      const option = recognitionOptions.options[optionIndex];
      const button = recognitionOptionButtons[optionIndex];
      if (!option || !button || button.disabled) return;
      recognitionPicks += 1;
      frontResult.hidden = false;
      answerResult.hidden = false;
      if (option.answer) {
        recognitionResolved = true;
        recognitionOptionButtons.forEach((entry) => { entry.disabled = true; });
        button.setAttribute('aria-pressed', 'true');
        frontResult.textContent = `That's right — “${item.display}” means “${item.meaning}.”`;
        answerResult.textContent = `That's right — “${item.display}” means “${item.meaning}.”`;
      } else {
        recognitionMistakes += 1;
        button.disabled = true;
        button.setAttribute('aria-pressed', 'false');
        frontResult.textContent = `Not quite — that means “${option.meaning}.” Try again.`;
        answerResult.textContent = `Not quite — that means “${option.meaning}.” Try again.`;
      }
    }

    reviewingBlock.appendChild(card);
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
        element('a', { className: 'button-secondary', text: 'Go to Dashboard', attrs: { href: '#dashboard' } }),
        element('a', { className: 'button-secondary', text: 'Log study session', attrs: { href: '#sessions?new=1' } })
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
          const retryQueue = failed.map(({ result, ...rest }) => rest);
          const session = await apiRequest('/api/review/sessions', {
            method: 'POST',
            body: {
              sourceFrom: lastSearch.from,
              sourceTo: lastSearch.to,
              items: retryQueue.map(({ entityType, entityId }) => ({ entityType, entityId }))
            }
          });
          sessionId = session.id;
          queue = retryQueue;
          currentIndex = 0;
          revealed = false;
          graded = [];
          lastPickedByKey.clear();
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
  if (!tryResumeImmersionQueue()) tryResumeRetake();

  // V5.6 Completion Pass: deep-link resume for genuinely unfinished
  // sessions (Continue Studying → #review?retake=<id>). Same semantics as
  // the history Retake button — persisted queue minus graded items on the
  // SAME open session — without needing the history modal first.
  async function tryResumeRetake() {
    let retakeId = null;
    try {
      const hash = typeof window !== 'undefined' && window.location ? window.location.hash || '' : '';
      const queryIndex = hash.indexOf('?');
      if (queryIndex === -1) return;
      retakeId = new URLSearchParams(hash.slice(queryIndex + 1)).get('retake');
      if (!retakeId || !/^[1-9]\d*$/.test(retakeId)) return;
    } catch { return; }
    const id = Number(retakeId);
    let data = null;
    try {
      data = await apiRequest(`/api/review/sessions/${id}/items`);
    } catch (error) {
      showToast(error?.message || 'Could not resume the session.', 'error');
      return;
    }
    const stored = Array.isArray(data?.items) ? data.items : [];
    const remaining = stored.filter((entry) => !entry.lastResult);
    if (!remaining.length) {
      showToast('Nothing left to resume in this session.', 'info');
      return;
    }
    sessionId = id;
    queue = remaining.map(({ lastResult, position, ...rest }) => rest);
    currentIndex = 0;
    revealed = false;
    graded = stored
      .filter((entry) => entry.lastResult === 'Again' || entry.lastResult === 'Hard')
      .map(({ lastResult, position, ...rest }) => ({ ...rest, result: lastResult }));
    lastPickedByKey.clear();
    activeReview = { sessionId, selected: queue };
    setStage('REVIEWING');
    renderCard();
    showToast(`Resumed with ${remaining.length} remaining item${remaining.length === 1 ? '' : 's'}.`);
  }
}
