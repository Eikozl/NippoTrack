// VAF-B — Vocabulary Auto-Fill shared client module.
//
// PRESENTATION ONLY: consumes the backend autofill contract exactly, never
// redefines it. Prefill values always come from backend fieldHints
// (authoritative). composeSenseMeaningMirror is used ONLY for explicit user
// sense picks from backend-supplied full gloss arrays.
//
// Provenance labels are verbatim by design ("JMdict" | "Context" | "Parser"
// | "User") — proper nouns, never passed through i18n translation.
//
// Backend contract (parallel implementation — consumed exactly):
//   POST /api/vocabulary/autofill {word, includeOwnership?} -> 200
//     {word, dictionaryMatch, interpretation, reason|null, retryable,
//      pin|null, item|null, fieldHints:{reading, meaning}, ownership|null,
//      hint|null}
//   POST /api/vocabulary/autofill/entry {sourceId,entryId,senseCursor?}
//     -> 200 {status:'ok',pin,entry,senses,nextCursor,truncated,reading?}
//      | 200 {status:'unavailable',reason,snapshot|transient,retryable,...}
//   Entry failures branch on reason: 'snapshot-unavailable' needs a NEW word
//   lookup (Refresh); retryable transient reasons repeat the same expansion
//   (Retry). Overflow reading (when present) is consumed exactly — prefill,
//   explicit choices, or blank — and never overwrites a user-edited reading.

import { apiRequest } from './api.js';
import { element } from './ui.js';

export const VAF_DEBOUNCE_MS = 300;
export const VAF_MEANING_MAX_LENGTH = 255;
export const VAF_EXAMPLE_PREFILL_MAX_LENGTH = 200;
export const VAF_EXAMPLE_SERVER_MAX_LENGTH = 2000;

// Verbatim provenance labels. Never localize.
export const VAF_PROVENANCE = {
  JMDICT: 'JMdict',
  CONTEXT: 'Context',
  PARSER: 'Parser',
  USER: 'User'
};

const TERMINAL_MARKS = new Set(['。', '？', '！', '?', '!']);

export function provenanceLabel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  if (value === 'JMdict' || value === 'Context' || value === 'Parser' || value === 'User') return value;
  const lower = value.toLowerCase();
  if (lower === 'jmdict' || lower === 'dictionary' || lower === 'dict') return 'JMdict';
  if (lower === 'context') return 'Context';
  if (lower === 'parser' || lower === 'lexical' || lower === 'kuromoji') return 'Parser';
  if (lower === 'user') return 'User';
  return null;
}

// Client mirror of the meaning composer: same-sense only, " · " join, greedy
// whole-gloss fit within max. Zero-fit yields a blank (never a clipped gloss).
export function composeSenseMeaningMirror(glosses, max = VAF_MEANING_MAX_LENGTH) {
  const limit = Number.isInteger(max) && max > 0 ? max : VAF_MEANING_MAX_LENGTH;
  const list = Array.isArray(glosses) ? glosses.filter((g) => typeof g === 'string' && g.length > 0) : [];
  if (!list.length) return { value: '', glossesUsed: [], glossCount: 0, remainingCount: 0, fits: true };
  const used = [];
  let value = '';
  for (const gloss of list) {
    const candidate = used.length ? `${value} · ${gloss}` : gloss;
    if ([...candidate].length <= limit) {
      value = candidate;
      used.push(gloss);
    } else {
      break;
    }
  }
  if (!used.length) return { value: '', glossesUsed: [], glossCount: 0, remainingCount: list.length, fits: false };
  return { value, glossesUsed: used, glossCount: used.length, remainingCount: list.length - used.length, fits: used.length === list.length };
}

export function glossCountNote({ glossCount = 0, remainingCount = 0 } = {}) {
  const used = Number(glossCount) || 0;
  const remaining = Number(remainingCount) || 0;
  if (!used && !remaining) return null;
  const base = used ? `${used} gloss${used === 1 ? '' : 'es'} used` : null;
  const more = remaining > 0 ? `+${remaining} more` : null;
  return [base, more].filter(Boolean).join(' · ') || null;
}

// Per-dialog state: untouched | system-prefilled | system-suggested | user-edited.
export function createAutofillState(identityWord = null) {
  const word = typeof identityWord === 'string' && identityWord.trim() ? identityWord.trim() : null;
  return {
    fieldStates: { reading: 'untouched', meaning: 'untouched' },
    provenance: { reading: null, meaning: null },
    identityWord: word,
    identityKey: word,
    seq: 0,
    pin: null,
    stale: false
  };
}

export function markUserEdited(state, fieldName) {
  if (!state || (fieldName !== 'reading' && fieldName !== 'meaning')) return state;
  state.fieldStates[fieldName] = 'user-edited';
  state.provenance[fieldName] = VAF_PROVENANCE.USER;
  return state;
}

export function markSystemPrefilled(state, fieldName, provenance) {
  if (!state || (fieldName !== 'reading' && fieldName !== 'meaning')) return state;
  state.fieldStates[fieldName] = 'system-prefilled';
  state.provenance[fieldName] = provenanceLabel(provenance) || VAF_PROVENANCE.JMDICT;
  return state;
}

export function markSystemSuggested(state, fieldName, provenance) {
  if (!state || (fieldName !== 'reading' && fieldName !== 'meaning')) return state;
  state.fieldStates[fieldName] = 'system-suggested';
  state.provenance[fieldName] = provenanceLabel(provenance) || VAF_PROVENANCE.JMDICT;
  return state;
}

export function shouldClearSystemField(fieldState) {
  return fieldState === 'system-prefilled' || fieldState === 'system-suggested';
}

