// CA-B2 — Context-Aware API diet and block assembly. Pure: no I/O.
//
// Correctness evaluation (contextFilters) ALWAYS runs before these display
// caps: truncation here is presentation-only and can never change an
// already-computed semantic status. Caps (frozen): ≤5 displayed entries,
// ≤3 displayed compatible senses, ≤3 glosses per sense, ≤100 KB additive
// payload. No numeric confidence, no LIKELY anywhere — the status sets are
// closed and asserted by test.

const { MATCH, INTERP } = require('./contextFilters');

const DISPLAY_MAX_ENTRIES = 5;
const DISPLAY_MAX_SENSES = 3;
const DISPLAY_MAX_GLOSSES = 3;
const DISPLAY_MAX_ALTERNATIVES = 5;
const DISPLAY_MAX_SURFACES = 10;
const CONTEXT_PAYLOAD_MAX_BYTES = 100 * 1024;

const MATCH_STATUSES = new Set(Object.values(MATCH));
const INTERPRETATION_STATUSES = new Set(Object.values(INTERP));

function sliceStrings(values, limit) {
  const list = (Array.isArray(values) ? values : []).filter((value) => typeof value === 'string');
  return list.slice(0, limit);
}

// Entry diet: what CA-B3 needs, nothing more. Never jmdict_entries.doc.
function dietEntry(entry) {
  const keb = [];
  const reb = [];
  for (const form of entry.allForms || []) {
    if (form.kind === 'keb') {
      if (!keb.includes(form.surface)) keb.push(form.surface);
    } else if (form.kind === 'reb') {
      if (!reb.includes(form.surface)) reb.push(form.surface);
    }
  }
  return {
    entryId: entry.entryId,
    kanji: keb.slice(0, DISPLAY_MAX_SURFACES),
    kanjiCount: keb.length,
    kana: reb.slice(0, DISPLAY_MAX_SURFACES),
    kanaCount: reb.length,
    posSummary: sliceStrings(entry.posSummary, DISPLAY_MAX_SURFACES),
    // Runtime adapter folds booleans to 0/1; accept both shapes.
    isCommon: entry.isCommon === true || entry.isCommon === 1,
    matchedSurfaces: [...new Set((entry.matchedForms || []).map((row) => row.surface))].slice(0, DISPLAY_MAX_SURFACES)
  };
}

function dietSense(sense) {
  return {
    senseId: sense.senseNo,
    glosses: sliceStrings(sense.glossEn, DISPLAY_MAX_GLOSSES),
    glossCount: Array.isArray(sense.glossEn) ? sense.glossEn.length : 0,
    pos: sliceStrings(sense.pos, DISPLAY_MAX_SURFACES)
  };
}

function withEntryId(entryId, sense) {
  return { entryId, ...dietSense(sense) };
}

// Assemble one item block from a finalized candidate. `entryCap`
// pre-applied by the service when the global Q2 budget truncates; display
// caps apply here, after evaluation.
function buildItem(finalized) {
  const entries = finalized.survivingEntries.map(dietEntry);
  const compatible = finalized.compatibleSenses.map((sense) => ({
    entryId: sense.entryId,
    senseId: sense.senseNo,
    glosses: sliceStrings(sense.glossEn, DISPLAY_MAX_GLOSSES),
    glossCount: Array.isArray(sense.glossEn) ? sense.glossEn.length : 0,
    pos: sliceStrings(sense.pos, DISPLAY_MAX_SURFACES)
  }));
  return {
    key: finalized.candidateKey,
    canonical: finalized.canonical,
    dictionaryMatch: {
      status: finalized.matchStatus,
      identityStrategy: finalized.identityStrategy,
      lookupTruncated: finalized.lookupTruncated === true,
      entries: entries.slice(0, DISPLAY_MAX_ENTRIES),
      entryCount: entries.length,
      selectedEntryId: finalized.selectedEntryId,
      readings: {
        suggested: finalized.itemReadings.suggested,
        alternatives: (finalized.itemReadings.alternatives || []).slice(0, DISPLAY_MAX_ALTERNATIVES),
        provenance: finalized.itemReadings.provenance
      },
      reason: finalized.matchReason
    },
    interpretation: {
      status: finalized.interpretationStatus,
      evaluationTruncated: finalized.evaluationTruncated === true,
      selectedSense: finalized.selectedSense
        ? {
          entryId: finalized.selectedSense.entryId,
          senseId: finalized.selectedSense.senseNo,
          glosses: sliceStrings(finalized.selectedSense.glossEn, DISPLAY_MAX_GLOSSES),
          glossCount: finalized.selectedSense.glossEn.length,
          pos: sliceStrings(finalized.selectedSense.pos, DISPLAY_MAX_SURFACES)
        }
        : null,
      compatibleSenses: compatible.slice(0, DISPLAY_MAX_SENSES),
      remainingCount: Math.max(0, compatible.length - DISPLAY_MAX_SENSES),
      evidenceSummary: finalized.evidenceSummary,
      reason: finalized.interpretationReason
    }
  };
}

