// Phase 12-A — lexicalTokenAdapter tests: normalized contract, offsets,
// hiragana readings, POS mapping, null handling, unknown words, and the
// invariant that whole-word readings are never split across kanji.
// Pure unit tests: handcrafted raw engine tokens, no dictionary load.
const test = require('node:test');
const assert = require('node:assert/strict');

const { adaptToken, adaptTokens, classifyCandidate, normalizePos } = require('../src/services/lexicalTokenAdapter');

const ENGINE = { name: 'kuromoji', dictionary: 'ipadic', dictionaryVersion: null, adapterVersion: 1 };

function raw(overrides) {
  return {
    surface_form: '学校',
    pos: '名詞',
    pos_detail_1: '一般',
    pos_detail_2: '*',
    pos_detail_3: '*',
    conjugated_type: '*',
    conjugated_form: '*',
    basic_form: '学校',
    reading: 'ガッコウ',
    pronunciation: 'ガッコー',
    word_type: 'KNOWN',
    word_position: 1,
    ...overrides
  };
}

test('normalized contract exposes exactly the JLT-owned schema', () => {
  const token = adaptToken(raw(), ENGINE);
  assert.deepEqual(Object.keys(token).sort(), [
    'end', 'engine', 'inflectionForm', 'inflectionType', 'isContentWord', 'isUnknown',
    'lemma', 'lemmaReading', 'pos', 'posDetail', 'start', 'surface', 'surfaceReading'
  ].sort());
  assert.deepEqual(token.engine, ENGINE);
});

test('offsets use code-point indexes against the original text', () => {
  const text = 'A𠀋学校B';
  const tokens = adaptTokens(
    [raw({ surface_form: 'A', basic_form: '*', reading: '', pronunciation: '', word_type: 'UNKNOWN', word_position: 1 }),
     raw({ surface_form: '学校', word_position: 3 })],
    text,
    ENGINE
  );
  assert.deepEqual([tokens[1].start, tokens[1].end], [2, 4]);
  const chars = Array.from(text);
  for (const token of tokens) {
    assert.equal(chars.slice(token.start, token.end).join(''), token.surface);
  }
});

test('surfaceReading is the occurrence pronunciation; lemmaReading only for observed dictionary forms', () => {
  const school = adaptToken(raw(), ENGINE);
  assert.equal(school.surfaceReading, 'がっこー'); // pronunciation ガッコー, not がっこう
  assert.equal(school.lemmaReading, 'がっこう'); // surface === basic_form
  const particle = adaptToken(raw({
    surface_form: 'は', pos: '助詞', pos_detail_1: '係助詞', basic_form: 'は', reading: 'ハ', pronunciation: 'ワ', word_position: 2
  }), ENGINE);
  assert.equal(particle.surfaceReading, 'わ');
  assert.equal(particle.lemmaReading, 'は');
  const inflected = adaptToken(raw({
    surface_form: '行っ', pos: '動詞', pos_detail_1: '自立',
    conjugated_type: '五段・カ行促音便', conjugated_form: '連用タ接続',
    basic_form: '行く', reading: 'イッ', pronunciation: 'イッ', word_position: 6
  }), ENGINE);
  assert.equal(inflected.lemma, '行く');
  assert.equal(inflected.surfaceReading, 'いっ');
  assert.equal(inflected.lemmaReading, null); // イッ is a fragment, not いく — never invent
});

test('POS normalization covers the IPADIC coarse set', () => {
  const cases = [
    [{ pos: '名詞', pos_detail_1: '一般' }, 'noun'],
    [{ pos: '名詞', pos_detail_1: '固有名詞' }, 'proper-noun'],
    [{ pos: '名詞', pos_detail_1: '形容動詞語幹' }, 'na-adjective'],
    [{ pos: '名詞', pos_detail_1: '数' }, 'noun'],
    [{ pos: '名詞', pos_detail_1: '接尾' }, 'suffix'],
    [{ pos: '名詞', pos_detail_1: 'サ変接続' }, 'noun'],
    [{ pos: '動詞', pos_detail_1: '自立' }, 'verb'],
    [{ pos: '動詞', pos_detail_1: '非自立' }, 'auxiliary'],
    [{ pos: '形容詞', pos_detail_1: '自立' }, 'i-adjective'],
    [{ pos: '副詞' }, 'adverb'],
    [{ pos: '連体詞' }, 'adnominal'],
    [{ pos: '接続詞' }, 'conjunction'],
    [{ pos: '感動詞' }, 'interjection'],
    [{ pos: 'フィラー' }, 'interjection'],
    [{ pos: '助詞', pos_detail_1: '係助詞' }, 'particle'],
    [{ pos: '助動詞', conjugated_type: '特殊・タ', basic_form: 'た' }, 'auxiliary'],
    [{ pos: '助動詞', conjugated_type: '特殊・ダ', basic_form: 'だ' }, 'copula'],
    [{ pos: '助動詞', conjugated_type: '特殊・デス', basic_form: 'です' }, 'copula'],
    [{ pos: '助動詞', conjugated_type: '特殊・ダ', conjugated_form: '体言接続', basic_form: 'だ' }, 'copula'],
    [{ pos: '接頭詞' }, 'prefix'],
    [{ pos: '接尾辞' }, 'suffix'],
    [{ pos: '記号', pos_detail_1: '句点' }, 'symbol'],
    [{ pos: '名詞', pos_detail_1: '一般', word_type: 'UNKNOWN' }, 'unknown']
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizePos({ pos_detail_1: '*', word_type: 'KNOWN', ...input }), expected, JSON.stringify(input));
  }
});

