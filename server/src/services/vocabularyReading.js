// Phase 5 — Reading-Aware Vocabulary (Level A).
//
// Semantic model:
// - vocabulary.reading is the authoritative full-word reading for that entry
//   ("authoritative" = truth for this user entry, not dictionary-canonical).
// - User kanji onyomi/kunyomi are personal study notes, never aligned to the word.
// - kanji_reference onyomi/kunyomi/meanings are shared contextual inventories,
//   never evidence that a given reading is used inside the word.
// - Per-kanji reading segments are NEVER inferred (no kana splitting, no
//   substring matching). Level A always returns readingSegment: null with
//   provenance 'unverified'. Jukujikun examples: 今日=きょう, 大人=おとな,
//   明日=あした must never be split (e.g. 今=きょ + 日=う is forbidden).
//
// A nullable verified mapping may be added in a later level only when a
// lexical source explicitly supplies it; unknown stays unclaimed.

const READING_PROVENANCE = Object.freeze({
  AUTHORITATIVE: 'authoritative',
  USER: 'user',
  REFERENCE: 'reference',
  UNVERIFIED: 'unverified'
});

const CONTEXT_NOTICE =
  'Reference readings are general inventories for each kanji and are not derived from this word\u2019s reading. ' +
  'Per-kanji alignment is unverified: some words use special whole-word readings (jukujikun/ateji) or sound changes ' +
  '(rendaku/onbin) with no direct correspondence.';

function toStringArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function toNullableString(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

// Normalizes one joined kanji row (single-query LEFT JOIN output) into the
// reading-aware shape. Never derives readingSegment from the word reading.
// Kept for compatibility; new code prefers buildFullVocabularyReadingContext.
function buildKanjiReadingEntry(row) {
  const refOnyomi = toStringArray(row.ref_onyomi);
  const refKunyomi = toStringArray(row.ref_kunyomi);
  const refMeanings = toStringArray(row.ref_meanings);
  return {
    idKanji: row.id_kanji,
    character: row.character_kanji,
    meaning: row.meaning ?? null,
    jlptLevel: row.jlpt_level ?? null,
    status: row.status ?? null,
    userOnyomi: toNullableString(row.user_onyomi),
    userKunyomi: toNullableString(row.user_kunyomi),
    userProvenance: READING_PROVENANCE.USER,
    reference: row.reference_id === null || row.reference_id === undefined
      ? null
      : {
          onyomi: refOnyomi,
          kunyomi: refKunyomi,
          meanings: refMeanings,
          provenance: READING_PROVENANCE.REFERENCE,
          contextualOnly: true
        },
    // Level A: no verified source supplies per-kanji alignment, so this is
    // always null. Any future Level B must set it only from explicit lexical
    // evidence, never from string matching.
    readingSegment: null,
    readingProvenance: READING_PROVENANCE.UNVERIFIED
  };
}

// Builds the additive reading context for a vocabulary detail response.
// `entry` is the vocabulary row; `kanjiRows` are the joined kanji rows.
function buildVocabularyReadingContext(entry, kanjiRows) {
  const rows = Array.isArray(kanjiRows) ? kanjiRows : [];
  return {
    wordReading: {
      value: entry && entry.reading ? String(entry.reading) : null,
      provenance: READING_PROVENANCE.AUTHORITATIVE,
      note: 'Authoritative full-word reading recorded on this vocabulary entry.'
    },
    kanji: rows.map(buildKanjiReadingEntry),
    notice: CONTEXT_NOTICE
  };
}

// Phase 5 enhancement: reading/reference context for EVERY unique Han
// character literally present in the vocabulary word — not just the user's
// linked kanji. `characters` is the ordered unique Han list from the word;
// `userKanjiRows` are the requester's kanji for those characters (one batched
// query); `referenceRows` are the shared kanji_reference rows (one batched
// query). Missing user kanji are reported explicitly (inUserCollection:
// false, userKanji: null) and must be imported via explicit user action —
// never auto-created here. No per-kanji reading is ever inferred.
function buildFullVocabularyReadingContext(entry, characters, userKanjiRows, referenceRows) {
  const chars = Array.isArray(characters) ? characters : [];
  const usersByChar = new Map();
  for (const row of Array.isArray(userKanjiRows) ? userKanjiRows : []) {
    if (row && typeof row.character_kanji === 'string' && !usersByChar.has(row.character_kanji)) {
      usersByChar.set(row.character_kanji, row);
    }
  }
  const refsByChar = new Map();
  for (const row of Array.isArray(referenceRows) ? referenceRows : []) {
    if (row && typeof row.character === 'string' && !refsByChar.has(row.character)) {
      refsByChar.set(row.character, row);
    }
  }
  return {
    wordReading: {
      value: entry && entry.reading ? String(entry.reading) : null,
      provenance: READING_PROVENANCE.AUTHORITATIVE,
      note: 'Authoritative full-word reading recorded on this vocabulary entry.'
    },
    kanji: chars.map((character) => {
      const userRow = usersByChar.get(character) || null;
      const refRow = refsByChar.get(character) || null;
      const refOnyomi = toStringArray(refRow && refRow.onyomi);
      const refKunyomi = toStringArray(refRow && refRow.kunyomi);
      const refMeanings = toStringArray(refRow && refRow.meanings);
      return {
        character,
        inUserCollection: userRow !== null,
        userKanji: userRow ? {
          idKanji: userRow.id_kanji,
          meaning: userRow.meaning ?? null,
          jlptLevel: userRow.jlpt_level ?? null,
          status: userRow.status ?? null,
          onyomi: toNullableString(userRow.user_onyomi),
          kunyomi: toNullableString(userRow.user_kunyomi)
        } : null,
        // Flattened mirrors (compatibility with Level-A consumers).
        // jlptLevel stays user-only; reference JLPT lives under reference
        // so the two are never conflated.
        idKanji: userRow ? userRow.id_kanji : null,
        meaning: userRow ? (userRow.meaning ?? null) : null,
        jlptLevel: userRow ? (userRow.jlpt_level ?? null) : null,
        status: userRow ? (userRow.status ?? null) : null,
        userOnyomi: toNullableString(userRow && userRow.user_onyomi),
        userKunyomi: toNullableString(userRow && userRow.user_kunyomi),
        userProvenance: READING_PROVENANCE.USER,
        reference: refRow ? {
          onyomi: refOnyomi,
          kunyomi: refKunyomi,
          meanings: refMeanings,
          jlptLevel: refRow.jlpt_level ?? null,
          provenance: READING_PROVENANCE.REFERENCE,
          contextualOnly: true
        } : null,
        readingSegment: null,
        readingProvenance: READING_PROVENANCE.UNVERIFIED
      };
    }),
    notice: CONTEXT_NOTICE
  };
}

module.exports = {
  CONTEXT_NOTICE,
  READING_PROVENANCE,
  buildFullVocabularyReadingContext,
  buildKanjiReadingEntry,
  buildVocabularyReadingContext,
  toNullableString,
  toStringArray
};
