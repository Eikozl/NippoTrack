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

test('classifier is deterministic, reports user-scoped kanji stats, and withholds level below the length threshold', async () => {
  assert.equal(gradedReader.MIN_LEVEL_CHARACTERS, 50);
  const calls = [];
  await withPoolStubs({ execute: analysisPool(calls) }, async () => {
    const first = await gradedReader.classifyLevel(pool, USER_ID, `学${'あ'.repeat(49)}`);
    const second = await gradedReader.classifyLevel(pool, USER_ID, `学${'あ'.repeat(49)}`);
    assert.deepEqual(first, second);
    assert.equal(first.level, 'N5');
    assert.equal(first.stats.characters, 50);
    assert.equal(first.stats.uniqueKanji, 1);
    assert.equal(first.stats.knownKanjiPct, 100);
    assert.deepEqual(first.stats.byLevel, { N5: 1, N4: 0, N3: 0, N2: 0, N1: 0, unclassified: 0 });
    assert.equal(first.stats.sentences, 1);
    assert.ok(first.confidence > 0 && first.confidence <= 1);
    assert.ok(calls.every(({ sql, params }) => !/FROM kanji WHERE user_id = \?/i.test(sql) || params[0] === USER_ID));

    const long = await gradedReader.classifyLevel(pool, USER_ID, '学'.repeat(2101));
    assert.equal(long.stats.characters, 2101);
    assert.equal(long.stats.uniqueKanji, 1);

    // Below the threshold (and empty texts) the level is withheld instead of
    // reporting single-sample noise — annotations are unaffected.
    for (const tiny of ['学', 'これは本です。', '   ']) {
      const result = await gradedReader.classifyLevel(pool, USER_ID, tiny);
      assert.equal(result.level, null, `no level for ${result.stats.characters} chars`);
      assert.equal(result.confidence, 0);
    }
    const empty = await gradedReader.classifyLevel(pool, USER_ID, '   ');
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
        ? [[{ id: '5', title: 'Shared', level: 'N5', sourceType: 'aozora', text: '学', createdAt: '2026-09-01' }]]
        : [[
          { id: '5', title: 'Shared', level: 'N5', sourceType: 'aozora', text: '学', createdAt: '2026-09-01' },
          { id: '6', title: 'Mine', level: 'N4', sourceType: 'user', text: '本', createdAt: '2026-09-01' }
        ]];
    }
    if (/FROM kanji WHERE user_id = \?/i.test(sql)) return [[{ character_kanji: '学' }]];
    throw new Error(`Unexpected library SQL: ${sql}`);
  } }, async () => {
    const response = mockRes();
    await controller.listLibrary({ query: { level: 'N5', source: 'aozora', date: '2026-09-01', page: '2', limit: '1' }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 200);
    assert.equal(response.body().total, 1);
    assert.equal(response.body().page, 2);
    assert.equal(response.body().limit, 1);
    assert.equal(response.body().items[0].knownKanjiPct, 100);
    assert.ok(calls.every(({ sql, params }) => !/FROM reading_texts/i.test(sql) || (sql.includes('rt.user_id IS NULL') && params.includes(USER_ID))));
    const listCall = calls.find(({ sql }) => /FROM reading_texts rt LEFT JOIN reading_sources rs/i.test(sql) && /ORDER BY rt.created_at/i.test(sql));
    assert.deepEqual(listCall.params.slice(-2), [1, 1]);
    // Regression: the SELECT-list mine placeholder leads the SQL text, so
    // its user_id must lead the params. A [...filters, userId] order bound
    // the source value to rt.user_id and broke every filtered listing on
    // real Postgres with "invalid input syntax for type uuid" (stubs never
    // caught it because they ignore param positions).
    assert.deepEqual(listCall.params.slice(0, 4), [USER_ID, USER_ID, 'N5', 'aozora'], 'mine, ownership, level, then source filter');

    const allRows = mockRes();
    await controller.listLibrary({ query: { page: '1', limit: '2' }, user: { id: USER_ID } }, allRows.res);
    assert.equal(allRows.body().items.length, 2);
    assert.deepEqual(allRows.body().items.map((item) => item.sourceType), ['aozora', 'user']);
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
    if (/SELECT time_spent_seconds FROM user_reading_progress/i.test(sql)) {
      assert.ok(params.includes(USER_ID), 'delta read stays user-scoped');
      return [[{ time_spent_seconds: 5 }]];
    }
    if (/INSERT INTO user_reading_progress/i.test(sql)) return [[{ id: 4 }]];
    if (/SELECT position FROM user_reading_progress/i.test(sql)) return [[{ position: '2' }]];
    if (/INSERT INTO reading_study_days/i.test(sql)) {
      assert.ok(params.includes(USER_ID), 'daily credit stays user-scoped');
      return [{ affectedRows: 1 }];
    }
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
    assert.match(upsert.sql, /GREATEST\(user_reading_progress\.position, EXCLUDED\.position\)/i);
    assert.ok(upsert.params.includes(USER_ID));
    // Delta credit: submitted 15s minus stored 5s credits 10s to today.
    const daily = calls.find(({ sql }) => /INSERT INTO reading_study_days/i.test(sql));
    assert.ok(daily, 'reading time accrues to the daily row');
    assert.deepEqual(daily.params, [USER_ID, 10]);
    assert.match(daily.sql, /ON CONFLICT \(user_id, day\) DO UPDATE/i);
  });

  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/SELECT id_reading_text, text FROM reading_texts/i.test(sql)) {
      return [[{ id_reading_text: 31, text: '学生' }]];
    }
    if (/SELECT time_spent_seconds FROM user_reading_progress/i.test(sql)) {
      return [[{ time_spent_seconds: 20 }]];
    }
    // Stored position 5 wins over the submitted 1: progress never regresses,
    // and the response echoes the stored (post-GREATEST) value.
    if (/INSERT INTO user_reading_progress/i.test(sql)) return [[{ id: 4 }]];
    if (/SELECT position FROM user_reading_progress/i.test(sql)) return [[{ position: '5' }]];
    if (/INSERT INTO reading_study_days/i.test(sql)) {
      throw new Error('backwards totals must not credit anything');
    }
    throw new Error(`Unexpected progress SQL: ${sql}`);
  } }, async () => {
    const response = mockRes();
    await controller.updateProgress({ params: { id: '31' }, body: { position: 1, timeSpentSeconds: 15 }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 200);
    assert.equal(response.body().position, 5);
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

test('source import reads the fixed Aozora work index and reports fetch failures as unavailable', async () => {
  const aozoraPages = new Map([
    ['https://www.aozora.gr.jp/index_pages/sakuhin_a1.html', '<a href="https://attacker.test/cards/1/card1.html">No</a><a href="/cards/000001/card1.html">短い物語</a><a href="/cards/000002/card2.html">第二話</a>'],
    ['https://www.aozora.gr.jp/cards/000001/card1.html', '<a href="/files/1_1.html">テキストファイル</a>'],
    ['https://www.aozora.gr.jp/files/1_1.html', '<div class="main_text"><p>昔々、村に子どもがいました。</p></div>'],
    ['https://www.aozora.gr.jp/cards/000002/card2.html', '<a href="./files/2_1.html">2_1.html</a>'],
    ['https://www.aozora.gr.jp/cards/000002/files/2_1.html', '<div class="main_text"><p>第二の物語です。</p></div>']
  ]);
  const fetchedUrls = [];
  const aozora = await gradedReader.loadAozoraSources(async (url, options) => {
    assert.equal(options.redirect, 'error');
    fetchedUrls.push(String(url));
    const page = aozoraPages.get(String(url));
    assert.ok(page, `unexpected source URL: ${url}`);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(page)) }, text: async () => page };
  });
  assert.equal(fetchedUrls[0], gradedReader.AOZORA_LISTING_URL);
  assert.match(gradedReader.AOZORA_LISTING_URL, /^https:\/\/www\.aozora\.gr\.jp\/index_pages\/sakuhin_a1\.html$/);
  assert.equal(aozora.status, 'ok');
  assert.equal(aozora.items.length, 2);
  assert.equal(aozora.items[0].title, '短い物語');
  assert.match(aozora.items[0].text, /昔々、村に子どもがいました/);
  assert.equal(aozora.items[1].title, '第二話');
  assert.match(aozora.items[1].text, /第二の物語です/);

  const unavailable = await gradedReader.loadAozoraSources(async () => { throw new Error('private network detail'); });
  assert.deepEqual(unavailable, { status: 'unavailable', reason: 'Source request failed.' });

  // Imports run inside the request (never detached: serverless runtimes kill
  // anything scheduled after the response). An offline source answers with
  // an honest 502 instead of a fake 202-accepted that never lands.
  const offline = mockRes();
  await controller.importSources({ body: { sourceType: 'aozora' }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } }, offline.res);
  assert.equal(offline.status(), 502);
  assert.match(offline.body().error, /Source request failed/i);

  const retired = mockRes();
  await controller.importSources({ body: { sourceType: 'nhk' }, user: { id: USER_ID } }, retired.res);
  assert.equal(retired.status(), 400);
  assert.match(retired.body().error, /sourceType must be aozora or hukumusume/i);

  const hukuOffline = mockRes();
  await controller.importSources(
    { body: { sourceType: 'hukumusume', urls: ['https://hukumusume.com/douwa/pc/jap/01/01.htm'], index: '01' }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } },
    hukuOffline.res
  );
  assert.equal(hukuOffline.status(), 502);
  assert.match(hukuOffline.body().error, /Source request failed/i);

  const badHukuIndex = mockRes();
  await controller.importSources(
    { body: { sourceType: 'hukumusume', index: '99' }, user: { id: USER_ID } },
    badHukuIndex.res
  );
  assert.equal(badHukuIndex.status(), 400);
});