// Word-change plan: clears untouched system-prefilled/suggested values bound
// to the old identity. User-edited fields are never cleared. Clearing the
// word clears system values; notes/status/JLPT/user example fields are owned
// elsewhere and therefore preserved by construction (this module only touches
// reading + meaning).
export function planWordChange({ state, newWord }) {
  const fallback = { clearReading: false, clearMeaning: false };
  if (!state) return fallback;
  const trimmed = typeof newWord === 'string' ? newWord.trim() : '';
  if (!trimmed) {
    return {
      clearReading: shouldClearSystemField(state.fieldStates.reading),
      clearMeaning: shouldClearSystemField(state.fieldStates.meaning)
    };
  }
  if (state.identityWord && trimmed === state.identityWord) return fallback;
  if (!state.identityWord && trimmed) return fallback;
  return {
    clearReading: shouldClearSystemField(state.fieldStates.reading),
    clearMeaning: shouldClearSystemField(state.fieldStates.meaning)
  };
}

export function shouldDiscardResponse(requestSeq, currentSeq) {
  return requestSeq !== currentSeq;
}

export function isStaleAutofillResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.reason === 'snapshot-unavailable') return true;
  if (result.status === 'unavailable' && result.reason === 'snapshot-unavailable') return true;
  return false;
}

// Backend match/interpretation statuses are NESTED objects
// (dictionaryMatch.status, interpretation.status) — never bare strings.
// Missing or malformed shapes degrade to null (manual entry) and never crash.
export function autofillMatchStatuses(result) {
  if (!result || typeof result !== 'object') return { dictionaryMatch: null, interpretation: null };
  const dm = result.dictionaryMatch;
  const interp = result.interpretation;
  return {
    dictionaryMatch: dm && typeof dm === 'object' && typeof dm.status === 'string' ? dm.status : null,
    interpretation: interp && typeof interp === 'object' && typeof interp.status === 'string' ? interp.status : null
  };
}

// Stale-snapshot notice: the pinned dictionary data changed, so only a NEW
// word lookup helps (never a same-pin retry). User-entered values are kept.
export const VAF_STALE_MESSAGE = 'Dictionary data changed since this lookup. Your entries are kept — refresh the lookup to continue.';

// Ownership is advisory only — never blocking.
export function ownershipBannerModel(ownership) {
  if (!ownership || typeof ownership !== 'object') return { kind: null, text: null };
  if (ownership.state === 'existing') {
    const matches = Array.isArray(ownership.matches) ? ownership.matches : [];
    return {
      kind: 'existing',
      text: matches.length
        ? `Already in Vocabulary (${matches.length} match${matches.length === 1 ? '' : 'es'}) — saving may be rejected as a duplicate.`
        : 'Already in Vocabulary — saving may be rejected as a duplicate.'
    };
  }
  if (ownership.state === 'possible-match') {
    const words = (Array.isArray(ownership.matches) ? ownership.matches : [])
      .filter((m) => m && typeof m.word === 'string' && m.word.trim())
      .map((m) => m.word.trim());
    return {
      kind: 'possible-match',
      text: words.length
        ? `Possible match: ${words.slice(0, 3).join('、')} — verify the meaning before adding.`
        : 'Possible match in Vocabulary — verify the meaning before adding.'
    };
  }
  if (ownership.state === 'unavailable') {
    return { kind: 'unavailable', text: 'Ownership unknown — Vocabulary collection matching is unavailable.' };
  }
  return { kind: null, text: null };
}

export function normalizeReadingHint(hint) {
  if (!hint || typeof hint !== 'object') return { action: 'blank', value: '', choices: [], provenance: null };
  const action = hint.action === 'prefill' || hint.action === 'choose' ? hint.action : 'blank';
  const value = typeof hint.value === 'string' ? hint.value : '';
  // Choices are consumed exactly as the backend supplies them: plain strings
  // (lookup hints) or {reading, provenance} objects (entry overflow). Only
  // the backend-provided reading text is used — never reconstructed from
  // entry forms, kana lists, or kanji data client-side.
  const rawChoices = Array.isArray(hint.choices) ? hint.choices : [];
  const choices = [];
  for (const choice of rawChoices) {
    if (typeof choice === 'string' && choice) choices.push(choice);
    else if (choice && typeof choice === 'object' && typeof choice.reading === 'string' && choice.reading) choices.push(choice.reading);
  }
  return { action, value, choices, provenance: provenanceLabel(hint.provenance) || (action === 'blank' ? null : VAF_PROVENANCE.JMDICT) };
}

export function normalizeMeaningHint(hint) {
  if (!hint || typeof hint !== 'object') {
    return { action: 'blank', value: '', glossesUsed: [], glossCount: 0, remainingCount: 0, entryId: null, senseId: null, provenance: null, senseChoices: [], entryChoices: [] };
  }
  const allowed = new Set(['prefill', 'choose', 'choose-entry-then-sense', 'blank']);
  const action = allowed.has(hint.action) ? hint.action : 'blank';
  return {
    action,
    value: typeof hint.value === 'string' ? hint.value : '',
    glossesUsed: Array.isArray(hint.glossesUsed) ? hint.glossesUsed : [],
    glossCount: Number.isInteger(hint.glossCount) ? hint.glossCount : 0,
    remainingCount: Number.isInteger(hint.remainingCount) ? hint.remainingCount : 0,
    entryId: hint.entryId ?? null,
    senseId: hint.senseId ?? null,
    provenance: provenanceLabel(hint.provenance) || (action === 'blank' ? null : VAF_PROVENANCE.JMDICT),
    senseChoices: Array.isArray(hint.senseChoices) ? hint.senseChoices : [],
    entryChoices: Array.isArray(hint.entryChoices) ? hint.entryChoices : []
  };
}

