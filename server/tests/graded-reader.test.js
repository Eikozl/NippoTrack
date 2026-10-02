const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const pool = require('../src/config/db');
const controller = require('../src/controllers/gradedReaderController');
const gradedReader = require('../src/services/gradedReader');

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
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

function analysisPool(sqlCalls = []) {
  return async (sql, params = []) => {
    sqlCalls.push({ sql, params });
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) {
      return [[{ id_kanji_reference: 3, character: '学', jlpt_level: 'N5', onyomi: ['ガク'], kunyomi: ['まな.ぶ'], meanings: ['study'] }]];
    }
    if (/FROM kanji WHERE user_id = \?/i.test(sql)) {
      return [[{ id_kanji: 8, character_kanji: '学' }]];
    }
    if (/FROM grammar_reference WHERE source =/i.test(sql)) return [[]];
    if (/FROM grammar_points WHERE user_id = \?/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE user_id = \?/i.test(sql)) return [[]];
    if (/FROM jmdict_active_snapshot/i.test(sql)) return [[]];
    throw new Error(`Unexpected analysis SQL: ${sql}`);
  };
}

test('classifier is deterministic, reports user-scoped kanji stats, and empty text has null level/confidence zero', async () => {
  const calls = [];
  await withPoolStubs({ execute: analysisPool(calls) }, async () => {
    const first = await gradedReader.classifyLevel(pool, USER_ID, '学');
    const second = await gradedReader.classifyLevel(pool, USER_ID, '学');
    assert.deepEqual(first, second);
    assert.equal(first.level, 'N5');
    assert.equal(first.stats.characters, 1);
    assert.equal(first.stats.uniqueKanji, 1);
    assert.equal(first.stats.knownKanjiPct, 100);
    assert.deepEqual(first.stats.byLevel, { N5: 1, N4: 0, N3: 0, N2: 0, N1: 0, unclassified: 0 });
    assert.equal(first.stats.sentences, 1);
    assert.ok(first.confidence > 0 && first.confidence <= 1);
    assert.ok(calls.every(({ sql, params }) => !/FROM kanji WHERE user_id = \?/i.test(sql) || params[0] === USER_ID));

    const long = await gradedReader.classifyLevel(pool, USER_ID, '学'.repeat(2101));
    assert.equal(long.stats.characters, 2101);
    assert.equal(long.stats.uniqueKanji, 1);

    const empty = await gradedReader.classifyLevel(pool, USER_ID, '   ');
    assert.equal(empty.level, null);
    assert.equal(empty.confidence, 0);
    assert.equal(empty.stats.characters, 0);
    assert.equal(empty.stats.grammarMatchesPer1000, 0);
  });
});

test('user-text endpoint validates text and uses req.user.id, not a body userId', async () => {
  const { res, status, body } = mockRes();
  await controller.createUserText({ body: { text: '   ' }, user: { id: USER_ID } }, res);
  assert.equal(status(), 400);
  assert.match(body().error, /text is required/i);
  const oversized = mockRes();
  await controller.createUserText({ body: { text: '学'.repeat(gradedReader.MAX_READING_TEXT_LENGTH + 1) }, user: { id: USER_ID } }, oversized.res);
  assert.equal(oversized.status(), 400);

  const wrongIdentity = mockRes();
  await controller.analyzeText({ body: { text: '学', userId: OTHER_USER_ID }, user: { id: USER_ID } }, wrongIdentity.res);
  assert.equal(wrongIdentity.status(), 400);

  const calls = [];
  let transaction;
  const connection = {
    async beginTransaction() { transaction = ['BEGIN']; },
    async commit() { transaction.push('COMMIT'); },
    async rollback() { transaction.push('ROLLBACK'); },
    release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO reading_sources/i.test(sql)) return [{ insertId: 11 }];
      if (/INSERT INTO reading_texts/i.test(sql)) return [{ insertId: 12 }];
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    }
  };
  await withPoolStubs({ execute: analysisPool(), getConnection: async () => connection }, async () => {
    const response = mockRes();
    await controller.createUserText({ body: { title: 'Lesson', text: '学' }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 201);
    assert.equal(response.body().id, 12);
    assert.equal(response.body().title, 'Lesson');
    assert.deepEqual(transaction, ['BEGIN', 'COMMIT']);
  });
  assert.ok(calls.some(({ sql, params }) => /INSERT INTO reading_texts/i.test(sql) && params.includes(USER_ID)));
});

test('user-text source and text writes roll back together on a text insert failure', async () => {
  const phases = [];
  const connection = {
    async beginTransaction() { phases.push('BEGIN'); },
    async commit() { phases.push('COMMIT'); },
    async rollback() { phases.push('ROLLBACK'); },
    release() {},
    async execute(sql) {
      if (/INSERT INTO reading_sources/i.test(sql)) return [{ insertId: 21 }];
      if (/INSERT INTO reading_texts/i.test(sql)) throw new Error('simulated insert failure');
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    }
  };
  await withPoolStubs({ execute: analysisPool(), getConnection: async () => connection }, async () => {
    await assert.rejects(
      gradedReader.createUserReadingText(pool, USER_ID, { title: 'Atomic', text: '学' }),
      /simulated insert failure/
    );
  });
  assert.deepEqual(phases, ['BEGIN', 'ROLLBACK']);
});