test('import preview lists selectable works without fetching articles', async () => {
  const listing = '<a href="https://attacker.test/cards/9/card9.html">No</a><a href="/cards/000001/card1.html">短い物語</a>';
  const response = mockRes();
  await controller.previewImports({ query: { source: 'aozora' }, user: { id: USER_ID }, app: { locals: { readingFetch: async (url) => {
    assert.equal(String(url), gradedReader.AOZORA_LISTING_URL);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(listing)) }, text: async () => listing };
  } } } }, response.res);
  assert.equal(response.status(), 200);
  assert.equal(response.body().status, 'ok');
  assert.deepEqual(response.body().items, [{ title: '短い物語', url: 'https://www.aozora.gr.jp/cards/000001/card1.html', date: null, text: null, audio: null }]);

  const badSource = mockRes();
  await controller.previewImports({ query: { source: 'nhk' }, user: { id: USER_ID } }, badSource.res);
  assert.equal(badSource.status(), 400);

  const down = mockRes();
  await controller.previewImports({ query: {}, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } }, down.res);
  assert.equal(down.status(), 200);
  assert.equal(down.body().status, 'unavailable');
});

test('import preview switches kana indexes and rejects unknown ones', async () => {
  const fetched = [];
  const ka = mockRes();
  await controller.previewImports({ query: { source: 'aozora', index: 'ka' }, user: { id: USER_ID }, app: { locals: { readingFetch: async (url) => {
    fetched.push(String(url));
    return { ok: true, headers: { get: () => '10' }, text: async () => '<a href="/cards/1/card1.html">かきくけこ</a>' };
  } } } }, ka.res);
  assert.equal(ka.status(), 200);
  assert.equal(ka.body().status, 'ok');
  assert.equal(ka.body().index, 'ka');
  assert.deepEqual(fetched, ['https://www.aozora.gr.jp/index_pages/sakuhin_ka1.html']);
  assert.equal(ka.body().items.length, 1);

  const badIndex = mockRes();
  await controller.previewImports({ query: { index: 'zzz' }, user: { id: USER_ID } }, badIndex.res);
  assert.equal(badIndex.status(), 400);
  assert.match(badIndex.body().error, /index must be one of/);
});

