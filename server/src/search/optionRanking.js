const {
  hiraganaToRomaji,
  normalizeJapaneseReading
} = require('./japaneseSearch');

function comparable(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function includes(value, query) {
  return Boolean(query) && comparable(value).includes(comparable(query));
}

function startsWith(value, query) {
  return Boolean(query) && comparable(value).startsWith(comparable(query));
}

function exact(value, query) {
  return Boolean(query) && comparable(value) === comparable(query);
}

function proseMatches(value, candidates) {
  return candidates.normalizedRomaji ? false : includes(value, candidates.raw);
}

function finish(items, limit, idKey, preserveOrder = false) {
  const matches = items.filter(({ matched }) => matched);
  if (!preserveOrder) {
    matches.sort((left, right) => left.score - right.score
      || comparable(left.displayRomaji).length - comparable(right.displayRomaji).length
      || Number(right.item[idKey]) - Number(left.item[idKey]));
  }
  return matches
    .slice(0, limit)
    .map(({ item, displayRomaji }) => ({ ...item, displayRomaji }));
}

function rankVocabularyOptions(rows, candidates, limit) {
  return finish(rows.map((item) => {
    const normalizedWord = normalizeJapaneseReading(item.word || '');
    const normalizedReading = normalizeJapaneseReading(item.reading || '');
    const displayRomaji = (normalizedReading ? hiraganaToRomaji(normalizedReading) : null)
      || (normalizedWord ? hiraganaToRomaji(normalizedWord) : null);
    const directMatch = [item.word, item.reading].some((value) => includes(value, candidates.raw))
      || proseMatches(item.meaning, candidates);
    const romajiMatch = includes(displayRomaji, candidates.normalizedRomaji);
    const japaneseMatch = [normalizedWord, normalizedReading]
      .some((value) => includes(value, candidates.normalizedJapanese));
    const matched = !candidates.raw || directMatch || romajiMatch
      || ((!candidates.normalizedRomaji || candidates.romajiComplete) && japaneseMatch);
    let score = 8;
    if (exact(item.word, candidates.raw)) score = 1;
    else if (exact(item.reading, candidates.raw)
      || [normalizedWord, normalizedReading].some((value) => exact(value, candidates.normalizedJapanese))) score = 2;
    else if (exact(displayRomaji, candidates.normalizedRomaji)) score = 3;
    else if (startsWith(item.word, candidates.raw)) score = 4;
    else if ([normalizedWord, normalizedReading]
      .some((value) => startsWith(value, candidates.normalizedJapanese))) score = 5;
    else if (startsWith(displayRomaji, candidates.normalizedRomaji)) score = 6;
    else if (startsWith(item.meaning, candidates.raw)) score = 7;
    return { item, displayRomaji, matched, score };
  }), limit, 'id_vocabulary', !candidates.raw);
}

function rankKanjiOptions(rows, candidates, limit) {
  return finish(rows.map((item) => {
    const normalizedOnyomi = normalizeJapaneseReading(item.onyomi || '');
    const normalizedKunyomi = normalizeJapaneseReading(item.kunyomi || '');
    const onyomiRomaji = normalizedOnyomi ? hiraganaToRomaji(normalizedOnyomi) : null;
    const kunyomiRomaji = normalizedKunyomi ? hiraganaToRomaji(normalizedKunyomi) : null;
    const displayRomaji = [onyomiRomaji, kunyomiRomaji].filter(Boolean).join(' / ') || null;
    const directMatch = [item.character_kanji, item.onyomi, item.kunyomi]
      .some((value) => includes(value, candidates.raw))
      || proseMatches(item.meaning, candidates);
    const romajiMatch = [onyomiRomaji, kunyomiRomaji]
      .some((value) => includes(value, candidates.normalizedRomaji));
    const japaneseMatch = [normalizedOnyomi, normalizedKunyomi]
      .some((value) => includes(value, candidates.normalizedJapanese));
    const matched = !candidates.raw || directMatch || romajiMatch
      || ((!candidates.normalizedRomaji || candidates.romajiComplete) && japaneseMatch);
    let score = 7;
    if (exact(item.character_kanji, candidates.raw)) score = 1;
    else if ([normalizedOnyomi, normalizedKunyomi].some((value) => exact(value, candidates.normalizedJapanese))) score = 2;
    else if ([onyomiRomaji, kunyomiRomaji].some((value) => exact(value, candidates.normalizedRomaji))) score = 3;
    else if ([normalizedOnyomi, normalizedKunyomi].some((value) => startsWith(value, candidates.normalizedJapanese))) score = 4;
    else if ([onyomiRomaji, kunyomiRomaji].some((value) => startsWith(value, candidates.normalizedRomaji))) score = 5;
    else if (startsWith(item.meaning, candidates.raw)) score = 6;
    return { item, displayRomaji, matched, score };
  }), limit, 'id_kanji', !candidates.raw);
}

function rankGrammarOptions(rows, candidates, limit) {
  return finish(rows.map((item) => {
    const normalizedPoint = normalizeJapaneseReading(item.grammar_point || '');
    const displayRomaji = normalizedPoint ? hiraganaToRomaji(normalizedPoint) : null;
    const directMatch = includes(item.grammar_point, candidates.raw)
      || [item.meaning, item.structure, item.example]
        .some((value) => proseMatches(value, candidates));
    const romajiMatch = includes(displayRomaji, candidates.normalizedRomaji);
    const japaneseMatch = includes(normalizedPoint, candidates.normalizedJapanese);
    const matched = !candidates.raw || directMatch || romajiMatch
      || ((!candidates.normalizedRomaji || candidates.romajiComplete) && japaneseMatch);
    let score = 7;
    if (exact(item.grammar_point, candidates.raw)) score = 1;
    else if (exact(normalizedPoint, candidates.normalizedJapanese)) score = 2;
    else if (exact(displayRomaji, candidates.normalizedRomaji)) score = 3;
    else if (startsWith(normalizedPoint, candidates.normalizedJapanese)) score = 4;
    else if (startsWith(displayRomaji, candidates.normalizedRomaji)) score = 5;
    else if (startsWith(item.meaning, candidates.raw)) score = 6;
    return { item, displayRomaji, matched, score };
  }), limit, 'id_grammar', !candidates.raw);
}

module.exports = {
  rankGrammarOptions,
  rankKanjiOptions,
  rankVocabularyOptions
};