test('library returns shared and owned rows with filters and bounded pagination', async () => {
  const calls = [];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT COUNT\(\*\) AS total FROM reading_texts/i.test(sql)) {
      return [[{ total: sql.includes('rt.level = ?') ? '1' : '2' }]];
    }
    if (/FROM reading_texts rt LEFT JOIN reading_sources rs/i.test(sql)) {
      return sql.includes('rt.level = ?')
        ? [[{ id: '5', title: 'Shared', level: 'N5', sourceType: 'nhk', text: '学', createdAt: '2026-09-01' }]]
        : [[
          { id: '5', title: 'Shared', level: 'N5', sourceType: 'nhk', text: '学', createdAt: '2026-09-01' },
          { id: '6', title: 'Mine', level: 'N4', sourceType: 'user', text: '本', createdAt: '2026-09-01' }
        ]];
    }
    if (/FROM kanji WHERE user_id = \?/i.test(sql)) return [[{ character_kanji: '学' }]];
    throw new Error(`Unexpected library SQL: ${sql}`);
  } }, async () => {
    const response = mockRes();
    await controller.listLibrary({ query: { level: 'N5', source: 'nhk', date: '2026-09-01', page: '2', limit: '1' }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 200);
    assert.equal(response.body().total, 1);
    assert.equal(response.body().page, 2);
    assert.equal(response.body().limit, 1);
    assert.equal(response.body().items[0].knownKanjiPct, 100);
    assert.ok(calls.every(({ sql, params }) => !/FROM reading_texts/i.test(sql) || (sql.includes('rt.user_id IS NULL') && params.includes(USER_ID))));
    const listCall = calls.find(({ sql }) => /FROM reading_texts rt LEFT JOIN reading_sources rs/i.test(sql) && /ORDER BY rt.created_at/i.test(sql));
    assert.deepEqual(listCall.params.slice(-2), [1, 1]);

    const allRows = mockRes();
    await controller.listLibrary({ query: { page: '1', limit: '2' }, user: { id: USER_ID } }, allRows.res);
    assert.equal(allRows.body().items.length, 2);
    assert.deepEqual(allRows.body().items.map((item) => item.sourceType), ['nhk', 'user']);
  });
});

test('GET text hides foreign rows as 404 and returns annotations for readable rows', async () => {
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt LEFT JOIN reading_sources rs/i.test(sql)) return [[]];
    throw new Error(`Unexpected foreign-text SQL: ${sql}`);
  } }, async () => {
    const response = mockRes();
    await controller.getText({ params: { id: '25' }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 404);
  });

  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/FROM reading_texts rt LEFT JOIN reading_sources rs/i.test(sql)) {
      assert.ok(params.includes(USER_ID));
      return [[{ id: '26', title: 'One', level: 'N5', sourceType: 'user', metadata: {}, text: '学', position: null, completedAt: null, timeSpentSeconds: null }]];
    }
    return analysisPool()(sql, params);
  } }, async () => {
    const response = mockRes();
    await controller.getText({ params: { id: '26' }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 200);
    assert.ok(response.body().annotations.some((item) => item.type === 'kanji' && item.char === '学' && item.position === 0));
    assert.equal(response.body().progress, null);
  });
});

test('progress is user-scoped, validates bounds, and uses an upsert', async () => {
  const calls = [];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT id_reading_text, text FROM reading_texts/i.test(sql)) {
      assert.ok(params.includes(USER_ID));
      return [[{ id_reading_text: 31, text: '学生' }]];
    }
    if (/INSERT INTO user_reading_progress/i.test(sql)) return [[{ id: 4 }]];
    throw new Error(`Unexpected progress SQL: ${sql}`);
  } }, async () => {
    const invalid = mockRes();
    await controller.updateProgress({ params: { id: '31' }, body: { position: 4 }, user: { id: USER_ID } }, invalid.res);
    assert.equal(invalid.status(), 400);
    const zeroPosition = mockRes();
    await controller.updateProgress({ params: { id: '31' }, body: { position: 0 }, user: { id: USER_ID } }, zeroPosition.res);
    assert.equal(zeroPosition.status(), 400);

    const response = mockRes();
    await controller.updateProgress({ params: { id: '31' }, body: { position: 2, timeSpentSeconds: 15, completed: true }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 200);
    assert.equal(response.body().position, 2);
    const upsert = calls.find(({ sql }) => /INSERT INTO user_reading_progress/i.test(sql));
    assert.match(upsert.sql, /ON CONFLICT \(user_id, text_id\) DO UPDATE/i);
    assert.ok(upsert.params.includes(USER_ID));
  });

  await withPoolStubs({ execute: async (sql) => {
    if (/SELECT id_reading_text, text FROM reading_texts/i.test(sql)) return [[]];
    throw new Error(`Unexpected foreign progress SQL: ${sql}`);
  } }, async () => {
    const response = mockRes();
    await controller.updateProgress({ params: { id: '31' }, body: { position: 1 }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 404);
  });
});