test('hukumusume preview lists month stories and imports a pasted link', async () => {
  const monthHtml = '<a href="https://attacker.test/evil.html">No</a><a href="../01/01.htm">placeholder-title</a>';
  const preview = mockRes();
  await controller.previewImports({ query: { source: 'hukumusume', index: '05' }, user: { id: USER_ID }, app: { locals: { readingFetch: async (url) => {
    assert.equal(String(url), 'https://hukumusume.com/douwa/pc/jap/itiran/05gatu.htm');
    return { ok: true, headers: { get: () => String(Buffer.byteLength(monthHtml)) }, text: async () => monthHtml };
  } } } }, preview.res);
  assert.equal(preview.status(), 200);
  assert.equal(preview.body().status, 'ok');
  assert.equal(preview.body().index, '05');
  assert.deepEqual(preview.body().items, [{ title: 'placeholder-title', url: 'https://hukumusume.com/douwa/pc/jap/01/01.htm', date: null, text: null, audio: null }]);

  const badMonth = mockRes();
  await controller.previewImports({ query: { source: 'hukumusume', index: '13' }, user: { id: USER_ID } }, badMonth.res);
  assert.equal(badMonth.status(), 400);
  assert.match(badMonth.body().error, /index must be one of/);

  // Pasted-link shape validation covers both hosts (no network: invalid
  // shapes 400 before any fetch; the valid shape is exercised below with an
  // offline stub proving the awaited import fails honestly, never silently).
  for (const url of ['https://hukumusume.com/douwa/pc/jap/01/01.htm.evil', 'https://hukumusume.com/other/page.html']) {
    const probe = mockRes();
    await controller.importFromUrl({ body: { url }, user: { id: USER_ID } }, probe.res);
    assert.equal(probe.status(), 400, `url rejected: ${url}`);
  }
  {
    const offline = mockRes();
    await controller.importFromUrl(
      { body: { url: 'https://www.aozora.gr.jp/cards/1/card1.html' }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } },
      offline.res
    );
    assert.equal(offline.status(), 502, 'offline source fails honestly');
    assert.match(offline.body().error, /Source request failed/i);
  }

  // Happy path: card title extracted, story trimmed at おしまい, stored.
  const storyUrl = 'https://hukumusume.com/douwa/pc/jap/01/01.htm';
  // Nested inner table: a lazy first-</td> match would stop inside the
  // header junk and lose the tale; the balanced scan must span it.
  const cardHtml = '<html><head><title>ネコがネズミを追いかける訳 ＜福娘童話集 きょうの日本昔話＞</title></head>'
    + '<body><table><tr><td width="619" valign="top"><p>福娘童話集 &gt; きょうの日本昔話 &gt; ネコがネズミを追いかける訳</p>'
    + '<table><tr><td>ヘッダー画像</td></tr></table>'
    + '<p>ネコがネズミを追いかける訳</p><p>むかしむかし、あるところに学ぶ子どもがいました。</p>'
    + '<p>おしまい</p><p>隠しキャラの正解は秘密です</p></td></tr></table></body></html>';
  const fetchStub = async (url) => {
    assert.equal(String(url), storyUrl);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(cardHtml)) }, text: async () => cardHtml };
  };
  const analyze = analysisPool();
  const calls = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/pg_advisory_xact_lock/i.test(sql)) return [[]];
      if (/FROM reading_sources WHERE type/i.test(sql)) return [[]];
      if (/INSERT INTO reading_sources/i.test(sql)) return [{ insertId: 91 }];
      if (/FROM reading_texts WHERE source_id/i.test(sql)) return [[]];
      if (/INSERT INTO reading_texts/i.test(sql)) return [{ insertId: 92 }];
      return analyze(sql, params);
    }
  };
  const executor = { execute: (sql, params) => analyze(sql, params), getConnection: async () => connection };
  const result = await gradedReader.importHukuUrl(executor, USER_ID, storyUrl, { fetch: fetchStub });
  assert.equal(result.status, 'ok');
  assert.equal(result.textsImported, 1);
  const textInsert = calls.find(({ sql }) => /INSERT INTO reading_texts/i.test(sql));
  assert.ok(textInsert.params.includes('ネコがネズミを追いかける訳'), 'title without the collection suffix');
  const storedText = textInsert.params.find((param) => typeof param === 'string' && param.includes('むかしむかし'));
  assert.ok(storedText, 'story body stored');
  assert.ok(!storedText.includes('隠しキャラ'), 'post-ending bonus content trimmed');
  assert.ok(!storedText.includes('福娘童話集 >'), 'header chrome trimmed');
});

test('source heartbeat: malformed markup and dead hosts degrade honestly', async () => {
  // Garbage listing HTML parses to zero works (never throws, never invents).
  const garbage = async () => ({ ok: true, headers: { get: () => '9' }, text: async () => '<html><body>no stories here</body></html>' });
  const aozoraEmpty = await gradedReader.loadAozoraSources(garbage, { index: 'a' });
  assert.equal(aozoraEmpty.status, 'ok');
  assert.deepEqual(aozoraEmpty.items, []);
  const hukuEmpty = await gradedReader.loadHukuSources(garbage, { index: '01' });
  assert.equal(hukuEmpty.status, 'ok');
  assert.deepEqual(hukuEmpty.items, []);
  // Dead hosts and non-OK responses collapse to unavailable with a reason.
  const dead = async () => { throw new Error('socket hang up'); };
  assert.deepEqual(await gradedReader.loadAozoraSources(dead), { status: 'unavailable', reason: 'Source request failed.' });
  assert.deepEqual(await gradedReader.loadHukuSources(dead), { status: 'unavailable', reason: 'Source request failed.' });
  const badStatus = async () => ({ ok: false, status: 403, headers: { get: () => '0' }, text: async () => '' });
  assert.deepEqual(await gradedReader.previewAozoraSources(badStatus), { status: 'unavailable', reason: 'Source request failed.' });
  assert.deepEqual(await gradedReader.previewHukuSources(badStatus), { status: 'unavailable', reason: 'Source request failed.' });
});

test('pasted-link import validates shape and stores the extracted work', async () => {
  for (const url of [undefined, '', 'not-a-url', 'http://www.aozora.gr.jp/cards/1/card1.html', 'https://evil.test/cards/1/card1.html', 'https://www.aozora.gr.jp/index_pages/sakuhin_a1.html']) {
    const response = mockRes();
    await controller.importFromUrl({ body: { url }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 400, `url rejected: ${JSON.stringify(url)}`);
    assert.match(response.body().error, /work page URL|story page URL/);
  }
  const extra = mockRes();
  await controller.importFromUrl({ body: { url: 'https://www.aozora.gr.jp/cards/1/card1.html', extra: 1 }, user: { id: USER_ID } }, extra.res);
  assert.equal(extra.status(), 400);

  const cardUrl = 'https://www.aozora.gr.jp/cards/000007/card7.html';
  const pages = new Map([
    [cardUrl, '<html><head><title>図書カード：貼り付け物語</title></head><body><a href="./files/7_1.html">7_1.html</a></body></html>'],
    ['https://www.aozora.gr.jp/cards/000007/files/7_1.html', '<div class="main_text"><p>学ぶ。</p></div>']
  ]);
  const fetchStub = async (url) => {
    const page = pages.get(String(url));
    if (!page) throw new Error(`unexpected source URL: ${url}`);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(page)) }, text: async () => page };
  };
  const analyze = analysisPool();
  const calls = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/pg_advisory_xact_lock/i.test(sql)) return [[]];
      if (/FROM reading_sources WHERE type/i.test(sql)) return [[]];
      if (/INSERT INTO reading_sources/i.test(sql)) return [{ insertId: 81 }];
      if (/FROM reading_texts WHERE source_id/i.test(sql)) return [[]];
      if (/INSERT INTO reading_texts/i.test(sql)) return [{ insertId: 82 }];
      return analyze(sql, params);
    }
  };
  const result = await gradedReader.importAozoraUrl({ execute: (sql, params) => analyze(sql, params), getConnection: async () => connection }, USER_ID, cardUrl, { fetch: fetchStub });
  assert.equal(result.status, 'ok');
  assert.equal(result.textsImported, 1);
  const textInsert = calls.find(({ sql }) => /INSERT INTO reading_texts/i.test(sql));
  assert.ok(textInsert.params.includes('貼り付け物語'), 'stored title comes from the card page');

  const noTitle = await gradedReader.importAozoraUrl({ execute: (sql, params) => analyze(sql, params), getConnection: async () => connection }, USER_ID, cardUrl, {
    fetch: async () => ({ ok: true, headers: { get: () => '10' }, text: async () => '<html><head></head><body></body></html>' })
  });
  assert.equal(noTitle.status, 'unavailable');

  const offline = mockRes();
  await controller.importFromUrl({ body: { url: cardUrl }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } }, offline.res);
  assert.equal(offline.status(), 502);
  assert.match(offline.body().error, /Source request failed/i);
});

