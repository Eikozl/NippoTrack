// CA-B3 — Context-Aware presentation mapper (pure, no DOM).
//
// Translates the frozen backend context contract (server contextResponse /
// contextFilters shapes) into display state. PRESENTATION ONLY: never
// recomputes dictionaryMatch, interpretation, filters, or compatibility.
// Backend statuses, remainingCount, and truncation flags are trusted as-is;
// displayed sense/entry arrays are capped, so "one shown" never implies
// certainty. The raw backend item is never mutated.
//
// Display-state kinds:
//   compatible        UNIQUE + COMPATIBLE   (one certain meaning)
//   ambiguous-unique  UNIQUE + AMBIGUOUS    (word known, meaning open)
//   multiple          MULTIPLE              (identity unresolved)
//   no-match          NO_MATCH              (quiet state)
//   unavailable       UNAVAILABLE item, or a failed block (notice + opt retry)
//   unsupported       UNSUPPORTED           (manual Add path unaffected)
//   pending           no context data at all (back-compat: render nothing)

export const CONTEXT_EVIDENCE_COPY = {
  LEMMA_EXACT: 'Dictionary form matches',
  ORTHOGRAPHIC_EXACT: 'Spelling matches',
  READING_COMPATIBLE: 'Reading matches',
  READING_RESTRICTED: 'Reading is valid for this spelling',
  POS_EXACT: 'Part of speech matches',
  POS_BROAD: 'Part of speech is compatible',
  INFLECTION_FAMILY_COMPATIBLE: 'Conjugation matches the dictionary verb family'
};

// Backend evidence-order is the display order (stable, deterministic).
export const CONTEXT_EVIDENCE_ORDER = [
  'LEMMA_EXACT',
  'ORTHOGRAPHIC_EXACT',
  'READING_COMPATIBLE',
  'READING_RESTRICTED',
  'POS_EXACT',
  'POS_BROAD',
  'INFLECTION_FAMILY_COMPATIBLE'
];

// excludedBy veto codes collapse into three user-facing restriction kinds.
// Raw H-codes never reach the UI.
const EXCLUDED_COPY = {
  spelling: 'spelling',
  reading: 'reading',
  partOfSpeech: 'part of speech'
};

function excludedKinds(excludedBy) {
  const kinds = new Set();
  for (const code of Object.keys(excludedBy || {})) {
    if (code === 'STAGK_INCOMPATIBLE' || code === 'READING_FORM_RESTRICTED' || code === 'NOKANJI_INCOMPATIBLE') kinds.add(EXCLUDED_COPY.spelling);
    else if (code === 'STAGR_INCOMPATIBLE') kinds.add(EXCLUDED_COPY.reading);
    else if (code === 'POS_INCOMPATIBLE') kinds.add(EXCLUDED_COPY.partOfSpeech);
  }
  return [...kinds];
}

export function evidenceLines(evidenceSummary) {
  const codes = Array.isArray(evidenceSummary?.codes) ? evidenceSummary.codes : [];
  return CONTEXT_EVIDENCE_ORDER
    .filter((code) => codes.includes(code))
    .map((code) => CONTEXT_EVIDENCE_COPY[code]);
}

export function excludedSummary(excludedBy) {
  const kinds = excludedKinds(excludedBy);
  if (!kinds.length) return null;
  if (kinds.length === 1) {
    return `Some dictionary meanings were excluded because they do not match this ${kinds[0]}.`;
  }
  const last = kinds[kinds.length - 1];
  return `Some dictionary meanings were excluded because they do not match this ${kinds.slice(0, -1).join(', ')} or ${last}.`;
}

function firstGloss(sense) {
  const glosses = Array.isArray(sense?.glosses) ? sense.glosses.filter((value) => typeof value === 'string' && value) : [];
  return glosses.length ? glosses[0] : '';
}

function compactGlosses(sense) {
  const glosses = Array.isArray(sense?.glosses) ? sense.glosses.filter((value) => typeof value === 'string' && value) : [];
  return glosses.join(' · ');
}

// Displayable sense choices for UNIQUE + AMBIGUOUS. Always explicit user
// picks: choosing one fills the meaning field, never auto-selects.
export function senseChoices(item, limit = 8) {
  const senses = Array.isArray(item?.interpretation?.compatibleSenses) ? item.interpretation.compatibleSenses : [];
  return senses.slice(0, limit).map((sense) => ({
    entryId: sense.entryId ?? null,
    senseId: sense.senseId ?? null,
    label: compactGlosses(sense) || 'Untranslated sense',
    primaryGloss: firstGloss(sense)
  }));
}

