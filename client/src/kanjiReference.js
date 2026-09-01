const singleHanCodePoint = /^\p{Script=Han}$/u;
const canonicalKanjiFieldNames = ['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level'];

export function isSingleHanCodePoint(value) {
  return typeof value === 'string' && singleHanCodePoint.test(value);
}

export function kanjiReferenceRoute(character) {
  return isSingleHanCodePoint(character) ? `kanji-reference/${encodeURIComponent(character)}` : null;
}

export function parseKanjiReferenceRoute(pageName) {
  const prefix = 'kanji-reference/';
  if (typeof pageName !== 'string' || !pageName.startsWith(prefix)) return null;
  try {
    const character = decodeURIComponent(pageName.slice(prefix.length));
    return isSingleHanCodePoint(character) ? character : null;
  } catch {
    return null;
  }
}

export function transliteratedValue(transliteration, script) {
  if (!transliteration || (script !== 'hiragana' && script !== 'katakana')) return null;
  return typeof transliteration[script] === 'string' && transliteration[script] ? transliteration[script] : null;
}

export function applyPristineKanjiAutofill(fields, dirtyFields, reference) {
  const values = {
    meaning: reference.meanings?.join(', ') || '',
    onyomi: reference.onyomi?.join(', ') || '',
    kunyomi: reference.kunyomi?.join(', ') || '',
    jlpt_level: reference.jlptLevel || ''
  };

  Object.entries(values).forEach(([name, value]) => {
    if (fields[name] && !dirtyFields.has(name)) fields[name].value = value;
  });
}

export function changedKanjiReferenceFields(original, values) {
  return canonicalKanjiFieldNames.filter((name) => String(original[name] ?? '') !== String(values[name] ?? ''));
}