test('selective import analyzes and stores only the requested urls', async () => {
  const pages = new Map([
    [gradedReader.AOZORA_LISTING_URL, '<a href="/cards/000001/card1.html">One</a><a href="/cards/000002/card2.html">Two</a>'],
    ['https://www.aozora.gr.jp/cards/000001/card1.html', '<a href="/files/1_1.html">file</a>'],
    ['https://www.aozora.gr.jp/files/1_1.html', '<div class="main_text"><p>学ぶ。</p></div>'],
    ['https://www.aozora.gr.jp/cards/000002/card2.html', '<a href="./files/2_1.html">2_1.html</a>'],
    ['https://www.aozora.gr.jp/cards/000002/files/2_1.html', '<div class="main_text"><p>読む。</p></div>']
  ]);
  const fetchStub = async (url) => {
    const page = pages.get(String(url));
    if (!page) throw new Error(`unlisted source URL: ${url}`);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(page)) }, text: async () => page };
  };
  const analyze = analysisPool();
  const calls = [];
  const flow = [];
  const connection = {
    async beginTransaction() { flow.push('BEGIN'); },
    async commit() { flow.push('COMMIT'); },
    async rollback() { flow.push('ROLLBACK'); },
    release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/pg_advisory_xact_lock/i.test(sql)) return [[]];
      if (/FROM reading_sources WHERE type/i.test(sql)) return [[]];
      if (/INSERT INTO reading_sources/i.test(sql)) return [{ insertId: 71 }];
      if (/FROM reading_texts WHERE source_id/i.test(sql)) return [[]];
      if (/INSERT INTO reading_texts/i.test(sql)) return [{ insertId: 72 }];
      throw new Error(`Unexpected import SQL: ${sql}`);
    }
  };
  const executor = { execute: (sql, params) => analyze(sql, params), getConnection: async () => connection };
  const result = await gradedReader.syncReadingSources(executor, USER_ID, 'aozora', {
    fetch: fetchStub,
    urls: ['https://www.aozora.gr.jp/cards/000002/card2.html', 'https://attacker.test/cards/9/card9.html']
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.imported, 1, 'only the listed + requested url is imported');
  assert.equal(result.textsImported, 1);
  const textInserts = calls.filter(({ sql }) => /INSERT INTO reading_texts/i.test(sql));
  assert.equal(textInserts.length, 1);
  assert.ok(textInserts[0].params.includes('Two'), 'stored title belongs to the selected work');
  assert.ok(!calls.some(({ params }) => params.some((param) => typeof param === 'string' && param.includes('card1.html'))), 'unselected work never touches the database');
  assert.deepEqual(flow.filter((phase) => phase === 'ROLLBACK'), [], 'no rollback on the happy path');
});

test('import rejects malformed url selections', async () => {
  for (const urls of [
    'not-an-array',
    [],
    new Array(21).fill('https://www.aozora.gr.jp/cards/1/card1.html'),
    ['http://www.aozora.gr.jp/cards/1/card1.html'],
    ['https://evil.test/cards/1/card1.html'],
    ['https://www.aozora.gr.jp/index_pages/sakuhin_a1.html'],
    [42]
  ]) {
    const response = mockRes();
    await controller.importSources({ body: { sourceType: 'aozora', urls }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 400, `urls rejected: ${JSON.stringify(urls)?.slice(0, 60)}`);
    assert.match(response.body().error, /urls must be an array of 1 to 20 source URLs/);
  }
});

test('import analysis retries once on transport failures, never on logic errors', async () => {
  assert.equal(gradedReader.isTransientDbError(null), false);
  assert.equal(gradedReader.isTransientDbError(new Error('boom')), false);
  assert.equal(gradedReader.isTransientDbError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(gradedReader.isTransientDbError(new Error('Connection terminated due to connection timeout')), true);
  assert.equal(gradedReader.isTransientDbError(new Error('canceling statement due to statement timeout')), true);
  assert.equal(gradedReader.isTransientDbError(Object.assign(new Error('Japanese parser engine initialization timed out.'), { name: 'ParserError', code: 'PARSER_INIT_FAILED' })), false);
  assert.equal(gradedReader.isTransientDbError(new Error('position must be a positive integer within the text length.')), false);

  // One transient blip mid-analysis: the import recovers and stores the text.
  const pages = new Map([
    [gradedReader.AOZORA_LISTING_URL, '<a href="/cards/000009/card9.html">Nine</a>'],
    ['https://www.aozora.gr.jp/cards/000009/card9.html', '<a href="/files/9_1.html">file</a>'],
    ['https://www.aozora.gr.jp/files/9_1.html', '<div class="main_text"><p>学ぶ。</p></div>']
  ]);
  const fetchStub = async (url) => {
    const page = pages.get(String(url));
    if (!page) throw new Error(`unexpected source URL: ${url}`);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(page)) }, text: async () => page };
  };
  const analyze = analysisPool();
  let analysisCalls = 0;
  let blipped = false;
  const flakyAnalyze = async (sql, params = []) => {
    analysisCalls += 1;
    if (!blipped && analysisCalls === 3) {
      blipped = true;
      throw Object.assign(new Error('Connection terminated due to connection timeout'), { code: 'ECONNRESET' });
    }
    return analyze(sql, params);
  };
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      if (/pg_advisory_xact_lock/i.test(sql)) return [[]];
      if (/FROM reading_sources WHERE type/i.test(sql)) return [[]];
      if (/INSERT INTO reading_sources/i.test(sql)) return [{ insertId: 95 }];
      if (/FROM reading_texts WHERE source_id/i.test(sql)) return [[]];
      if (/INSERT INTO reading_texts/i.test(sql)) return [{ insertId: 96 }];
      return flakyAnalyze(sql, params);
    }
  };
  const executor = { execute: (sql, params) => flakyAnalyze(sql, params), getConnection: async () => connection };
  const result = await gradedReader.syncReadingSources(executor, USER_ID, 'aozora', { fetch: fetchStub });
  assert.equal(result.status, 'ok');
  assert.equal(result.textsImported, 1, 'transient blip retried, text stored');
  assert.ok(blipped, 'the blip actually fired');
});

test('legacy source bytes transcode from the declared charset instead of mojibake', async () => {
  // '<a>' + あ (U+3042: EUC-JP A4A2) + '</a>' with an euc-jp meta declaration.
  const eucJp = Buffer.concat([
    Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html;charset=euc-jp"></head><body><a href="/cards/1/card1.html">', 'latin1'),
    Buffer.from([0xa4, 0xa2]),
    Buffer.from('</a></body></html>', 'latin1')
  ]);
  const chunks = [eucJp];
  const readerStub = {
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(chunks[0]) };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
  const byteLength = eucJp.byteLength;
  assert.ok(byteLength > 0);
  const listed = await gradedReader.loadAozoraSources(async (url) => {
    if (String(url) === gradedReader.AOZORA_LISTING_URL) return readerStub;
    throw new Error(`unexpected source URL: ${url}`);
  });
  assert.equal(listed.status, 'ok');
  // A UTF-8 misread of A4A2 would be mojibake, never あ: the anchor title
  // proves the euc-jp bytes were transcoded before parsing.
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].title, 'あ');
});

