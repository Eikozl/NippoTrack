// Phase 12-B — lexical analyzer view helpers (pure, no DOM).
// Mirrors the server candidate contract into card view-models plus the
// explicit Add-to-Vocabulary prefill rules. Reading honesty is enforced here:
// lemmaReading is the ONLY reading ever prefilled, and only for the lemma
// word itself. surfaceReading ("as read here") is display-only and must never
// become the reading of a different dictionary form.

export const LEXICAL_ANALYSIS_MAX_LENGTH = 2000;
// Keep action labels useful on narrow cards without truncating the lexical
// identity shown in the card or sent in the import payload.
export const MAX_ADD_LABEL_CODE_POINTS = 12;

export const LEXICAL_POS_LABELS = {
  noun: 'noun',
  verb: 'verb',
  'i-adjective': 'adjective',
  'na-adjective': 'adjective',
  adverb: 'adverb',
  interjection: 'interjection'
};

export const LEXICAL_MATCH_PILLS = {
  existing: 'Already in Vocabulary',
  new: 'New',
  ambiguous: 'Needs verification',
  unavailable: 'Ownership unknown',
  unsupported: 'Needs verification'
};

export function lexicalPosLabel(pos) {
  return LEXICAL_POS_LABELS[pos] || 'word';
}

export function lexicalMatchPill(matchState) {
  return LEXICAL_MATCH_PILLS[matchState] || 'Needs verification';
}

function firstObservedSurface(candidate) {
  const observed = Array.isArray(candidate.observed) ? candidate.observed : [];
  return observed.length ? observed[0].surface : candidate.canonical;
}

// Display-only "Observed: X (reading) · Y" line for surfaces that differ from
// the canonical form. Never used as import data.
export function formatObservedLine(candidate) {
  const observed = (Array.isArray(candidate.observed) ? candidate.observed : []).filter(
    (entry) => entry && entry.surface !== candidate.canonical
  );
  if (!observed.length) return null;
  const parts = observed.map((entry) =>
    entry.surfaceReading ? `${entry.surface} (${entry.surfaceReading})` : entry.surface
  );
  return `Observed: ${parts.join(' · ')}`;
}

// Check if any observed form differs from the canonical form (for button label)
function hasObservedFormDifferentFromCanonical(candidate) {
  const observed = Array.isArray(candidate.observed) ? candidate.observed : [];
  return observed.some((entry) => entry.surface !== candidate.canonical);
}

export function formatLexicalCandidate(candidate, { added = false } = {}) {
  const matchState = added ? 'existing' : (candidate.match && candidate.match.state) || 'new';
  const showAdd = matchState === 'new';
  const observedDiffers = hasObservedFormDifferentFromCanonical(candidate);
  const canonicalFitsActionLabel = Array.from(candidate.canonical || '').length <= MAX_ADD_LABEL_CODE_POINTS;
  return {
    key: candidate.key,
    canonical: candidate.canonical,
    pill: lexicalMatchPill(matchState),
    matchState,
    showAdd,
    addLabel: observedDiffers && canonicalFitsActionLabel ? `Add ${candidate.canonical}` : 'Add to Vocabulary',
    posLabel: lexicalPosLabel(candidate.pos),
    occurrences: candidate.occurrences || 1,
    observedLine: formatObservedLine(candidate),
    readingLine: candidate.lemmaReading ? `Reading: ${candidate.lemmaReading}` : null,
    possibleMatches: matchState === 'ambiguous' ? (candidate.match.possibleMatches || []) : []
  };
}

// Groups server candidates + unverified material for rendering. localAdded is
// a Set of canonical forms the user added in this session (no re-analysis).
export function groupLexicalCandidates(lexical, localAdded) {
  const added = localAdded instanceof Set ? localAdded : new Set();
  const candidates = Array.isArray(lexical?.candidates) ? lexical.candidates : [];
  const unverified = Array.isArray(lexical?.unverified) ? lexical.unverified : [];
  const groups = { existing: [], fresh: [], verify: [] };
  for (const candidate of candidates) {
    const view = formatLexicalCandidate(candidate, { added: added.has(candidate.canonical) });
    if (view.matchState === 'existing') groups.existing.push(view);
    else if (view.matchState === 'new') groups.fresh.push(view);
    else groups.verify.push(view);
  }
  const verifyUnverified = unverified.map((item) => ({
    key: item.key,
    canonical: item.canonical,
    pill: lexicalMatchPill('unsupported'),
    matchState: 'unsupported',
    showAdd: false,
    addLabel: null,
    posLabel: item.pos === 'proper-noun' ? 'proper noun' : 'word',
    occurrences: item.occurrences || 1,
    observedLine: null,
    readingLine: null,
    possibleMatches: []
  }));
  groups.verify.push(...verifyUnverified);
  return groups;
}

// Prefill for the explicit Add-to-Vocabulary confirmation form. Returns null
// when there is nothing safe to prefill (caller keeps user input instead).
// meaning is NEVER fabricated: blank unless the caller passes one. Optional
// word/reading overrides let the user correct the form; the safe defaults
// below apply when overrides are absent.
export function buildVocabularyImportPayload(candidate, { meaning = '', word, reading } = {}) {
  if (!candidate || typeof candidate.canonical !== 'string' || !candidate.canonical) return null;
  const trimmedMeaning = typeof meaning === 'string' ? meaning.trim() : '';
  if (!trimmedMeaning) return null;
  const safeWord = candidate.lemma || candidate.canonical;
  const safeReading = safeWord === candidate.lemma && candidate.lemmaReading ? candidate.lemmaReading : '';
  const finalWord = typeof word === 'string' && word.trim() ? word.trim() : safeWord;
  const finalReading = typeof reading === 'string' ? reading.trim() : safeReading;
  if (!finalWord) return null;
  return { word: finalWord, reading: finalReading, meaning: trimmedMeaning };
}