// Sense rows: full composed preview per sense via the mirror composer.
export function sensePickRows(senseChoices) {
  if (!Array.isArray(senseChoices)) return [];
  return senseChoices.map((choice) => {
    if (!choice || typeof choice !== 'object') return null;
    const glosses = Array.isArray(choice.glosses) ? choice.glosses.filter((g) => typeof g === 'string' && g) : [];
    const pos = Array.isArray(choice.pos) ? choice.pos.filter((p) => typeof p === 'string' && p) : [];
    const composed = composeSenseMeaningMirror(glosses, VAF_MEANING_MAX_LENGTH);
    return {
      entryId: choice.entryId ?? null,
      senseId: choice.senseId ?? null,
      glosses,
      pos,
      composed,
      label: composed.value || glosses[0] || 'Untranslated sense'
    };
  }).filter(Boolean);
}

// Entry rows: defensive across backend shapes (kanji/kana, written/kana,
// headword, glossPreview/gloss/preview/glosses/senses/meaning).
export function entryPickRows(entryChoices) {
  if (!Array.isArray(entryChoices)) return [];
  return entryChoices.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const entryId = entry.entryId ?? entry.id ?? null;
    const kanji = Array.isArray(entry.kanji)
      ? entry.kanji.filter((v) => typeof v === 'string' && v)
      : (typeof entry.written === 'string' && entry.written ? [entry.written] : []);
    const kana = Array.isArray(entry.kana)
      ? entry.kana.filter((v) => typeof v === 'string' && v)
      : (typeof entry.reading === 'string' && entry.reading ? [entry.reading] : []);
    const headword = kanji[0] || kana[0] || entry.headword || entry.word || 'Dictionary entry';
    const kanaLine = kana[0] && kana[0] !== headword ? kana[0] : null;
    let glossPreview = '';
    if (typeof entry.glossPreview === 'string' && entry.glossPreview) glossPreview = entry.glossPreview;
    else if (typeof entry.gloss === 'string' && entry.gloss) glossPreview = entry.gloss;
    else if (typeof entry.preview === 'string' && entry.preview) glossPreview = entry.preview;
    else if (Array.isArray(entry.glosses) && entry.glosses.length) glossPreview = composeSenseMeaningMirror(entry.glosses).value || String(entry.glosses[0] || '');
    else if (Array.isArray(entry.senses) && entry.senses.length) {
      const first = entry.senses[0];
      const g = Array.isArray(first?.glosses) ? first.glosses : [];
      glossPreview = composeSenseMeaningMirror(g).value || '';
    } else if (typeof entry.meaning === 'string') glossPreview = entry.meaning;
    const pos = Array.isArray(entry.pos) ? entry.pos : (Array.isArray(entry.posSummary) ? entry.posSummary : []);
    return { entryId, headword, kanaLine, kanji, kana, glossPreview, pos: pos.filter((p) => typeof p === 'string') };
  }).filter(Boolean);
}

export function countTerminalMarks(text) {
  if (typeof text !== 'string' || !text) return 0;
  let count = 0;
  for (const ch of text) {
    if (TERMINAL_MARKS.has(ch)) count += 1;
  }
  return count;
}

// Example-sentence gate (Analyzer only — standalone never touches examples).
// Prefill ONLY when trimmed source <=200 chars, <=1 terminal mark, and the
// observed surface is present. Otherwise offer an explicit action; sources
// over the 2000-char server max disable the action with an explanation.
export function evaluateExampleOffer({ sourceText, observedSurface } = {}) {
  const trimmed = typeof sourceText === 'string' ? sourceText.trim() : '';
  const observed = typeof observedSurface === 'string' ? observedSurface.trim() : '';
  if (!trimmed) return { action: 'none' };
  if ([...trimmed].length > VAF_EXAMPLE_SERVER_MAX_LENGTH) {
    return {
      action: 'disabled',
      value: trimmed,
      reason: `Source text exceeds ${VAF_EXAMPLE_SERVER_MAX_LENGTH} characters and cannot be saved as an example.`
    };
  }
  const withinPrefill = [...trimmed].length <= VAF_EXAMPLE_PREFILL_MAX_LENGTH;
  const terminals = countTerminalMarks(trimmed);
  const observedPresent = Boolean(observed) && trimmed.includes(observed);
  if (withinPrefill && terminals <= 1 && observedPresent) {
    return { action: 'prefill', value: trimmed, provenance: VAF_PROVENANCE.CONTEXT };
  }
  return { action: 'offer', value: trimmed, provenance: VAF_PROVENANCE.CONTEXT };
}