// Compact rows for MULTIPLE: one headword + gloss per displayed entry.
// Headword prefers kanji, then kana, then matched surfaces. Informational
// only — no entry is selectable as an identity here.
export function multipleEntryRows(item, limit = 5) {
  const entries = Array.isArray(item?.dictionaryMatch?.entries) ? item.dictionaryMatch.entries : [];
  const senses = Array.isArray(item?.interpretation?.compatibleSenses) ? item.interpretation.compatibleSenses : [];
  const glossByEntry = new Map();
  for (const sense of senses) {
    if (sense && sense.entryId != null && !glossByEntry.has(String(sense.entryId)) && firstGloss(sense)) {
      glossByEntry.set(String(sense.entryId), firstGloss(sense));
    }
  }
  return entries.slice(0, limit).map((entry) => {
    const headword = (Array.isArray(entry.kanji) && entry.kanji[0])
      || (Array.isArray(entry.kana) && entry.kana[0])
      || (Array.isArray(entry.matchedSurfaces) && entry.matchedSurfaces[0])
      || 'Dictionary entry';
    return { entryId: entry.entryId ?? null, headword, gloss: glossByEntry.get(String(entry.entryId)) || '' };
  });
}

// Safe Add-dialog suggestion model. meaning is a suggestion ONLY for
// COMPATIBLE; AMBIGUOUS yields explicit choices the user must pick.
// MULTIPLE/NO_MATCH/UNSUPPORTED/UNAVAILABLE yield no context-derived
// reading or meaning (dictionary identity unresolved or absent).
export function addSuggestion(item) {
  const match = item?.dictionaryMatch?.status || null;
  const interpretation = item?.interpretation?.status || null;
  const isUnique = match === 'UNIQUE';
  const base = {
    word: null,
    reading: null,
    readingProvenance: null,
    meaning: null,
    meaningChoices: [],
    moreMeanings: false,
    requiresChoice: false,
    sourceKey: item?.key ?? null
  };
  if (!isUnique) return base;
  const suggested = item?.dictionaryMatch?.readings?.suggested || null;
  if (typeof suggested === 'string' && suggested) {
    base.reading = suggested;
    base.readingProvenance = 'dictionary';
  }
  if (interpretation === 'COMPATIBLE' && item?.interpretation?.selectedSense) {
    base.meaning = firstGloss(item.interpretation.selectedSense);
    return base;
  }
  if (interpretation === 'AMBIGUOUS') {
    base.meaningChoices = senseChoices(item);
    base.moreMeanings = (item?.interpretation?.remainingCount || 0) > 0;
    base.requiresChoice = true;
  }
  return base;
}

// Block-level failure model. Structural partials (bounded results) are NOT
// outages: they report state 'partial' with neutral copy and never offer
// Retry. Only transient backend-marked failures are 'unavailable' +
// retryable. Deterministic absences stay quiet and non-retryable.
const STRUCTURAL_PARTIAL_COPY = {
  'candidate-cap-reached': 'Dictionary context was generated for part of the vocabulary in this analysis.',
  'lookup-truncated': 'Some dictionary matches were omitted.',
  'evaluation-truncated': 'Some dictionary possibilities could not be fully evaluated.'
};

export function contextBlockModel(context) {
  if (!context || typeof context !== 'object') return { state: 'pending', retryable: false, notice: null };
  if (context.status === 'ok') return { state: 'ok', retryable: false, notice: null };
  const retryable = context.retryable === true;
  if (context.reason === 'lexical-required') {
    return { state: 'pending', retryable: false, notice: null };
  }
  if (context.reason === 'version-absent') {
    return { state: 'unavailable', retryable: false, notice: "Dictionary context isn't available in this environment yet." };
  }
  if (typeof context.reason === 'string' && Object.hasOwn(STRUCTURAL_PARTIAL_COPY, context.reason)) {
    return { state: 'partial', retryable: false, notice: STRUCTURAL_PARTIAL_COPY[context.reason] };
  }
  if (retryable) {
    return {
      state: 'unavailable',
      retryable: true,
      notice: context.status === 'partial'
        ? 'Dictionary context is temporarily unavailable for some results.'
        : 'Dictionary context is temporarily unavailable.'
    };
  }
  // Unknown non-retryable shape: neutral partial, never outage wording.
  return { state: 'partial', retryable: false, notice: 'Some dictionary context details are incomplete.' };
}

