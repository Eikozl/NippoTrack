const ALLOWED_READING_COLUMNS = new Set(['word', 'reading', 'onyomi', 'kunyomi', 'grammar_point']);
const READING_DECORATIONS = [
  '.', '．', '・', '･', '·', ' ', '　', '〜', '～', '~', '/', '／',
  ',', '，', '、', ';', '；', ':', '：', '(', ')', '（', '）', '[', ']', '【', '】'
];

function normalizedJapaneseSql(column) {
  if (!ALLOWED_READING_COLUMNS.has(column)) {
    throw new TypeError(`Unsupported reading column: ${column}`);
  }
  return READING_DECORATIONS.reduce(
    (expression, decoration) => `REPLACE(${expression}, '${decoration}', '')`,
    `COALESCE(${column}, '')`
  );
}

function kanaSearchValues(candidates) {
  return Array.from(new Set((candidates.kanaCandidates || [])
    .flatMap(({ hiragana, katakana }) => [hiragana, katakana])
    .filter(Boolean)));
}

function buildComparisons(expressions, values, { operator = 'LIKE', pattern = 'contains' } = {}) {
  const comparisons = [];
  const params = [];
  expressions.forEach((expression) => {
    values.forEach((value) => {
      comparisons.push(`${expression} ${operator} ?`);
      if (operator === '=') params.push(value);
      else if (pattern === 'prefix') params.push(`${value}%`);
      else params.push(`%${value}%`);
    });
  });
  return { sql: comparisons.join(' OR '), params };
}

module.exports = {
  buildComparisons,
  kanaSearchValues,
  normalizedJapaneseSql
};
