const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const app = require('../src/app');
const pool = require('../src/config/db');
const fs = require('node:fs');
const {
  MAX_EXAMPLES,
  fetchKanjiVocabularyExamples,
  selectVocabularyExamples
} = require('../src/services/kanjiVocabularyExamples');

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function withPoolStubs(stubs, callback) {
  const originals = {};
  for (const [method, replacement] of Object.entries(stubs)) {
    originals[method] = pool[method];
    pool[method] = replacement;
  }
  try {
    await callback();
  } finally {
    for (const [method, original] of Object.entries(originals)) pool[method] = original;
  }
}

test.after(async () => {
  await pool.end();
});

// Fixtures mirror the JMdict projection shape (keb surface + reb reading +
// first English gloss). Rows arrive pre-ranked: common → concise → stable
// entry order, exactly as EXAMPLES_SQL orders them.
const seaRows = (overrides = []) => [
  { entry_id: 100, surface: '海', reading: 'うみ', gloss: 'sea' },
  { entry_id: 101, surface: '海賊', reading: 'かいぞく', gloss: 'pirate' },
  { entry_id: 102, surface: '海外', reading: 'かいがい', gloss: 'overseas' },
  { entry_id: 103, surface: '海岸', reading: 'かいがん', gloss: 'coast' },
  { entry_id: 104, surface: '海賊', reading: 'かいぞく', gloss: 'pirate' },
  { entry_id: 105, surface: '海水', reading: null, gloss: 'seawater' },
  { entry_id: 106, surface: '東京', reading: 'とうきょう', gloss: 'Tokyo' },
  ...overrides
];

test('SQL enforces keb-applicability as a hard filter, never a preference', () => {
  // restr/stagk restricted to another keb must never leak onto the
  // displayed surface (language review): inapplicable rows are excluded in
  // WHERE, so the lateral yields NULL and selection drops the row.
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/services/kanjiVocabularyExamples.js'), 'utf8');
  assert.ok(source.includes("AND (r.restr = \\'{}\\' OR r.restr @> ARRAY[c.surface])"), 'reading applicability is a hard filter');
  assert.ok(source.includes("AND (s.stagk = \\'{}\\' OR s.stagk @> ARRAY[c.surface])"), 'sense applicability is a hard filter');
  assert.ok(!source.includes('ORDER BY (r.restr'), 'no soft reading preference that could leak');
  assert.ok(!source.includes('ORDER BY (s.stagk'), 'no soft sense preference that could leak');
});

test('selection caps at 3 with word/reading/meaning present', () => {  assert.equal(MAX_EXAMPLES, 3);
  const selected = selectVocabularyExamples(seaRows(), '海');
  assert.equal(selected.length, 3);
  for (const item of selected) {
    assert.ok(item.word.includes('海'), `${item.word} genuinely contains the kanji`);
    assert.ok(item.reading, 'kana reading present');
    assert.ok(item.meaning, 'English gloss present');
  }
});

test('selection keeps ranked order and dedupes surfaces conservatively', () => {
  const selected = selectVocabularyExamples(seaRows(), '海');
  assert.deepEqual(selected.map((item) => item.word), ['海', '海賊', '海外']);
  assert.deepEqual(selected[1], { word: '海賊', reading: 'かいぞく', meaning: 'pirate' });
});

test('selection drops gloss-less, reading-less, and off-kanji rows', () => {
  const rows = [
    { entry_id: 1, surface: '海月', reading: 'くらげ', gloss: '' },
    { entry_id: 2, surface: '海月', reading: '', gloss: 'jellyfish' },
    { entry_id: 3, surface: '月見', reading: 'つきみ', gloss: 'moon viewing' }
  ];
  assert.deepEqual(selectVocabularyExamples(rows, '海'), []);
});

test('selection is deterministic for the same snapshot rows', () => {
  const first = selectVocabularyExamples(seaRows(), '海');
  const second = selectVocabularyExamples(seaRows(), '海');
  assert.deepEqual(first, second);
});

test('unknown character and non-Han input yield no examples', () => {
  assert.deepEqual(selectVocabularyExamples(seaRows(), '鰻'), []);
  assert.deepEqual(selectVocabularyExamples([], '海'), []);
  assert.deepEqual(selectVocabularyExamples(null, '海'), []);
});