test('source import has fixed-host parsing and reports fetch failures as unavailable', async () => {
  const fixture = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[学ぶニュース]]></title><link>https://www3.nhk.or.jp/news/easy/abc/abc.html</link><pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>子どもが学校で学びます。</p>]]></description><enclosure url="https://www3.nhk.or.jp/audio/example.mp3" /></item></channel></rss>`;
  const parsed = await gradedReader.loadNHKEasySources(async (url, options) => {
    assert.equal(String(url), 'https://www3.nhk.or.jp/rss/news/easy.xml');
    assert.equal(options.redirect, 'error');
    return { ok: true, headers: { get: () => String(Buffer.byteLength(fixture)) }, text: async () => fixture };
  });
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, '学ぶニュース');
  assert.match(parsed.items[0].text, /子どもが学校で学びます/);
  assert.equal(parsed.items[0].audio, 'https://www3.nhk.or.jp/audio/example.mp3');

  const aozoraPages = new Map([
    ['https://www.aozora.gr.jp/index_pages/sakuhin_top.html', '<a href="https://attacker.test/cards/1/card1.html">No</a><a href="/cards/000001/card1.html">短い物語</a>'],
    ['https://www.aozora.gr.jp/cards/000001/card1.html', '<a href="/files/1_1.html">テキストファイル</a>'],
    ['https://www.aozora.gr.jp/files/1_1.html', '<div class="main_text"><p>昔々、村に子どもがいました。</p></div>']
  ]);
  const aozora = await gradedReader.loadAozoraSources(async (url, options) => {
    assert.equal(options.redirect, 'error');
    const page = aozoraPages.get(String(url));
    assert.ok(page, `unexpected source URL: ${url}`);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(page)) }, text: async () => page };
  });
  assert.equal(aozora.status, 'ok');
  assert.equal(aozora.items.length, 1);
  assert.equal(aozora.items[0].title, '短い物語');
  assert.match(aozora.items[0].text, /昔々、村に子どもがいました/);

  const unavailable = await gradedReader.loadNHKEasySources(async () => { throw new Error('private network detail'); });
  assert.deepEqual(unavailable, { status: 'unavailable', reason: 'Source request failed.' });
  const response = mockRes();
  await controller.importSources({ body: { sourceType: 'nhk' }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } }, response.res);
  assert.equal(response.status(), 200);
  assert.deepEqual(response.body(), { status: 'unavailable', reason: 'Source request failed.' });
});

test('reading progress listing is user-scoped, joined with text metadata, and paginated', async () => {
  const calls = [];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT COUNT\(\*\) AS total FROM user_reading_progress WHERE user_id = \?/i.test(sql)) {
      assert.deepEqual(params, [USER_ID]);
      return [[{ total: '2' }]];
    }
    if (/FROM user_reading_progress p/i.test(sql)) {
      assert.match(sql, /JOIN reading_texts t ON t\.id_reading_text = p\.text_id/i);
      assert.match(sql, /WHERE p\.user_id = \?/i);
      assert.equal(params[0], USER_ID);
      assert.deepEqual(params.slice(1), [20, 0]);
      return [[
        { textId: '31', title: 'First steps', level: 'N5', characters: '120', sourceType: 'nhk', position: '120', completedAt: '2026-10-01T10:00:00Z', timeSpentSeconds: '300', updatedAt: '2026-10-01T10:05:00Z' },
        { textId: '32', title: 'Second steps', level: null, characters: '80', sourceType: null, position: '10', completedAt: null, timeSpentSeconds: '0', updatedAt: '2026-09-30T09:00:00Z' }
      ]];
    }
    throw new Error(`Unexpected progress listing SQL: ${sql}`);
  } }, async () => {
    const response = mockRes();
    await controller.listProgress({ query: {}, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 200);
    const body = response.body();
    assert.equal(body.total, 2);
    assert.equal(body.page, 1);
    assert.equal(body.limit, 20);
    assert.equal(body.totalPages, 1);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].textId, 31);
    assert.equal(body.items[0].title, 'First steps');
    assert.equal(body.items[0].level, 'N5');
    assert.equal(body.items[0].characters, 120);
    assert.equal(body.items[0].sourceType, 'nhk');
    assert.equal(body.items[0].position, 120);
    assert.equal(body.items[0].completedAt, '2026-10-01T10:00:00Z');
    assert.equal(body.items[0].timeSpentSeconds, 300);
    assert.equal(body.items[1].level, null);
    assert.equal(body.items[1].completedAt, null);
    assert.ok(calls.every(({ params }) => !params.length || params[0] === USER_ID || params[0] === 20));
  });

  const badPage = mockRes();
  await controller.listProgress({ query: { page: 'zero' }, user: { id: USER_ID } }, badPage.res);
  assert.equal(badPage.status(), 400);
  const tooLarge = mockRes();
  await controller.listProgress({ query: { limit: '999' }, user: { id: USER_ID } }, tooLarge.res);
  assert.equal(tooLarge.status(), 400);
});
