// Phase 8 — Smart Text Analyzer (deterministic character analysis).
//
// Paste arbitrary Japanese text; report which Han characters it literally
// contains, how often each occurs, and each character's collection /
// reference state for the requesting user. This is Unicode + reference +
// collection analysis — NOT NLP: no tokenization, no morphological parsing,
// no word segmentation, no grammar detection, no contextual reading
// assignment, no furigana, no translation, no level estimation.
//
// Reuse: occurrence order comes from extractHanOccurrences
// (kanjiVocabularyLinks, same \p{Script=Han} definition as Phase 2/3/6);
// per-character collection/reference join reuses buildSessionKanjiDiscovery
// (Phase 6) so analyzer entries share the exact discovery contract the
// Phase 6/7 client helpers already format and import. Analysis is strictly
// read-only: it never creates sessions, vocabulary, kanji, encounters,
// reviews, or statistics. Only explicit Add actions write (via the existing
// POST /api/kanji rules).
//
// Linguistic boundary: reference readings/meanings are general inventories
// for a character, never the reading used in the pasted text. Per-character
// readingSegment is always null (provenance 'unverified'); jukujikun/ateji
// (今日, 大人, 明日) and sound changes (rendaku/onbin) are never aligned.

const { extractHanOccurrences } = require('./kanjiVocabularyLinks');
const {
  buildSessionKanjiDiscovery,
  DISCOVERY_STATES
} = require('./sessionKanjiDiscovery');

// Matches the writing_content convention (sessionsController
// normalizeWriting): large enough for reasonable pasted text, small enough
// to bound the IN-clause payload. Validated client-side for UX and
// server-side for authority.
const MAX_ANALYZER_TEXT_LENGTH = 10000;

const ANALYZER_SOURCE = 'pasted_text';

const ANALYZER_NOTICE =
  'Kanji below are individual characters detected in the pasted text. ' +
  'Reference readings and meanings are general inventories for each character, not readings used in this text. ' +
  'Nothing has been added to your collection.';

// Public analyzer states. These name the same three outcomes as the Phase 6
// discovery states (kept on each entry as `discoveryState` so Phase 6/7
// client helpers keep working); `state` is the Phase 8 alias:
// - in_collection: character is in the requester's kanji collection
// - available_from_reference: not collected, but kanji_reference has usable
//   data (meanings) so it can be imported via explicit user action
// - no_reference_data: neither collected nor usable reference data; nothing
//   may be fabricated for these characters.
const ANALYZER_STATES = Object.freeze({
  IN_COLLECTION: 'in_collection',
  AVAILABLE: 'available_from_reference',
  NO_REFERENCE: 'no_reference_data'
});

function toAnalyzerState(discoveryState) {
  if (discoveryState === DISCOVERY_STATES.IN_COLLECTION) return ANALYZER_STATES.IN_COLLECTION;
  if (discoveryState === DISCOVERY_STATES.AVAILABLE) return ANALYZER_STATES.AVAILABLE;
  return ANALYZER_STATES.NO_REFERENCE;
}

// Reference-only metadata summary ("Kanji reference distribution").
// Counts UNIQUE kanji per reference JLPT level — never occurrences, never a
// "text level", never learner proficiency. Characters without a recognized
// N5..N1 reference level are counted as unclassified, kept separate.
function buildJlptDistribution(kanji) {
  const distribution = { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0, unclassified: 0 };
  for (const entry of Array.isArray(kanji) ? kanji : []) {
    const level = entry && entry.reference && typeof entry.reference.jlptLevel === 'string'
      ? entry.reference.jlptLevel.trim().toUpperCase()
      : null;
    if (level && Object.prototype.hasOwnProperty.call(distribution, level)) {
      distribution[level] += 1;
    } else {
      distribution.unclassified += 1;
    }
  }
  return distribution;
}

function emptyAnalysis(totalCharacters) {
  return {
    source: ANALYZER_SOURCE,
    totalCharacters,
    uniqueKanjiCount: 0,
    totalKanjiOccurrences: 0,
    characters: [],
    kanji: [],
    summary: {
      uniqueKanji: 0,
      totalOccurrences: 0,
      inCollection: 0,
      availableToAdd: 0,
      noReferenceData: 0
    },
    jlptDistribution: buildJlptDistribution([]),
    maxLength: MAX_ANALYZER_TEXT_LENGTH,
    notice: ANALYZER_NOTICE
  };
}

// Assembles the analyzer payload. `scanned` is the ordered occurrence list
// from extractHanOccurrences; `userKanjiRows` / `referenceRows` come from
// the two bounded batched queries in the controller. Pure in-memory join.
function buildTextKanjiAnalysis(scanned, userKanjiRows, referenceRows, totalCharacters) {
  const list = Array.isArray(scanned) ? scanned : [];
  if (!list.length) return emptyAnalysis(totalCharacters);
  const characters = list.map((entry) => entry.character);
  const discovery = buildSessionKanjiDiscovery(characters, userKanjiRows, referenceRows);
  const occurrencesByChar = new Map(list.map((entry) => [entry.character, entry.occurrences]));
  const kanji = discovery.kanji.map((entry) => ({
    ...entry,
    occurrences: occurrencesByChar.get(entry.character) || 0,
    state: toAnalyzerState(entry.discoveryState)
  }));
  const totalKanjiOccurrences = kanji.reduce((sum, entry) => sum + entry.occurrences, 0);
  const summary = {
    uniqueKanji: kanji.length,
    totalOccurrences: totalKanjiOccurrences,
    inCollection: kanji.filter((entry) => entry.state === ANALYZER_STATES.IN_COLLECTION).length,
    availableToAdd: kanji.filter((entry) => entry.state === ANALYZER_STATES.AVAILABLE).length,
    noReferenceData: kanji.filter((entry) => entry.state === ANALYZER_STATES.NO_REFERENCE).length
  };
  return {
    source: ANALYZER_SOURCE,
    totalCharacters,
    uniqueKanjiCount: kanji.length,
    totalKanjiOccurrences,
    characters: [...characters],
    kanji,
    summary,
    jlptDistribution: buildJlptDistribution(kanji),
    maxLength: MAX_ANALYZER_TEXT_LENGTH,
    notice: ANALYZER_NOTICE
  };
}

module.exports = {
  ANALYZER_NOTICE,
  ANALYZER_SOURCE,
  ANALYZER_STATES,
  MAX_ANALYZER_TEXT_LENGTH,
  buildJlptDistribution,
  buildTextKanjiAnalysis,
  emptyAnalysis,
  extractHanOccurrences,
  toAnalyzerState
};