test('reading text delete is owner-scoped and cleans the private source', async () => {
  const calls = [];
  let flow = [];
  const connection = {
    async beginTransaction() { flow.push('BEGIN'); },
    async commit() { flow.push('COMMIT'); },
    async rollback() { flow.push('ROLLBACK'); },
    release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id_reading_text, source_id FROM reading_texts/i.test(sql)) {
        assert.deepEqual(params, [31, USER_ID]);
        return [[{ id_reading_text: 31, source_id: 9 }]];
      }
      if (/DELETE FROM reading_texts/i.test(sql)) {
        assert.deepEqual(params, [31, USER_ID]);
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM reading_sources/i.test(sql)) {
        assert.match(sql, /NOT EXISTS \(SELECT 1 FROM reading_texts WHERE source_id = \?\)/i);
        assert.deepEqual(params, [9, 9]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected delete SQL: ${sql}`);
    }
  };
  await withPoolStubs({ getConnection: async () => connection }, async () => {
    const response = mockRes();
    await controller.deleteText({ params: { id: '31' }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 200);
    assert.deepEqual(response.body(), { id: 31, deleted: true });
    assert.deepEqual(flow, ['BEGIN', 'COMMIT']);
  });

  const foreignConnection = {
    async beginTransaction() {},
    async rollback() { flow.push('FOREIGN-ROLLBACK'); },
    async commit() { throw new Error('must not commit a foreign delete'); },
    release() {},
    async execute(sql) {
      if (/SELECT id_reading_text, source_id FROM reading_texts/i.test(sql)) return [[]];
      throw new Error(`Unexpected foreign delete SQL: ${sql}`);
    }
  };
  await withPoolStubs({ getConnection: async () => foreignConnection }, async () => {
    const response = mockRes();
    await controller.deleteText({ params: { id: '31' }, user: { id: OTHER_USER_ID } }, response.res);
    assert.equal(response.status(), 404);
    assert.ok(flow.includes('FOREIGN-ROLLBACK'));
  });
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

test('token layer exposes sentences with code-point bounds and per-occurrence tokens with exact offsets', async () => {
  const text = '今日は暑くて、学校に行く。';
  const points = Array.from(text);
  await withPoolStubs({ execute: analysisPool() }, async () => {
    const first = await gradedReader.analyzeTextForReading(pool, USER_ID, text);
    const second = await gradedReader.analyzeTextForReading(pool, USER_ID, text);
    assert.ok(Array.isArray(first.sentences) && first.sentences.length > 0);
    assert.ok(Array.isArray(first.tokens) && first.tokens.length > 0);
    for (const sentence of first.sentences) {
      assert.equal(typeof sentence.id, 'number');
      assert.equal(typeof sentence.text, 'string');
      assert.ok(Number.isInteger(sentence.start) && Number.isInteger(sentence.end));
      assert.equal(points.slice(sentence.start, sentence.end).join(''), sentence.text);
      assert.equal(sentence.end - sentence.start, Array.from(sentence.text).length);
    }
    const wanted = ['surface', 'lemma', 'surfaceReading', 'lemmaReading', 'gloss', 'entityKind', 'candidateId', 'start', 'end', 'sentenceId', 'tappable', 'known', 'level'];
    for (const token of first.tokens) {
      assert.deepEqual(Object.keys(token).sort(), wanted.sort());
      assert.equal(typeof token.surface, 'string');
      assert.ok(token.surface.length > 0);
      assert.equal(points.slice(token.start, token.end).join(''), token.surface);
      assert.ok(['vocabulary', 'kanji', 'grammar'].includes(token.entityKind));
      assert.equal(typeof token.candidateId, 'string');
      assert.ok(token.candidateId.length > 0);
      assert.equal(typeof token.tappable, 'boolean');
      assert.equal(typeof token.known, 'boolean');
      if (token.entityKind === 'vocabulary') assert.equal(token.level, null);
    }
    // Inflected fixture: 暑く (observed) vs 暑い (dictionary form).
    const atsui = first.tokens.find((entry) => entry.entityKind === 'vocabulary' && entry.lemma === '暑い');
    assert.ok(atsui, 'inflected adjective present');
    assert.notEqual(atsui.surface, atsui.lemma);
    assert.equal(points.slice(atsui.start, atsui.end).join(''), atsui.surface);
    assert.equal(atsui.surfaceReading, 'あつく');
    assert.equal(atsui.lemmaReading, null);
    assert.equal(atsui.tappable, true);
    assert.match(atsui.candidateId, /^vocabulary::暑い::/);
    // Deterministic: same text yields identical token and sentence layers.
    assert.deepEqual(second.sentences, first.sentences);
    assert.deepEqual(second.tokens, first.tokens);
    // Legacy annotations stay untouched alongside the new layer.
    assert.ok(Array.isArray(first.annotations));
  });
});

test('token layer withholds readings for proper nouns and unknown spans', async () => {
  const text = '田中さんがxyzを買う。';
  await withPoolStubs({ execute: analysisPool() }, async () => {
    const result = await gradedReader.analyzeTextForReading(pool, USER_ID, text);
    const points = Array.from(text);
    const tanaka = result.tokens.find((entry) => entry.entityKind === 'vocabulary' && entry.surface === '田中');
    assert.ok(tanaka, 'proper-noun token present');
    assert.equal(tanaka.surfaceReading, null);
    assert.equal(tanaka.lemmaReading, null);
    assert.equal(tanaka.tappable, false);
    const unknown = result.tokens.find((entry) => entry.surface === 'xyz');
    assert.ok(unknown, 'unknown token present');
    assert.equal(unknown.surfaceReading, null);
    assert.equal(unknown.lemmaReading, null);
    assert.equal(unknown.tappable, false);
    assert.equal(points.slice(unknown.start, unknown.end).join(''), 'xyz');
  });
});

test('token layer marks particles symbols numerals and suffixes as not tappable', async () => {
  const text = '田中さんが３本買う。';
  await withPoolStubs({ execute: analysisPool() }, async () => {
    const result = await gradedReader.analyzeTextForReading(pool, USER_ID, text);
    const bySurface = (value) => result.tokens.find((entry) => entry.entityKind === 'vocabulary' && entry.surface === value);
    for (const value of ['が', '。', '３', 'さん', '本']) {
      const token = bySurface(value);
      assert.ok(token, `token present for ${value}`);
      assert.equal(token.tappable, false);
    }
    const numeral = bySurface('３');
    assert.match(numeral.candidateId, /^vocabulary::３::/);
    const symbol = bySurface('。');
    assert.equal(symbol.surfaceReading, null);
    assert.equal(symbol.lemmaReading, null);
    const kau = result.tokens.find((entry) => entry.entityKind === 'vocabulary' && entry.lemma === '買う');
    assert.ok(kau);
    assert.equal(kau.tappable, true);
    assert.equal(kau.surfaceReading, 'かう');
  });
});

test('token layer keeps vocabulary level null while kanji carries reference bands', async () => {
  const text = '学校に行く。学校が好き。';
  await withPoolStubs({ execute: analysisPool() }, async () => {
    const result = await gradedReader.analyzeTextForReading(pool, USER_ID, text);
    for (const token of result.tokens) {
      if (token.entityKind === 'vocabulary') assert.equal(token.level, null);
    }
    const gakko = result.tokens.filter((entry) => entry.entityKind === 'vocabulary' && entry.display === undefined && entry.surface === '学校');
    assert.ok(gakko.length >= 2, 'repeat occurrences share one deterministic id');
    assert.equal(gakko[0].candidateId, gakko[1].candidateId);
    assert.match(gakko[0].candidateId, /^vocabulary::学校::/);
    assert.notEqual(gakko[0].sentenceId, gakko[1].sentenceId);
    const gakuKanji = result.tokens.find((entry) => entry.entityKind === 'kanji' && entry.surface === '学');
    assert.ok(gakuKanji);
    assert.equal(gakuKanji.candidateId, 'kanji::学');
    assert.equal(gakuKanji.level, 'N5');
    assert.equal(gakuKanji.known, true);
  });
});

test('token layer aligns astral-plane offsets via Array.from', async () => {
  const text = 'A𠀋学校B。';
  const points = Array.from(text);
  assert.equal(points.length, 6);
  await withPoolStubs({ execute: analysisPool() }, async () => {
    const result = await gradedReader.analyzeTextForReading(pool, USER_ID, text);
    assert.equal(result.sentences.length, 1);
    assert.equal(result.sentences[0].start, 0);
    assert.equal(result.sentences[0].end, points.length);
    for (const token of result.tokens) {
      assert.equal(points.slice(token.start, token.end).join(''), token.surface);
    }
  });
});

test('reading enroll intersects server analysis ignores unknown ids and returns shaped payload', async () => {
  const text = '学校に行く。';
  let analysisExecutor;
  await withPoolStubs({ execute: analysisPool() }, async () => {
    analysisExecutor = pool.execute;
    const analysis = await gradedReader.analyzeTextForReading(pool, USER_ID, text);
    const vocabId = analysis.tokens.find((entry) => entry.entityKind === 'vocabulary' && entry.tappable).candidateId;
    const kanjiId = analysis.tokens.find((entry) => entry.entityKind === 'kanji').candidateId;
    assert.ok(vocabId.startsWith('vocabulary::'));
    assert.ok(kanjiId.startsWith('kanji::'));

    const calls = [];
    const connection = {
      async beginTransaction() { calls.push('BEGIN'); },
      async commit() { calls.push('COMMIT'); },
      async rollback() { calls.push('ROLLBACK'); },
      release() {},
      async execute(sql, params = []) {
        calls.push(sql.slice(0, 48));
        if (/INSERT INTO vocabulary/i.test(sql)) return [{ insertId: 201 }];
        if (/INSERT INTO kanji/i.test(sql)) return [{ insertId: 202 }];
        if (/INSERT INTO grammar_points/i.test(sql)) return [{ insertId: 203 }];
        if (/INSERT INTO review_items/i.test(sql)) return [[{ affectedRows: 1 }]];
        if (/INSERT INTO review_sessions/i.test(sql)) return [{ insertId: 401 }];
        if (/INSERT INTO review_session_items/i.test(sql)) return [[{ affectedRows: 1 }]];
        if (/FROM review_items WHERE/i.test(sql)) return [[{ id_review_item: 301 }]];
        return analysisPool()(sql, params);
      }
    };
    const executor = {
      execute: async (sql, params = []) => {
        if (/FROM reading_texts WHERE id_reading_text/i.test(sql)) {
          assert.ok(params.includes(USER_ID));
          return [[{ id_reading_text: 77, text }]];
        }
        return analysisPool()(sql, params);
      },
      getConnection: async () => connection
    };
    const result = await gradedReader.enrollReadingItems(executor, USER_ID, 77, [vocabId, kanjiId, 'vocabulary::bogus::yomi']);
    assert.equal(typeof result.reviewSessionId, 'number');
    assert.ok(Array.isArray(result.queueItems) && result.queueItems.length === 2);
    assert.equal(result.created, 2);
    assert.ok(Array.isArray(result.items) && result.items.length === 2);
    for (const item of result.items) {
      assert.ok(['vocabulary', 'kanji', 'grammar'].includes(item.entityType));
      assert.equal(typeof item.entityId, 'number');
      assert.equal(typeof item.display, 'string');
    }
    for (const item of result.queueItems) {
      assert.ok(item.display);
      assert.ok(Number.isInteger(item.entityId));
    }
    assert.deepEqual(calls[0], 'BEGIN');
    assert.ok(calls.includes('COMMIT'));
  });
});

test('reading enroll validates selection shape and hides foreign texts', async () => {
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts WHERE id_reading_text/i.test(sql)) return [[]];
    throw new Error(`Unexpected enroll lookup SQL: ${sql}`);
  } }, async () => {
    assert.equal(await gradedReader.enrollReadingItems(pool, USER_ID, 999, ['vocabulary::学校::がっこう']), null);
    await assert.rejects(gradedReader.enrollReadingItems(pool, USER_ID, 999, []), /selected must be an array/);
    await assert.rejects(gradedReader.enrollReadingItems(pool, USER_ID, 999, new Array(201).fill('vocabulary::学校::がっこう')), /selected must be an array/);
    await assert.rejects(gradedReader.enrollReadingItems(pool, USER_ID, 999, [42]), /non-empty candidate id strings/);
  });

  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts WHERE id_reading_text/i.test(sql)) return [[]];
    throw new Error(`Unexpected foreign enroll SQL: ${sql}`);
  } }, async () => {
    const response = mockRes();
    await controller.enrollText({ params: { id: '999' }, body: { selected: ['vocabulary::学校::がっこう'] }, user: { id: USER_ID } }, response.res);
    assert.equal(response.status(), 404);
  });

  const badShape = mockRes();
  await controller.enrollText({ params: { id: '77' }, body: { selected: [] }, user: { id: USER_ID } }, badShape.res);
  assert.equal(badShape.status(), 400);

  const badField = mockRes();
  await controller.enrollText({ params: { id: '77' }, body: { selected: ['vocabulary::学校::がっこう'], extra: 1 }, user: { id: USER_ID } }, badField.res);
  assert.equal(badField.status(), 400);
});

test('token cache hit serves the stored artifact and refreshes only ownership', async () => {
  const calls = [];
  const cachedTokens = [
    { surface: '学校', lemma: '学校', surfaceReading: 'がっこう', lemmaReading: 'がっこう', gloss: 'school', entityKind: 'vocabulary', candidateId: 'vocabulary::学校::がっこう', start: 0, end: 2, sentenceId: 0, tappable: true, known: false, level: null },
    { surface: '学', lemma: null, surfaceReading: null, lemmaReading: null, gloss: 'study', entityKind: 'kanji', candidateId: 'kanji::学', start: 0, end: 1, sentenceId: 0, tappable: true, known: false, level: 'N5' }
  ];
  const cachedAnnotations = [
    { type: 'vocabulary', word: '学校', position: 0, level: null, known: false, reading: 'がっこう', meaning: 'school' },
    { type: 'kanji', char: '学', position: 0, level: 'N5', known: false, reading: 'ガク', meaning: 'study', info: { onyomi: ['ガク'], kunyomi: [] } }
  ];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_texts rt LEFT JOIN/i.test(sql)) {
      return [[{ id: 7, title: 'cached', level: 'N5', sourceType: 'user', metadata: {}, text: '学校に行く。', annotations_json: cachedAnnotations, sentences_json: [{ id: 0, text: '学校に行く。', start: 0, end: 6 }], tokens_json: { tokens: cachedTokens, truncated: false }, position: null, completedAt: null, timeSpentSeconds: 0 }]];
    }
    if (/FROM vocabulary WHERE user_id/i.test(sql)) {
      assert.ok(params.includes(USER_ID));
      return [[{ word: '学校', reading: 'がっこう' }]];
    }
    if (/FROM kanji WHERE user_id/i.test(sql)) return [[{ character_kanji: '学' }]];
    if (/FROM grammar_reference/i.test(sql)) return [[]];
    if (/FROM grammar_points/i.test(sql)) return [[]];
    throw new Error(`Unexpected cache-hit SQL: ${sql.slice(0, 80)}`);
  } }, async () => {
    const data = await gradedReader.getReadingText(pool, USER_ID, 7);
    assert.deepEqual(data.tokens, cachedTokens.map((token) => ({ ...token, known: true })), 'cached tokens served with refreshed known');
    assert.deepEqual(data.annotations, cachedAnnotations.map((item) => ({ ...item, known: true })));
    assert.deepEqual(data.sentences, [{ id: 0, text: '学校に行く。', start: 0, end: 6 }]);
    assert.equal(data.truncated, false);
    assert.ok(!calls.some(({ sql }) => /kanji_reference|jmdict/i.test(sql)), 'no reference/gloss analysis queries on a hit');
    assert.ok(calls.length <= 6, `bounded overlay queries, saw ${calls.length}`);
  });
});

test('token cache miss analyzes once and persists the artifact', async () => {
  const calls = [];
  const updated = [];
  const base = analysisPool(calls);
  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/FROM reading_texts rt LEFT JOIN/i.test(sql)) {
      calls.push({ sql, params });
      return [[{ id: 9, title: 'fresh', level: null, sourceType: 'user', metadata: {}, text: '学校に行く。', annotations_json: null, sentences_json: null, tokens_json: null, position: null, completedAt: null, timeSpentSeconds: 0 }]];
    }
    if (/UPDATE reading_texts SET sentences_json/i.test(sql)) {
      calls.push({ sql, params });
      updated.push(params);
      return [{ affectedRows: 1 }];
    }
    return base(sql, params);
  } }, async () => {
    const data = await gradedReader.getReadingText(pool, USER_ID, 9);
    assert.ok(Array.isArray(data.tokens) && data.tokens.length > 0, 'fresh analysis served');
    assert.equal(data.truncated, false);
    assert.equal(updated.length, 1, 'cache persisted once');
    assert.deepEqual(updated[0].slice(2), [9, USER_ID], 'persist scoped to the owned text');
    const persisted = JSON.parse(updated[0][1]);
    assert.ok(Array.isArray(persisted.tokens) && persisted.tokens.length > 0, 'tokens stored');
    assert.equal(persisted.truncated, false);
  });
});

test('token layer caps unbounded texts with truncated:true', async () => {
  assert.equal(gradedReader.MAX_TOKENS, 2000);
  const calls = [];
  await withPoolStubs({ execute: analysisPool(calls) }, async () => {
    const data = await gradedReader.analyzeTextForReading(pool, USER_ID, '学'.repeat(2101));
    assert.equal(data.tokens.length, gradedReader.MAX_TOKENS);
    assert.equal(data.truncated, true);
    const points = Array.from('学'.repeat(2101));
    for (const token of data.tokens) {
      assert.equal(points.slice(token.start, token.end).join(''), token.surface, 'capped tokens still slice exact');
    }
    const small = await gradedReader.analyzeTextForReading(pool, USER_ID, '学校に行く。');
    assert.ok(small.tokens.length > 0 && small.tokens.length < gradedReader.MAX_TOKENS);
    assert.equal(small.truncated, false);
  });
});

test('ownership overlay never trusts baked known flags', async () => {
  const cachedTokens = [
    { surface: '学校', lemma: '学校', surfaceReading: 'がっこう', lemmaReading: 'がっこう', gloss: 'school', entityKind: 'vocabulary', candidateId: 'vocabulary::学校::がっこう', start: 0, end: 2, sentenceId: 0, tappable: true, known: true, level: null }
  ];
  const cachedAnnotations = [
    { type: 'vocabulary', word: '学校', position: 0, level: null, known: true, reading: 'がっこう', meaning: 'school' }
  ];
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt LEFT JOIN/i.test(sql)) {
      return [[{ id: 11, title: 'stale', level: null, sourceType: 'user', metadata: {}, text: '学校。', annotations_json: cachedAnnotations, sentences_json: [{ id: 0, text: '学校。', start: 0, end: 3 }], tokens_json: { tokens: cachedTokens, truncated: false }, position: null, completedAt: null, timeSpentSeconds: 0 }]];
    }
    if (/FROM (vocabulary|kanji|grammar_points|grammar_reference)/i.test(sql)) return [[]];
    throw new Error(`Unexpected stale-overlay SQL: ${sql.slice(0, 80)}`);
  } }, async () => {
    const data = await gradedReader.getReadingText(pool, USER_ID, 11);
    assert.ok(data.tokens.every((token) => token.known === false), 'stale token flags reset');
    assert.ok(data.annotations.every((item) => item.known === false), 'stale annotation flags reset');
  });
});

test('sentence translations validate shape ids and length', async () => {
  const row = [[{ id_reading_text: 5, text: '学校に行く。' }]];
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts WHERE id_reading_text/i.test(sql)) return row;
    if (/UPDATE reading_texts SET sentence_translations_json/i.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected translation SQL: ${sql.slice(0, 80)}`);
  } }, async () => {
    await assert.rejects(gradedReader.saveSentenceTranslations(pool, USER_ID, 5, 'nope'), /must be an array/);
    await assert.rejects(gradedReader.saveSentenceTranslations(pool, USER_ID, 5, [null]), /must be a \{sentenceId, translation\} object/);
    await assert.rejects(gradedReader.saveSentenceTranslations(pool, USER_ID, 5, [{ sentenceId: 9, translation: 'x' }]), /does not exist in this text/);
    await assert.rejects(gradedReader.saveSentenceTranslations(pool, USER_ID, 5, [{ sentenceId: 0, translation: 42 }]), /must be a string/);
    await assert.rejects(
      gradedReader.saveSentenceTranslations(pool, USER_ID, 5, [{ sentenceId: 0, translation: 'x'.repeat(gradedReader.MAX_TRANSLATION_LENGTH + 1) }]),
      /must not exceed/
    );
    const cleared = await gradedReader.saveSentenceTranslations(pool, USER_ID, 5, [{ sentenceId: 0, translation: '   ' }]);
    assert.deepEqual(cleared, {}, 'blank entries clear instead of storing whitespace');
    const dupes = await gradedReader.saveSentenceTranslations(pool, USER_ID, 5, [{ sentenceId: 0, translation: 'a' }, { sentenceId: 0, translation: 'b' }]);
    assert.deepEqual(dupes, { 0: 'b' }, 'duplicate ids keep the last value');
  });

  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts WHERE id_reading_text/i.test(sql)) return [[]];
    throw new Error(`Unexpected foreign translation SQL: ${sql.slice(0, 80)}`);
  } }, async () => {
    assert.equal(await gradedReader.saveSentenceTranslations(pool, USER_ID, 999, [{ sentenceId: 0, translation: 'x' }]), null);
  });
});