test('engine "*" and empty readings become null; original surface preserved', () => {
  const token = adaptToken(raw({
    surface_form: 'ｺﾝﾋﾟｭｰﾀｰ', basic_form: '*', reading: '', pronunciation: '',
    pos: '名詞', pos_detail_1: '一般', word_type: 'UNKNOWN', word_position: 1
  }), ENGINE);
  assert.equal(token.lemma, null);
  assert.equal(token.surfaceReading, null);
  assert.equal(token.lemmaReading, null);
  assert.equal(token.isUnknown, true);
  assert.equal(token.surface, 'ｺﾝﾋﾟｭｰﾀｰ'); // half-width original untouched
  assert.equal(token.inflectionType, null);
  assert.deepEqual(token.posDetail, ['一般', null, null]);
});

test('proper nouns withhold readings; symbols withhold readings', () => {
  const name = adaptToken(raw({
    surface_form: '田中', pos: '名詞', pos_detail_1: '固有名詞', basic_form: '田中',
    reading: 'タナカ', pronunciation: 'タナカ', word_position: 1
  }), ENGINE);
  assert.equal(name.pos, 'proper-noun');
  assert.equal(name.surfaceReading, null);
  assert.equal(name.lemmaReading, null);
  const punct = adaptToken(raw({
    surface_form: '。', pos: '記号', pos_detail_1: '句点', basic_form: '。',
    reading: '。', pronunciation: '。', word_position: 9
  }), ENGINE);
  assert.equal(punct.surfaceReading, null);
  assert.equal(punct.lemmaReading, null);
});

test('whole-word readings are never split across kanji', () => {
  const token = adaptToken(raw(), ENGINE);
  for (const value of [token.surfaceReading, token.lemmaReading]) {
    assert.ok(!value.includes(' '), 'no partitioned reading');
  }
  // The adapter exposes no per-kanji reading field at all.
  assert.ok(!('kanjiReadings' in token) && !('readingSegments' in token));
});

test('classifier separates candidates from function/unknown tokens', () => {
  const candidate = (pos, extra = {}) => classifyCandidate({ pos, isUnknown: false, posDetail: [], ...extra });
  assert.deepEqual(candidate('noun'), { candidate: true, reason: 'content-word' });
  assert.deepEqual(candidate('verb'), { candidate: true, reason: 'content-word' });
  assert.deepEqual(candidate('i-adjective'), { candidate: true, reason: 'content-word' });
  assert.deepEqual(candidate('na-adjective'), { candidate: true, reason: 'content-word' });
  assert.deepEqual(candidate('adverb'), { candidate: true, reason: 'content-word' });
  assert.deepEqual(candidate('interjection'), { candidate: true, reason: 'content-word' });
  assert.deepEqual(candidate('particle'), { candidate: false, reason: 'function-word' });
  assert.deepEqual(candidate('auxiliary'), { candidate: false, reason: 'function-word' });
  assert.deepEqual(candidate('copula'), { candidate: false, reason: 'function-word' });
  assert.deepEqual(candidate('conjunction'), { candidate: false, reason: 'function-word' });
  assert.deepEqual(candidate('adnominal'), { candidate: false, reason: 'function-word' });
  assert.deepEqual(candidate('prefix'), { candidate: false, reason: 'function-word' });
  assert.deepEqual(candidate('suffix'), { candidate: false, reason: 'function-word' });
  assert.deepEqual(candidate('symbol'), { candidate: false, reason: 'symbol' });
  assert.deepEqual(candidate('proper-noun'), { candidate: false, reason: 'proper-noun' });
  assert.deepEqual(candidate('noun', { posDetail: ['数', null, null] }), { candidate: false, reason: 'numeral' });
  assert.deepEqual(classifyCandidate({ pos: 'noun', isUnknown: true, posDetail: [] }), { candidate: false, reason: 'unknown' });
  assert.deepEqual(classifyCandidate(null), { candidate: false, reason: 'unknown' });
});

test('adaptTokens rejects non-string input and tolerates empty streams', () => {
  assert.throws(() => adaptTokens([], 123), TypeError);
  assert.deepEqual(adaptTokens([], '学校', ENGINE), []);
  assert.deepEqual(adaptTokens(null, '学校', ENGINE), []);
});
