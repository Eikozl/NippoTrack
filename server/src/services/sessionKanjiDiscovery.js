// Phase 6 — Kanji Discovery from Sessions.
//
// Deterministic character extraction, NOT NLP: for every unique Han
// character literally present in the authoritative session-writing text
// (session_writings.content — the same source Phase 3 encounter extraction
// scans), report collection/reference discovery state. No word
// segmentation, no grammar parsing, no reading inference, no vocabulary
// extraction, no semantic interpretation.
//
// Discovery states:
// - alreadyInCollection: the character is in the requester's kanji collection
// - availableToAdd: not collected, but kanji_reference has usable data
//   (meanings) so it can be imported via explicit user action (Phase 7)
// - noReferenceData: neither collected nor usable reference data; nothing
//   may be fabricated for these characters.
//
// Reference readings/meanings are shared informational inventories only,
// never claims about the session text. Per-character reading segments are
// never inferred (readingSegment: null, provenance 'unverified').

const { extractUniqueKanji } = require('./kanjiVocabularyLinks');
const {
  READING_PROVENANCE,
  toNullableString,
  toStringArray
} = require('./vocabularyReading');

const DISCOVERY_STATES = Object.freeze({
  IN_COLLECTION: 'alreadyInCollection',
  AVAILABLE: 'availableToAdd',
  NO_REFERENCE: 'noReferenceData'
});

const DISCOVERY_SOURCE = 'session_writing';

const DISCOVERY_NOTICE =
  'Kanji below were detected as individual characters present in this session\u2019s writing content. ' +
  'Reference readings and meanings are general inventories for each character, not readings used in this text. ' +
  'Nothing has been added to your collection.';

// Aggregates Han characters across session-writing text sources in memory.
// Accepts an array of texts (normally the session's writing content rows);
// returns ordered first-occurrence-unique Han characters. Non-string inputs
// are ignored. kana-only content yields [].
function extractDiscoveryCharacters(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  return extractUniqueKanji(list.filter((text) => typeof text === 'string').join(''));
}

// Builds the additive discovery payload for a session detail response.
// `characters` is the ordered unique Han list from the session text;
// `userKanjiRows` are the requester's kanji for those characters (one
// batched query); `referenceRows` are the shared kanji_reference rows (one
// batched query). Pure in-memory join — no SQL here, no auto-creation.
function buildSessionKanjiDiscovery(characters, userKanjiRows, referenceRows) {
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
    source: DISCOVERY_SOURCE,
    characters: [...chars],
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
        // Flattened mirrors (same conventions as the vocabulary reading
        // context, so client formatters can be shared). jlptLevel stays
        // user-only; reference JLPT lives under reference.
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
          strokeCount: refRow.stroke_count ?? null,
          provenance: READING_PROVENANCE.REFERENCE,
          contextualOnly: true
        } : null,
        discoveryState: userRow !== null
          ? DISCOVERY_STATES.IN_COLLECTION
          : (refRow && refMeanings.length ? DISCOVERY_STATES.AVAILABLE : DISCOVERY_STATES.NO_REFERENCE),
        // Discovery never claims how a character reads in the session text.
        readingSegment: null,
        readingProvenance: READING_PROVENANCE.UNVERIFIED
      };
    }),
    notice: DISCOVERY_NOTICE
  };
}

module.exports = {
  DISCOVERY_NOTICE,
  DISCOVERY_SOURCE,
  DISCOVERY_STATES,
  buildSessionKanjiDiscovery,
  extractDiscoveryCharacters
};