test('sentence translations save scoped and merge into GET', async () => {
  const calls = [];
  const base = analysisPool(calls);
  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/FROM reading_texts WHERE id_reading_text/i.test(sql)) {
      calls.push({ sql, params });
      return [[{ id_reading_text: 5, text: '学校に行く。' }]];
    }
    if (/UPDATE reading_texts SET sentence_translations_json/i.test(sql)) {
      calls.push({ sql, params });
      assert.ok(params.includes(USER_ID), 'persist stays user-scoped');
      return [{ affectedRows: 1 }];
    }
    if (/FROM reading_texts rt LEFT JOIN/i.test(sql)) {
      calls.push({ sql, params });
      return [[{ id: 5, title: 'T', level: null, sourceType: 'user', metadata: {}, text: '学校に行く。', annotations_json: null, sentences_json: null, tokens_json: null, sentence_translations_json: { 0: 'Go to school.' }, position: null, completedAt: null, timeSpentSeconds: 0 }]];
    }
    if (/UPDATE reading_texts SET sentences_json/i.test(sql)) {
      calls.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
    return base(sql, params);
  } }, async () => {
    const saved = await gradedReader.saveSentenceTranslations(pool, USER_ID, 5, [{ sentenceId: 0, translation: '  Go to school. ' }]);
    assert.deepEqual(saved, { 0: 'Go to school.' }, 'trimmed map returned');
    const data = await gradedReader.getReadingText(pool, USER_ID, 5);
    assert.deepEqual(data.translations, { 0: 'Go to school.' }, 'stored map merged into GET');
  });
});

