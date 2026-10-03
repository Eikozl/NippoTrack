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
    if (/INSERT INTO user_reading_progress/i.test(sql)) return [[{ id: 4 }]];
    if (/SELECT position FROM user_reading_progress/i.test(sql)) return [[{ position: '2' }]];
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
  });

  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/SELECT id_reading_text, text FROM reading_texts/i.test(sql)) {
      return [[{ id_reading_text: 31, text: '学生' }]];
    }
    // Stored position 5 wins over the submitted 1: progress never regresses,
    // and the response echoes the stored (post-GREATEST) value.
    if (/INSERT INTO user_reading_progress/i.test(sql)) return [[{ id: 4 }]];
    if (/SELECT position FROM user_reading_progress/i.test(sql)) return [[{ position: '5' }]];
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

  // The endpoint only validates and enqueues (202): real imports take minutes
  // (per-text classification), so the work runs detached after the response.
  const accepted = mockRes();
  await controller.importSources({ body: { sourceType: 'aozora' }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } }, accepted.res);
  assert.equal(accepted.status(), 202);
  assert.deepEqual(accepted.body(), { status: 'accepted', sourceType: 'aozora' });
  // Let the detached background attempt settle (it fails against the offline
  // fetch stub and logs; it must never reject into the request lifecycle).
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const retired = mockRes();
  await controller.importSources({ body: { sourceType: 'nhk' }, user: { id: USER_ID } }, retired.res);
  assert.equal(retired.status(), 400);
  assert.match(retired.body().error, /sourceType must be aozora or hukumusume/i);

  const hukuAccepted = mockRes();
  await controller.importSources(
    { body: { sourceType: 'hukumusume', urls: ['https://hukumusume.com/douwa/pc/jap/01/01.htm'], index: '01' }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } },
    hukuAccepted.res
  );
  assert.equal(hukuAccepted.status(), 202);
  assert.deepEqual(hukuAccepted.body(), { status: 'accepted', sourceType: 'hukumusume' });

  const badHukuIndex = mockRes();
  await controller.importSources(
    { body: { sourceType: 'hukumusume', index: '99' }, user: { id: USER_ID } },
    badHukuIndex.res
  );
  assert.equal(badHukuIndex.status(), 400);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
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

  // Pasted-link shape validation covers both hosts.
  for (const url of ['https://hukumusume.com/douwa/pc/jap/01/01.htm.evil', 'https://hukumusume.com/other/page.html', 'https://www.aozora.gr.jp/cards/1/card1.html ']) {
    const probe = mockRes();
    await controller.importFromUrl({ body: { url }, user: { id: USER_ID } }, probe.res);
    if (url.trim().startsWith('https://www.aozora.gr.jp/cards/1/card1.html')) {
      assert.equal(probe.status(), 202, 'aozora card link still accepted');
    } else {
      assert.equal(probe.status(), 400, `url rejected: ${url}`);
    }
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

  const accepted = mockRes();
  await controller.importFromUrl({ body: { url: cardUrl }, user: { id: USER_ID }, app: { locals: { readingFetch: async () => { throw new Error('offline'); } } } }, accepted.res);
  assert.equal(accepted.status(), 202);
  assert.deepEqual(accepted.body(), { status: 'accepted', sourceType: 'aozora' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
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