// Analyzer seed from the cached context item: ZERO network calls. Meaning is
// the bounded same-sense composition (never primaryGloss-only). Diet-trim
// edge: compose from available glosses; "+N more" appears ONLY when the item
// carries an explicit remainingCount — never invent an unknown N.
// Pin: the context response diet (server contextResponse.buildItem) never
// emits per-item pins; provenance lives on the block-level dictionary for the
// SAME pinned snapshot as the items. Callers pass that snapshot as
// pinFallback so entry expansion stays anchored to the analyzed snapshot
// (an item-level pin still wins when present).
export function analyzerPrefillFromContext(candidate, contextItem, pinFallback = null) {
  if (!candidate || typeof candidate !== 'object') return null;
  const lemma = typeof candidate.lemma === 'string' && candidate.lemma.trim() ? candidate.lemma.trim() : null;
  const canonical = typeof candidate.canonical === 'string' ? candidate.canonical : '';
  const word = lemma || canonical;
  const isProperNoun = candidate.pos === 'proper-noun';
  const match = contextItem?.dictionaryMatch?.status ?? null;
  const interpretation = contextItem?.interpretation?.status ?? null;

  let reading = '';
  let readingProvenance = null;
  if (!isProperNoun) {
    const suggested = match === 'UNIQUE' && typeof contextItem?.dictionaryMatch?.readings?.suggested === 'string'
      ? contextItem.dictionaryMatch.readings.suggested
      : null;
    if (suggested) {
      reading = suggested;
      readingProvenance = provenanceLabel(contextItem.dictionaryMatch.readings.provenance) || VAF_PROVENANCE.JMDICT;
    } else if (word && lemma && word === lemma && typeof candidate.lemmaReading === 'string' && candidate.lemmaReading) {
      reading = candidate.lemmaReading;
      readingProvenance = VAF_PROVENANCE.PARSER;
    }
  }

  let meaning = '';
  let meaningChoices = [];
  let moreMeanings = false;
  let requiresChoice = false;
  let entryRows = [];
  let glossMeta = null;
  const pinFromItem = contextItem && typeof contextItem === 'object' && contextItem.pin && typeof contextItem.pin === 'object'
    ? contextItem.pin
    : null;
  const pinFromFallback = pinFallback && typeof pinFallback === 'object' && pinFallback.sourceId != null
    ? pinFallback
    : null;
  const pin = pinFromItem || pinFromFallback;

  if (!isProperNoun && match === 'UNIQUE' && interpretation === 'COMPATIBLE' && contextItem?.interpretation?.selectedSense) {
    const sense = contextItem.interpretation.selectedSense;
    const glosses = Array.isArray(sense?.glosses) ? sense.glosses.filter((g) => typeof g === 'string' && g) : [];
    const composed = composeSenseMeaningMirror(glosses, VAF_MEANING_MAX_LENGTH);
    meaning = composed.value;
    const remaining = Number(contextItem.interpretation.remainingCount) || 0;
    glossMeta = { glossCount: composed.glossCount, remainingCount: remaining, fits: composed.fits };
    moreMeanings = remaining > 0;
  } else if (!isProperNoun && match === 'UNIQUE' && interpretation === 'AMBIGUOUS') {
    const senses = Array.isArray(contextItem?.interpretation?.compatibleSenses) ? contextItem.interpretation.compatibleSenses : [];
    meaningChoices = sensePickRows(senses);
    moreMeanings = (Number(contextItem.interpretation.remainingCount) || 0) > 0;
    requiresChoice = true;
  } else if (!isProperNoun && match === 'MULTIPLE') {
    const entries = Array.isArray(contextItem?.dictionaryMatch?.entries) ? contextItem.dictionaryMatch.entries : [];
    const senses = Array.isArray(contextItem?.interpretation?.compatibleSenses) ? contextItem.interpretation.compatibleSenses : [];
    const firstSenseByEntry = new Map();
    for (const sense of senses) {
      if (sense && sense.entryId != null && !firstSenseByEntry.has(String(sense.entryId))) {
        firstSenseByEntry.set(String(sense.entryId), sense);
      }
    }
    entryRows = entries.slice(0, 5).map((entry) => {
      const headword = (Array.isArray(entry.kanji) && entry.kanji[0])
        || (Array.isArray(entry.kana) && entry.kana[0])
        || (Array.isArray(entry.matchedSurfaces) && entry.matchedSurfaces[0])
        || 'Dictionary entry';
      const kanaLine = (Array.isArray(entry.kana) && entry.kana[0] && entry.kana[0] !== headword) ? entry.kana[0] : null;
      const sense = firstSenseByEntry.get(String(entry.entryId));
      const glosses = Array.isArray(sense?.glosses) ? sense.glosses : [];
      const composed = composeSenseMeaningMirror(glosses, VAF_MEANING_MAX_LENGTH);
      const pos = Array.isArray(sense?.pos) ? sense.pos : (Array.isArray(entry.posSummary) ? entry.posSummary : []);
      return { entryId: entry.entryId ?? null, headword, kanaLine, glossPreview: composed.value || '', pos: pos.filter((p) => typeof p === 'string') };
    });
    moreMeanings = (Number(contextItem?.interpretation?.remainingCount) || 0) > 0
      || contextItem?.dictionaryMatch?.lookupTruncated === true;
  }

  return { word, reading, readingProvenance, meaning, meaningChoices, moreMeanings, requiresChoice, entryRows, pin, glossMeta, match, interpretation };
}

// Thin fetch wrappers with injectable request (tests spy via injection or
// global fetch through apiRequest). Missing fields degrade to manual upstream.
export async function lookupVocabularyAutofill(word, { signal, request, includeOwnership = true } = {}) {
  const trimmed = typeof word === 'string' ? word.trim() : '';
  if (!trimmed) return null;
  const doRequest = typeof request === 'function' ? request : apiRequest;
  return doRequest('/api/vocabulary/autofill', {
    method: 'POST',
    body: { word: trimmed, includeOwnership },
    ...(signal ? { signal } : {})
  });
}

export async function fetchAutofillEntry({ sourceId, entryId, senseCursor } = {}, { signal, request } = {}) {
  if (sourceId == null || entryId == null) throw new Error('sourceId and entryId are required.');
  const doRequest = typeof request === 'function' ? request : apiRequest;
  return doRequest('/api/vocabulary/autofill/entry', {
    method: 'POST',
    body: { sourceId, entryId, ...(senseCursor != null ? { senseCursor } : {}) },
    ...(signal ? { signal } : {})
  });
}

// ---------------------------------------------------------------------------
// Standalone dialog wiring (entityPage create-mode vocabulary dialog only).
// Inline pickers, compact, manual fields always enabled, typing never blocked,
// aria-busy + role=status loading that never steals focus.
// ---------------------------------------------------------------------------

function findDialogInput(content, name) {
  if (!Array.isArray(content)) return null;
  return content
    .map((item) => {
      if (!item) return null;
      if (typeof item.matches === 'function' && item.matches(`[name="${name}"]`)) return item;
      if (typeof item.querySelector === 'function') return item.querySelector(`[name="${name}"]`);
      return null;
    })
    .find(Boolean) || null;
}

function fieldWrapperIndex(content, input) {
  if (!input) return -1;
  return content.findIndex((item) => {
    if (!item) return false;
    if (item === input) return true;
    try {
      if (typeof item.contains === 'function' && item.contains(input)) return true;
    } catch { /* ignore */ }
    if (typeof item.querySelector === 'function') {
      try {
        const found = item.querySelector(`[name="${input.name || ''}"]`);
        if (found === input) return true;
      } catch { /* ignore */ }
    }
    return false;
  });
}

