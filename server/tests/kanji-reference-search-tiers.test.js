const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildSearchCandidates,
  classifyReferenceQuery,
  dakutenVariants,
  expandReferenceReadings,
  longVowelVariants,
  stripReadingHyphens
} = require('../src/search/japaneseSearch');
const { searchKanjiReferences } = require('../src/services/kanjiReference');

function classify(raw) {
  return classifyReferenceQuery(raw, buildSearchCandidates(raw));
}

// ---------- Part B: intent classification ----------

test('classify: Han input is han', () => {
  assert.equal(classify('俺').primary, 'han');
  assert.equal(classify('日').primary, 'han');
  assert.ok(classify('俺').hasHan);
});

test('classify: kana input is kana', () => {
  assert.equal(classify('おれ').primary, 'kana');
  assert.equal(classify('オレ').primary, 'kana');
});

test('classify: complete romaji is romaji but keeps both channels', () => {
  const result = classify('ore');
  assert.equal(result.primary, 'romaji');
  assert.ok(result.romajiComplete);
});

test('classify: partial latin is meaning, never forced into romaji', () => {
  assert.equal(classify('water').primary, 'meaning');
  assert.equal(classify('before').primary, 'meaning');
});

test('classify: single-letter latin stays dual-channel via tiers', () => {
  const result = classify('I');
  assert.equal(result.primary, 'romaji');
  assert.ok(result.romajiComplete);
});

// ---------- Part D: normalization ----------

test('dakuten variants cover ず/づ and じ/ぢ symmetrically without global rewrite', () => {
  assert.ok(dakutenVariants('つづく').includes('つずく'));
  assert.ok(dakutenVariants('つずく').includes('つづく'));
  assert.ok(dakutenVariants('ちぢむ').includes('ちじむ'));
  assert.ok(dakutenVariants('か').includes('か'));
  assert.equal(dakutenVariants('つづく').length, 2);
});

test('long-vowel variants cover plain-vowel and ー forms', () => {
  assert.ok(longVowelVariants('だあす').includes('だーす'));
  assert.ok(longVowelVariants('だーす').includes('だあす'));
  assert.ok(longVowelVariants('おう').includes('おー'));
  assert.ok(longVowelVariants('か').includes('か'));
});

test('reading hyphens strip for search comparison only', () => {
  assert.equal(stripReadingHyphens('-うえ'), 'うえ');
  assert.equal(stripReadingHyphens('ひと-'), 'ひと');
  assert.equal(stripReadingHyphens('おれ'), 'おれ');
});

test('expandReferenceReadings weights strong above weak and stays bounded', () => {
  const expanded = expandReferenceReadings(buildSearchCandidates('ore'));
  const strongValues = expanded.strong.map((entry) => entry.hiragana);
  const weakValues = expanded.weak.map((entry) => entry.hiragana);
  assert.ok(strongValues.includes('おれ'));
  assert.ok(expanded.strong.length <= 24);
  assert.ok(expanded.weak.length <= 16);
  const direct = expandReferenceReadings(buildSearchCandidates('おれ'));
  assert.deepEqual(direct.weak, []);
  assert.ok(direct.strong.some((entry) => entry.hiragana === 'おれ'));
});

test('expandReferenceReadings resolves dakuten round-trip for tsuzuku', () => {
  const expanded = expandReferenceReadings(buildSearchCandidates('tsuzuku'));
  const values = expanded.strong.map((entry) => entry.hiragana);
  assert.ok(values.includes('つずく'));
  assert.ok(values.includes('つづく'));
});

// ---------- Part C: tiered SQL shape ----------

function captureDb(rows = []) {
  const calls = [];
  return {
    calls,
    db: { execute: async (sql, params) => { calls.push({ sql, params }); return [rows]; } }
  };
}

function tierOrder(sql) {
  const relevanceCase = sql.slice(0, sql.indexOf('ELSE'));
  return [...relevanceCase.matchAll(/THEN (\d+)/g)].map((match) => Number(match[1]));
}

test('tiers order relevance before JLPT for ore', async () => {
  const { calls, db } = captureDb([]);
  await searchKanjiReferences('ore', 20, db);
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.deepEqual(tierOrder(sql), [0, 1, 2, 3, 4, 5, 6]);
  const relevanceEnd = sql.indexOf('ELSE 7');
  const jlptStart = sql.indexOf("CASE r.jlpt_level");
  assert.ok(relevanceEnd !== -1 && jlptStart > relevanceEnd);
  assert.ok(params.includes('%おれ%'));
  assert.ok(params.includes('ore'));
  assert.equal(params[params.length - 1], 20);
});

test('placeholder count matches param count for every probe', async () => {
  for (const probe of ['俺', 'おれ', 'オレ', 'ore', 'I', 'water', 'tsuzuku', 'a']) {
    const { calls, db } = captureDb([]);
    await searchKanjiReferences(probe, 20, db);
    const placeholders = (calls[0].sql.match(/\?/g) || []).length;
    assert.equal(placeholders, calls[0].params.length, `probe ${probe}: placeholders vs params`);
  }
});

test('exact-character branch binds the raw query', async () => {
  const { calls, db } = captureDb([]);
  await searchKanjiReferences('俺', 5, db);
  assert.match(calls[0].sql, /WHEN r\.character = \? THEN 0/);
  assert.ok(calls[0].params.includes('俺'));
  assert.equal(calls[0].params[calls[0].params.length - 1], 5);
});

test('exact-meaning branch binds the raw query for I', async () => {
  const { calls, db } = captureDb([]);
  await searchKanjiReferences('I', 20, db);
  assert.match(calls[0].sql, /UNNEST\(r\.meanings\).*LOWER\(\?\)/);
  assert.ok(calls[0].params.includes('I'));
});

// ---------- Matrix: contracts + 俺 ----------

test('response contract preserved: items plus transliteration', async () => {
  const rows = [{
    reference_id: 1, character: '俺', jlpt_level: null,
    onyomi: ['エン'], kunyomi: ['おれ', 'われ'], meanings: ['I', 'myself'], stroke_count: 10
  }];
  const { db } = captureDb(rows);
  const result = await searchKanjiReferences('ore', 20, db);
  assert.deepEqual(result.items, [{
    referenceId: 1, character: '俺', jlptLevel: null,
    onyomi: ['エン'], kunyomi: ['おれ', 'われ'], meanings: ['I', 'myself'], strokeCount: 10
  }]);
  assert.deepEqual(result.transliteration, { hiragana: 'おれ', katakana: 'オレ' });
});

test('kana query keeps transliteration null and same item shape', async () => {
  const { db } = captureDb([]);
  const result = await searchKanjiReferences('おれ', 5, db);
  assert.deepEqual(result.items, []);
  assert.equal(result.transliteration, null);
});

test('no candidate explosion: reading OR branches stay bounded', async () => {
  const { calls, db } = captureDb([]);
  await searchKanjiReferences('water', 20, db);
  const branches = (calls[0].sql.match(/ILIKE \?/g) || []).length;
  assert.ok(branches <= 40, `reading branches: ${branches}`);
});