function emptySummary() {
  return {
    dictionary: { UNIQUE: 0, MULTIPLE: 0, NO_MATCH: 0, UNSUPPORTED: 0, UNAVAILABLE: 0 },
    interpretation: { COMPATIBLE: 0, AMBIGUOUS: 0, NOT_APPLICABLE: 0, UNAVAILABLE: 0 },
    truncated: { lookup: 0, evaluation: 0 }
  };
}

// Defensive payload enforcement: trims display-only arrays (never statuses)
// until the block fits the budget, then marks truncated:true. Statuses were
// computed before truncation and are never recomputed here.
function enforcePayloadCap(block) {
  let json = JSON.stringify(block);
  if (Buffer.byteLength(json, 'utf8') <= CONTEXT_PAYLOAD_MAX_BYTES) return block;
  const trimmed = JSON.parse(json);
  trimmed.truncated = true;
  for (const item of trimmed.items || []) {
    item.dictionaryMatch.alternativesKept = undefined;
    item.dictionaryMatch.readings.alternatives = [];
    item.dictionaryMatch.entries = item.dictionaryMatch.selectedEntryId
      ? item.dictionaryMatch.entries.filter((entry) => entry.entryId === item.dictionaryMatch.selectedEntryId)
      : [];
    // Surface inventories inside entries are display-only too: a pathological
    // entry with hundreds of spellings must not defeat the cap by itself.
    for (const entry of item.dictionaryMatch.entries) {
      entry.kanji = (entry.kanji || []).slice(0, 3);
      entry.kana = (entry.kana || []).slice(0, 3);
      entry.matchedSurfaces = (entry.matchedSurfaces || []).slice(0, 3);
      entry.posSummary = (entry.posSummary || []).slice(0, 3);
    }
    item.interpretation.compatibleSenses = item.interpretation.selectedSense
      ? [{
        entryId: item.interpretation.selectedSense.entryId,
        senseId: item.interpretation.selectedSense.senseId,
        glosses: item.interpretation.selectedSense.glosses.slice(0, 1),
        glossCount: item.interpretation.selectedSense.glossCount,
        pos: []
      }]
      : [];
  }
  json = JSON.stringify(trimmed);
  if (Buffer.byteLength(json, 'utf8') <= CONTEXT_PAYLOAD_MAX_BYTES) return trimmed;
  trimmed.items = [];
  trimmed.truncated = true;
  return trimmed;
}

function buildBlock({ status, reason, dictionary, items, warnings, retryable, durationMs }) {
  const summary = emptySummary();
  for (const item of items) {
    if (MATCH_STATUSES.has(item.dictionaryMatch.status)) summary.dictionary[item.dictionaryMatch.status] += 1;
    if (INTERPRETATION_STATUSES.has(item.interpretation.status)) summary.interpretation[item.interpretation.status] += 1;
    if (item.dictionaryMatch.lookupTruncated) summary.truncated.lookup += 1;
    if (item.interpretation.evaluationTruncated) summary.truncated.evaluation += 1;
  }
  return enforcePayloadCap({
    status,
    reason: reason || null,
    dictionary: dictionary || null,
    items,
    summary,
    warnings: Array.isArray(warnings) ? warnings : [],
    retryable: retryable === true,
    truncated: false,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : 0
  });
}

function lexicalRequiredBlock() {
  return unavailableBlock('lexical-required', false);
}

function unavailableBlock(reason, retryable) {
  return {
    status: 'unavailable',
    reason,
    dictionary: null,
    items: [],
    summary: emptySummary(),
    warnings: [reason],
    retryable: retryable === true,
    truncated: false,
    durationMs: 0
  };
}

module.exports = {
  DISPLAY_MAX_ENTRIES,
  DISPLAY_MAX_SENSES,
  DISPLAY_MAX_GLOSSES,
  DISPLAY_MAX_ALTERNATIVES,
  DISPLAY_MAX_SURFACES,
  CONTEXT_PAYLOAD_MAX_BYTES,
  MATCH_STATUSES,
  INTERPRETATION_STATUSES,
  dietEntry,
  dietSense,
  withEntryId,
  buildItem,
  emptySummary,
  enforcePayloadCap,
  buildBlock,
  lexicalRequiredBlock,
  unavailableBlock
};