// Payload-budget disclosure: backend trimmed presentation data to fit.
// Informational only — independent of match statuses, no Retry, shown once
// per vocabulary section (the renderer combines it with any block notice).
export function payloadTruncationNotice(context) {
  if (context && typeof context === 'object' && context.truncated === true) {
    return 'Some dictionary context details were omitted to keep this analysis compact.';
  }
  return null;
}

export function truncationNotes(item) {
  const notes = [];
  if (item?.dictionaryMatch?.lookupTruncated === true) notes.push('More dictionary matches exist.');
  if (item?.interpretation?.evaluationTruncated === true) {
    notes.push('JLT kept this result ambiguous because not every dictionary possibility could be evaluated.');
  }
  const remaining = item?.interpretation?.remainingCount || 0;
  if (remaining > 0 && item?.interpretation?.status === 'AMBIGUOUS') notes.push('More meanings exist.');
  return notes;
}

// One visible source line for the whole vocabulary section (never per card).
// Returns null when no dictionary provenance is present.
export function attributionModel(dictionary) {
  if (!dictionary || typeof dictionary !== 'object' || !dictionary.source) return null;
  const detail = [dictionary.version ? `version ${dictionary.version}` : null, dictionary.fileDate ? `released ${dictionary.fileDate}` : null]
    .filter(Boolean)
    .join(' · ');
  return {
    text: 'Dictionary data: JMdict © EDRDG (CC BY-SA 4.0)',
    detail: detail || null
  };
}

// Main entry: backend item -> immutable display model. Unknown shapes degrade
// to the quiet no-match state rather than inventing certainty.
export function contextItemModel(item) {
  if (!item || typeof item !== 'object') return { kind: 'pending' };
  const match = item.dictionaryMatch?.status || null;
  const interpretation = item.interpretation?.status || null;
  const suggestion = addSuggestion(item);
  const readings = match === 'UNIQUE'
    ? {
      suggested: item.dictionaryMatch?.readings?.suggested || null,
      alternatives: Array.isArray(item.dictionaryMatch?.readings?.alternatives)
        ? item.dictionaryMatch.readings.alternatives.filter((value) => typeof value === 'string')
        : [],
      provenance: item.dictionaryMatch?.readings?.provenance || null
    }
    : { suggested: null, alternatives: [], provenance: null };
  if (match === 'UNIQUE' && interpretation === 'COMPATIBLE') {
    return {
      kind: 'compatible',
      heading: 'Compatible meaning',
      meaning: item.interpretation?.selectedSense ? compactGlosses(item.interpretation.selectedSense) : '',
      readings,
      evidence: evidenceLines(item.interpretation?.evidenceSummary),
      excluded: excludedSummary(item.interpretation?.evidenceSummary?.excludedBy),
      notes: truncationNotes(item),
      suggestion
    };
  }
  if (match === 'UNIQUE' && interpretation === 'AMBIGUOUS') {
    return {
      kind: 'ambiguous-unique',
      heading: 'Possible meanings',
      subheading: "JLT couldn't reliably distinguish one meaning from this context.",
      readings,
      choices: senseChoices(item),
      moreMeanings: (item?.interpretation?.remainingCount || 0) > 0,
      evidence: evidenceLines(item.interpretation?.evidenceSummary),
      excluded: excludedSummary(item.interpretation?.evidenceSummary?.excludedBy),
      notes: truncationNotes(item),
      suggestion
    };
  }
  if (match === 'MULTIPLE') {
    return {
      kind: 'multiple',
      heading: 'Multiple dictionary matches',
      subheading: 'This form matches multiple dictionary entries.',
      rows: multipleEntryRows(item),
      moreEntries: item.dictionaryMatch?.lookupTruncated === true,
      evidence: [],
      excluded: null,
      notes: truncationNotes(item),
      suggestion
    };
  }
  if (match === 'NO_MATCH') {
    return { kind: 'no-match', heading: null, notice: 'No reliable dictionary match found.', suggestion };
  }
  if (match === 'UNAVAILABLE') {
    return { kind: 'unavailable', heading: null, notice: 'Context details are temporarily unavailable.', suggestion };
  }
  if (match === 'UNSUPPORTED') {
    return { kind: 'unsupported', heading: null, notice: null, suggestion };
  }
  return { kind: 'no-match', heading: null, notice: 'No reliable dictionary match found.', suggestion };
}