test('translations endpoint validates rejects unknown fields and hides foreign texts', async () => {
  const row = [[{ id_reading_text: 5, text: '学校に行く。' }]];
  const stub = async (sql) => {
    if (/FROM reading_texts WHERE id_reading_text/i.test(sql)) return row;
    if (/UPDATE reading_texts SET sentence_translations_json/i.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected translations endpoint SQL: ${sql.slice(0, 80)}`);
  };
  await withPoolStubs({ execute: stub }, async () => {
    const badShape = mockRes();
    await controller.putTranslations({ params: { id: '5' }, body: { translations: 'nope' }, user: { id: USER_ID } }, badShape.res);
    assert.equal(badShape.status(), 400);

    const badField = mockRes();
    await controller.putTranslations({ params: { id: '5' }, body: { translations: [], extra: 1 }, user: { id: USER_ID } }, badField.res);
    assert.equal(badField.status(), 400);

    const happy = mockRes();
    await controller.putTranslations({ params: { id: '5' }, body: { translations: [{ sentenceId: 0, translation: 'Go.' }] }, user: { id: USER_ID } }, happy.res);
    assert.equal(happy.status(), 200);
    assert.equal(happy.body().text_id, 5);
    assert.deepEqual(happy.body().translations, { 0: 'Go.' });
  });

  await withPoolStubs({ execute: async () => [[]] }, async () => {
    const foreign = mockRes();
    await controller.putTranslations({ params: { id: '999' }, body: { translations: [] }, user: { id: USER_ID } }, foreign.res);
    assert.equal(foreign.status(), 404);
  });
});

test('re-import refresh resets cached analysis columns and translations', async () => {
  const pages = new Map([
    [gradedReader.AOZORA_LISTING_URL, '<a href="/cards/000002/card2.html">Two</a>'],
    ['https://www.aozora.gr.jp/cards/000002/card2.html', '<a href="./files/2_1.html">2_1.html</a>'],
    ['https://www.aozora.gr.jp/cards/000002/files/2_1.html', '<div class="main_text"><p>読む。</p></div>']
  ]);
  const fetchStub = async (url) => {
    const page = pages.get(String(url));
    if (!page) throw new Error(`unlisted source URL: ${url}`);
    return { ok: true, headers: { get: () => String(Buffer.byteLength(page)) }, text: async () => page };
  };
  const analyze = analysisPool();
  const calls = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/pg_advisory_xact_lock/i.test(sql)) return [[]];
      if (/FROM reading_sources WHERE type/i.test(sql)) return [[{ id_reading_source: 71 }]];
      if (/UPDATE reading_sources/i.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM reading_texts WHERE source_id/i.test(sql)) return [[{ id_reading_text: 72 }]];
      if (/UPDATE reading_texts SET text/i.test(sql)) return [{ affectedRows: 1 }];
      return analyze(sql, params);
    }
  };
  const executor = { execute: (sql, params) => analyze(sql, params), getConnection: async () => connection };
  const result = await gradedReader.syncReadingSources(executor, USER_ID, 'aozora', {
    fetch: fetchStub,
    urls: ['https://www.aozora.gr.jp/cards/000002/card2.html']
  });
  assert.equal(result.status, 'ok');
  const refresh = calls.find(({ sql }) => /UPDATE reading_texts SET text/i.test(sql));
  assert.ok(refresh, 'existing text refreshed via UPDATE');
  assert.match(refresh.sql, /sentence_translations_json = NULL/, 'stale translations reset on refresh');
  assert.match(refresh.sql, /sentences_json = NULL/, 'stale token cache reset on refresh');
});
