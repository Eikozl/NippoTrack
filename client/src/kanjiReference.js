const singleHanCodePoint = /^\p{Script=Han}$/u;

export function isSingleHanCodePoint(value) {
  return typeof value === 'string' && singleHanCodePoint.test(value);
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
