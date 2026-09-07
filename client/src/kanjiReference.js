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

function findInput(content, name) {
  return content.map((item) => item.matches?.(`[name="${name}"]`) ? item : item.querySelector?.(`[name="${name}"]`)).find(Boolean);
}

export function enableRomajiConversion(content, config, request) {
  if (typeof request !== 'function') return;
  Object.entries(config.japaneseTextFields || {}).forEach(([name, script]) => {
    const input = findInput(content, name);
    if (!input) return;
    input.addEventListener('blur', async () => {
      const original = input.value.trim();
      if (!original) return;
      try {
        const result = await request(`/api/kanji/reference?search=${encodeURIComponent(original)}&limit=1`);
        const converted = transliteratedValue(result.transliteration, script);
        if (converted && input.value.trim() === original) input.value = converted;
      } catch {
        // Leave the user's value unchanged when the reference service is unavailable.
      }
    });
  });
}

export function existingKanjiFromDuplicateError(error) {
  const existing = error?.status === 409 ? error.data?.existingKanji : null;
  if (!existing || !Number.isInteger(existing.idKanji) || existing.idKanji < 1 || !isSingleHanCodePoint(existing.character)) return null;
  return {
    idKanji: existing.idKanji,
    character: existing.character,
    meaning: typeof existing.meaning === 'string' ? existing.meaning : '',
    jlptLevel: typeof existing.jlptLevel === 'string' ? existing.jlptLevel : null,
    status: typeof existing.status === 'string' ? existing.status : null
  };
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