export function enableVocabularyAutofill(content, { request = apiRequest, debounceMs = VAF_DEBOUNCE_MS } = {}) {
  const emptyHandle = { state: createAutofillState(), destroy() {}, refresh() {} };
  if (!Array.isArray(content) || typeof document === 'undefined') return emptyHandle;
  const build = typeof element === 'function'
    ? element
    : (tag, opts = {}, children = []) => {
      const node = document.createElement(tag);
      if (opts.className) node.className = opts.className;
      if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
      for (const [k, v] of Object.entries(opts.attrs || {})) {
        if (v !== undefined && v !== null) node.setAttribute(k, String(v));
      }
      const list = Array.isArray(children) ? children : [children];
      for (const child of list.filter(Boolean)) node.appendChild(child);
      return node;
    };

  const wordInput = findDialogInput(content, 'word');
  const readingInput = findDialogInput(content, 'reading');
  const meaningInput = findDialogInput(content, 'meaning');
  if (!wordInput || !readingInput || !meaningInput) return emptyHandle;

  const state = createAutofillState(typeof wordInput.value === 'string' ? wordInput.value.trim() || null : null);
  let seq = 0;
  let aborter = null;
  let timer = null;
  let destroyed = false;

  const ownershipBanner = build('div', {
    className: 'hidden rounded-lg border border-stone bg-paper/60 p-3 text-xs leading-5 text-muted sm:col-span-2',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-vaf-ownership': '' }
  });
  const lookupStatus = build('p', {
    className: 'hidden text-xs text-muted sm:col-span-2',
    text: 'Looking up dictionary…',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-vaf-status': '' }
  });
  const readingHelper = build('div', {
    className: 'hidden grid gap-2 sm:col-span-2',
    attrs: { 'data-vaf-reading-helper': '' }
  });
  const meaningHelper = build('div', {
    className: 'hidden grid gap-2 sm:col-span-2',
    attrs: { 'data-vaf-meaning-helper': '' }
  });

  function show(node) { node?.classList?.remove('hidden'); }
  function hide(node) { node?.classList?.add('hidden'); node?.replaceChildren?.(); if (node === ownershipBanner && node) node.textContent = ''; }

  function setLoading(loading) {
    for (const input of [readingInput, meaningInput]) {
      try {
        input?.closest?.('.field')?.classList?.toggle('field-autofill-loading', loading);
        if (loading) input?.setAttribute?.('aria-busy', 'true');
        else input?.removeAttribute?.('aria-busy');
      } catch { /* never block typing */ }
    }
    if (lookupStatus) lookupStatus.classList.toggle('hidden', !loading);
  }

  function clearSystemField(name) {
    const input = name === 'reading' ? readingInput : meaningInput;
    if (shouldClearSystemField(state.fieldStates[name])) {
      try { input.value = ''; } catch { /* ignore */ }
      state.fieldStates[name] = 'untouched';
      state.provenance[name] = null;
    }
    hide(name === 'reading' ? readingHelper : meaningHelper);
  }

  function provenancePill(label) {
    // Verbatim label (proper noun) — never translated.
    return build('span', { className: 'status-pill shrink-0 text-xs', text: label });
  }

  function helperNote(text) {
    return build('p', { className: 'break-words text-xs leading-5 text-muted', text });
  }

  function choiceButton({ label, ariaLabel }) {
    const button = build('button', {
      className: 'button-secondary min-h-9 justify-start px-3 py-1.5 text-left text-xs',
      text: label,
      attrs: { type: 'button', ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) }
    });
    return button;
  }

  function renderOwnership(ownership) {
    const model = ownershipBannerModel(ownership);
    if (!model.kind) { hide(ownershipBanner); return; }
    ownershipBanner.replaceChildren(
      build('span', { className: 'status-pill shrink-0 text-xs', text: model.kind === 'existing' ? 'Already in Vocabulary' : (model.kind === 'possible-match' ? 'Possible match' : 'Ownership unknown') }),
      build('span', { className: 'break-words', text: ` ${model.text}` })
    );
    ownershipBanner.classList.remove('hidden');
  }

  function renderReadingHint(hint) {
    readingHelper.replaceChildren();
    if (state.fieldStates.reading === 'user-edited' && hint.action === 'prefill') {
      // User-edited fields are never overwritten; keep their value, show no pill.
      hide(readingHelper);
      return;
    }
    if (hint.action === 'prefill' && hint.value) {
      if (state.fieldStates.reading !== 'user-edited') {
        try { readingInput.value = hint.value; } catch { /* ignore */ }
        markSystemPrefilled(state, 'reading', hint.provenance);
        const row = build('div', { className: 'flex flex-wrap items-center gap-2' }, [
          provenancePill(hint.provenance || VAF_PROVENANCE.JMDICT),
          helperNote('Dictionary reading — editable.')
        ]);
        readingHelper.replaceChildren(row);
        show(readingHelper);
      }
      return;
    }
    if (hint.action === 'choose' && hint.choices.length) {
      if (state.fieldStates.reading !== 'user-edited') markSystemSuggested(state, 'reading', hint.provenance);
      const group = build('div', {
        className: 'grid gap-2',
        attrs: { role: 'group', 'aria-label': 'Dictionary readings — choose one' }
      }, [
        build('p', { className: 'text-xs font-semibold text-ink', text: 'Dictionary readings — choose one:' })
      ]);
      for (const choice of hint.choices.slice(0, 6)) {
        const button = choiceButton({ label: choice, ariaLabel: `Use reading ${choice}` });
        button.addEventListener('click', () => {
          try { readingInput.value = choice; } catch { /* ignore */ }
          markUserEdited(state, 'reading');
          state.identityKey = state.identityWord ? `${state.identityWord}` : choice;
          readingHelper.replaceChildren(build('div', { className: 'flex flex-wrap items-center gap-2' }, [
            provenancePill(VAF_PROVENANCE.JMDICT),
            helperNote('Dictionary reading — editable.')
          ]));
        });
        group.appendChild(button);
      }
      readingHelper.replaceChildren(group);
      show(readingHelper);
      return;
    }
    hide(readingHelper);
  }

  function renderMeaningHint(hint, result) {
    meaningHelper.replaceChildren();
    if (hint.action === 'prefill' && hint.value) {
      if (state.fieldStates.meaning !== 'user-edited') {
        try { meaningInput.value = hint.value; } catch { /* ignore */ }
        markSystemPrefilled(state, 'meaning', hint.provenance);
        if (hint.entryId != null && hint.senseId != null) state.identityKey = `${hint.entryId}:${hint.senseId}`;
      }
      const note = glossCountNote({ glossCount: hint.glossCount, remainingCount: hint.remainingCount });
      const row = build('div', { className: 'flex flex-wrap items-center gap-2' }, [
        provenancePill(hint.provenance || VAF_PROVENANCE.JMDICT),
        ...(note ? [helperNote(`${note} — editable.`)] : [helperNote('Dictionary meaning — editable.')])
      ]);
      meaningHelper.replaceChildren(row);
      show(meaningHelper);
      return;
    }
    if (hint.action === 'choose' && hint.senseChoices.length) {
      if (state.fieldStates.meaning !== 'user-edited') markSystemSuggested(state, 'meaning', hint.provenance);
      const rows = sensePickRows(hint.senseChoices);
      const group = build('div', {
        className: 'grid gap-2',
        attrs: { role: 'group', 'aria-label': 'Possible meanings — choose one' }
      }, [
        build('p', { className: 'text-xs font-semibold text-ink', text: 'Possible meanings — choose one:' })
      ]);
      let manualNote = null;
    for (const row of rows.slice(0, 8)) {
      const posSuffix = row.pos.length ? ` (${row.pos.join(', ')})` : '';
      const button = choiceButton({ label: `${row.label}${posSuffix}`, ariaLabel: `Use meaning "${row.label}"` });
      button.addEventListener('click', () => {
        // Explicit user pick: compose from the backend-supplied full gloss
        // array via the mirror composer. Zero-fit (not even one full gloss
        // fits in 255 chars): leave the field blank and require manual entry
        // — never place the over-long fallback label.
        const composed = composeSenseMeaningMirror(row.glosses, VAF_MEANING_MAX_LENGTH);
        try { meaningInput.value = composed.value || ''; } catch { /* ignore */ }
        markUserEdited(state, 'meaning');
        if (!composed.value && !manualNote) {
          manualNote = helperNote('This dictionary meaning is too long to fill in — please enter it manually.');
          group.appendChild(manualNote);
        }
          if (row.entryId != null && row.senseId != null) state.identityKey = `${row.entryId}:${row.senseId}`;
          try { meaningInput.focus(); } catch { /* ignore */ }
        });
        group.appendChild(button);
      }
      if ((Number(hint.remainingCount) || 0) > 0) {
        group.appendChild(helperNote(`+${hint.remainingCount} more dictionary meanings. Choose the meaning that matches what you intend.`));
      }
      meaningHelper.replaceChildren(group);
      show(meaningHelper);
      return;
    }
    if (hint.action === 'choose-entry-then-sense' && hint.entryChoices.length) {
      if (state.fieldStates.meaning !== 'user-edited') markSystemSuggested(state, 'meaning', hint.provenance);
      renderEntryPicker(hint, result?.pin || state.pin);
      return;
    }
    hide(meaningHelper);
  }

  function renderEntryPicker(hint, pin) {
    const rows = entryPickRows(hint.entryChoices);
    const group = build('div', {
      className: 'grid gap-2',
      attrs: { role: 'group', 'aria-label': 'Dictionary entries — choose one' }
    }, [
      build('p', { className: 'text-xs font-semibold text-ink', text: 'Multiple dictionary entries — choose one:' })
    ]);
    for (const row of rows.slice(0, 5)) {
      const posSuffix = row.pos.length ? ` · ${row.pos.join(', ')}` : '';
      const preview = row.glossPreview ? ` — ${row.glossPreview}` : '';
      const kanaSuffix = row.kanaLine ? ` (${row.kanaLine})` : '';
      const button = choiceButton({
        label: `${row.headword}${kanaSuffix}${preview}${posSuffix}`,
        ariaLabel: `Expand dictionary entry ${row.headword}`
      });
      button.addEventListener('click', () => {
        if (!pin?.sourceId || row.entryId == null) {
          meaningHelper.replaceChildren(helperNote('This entry cannot be expanded. Enter the meaning manually.'));
          show(meaningHelper);
          return;
        }
        expandEntry(pin.sourceId, row.entryId);
      });
      group.appendChild(button);
    }
    if ((Number(hint.remainingCount) || 0) > 0) group.appendChild(helperNote('More dictionary matches exist.'));
    meaningHelper.replaceChildren(group);
    show(meaningHelper);
  }

  async function expandEntry(sourceId, entryId) {
    const expandSeq = ++seq;
    state.seq = expandSeq;
    meaningHelper.replaceChildren(helperNote('Loading entry meanings…'));
    show(meaningHelper);
    try {
      const data = await fetchAutofillEntry({ sourceId, entryId }, { request });
      if (expandSeq !== seq || destroyed) return;
      if (!data || data.status === 'unavailable') {
        renderExpandFailure(data, () => expandEntry(sourceId, entryId));
        return;
      }
      const senses = Array.isArray(data.senses) ? data.senses : [];
      const rows = sensePickRows(senses);
      if (!rows.length) {
        meaningHelper.replaceChildren(helperNote('No expandable meanings. Enter the meaning manually.'));
        show(meaningHelper);
        return;
      }
      if (data.pin) state.pin = data.pin;
      // Overflow reading: consumed exactly as supplied (prefill value,
      // explicit choices, or blank) — never alternatives[0], never per-kanji
      // inference. A user-edited reading is skipped entirely; meaning choices
      // below still update.
      if (data.reading && state.fieldStates.reading !== 'user-edited') {
        renderReadingHint(normalizeReadingHint(data.reading));
      }
      const group = build('div', {
        className: 'grid gap-2',
        attrs: { role: 'group', 'aria-label': 'Entry meanings — choose one' }
      }, [
        build('p', { className: 'text-xs font-semibold text-ink', text: 'Entry meanings — choose one:' })
      ]);
      let expandManualNote = null;
      for (const row of rows.slice(0, 8)) {
        const button = choiceButton({ label: row.label, ariaLabel: `Use meaning "${row.label}"` });
        button.addEventListener('click', () => {
          // Zero-fit: leave blank + manual note (never the over-long label).
          const composed = composeSenseMeaningMirror(row.glosses, VAF_MEANING_MAX_LENGTH);
          try { meaningInput.value = composed.value || ''; } catch { /* ignore */ }
          markUserEdited(state, 'meaning');
          if (!composed.value && !expandManualNote) {
            expandManualNote = helperNote('This dictionary meaning is too long to fill in — please enter it manually.');
            group.appendChild(expandManualNote);
          }
          if (row.entryId != null && row.senseId != null) state.identityKey = `${row.entryId}:${row.senseId}`;
          try { meaningInput.focus(); } catch { /* ignore */ }
        });
        group.appendChild(button);
      }
      if (data.truncated || data.nextCursor != null) group.appendChild(helperNote('More meanings exist.'));
      meaningHelper.replaceChildren(group);
      show(meaningHelper);
    } catch (error) {
      if (error?.name === 'AbortError' || expandSeq !== seq) return;
      meaningHelper.replaceChildren(helperNote('Could not load entry meanings. Enter the meaning manually.'));
      show(meaningHelper);
    }
  }

  function renderHintText(hint) {
    if (typeof hint !== 'string' || !hint.trim()) return;
    meaningHelper.replaceChildren(helperNote(hint.trim()));
    show(meaningHelper);
  }

  function renderUnavailable(result) {
    const retryable = result?.retryable === true;
    meaningHelper.replaceChildren();
    meaningHelper.appendChild(helperNote('Dictionary lookup is unavailable. Enter the reading and meaning manually.'));
    if (retryable) {
      const retry = build('button', {
        className: 'button-secondary min-h-9 justify-self-start px-3 py-1.5 text-xs',
        text: 'Retry dictionary lookup',
        attrs: { type: 'button' }
      });
      retry.addEventListener('click', () => scheduleLookup(true));
      meaningHelper.appendChild(retry);
    }
    show(meaningHelper);
  }

  function renderStaleRefresh(message) {
    state.stale = true;
    const box = build('div', { className: 'grid gap-2' }, [helperNote(message || VAF_STALE_MESSAGE)]);
    const refresh = build('button', {
      className: 'button-secondary min-h-9 justify-self-start px-3 py-1.5 text-xs',
      text: 'Refresh dictionary lookup',
      attrs: { type: 'button' }
    });
    refresh.addEventListener('click', () => scheduleLookup(true));
    box.appendChild(refresh);
    // Keep visible data: append the refresh box without clearing field values.
    meaningHelper.appendChild(box);
    show(meaningHelper);
  }

  // Entry-expansion failures branch on the backend reason — never blind:
  // stale snapshots need a NEW word lookup (Refresh), transient failures may
  // still succeed on the same pin (Retry repeats the same expansion),
  // anything else degrades to manual. User-entered values are never touched.
  function renderExpandFailure(data, retryExpand) {
    const reason = data && typeof data === 'object' ? data.reason : null;
    const retryable = !data || (data && typeof data === 'object' && data.retryable === true);
    if (reason === 'snapshot-unavailable') {
      renderStaleRefresh(VAF_STALE_MESSAGE);
      return;
    }
    if (retryable) {
      renderExpandRetry(retryExpand);
      return;
    }
    meaningHelper.replaceChildren(helperNote('Could not load dictionary entry. Enter the meaning manually.'));
    show(meaningHelper);
  }

  function renderExpandRetry(retryExpand) {
    const box = build('div', { className: 'grid gap-2' }, [
      helperNote('Could not load dictionary entry. Your entries are kept — try again.')
    ]);
    const retry = build('button', {
      className: 'button-secondary min-h-9 justify-self-start px-3 py-1.5 text-xs',
      text: 'Retry',
      attrs: { type: 'button', 'aria-label': 'Retry loading this dictionary entry' }
    });
    retry.addEventListener('click', () => retryExpand());
    box.appendChild(retry);
    // Replace the loading note (field inputs live outside this helper, so
    // user-entered values are kept); replacing also prevents stacked Retry
    // boxes across repeated failures.
    meaningHelper.replaceChildren(box);
    show(meaningHelper);
  }

  function applyResult(result, word) {
    if (!result || typeof result !== 'object') return;
    if (isStaleAutofillResult(result)) {
      if (result.pin) state.pin = result.pin;
      renderStaleRefresh(VAF_STALE_MESSAGE);
      return;
    }
    state.stale = false;
    state.identityWord = word;
    if (state.identityKey == null || state.identityKey === '' || !String(state.identityKey).includes(':')) {
      state.identityKey = word;
    } else if (!String(state.identityKey).includes(':')) {
      state.identityKey = word;
    } else {
      // A fresh word lookup supersedes a previous entry pick.
      state.identityKey = word;
    }
    if (result.pin) state.pin = result.pin;
    renderOwnership(result.ownership);
    const readingHint = normalizeReadingHint(result.fieldHints?.reading);
    const meaningHint = normalizeMeaningHint(result.fieldHints?.meaning);
    const hadMeaningContent = meaningHelper.children?.length > 0 && !meaningHelper.classList.contains('hidden');
    renderReadingHint(readingHint);
    // Preserve a stale-refresh box if one is already visible: append rather
    // than replace is handled inside renderStaleRefresh only. Fresh results
    // replace meaning helpers (user-edited values themselves are preserved).
    void hadMeaningContent;
    renderMeaningHint(meaningHint, result);
    // Backend statuses are nested objects — normalized via the safe helper
    // (missing shapes degrade to manual, never crash).
    const { dictionaryMatch: matchStatus, interpretation: interpStatus } = autofillMatchStatuses(result);
    if (matchStatus === 'NO_MATCH' && typeof result.hint === 'string' && result.hint.trim()
      && meaningHint.action === 'blank') {
      renderHintText(result.hint);
    }
    if (matchStatus === 'UNAVAILABLE' || interpStatus === 'UNAVAILABLE') {
      // Show the unavailable note only when there is nothing more specific.
      if (meaningHint.action === 'blank' && !(typeof result.hint === 'string' && result.hint.trim())) {
        renderUnavailable(result);
      } else if (result.retryable === true && meaningHelper.children?.length > 0) {
        const retry = build('button', {
          className: 'button-secondary min-h-9 justify-self-start px-3 py-1.5 text-xs',
          text: 'Retry dictionary lookup',
          attrs: { type: 'button' }
        });
        retry.addEventListener('click', () => scheduleLookup(true));
        meaningHelper.appendChild(retry);
      }
    }
  }

  async function doLookup(word) {
    const mySeq = ++seq;
    state.seq = mySeq;
    if (aborter) {
      try { aborter.abort(); } catch { /* ignore */ }
    }
    aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setLoading(true);
    try {
      const result = await lookupVocabularyAutofill(word, { signal: aborter?.signal, request });
      if (destroyed || mySeq !== seq) return;
      if (wordInput.value.trim() !== word) return;
      applyResult(result, word);
    } catch (error) {
      if (error?.name === 'AbortError' || (destroyed || mySeq !== seq)) return;
      // Network failure: degrade to manual, never crash, never invent certainty.
      if (wordInput.value.trim() !== word) return;
    } finally {
      if (mySeq === seq && !destroyed) setLoading(false);
    }
  }

  function scheduleLookup(immediate = false) {
    if (destroyed) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const word = wordInput.value.trim();
    if (!word) {
      if (aborter) { try { aborter.abort(); } catch { /* ignore */ } aborter = null; }
      seq += 1;
      state.seq = seq;
      state.identityWord = null;
      state.identityKey = null;
      state.pin = null;
      state.stale = false;
      clearSystemField('reading');
      clearSystemField('meaning');
      hide(ownershipBanner);
      setLoading(false);
      return;
    }
    // Word change clears untouched system values bound to the old identity.
    const plan = planWordChange({ state, newWord: word });
    if (plan.clearReading) {
      try { if (state.fieldStates.reading !== 'user-edited') readingInput.value = ''; } catch { /* ignore */ }
      if (state.fieldStates.reading !== 'user-edited') {
        state.fieldStates.reading = 'untouched';
        state.provenance.reading = null;
      }
      hide(readingHelper);
    }
    if (plan.clearMeaning) {
      try { if (state.fieldStates.meaning !== 'user-edited') meaningInput.value = ''; } catch { /* ignore */ }
      if (state.fieldStates.meaning !== 'user-edited') {
        state.fieldStates.meaning = 'untouched';
        state.provenance.meaning = null;
      }
      hide(meaningHelper);
    }
    hide(ownershipBanner);
    if (immediate) {
      void doLookup(word);
      return;
    }
    timer = setTimeout(() => { timer = null; void doLookup(word); }, debounceMs);
  }

  const onWordInput = () => {
    // Invalidate in-flight lookups immediately so typing never blocks and
    // late responses are discarded entirely by sequence.
    seq += 1;
    state.seq = seq;
    if (aborter) { try { aborter.abort(); } catch { /* ignore */ } aborter = null; }
    setLoading(false);
    scheduleLookup(false);
  };
  const onReadingInput = () => markUserEdited(state, 'reading');
  const onMeaningInput = () => markUserEdited(state, 'meaning');

  wordInput.addEventListener('input', onWordInput);
  readingInput.addEventListener('input', onReadingInput);
  meaningInput.addEventListener('input', onMeaningInput);
  readingInput.addEventListener('change', onReadingInput);
  meaningInput.addEventListener('change', onMeaningInput);

  // Inline insertion: banner + status at the top (mirroring the kanji hook),
  // helpers directly after their fields when locatable.
  try {
    content.unshift(ownershipBanner, lookupStatus);
  } catch { /* ignore */ }
  try {
    const readingIndex = fieldWrapperIndex(content, readingInput);
    if (readingIndex >= 0) content.splice(readingIndex + 1, 0, readingHelper);
    else content.push(readingHelper);
    const meaningIndex = fieldWrapperIndex(content, meaningInput);
    if (meaningIndex >= 0) content.splice(meaningIndex + 1, 0, meaningHelper);
    else content.push(meaningHelper);
  } catch {
    try { content.push(readingHelper, meaningHelper); } catch { /* ignore */ }
  }

  return {
    state,
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      if (aborter) { try { aborter.abort(); } catch { /* ignore */ } }
      wordInput.removeEventListener('input', onWordInput);
      readingInput.removeEventListener('input', onReadingInput);
      meaningInput.removeEventListener('input', onMeaningInput);
      readingInput.removeEventListener('change', onReadingInput);
      meaningInput.removeEventListener('change', onMeaningInput);
    },
    refresh() { scheduleLookup(true); }
  };
}