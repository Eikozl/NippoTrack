const HAN_CHARACTER_PATTERN = /\p{Script=Han}/gu;

function extractUniqueKanji(text) {
  if (typeof text !== 'string') return [];
  return [...new Set(text.match(HAN_CHARACTER_PATTERN) || [])];
}

// Phase 8 — deterministic Han occurrence scan over arbitrary pasted text.
// Single O(n) pass; returns first-occurrence-ordered entries so analysis
// preserves stable order and occurrence counts without re-scanning.
// Non-string input yields []. kana/Latin/punctuation never match.
function extractHanOccurrences(text) {
  if (typeof text !== 'string') return [];
  const counts = new Map();
  for (const character of text.match(HAN_CHARACTER_PATTERN) || []) {
    counts.set(character, (counts.get(character) || 0) + 1);
  }
  return [...counts].map(([character, occurrences]) => ({ character, occurrences }));
}

async function syncVocabularyKanjiLinks(executor, { userId, vocabularyId, word }) {
  const characters = extractUniqueKanji(word);
  const ownershipParams = [vocabularyId, userId, userId];
  const retainedCharactersSql = characters.length
    ? ` AND k.character_kanji NOT IN (${characters.map(() => '?').join(', ')})`
    : '';

  await executor.execute(
    `DELETE FROM kanji_vocabulary kv
     USING kanji k, vocabulary v
     WHERE kv.id_kanji = k.id_kanji
       AND kv.id_vocabulary = v.id_vocabulary
       AND kv.id_vocabulary = ?
       AND k.user_id = ?
       AND v.user_id = ?${retainedCharactersSql}`,
    [...ownershipParams, ...characters]
  );

  if (!characters.length) return characters;

  await executor.execute(
    `INSERT INTO kanji_vocabulary (id_kanji, id_vocabulary)
     SELECT k.id_kanji, ?
     FROM kanji k
     JOIN vocabulary v ON v.id_vocabulary = ? AND v.user_id = ?
     WHERE k.user_id = ?
       AND k.character_kanji IN (${characters.map(() => '?').join(', ')})
     ON CONFLICT (id_kanji, id_vocabulary) DO NOTHING`,
    [vocabularyId, vocabularyId, userId, userId, ...characters]
  );

  return characters;
}

module.exports = { extractHanOccurrences, extractUniqueKanji, syncVocabularyKanjiLinks };