test('other kanji select their own words (fixture-modeled JMdict rows)', () => {
  const sunRows = [
    { entry_id: 200, surface: '日本', reading: 'にほん', gloss: 'Japan' },
    { entry_id: 201, surface: '三日', reading: 'みっか', gloss: 'third day of the month' },
    { entry_id: 202, surface: '本州', reading: 'ほんしゅう', gloss: 'Honshu' }
  ];
  assert.deepEqual(selectVocabularyExamples(sunRows, '日').map((item) => item.word), ['日本', '三日']);
  const eatRows = [
    { entry_id: 300, surface: '食べ物', reading: 'たべもの', gloss: 'food' },
    { entry_id: 301, surface: '食事', reading: 'しょくじ', gloss: 'meal' },
    { entry_id: 302, surface: '飲み物', reading: 'のみもの', gloss: 'drink' }
  ];
  assert.deepEqual(selectVocabularyExamples(eatRows, '食').map((item) => item.word), ['食べ物', '食事']);
});

test('service maps rows and reports ok', async () => {
  const database = { async execute() { return [seaRows()]; } };
  const result = await fetchKanjiVocabularyExamples('海', database);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.examples.map((item) => item.word), ['海', '海賊', '海外']);
});

test('service distinguishes no-matches from unavailable snapshot', async () => {
  const emptyReady = { async execute(sql) { return /active_snapshot/.test(sql) ? [[{ source_id: 3 }]] : [[]]; } };
  assert.deepEqual(await fetchKanjiVocabularyExamples('海', emptyReady), { status: 'ok', examples: [] });
  const emptyAbsent = { async execute() { return [[]]; } };
  assert.deepEqual(await fetchKanjiVocabularyExamples('海', emptyAbsent), { status: 'unavailable', examples: [] });
});

test('service never throws and rejects non-Han input without querying', async () => {
  let calls = 0;
  const failing = { async execute() { calls += 1; throw new Error('reference lookup down'); } };
  assert.deepEqual(await fetchKanjiVocabularyExamples('海', failing), { status: 'unavailable', examples: [] });
  const counting = { async execute() { calls += 1; return [[]]; } };
  assert.deepEqual(await fetchKanjiVocabularyExamples('日本', counting), { status: 'unavailable', examples: [] });
  assert.equal(calls, 1, 'only the throwing lookup ran; invalid input never queries');
});

const referenceRow = {
  reference_id: 7,
  character: '海',
  jlpt_level: 'N5',
  onyomi: ['カイ'],
  kunyomi: ['うみ'],
  meanings: ['sea'],
  stroke_count: 9
};

function lookupStubs({ jmdictRows, snapshot = true, jmdictThrows = false, seen }) {
  return {
    async execute(sql, params) {
      seen.push({ sql, params });
      if (/FROM kanji_reference WHERE character = \?/i.test(sql)) return [[referenceRow]];
      // NOTE: the examples query contains both jmdict_forms and the
      // snapshot CTE, so forms must match before the probe branch.
      if (/jmdict_forms/i.test(sql)) {
        if (jmdictThrows) throw new Error('jmdict down');
        return [jmdictRows];
      }
      if (/jmdict_active_snapshot/i.test(sql)) return [snapshot ? [{ source_id: 3 }] : []];
      return [[]];
    }
  };
}

test('GET /api/kanji/lookup/:character keeps its contract and adds examples', async () => {
  const server = await startServer();
  try {
    const seen = [];
    await withPoolStubs({ execute: lookupStubs({ jmdictRows: seaRows(), seen }).execute }, async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kanji/lookup/${encodeURIComponent('海')}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      // Frozen contract intact.
      assert.equal(body.character, '海');
      assert.deepEqual(body.meanings, ['sea']);
      assert.deepEqual(body.onyomi, ['カイ']);
      assert.deepEqual(body.kunyomi, ['うみ']);
      assert.equal(body.jlptLevel, 'N5');
      assert.equal(body.strokeCount, 9);
      // Additive-only examples.
      assert.equal(body.vocabularyExamplesStatus, 'ok');
      assert.deepEqual(body.vocabularyExamples.map((item) => item.word), ['海', '海賊', '海外']);
      assert.deepEqual(body.vocabularyExamples[1], { word: '海賊', reading: 'かいぞく', meaning: 'pirate' });
      // Narrow: one examples query, no per-example N+1.
      assert.equal(seen.filter(({ sql }) => /jmdict_forms/i.test(sql)).length, 1);
      assert.ok(!seen.some(({ sql }) => /INSERT|UPDATE|DELETE/i.test(sql)), 'read-only, no writes');
    });
  } finally {
    await stopServer(server);
  }
});

test('GET /api/kanji/lookup/:character still renders when JMdict is down', async () => {
  const server = await startServer();
  try {
    const seen = [];
    await withPoolStubs({ execute: lookupStubs({ jmdictRows: [], jmdictThrows: true, seen }).execute }, async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kanji/lookup/${encodeURIComponent('海')}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.character, '海');
      assert.deepEqual(body.meanings, ['sea']);
      assert.deepEqual(body.vocabularyExamples, []);
      assert.equal(body.vocabularyExamplesStatus, 'unavailable');
    });
  } finally {
    await stopServer(server);
  }
});
