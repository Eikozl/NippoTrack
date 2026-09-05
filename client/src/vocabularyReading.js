// Phase 5 — Reading-Aware Vocabulary (Level A), client-side helpers.
//
// The vocabulary's full word reading is authoritative for the entry.
// Per-kanji readings are NEVER derived from it: no kana splitting, no
// substring matching (今日=きょう, 大人=おとな, 明日=あした are indivisible).
// Reference onyomi/kunyomi are contextual inventories only.

export const VOCAB_READING_NOTICE =
  'Reference readings are general inventories for each kanji and are not derived from this word\u2019s reading. ' +
  'Per-kanji alignment is unverified: some words use special whole-word readings (jukujikun/ateji) or sound changes ' +
  '(rendaku/onbin) with no direct correspondence.';

// Defensive accessor: older API payloads may lack readingContext.
export function getReadingContext(item) {
  if (!item || typeof item !== 'object') return null;
  const context = item.readingContext;
  if (!context || typeof context !== 'object') return null;
  return context;
}

export function getContextKanji(item) {
  const context = getReadingContext(item);
  if (!context || !Array.isArray(context.kanji)) return [];
  return context.kanji;
}

// Phase 6 — Kanji Discovery from Sessions. Defensive accessor: older API
// payloads may lack kanjiDiscovery.
export function getDiscoveryContext(item) {
  if (!item || typeof item !== 'object') return null;
  const discovery = item.kanjiDiscovery;
  if (!discovery || typeof discovery !== 'object') return null;
  return discovery;
}

export function getDiscoveryKanji(item) {
  const discovery = getDiscoveryContext(item);
  if (!discovery || !Array.isArray(discovery.kanji)) return [];
  return discovery.kanji;
}

// Maps a formatted kanji-context entry to its Phase 6 discovery state:
// already in the user's collection, available from reference, or without
// reference data. Discovery never claims per-kanji readings.
export function getDiscoveryState(formattedEntry) {
  if (!formattedEntry || typeof formattedEntry !== 'object') return 'noReferenceData';
  if (formattedEntry.inUserCollection) return 'alreadyInCollection';
  if (formattedEntry.importable) return 'availableToAdd';
  return 'noReferenceData';
}

// Level A invariant: no per-kanji segment may ever be claimed.
// Empty/whitespace-only strings count as unclaimed, same as null.
export function hasClaimedSegment(entry) {
  if (!entry || entry.readingSegment === null || entry.readingSegment === undefined) return false;
  if (typeof entry.readingSegment === 'string' && !entry.readingSegment.trim()) return false;
  return true;
}

function joinList(value) {
  if (Array.isArray(value)) {
    const cleaned = value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
    return cleaned.length ? cleaned.join(' · ') : null;
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

export function formatKanjiContextEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const reference = entry.reference && typeof entry.reference === 'object' ? entry.reference : null;
  const userKanji = entry.userKanji && typeof entry.userKanji === 'object' ? entry.userKanji : null;
  const inUserCollection = entry.inUserCollection === true || userKanji !== null;
  return {
    character: entry.character || '',
    inUserCollection,
    userKanji,
    meaning: entry.meaning || userKanji?.meaning || null,
    jlptLevel: entry.jlptLevel || userKanji?.jlptLevel || null,
    status: entry.status || userKanji?.status || null,
    userOnyomi: entry.userOnyomi || userKanji?.onyomi || null,
    userKunyomi: entry.userKunyomi || userKanji?.kunyomi || null,
    referenceOnyomi: joinList(reference?.onyomi),
    referenceKunyomi: joinList(reference?.kunyomi),
    referenceMeanings: joinList(reference?.meanings),
    referenceJlptLevel: reference?.jlptLevel || null,
    hasReference: reference !== null,
    // Importable only when reference meanings exist (kanji creation
    // requires a meaning) — otherwise the user adds it manually.
    importable: !inUserCollection && (reference?.meanings?.length || 0) > 0,
    // Always null in Level A; surfaced so the UI can state it explicitly.
    readingSegment: entry.readingSegment ?? null,
    unverified: (entry.readingProvenance || 'unverified') === 'unverified'
  };
}

// Builds the POST /api/kanji payload that imports a missing kanji from its
// reference context, following existing creation conventions (comma-joined
// readings/meanings; server resolves reference_id and defaults).
// Returns null when the entry cannot be imported as-is.
export function buildKanjiImportPayload(entry) {
  const formatted = formatKanjiContextEntry(entry);
  if (!formatted || formatted.inUserCollection || !formatted.importable) return null;
  const reference = entry.reference && typeof entry.reference === 'object' ? entry.reference : null;
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).join(', ') : '');
  return {
    character_kanji: formatted.character,
    meaning: list(reference?.meanings),
    onyomi: list(reference?.onyomi),
    kunyomi: list(reference?.kunyomi),
    jlpt_level: reference?.jlptLevel || '',
    status: 'New'
  };
}
