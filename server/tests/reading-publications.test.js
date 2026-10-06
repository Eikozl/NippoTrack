// Reading publications (Reading <-> Community): snapshot publish, public
// feed, owner delete and import-to-library.mirrors deck publication pins.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const pool = require('../src/config/db');
const controller = require('../src/controllers/readingPublicationsController');
const service = require('../src/services/readingPublications');
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
    return await callback();
  } finally {
    for (const [method, original] of Object.entries(originals)) pool[method] = original;
  }
}

const OWN_TEXT = [{ id_reading_text: 5, title: 'My story', level: 'N5', text: '犬がいる。', sentence_translations_json: { 0: 'There is a dog.' } }];

test('publish snapshots an owned text with its translations', async () => {
  const calls = [];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_texts rt/i.test(sql)) {
      assert.ok(params.includes(USER_ID), 'ownership predicate stays user-scoped');
      return [OWN_TEXT];
    }
    if (/INSERT INTO reading_publications/i.test(sql)) return [{ insertId: 11 }];
    throw new Error(`Unexpected publish SQL: ${sql.slice(0, 80)}`);
  } }, async () => {
    const result = await service.publishReading(pool, USER_ID, { textId: 5, description: 'Nice tale' });
    assert.deepEqual(result, { id: 11 });
    const insert = calls.find(({ sql }) => /INSERT INTO reading_publications/i.test(sql));
    assert.deepEqual(insert.params.slice(0, 4), [USER_ID, 'My story', 'Nice tale', 'N5']);
    assert.deepEqual(JSON.parse(insert.params[5]), { 0: 'There is a dog.' }, 'translations snapshotted');
  });
});

test('publish refuses copies imported from Community', async () => {
  const importedRow = [[{
    id_reading_text: 8, title: 'Shared tale', level: 'N4', text: '犬がいる。',
    sentence_translations_json: null, source_type: 'user',
    source_metadata: { importedFromPublication: 11 }
  }]];
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt/i.test(sql)) return importedRow;
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    await assert.rejects(
      service.publishReading(pool, USER_ID, { textId: 8 }),
      /cannot be republished/,
      'imported copies are blocked even though they are owned'
    );
  });
  // Serialized (string) metadata from drivers without jsonb parsing: same gate.
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt/i.test(sql)) {
      return [[{ ...importedRow[0][0], source_metadata: '{"importedFromPublication":11}' }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    await assert.rejects(service.publishReading(pool, USER_ID, { textId: 8 }), /cannot be republished/);
  });
  // Legacy rows without any provenance marker stay publishable (grandfathered).
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt/i.test(sql)) return [OWN_TEXT];
    if (/INSERT INTO reading_publications/i.test(sql)) return [{ insertId: 12 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    assert.deepEqual(await service.publishReading(pool, USER_ID, { textId: 5 }), { id: 12 });
  });
});

test('publish rejects bad shape and hides foreign texts', async () => {
  await withPoolStubs({ execute: async () => [[]] }, async () => {
    assert.equal(await service.publishReading(pool, USER_ID, { textId: 999 }), null);
    await assert.rejects(service.publishReading(pool, USER_ID, { textId: 0 }), /positive integer/);
    await assert.rejects(service.publishReading(pool, USER_ID, { textId: 'abc' }), /positive integer/);
  });
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt/i.test(sql)) return [[{ id_reading_text: 6, title: '  ', level: null, text: 'x', sentence_translations_json: null }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    await assert.rejects(service.publishReading(pool, USER_ID, { textId: 6 }), /non-empty string/);
  });
});

test('postgres adapter maps reading_publications so bare INSERTs keep insertId', () => {
  // Regression: without this mapping the adapter skips auto-RETURNING and
  // publish throws on real Postgres (stubs always returned insertId, hiding
  // it). Mirrors the grammar_examples pin.
  const { ID_COLUMNS } = require('../src/config/db');
  assert.equal(ID_COLUMNS.reading_publications, 'id_reading_publication');
});

test('feed lists public rows with author and size, owner filter stays scoped', async () => {
  const calls = [];
  const feedRows = [[
    { id: 11, title: 'T1', description: '', level: 'N5', is_public: true, owner_id: OTHER_ID, owner_username: 'yef', owner_display: null, created_at: '2026-01-01', chars: '120', has_translations: true }
  ]];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_publications r/i.test(sql)) return feedRows;
    throw new Error(`Unexpected feed SQL: ${sql.slice(0, 80)}`);
  } }, async () => {
    const feed = await service.listReadingPublications(pool, { limit: 30 });
    assert.equal(feed.items.length, 1);
    assert.deepEqual(feed.items[0], {
      id: 11, title: 'T1', description: '', level: 'N5', isPublic: true, mine: false,
      ownerUsername: 'yef', ownerDisplay: null, createdAt: '2026-01-01', chars: 120, hasTranslations: true
    });
    assert.ok(/is_public = TRUE/.test(calls[0].sql), 'public feed hides private rows');
    await service.listReadingPublications(pool, { ownerId: USER_ID });
    assert.ok(/r\.owner_id = \?/.test(calls[1].sql) && calls[1].params.includes(USER_ID), 'owner filter stays user-scoped');
  });
});

test('detail hides private rows from strangers and flags ownership', async () => {
  const pubRow = (isPublic, owner) => [[{
    id: 11, owner_id: owner, title: 'T1', description: '', level: null, text: '犬。',
    translations_json: {}, is_public: isPublic, created_at: '2026-01-01', owner_username: null, owner_display: 'Yef'
  }]];
  const getAs = async (isPublic, owner, viewer) => withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_publications r/i.test(sql)) return pubRow(isPublic, owner);
    throw new Error(`Unexpected detail SQL: ${sql.slice(0, 60)}`);
  } }, async () => service.getReadingPublication(pool, 11, viewer));
  assert.equal(await getAs(false, OTHER_ID, USER_ID), null, 'private hidden from strangers');
  const own = await getAs(false, USER_ID, USER_ID);
  assert.equal(own.mine, true);
  assert.deepEqual(own.translations, {});
  const pub = await getAs(true, OTHER_ID, USER_ID);
  assert.equal(pub.mine, false);
  assert.equal(pub.text, '犬。');
});

test('delete is owner-only', async () => {
  const calls = [];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_publications WHERE/i.test(sql)) return [[{ owner_id: OTHER_ID }]];
    throw new Error(`Unexpected delete SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    assert.equal(await service.deleteReadingPublication(pool, 11, USER_ID), null);
    assert.ok(!calls.some(({ sql }) => /^DELETE/i.test(sql.trim())), 'no delete issued for strangers');
  });
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_publications WHERE/i.test(sql)) return [[{ owner_id: USER_ID }]];
    if (/^DELETE FROM reading_publications/i.test(sql.trim())) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected owner delete SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    assert.deepEqual(await service.deleteReadingPublication(pool, 11, USER_ID), { deletedId: 11 });
  });
});

test('import copies text plus translations into the importer library', async () => {
  const calls = [];
  const pubRow = [[{
    id: 11, owner_id: OTHER_ID, title: 'Shared tale', description: '', level: 'N4', text: '犬がいる。',
    translations_json: { 0: 'There is a dog.' }, is_public: true, created_at: '2026-01-01',
    owner_username: null, owner_display: null
  }]];
  const analysisStub = async (sql) => {
    if (/FROM kanji_reference/i.test(sql)) return [[]];
    if (/FROM kanji WHERE user_id/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE user_id/i.test(sql)) return [[]];
    if (/FROM jmdict/i.test(sql)) return [[]];
    if (/FROM grammar_reference/i.test(sql)) return [[]];
    if (/FROM grammar_points/i.test(sql)) return [[]];
    throw new Error(`Unexpected import analysis SQL: ${sql.slice(0, 70)}`);
  };
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO reading_sources/i.test(sql)) return [{ insertId: 71 }];
      if (/INSERT INTO reading_texts/i.test(sql)) return [{ insertId: 72 }];
      return analysisStub(sql, params);
    }
  };
  await withPoolStubs({
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM reading_publications r/i.test(sql)) return pubRow;
      if (/importedFromPublication/i.test(sql)) return [[]];
      if (/UPDATE reading_texts SET sentence_translations_json/i.test(sql)) return [{ affectedRows: 1 }];
      return analysisStub(sql, params);
    },
    getConnection: async () => connection
  }, async () => {
    const result = await service.importReadingPublication(pool, USER_ID, 11);
    assert.equal(result.id, 72);
    assert.equal(result.title, 'Shared tale');
    const textInsert = calls.find(({ sql }) => /INSERT INTO reading_texts/i.test(sql));
    assert.ok(textInsert && textInsert.params.includes(USER_ID), 'copy lands in the importer library');
    const sourceInsert = calls.find(({ sql }) => /INSERT INTO reading_sources/i.test(sql));
    assert.deepEqual(JSON.parse(sourceInsert.params[1]), { importedFromPublication: 11 }, 'import stamps provenance so the copy can never be republished');
    const translationUpdate = calls.find(({ sql }) => /UPDATE reading_texts SET sentence_translations_json/i.test(sql));
    assert.ok(translationUpdate, 'translations travel with the import');
    assert.deepEqual(JSON.parse(translationUpdate.params[0]), { 0: 'There is a dog.' });
  });
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    throw new Error(`Unexpected missing import SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    assert.equal(await service.importReadingPublication(pool, USER_ID, 999), null);
  });
});

test('import is idempotent: re-importing returns the existing copy', async () => {
  const calls = [];
  const pubRow = [[{
    id: 11, owner_id: OTHER_ID, title: 'Shared tale', description: '', level: 'N4', text: '犬がいる。',
    translations_json: null, is_public: true, created_at: '2026-01-01',
    owner_username: null, owner_display: null
  }]];
  await withPoolStubs({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_publications r/i.test(sql)) return pubRow;
    if (/importedFromPublication/i.test(sql)) {
      assert.ok(params.includes(USER_ID), 'dedupe lookup stays user-scoped');
      assert.ok(params.includes('11'), 'dedupe matches the publication marker');
      return [[{ id: 72, title: 'Shared tale' }]];
    }
    throw new Error(`Unexpected duplicate-import SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    assert.deepEqual(await service.importReadingPublication(pool, USER_ID, 11), { id: 72, title: 'Shared tale', duplicate: true });
    assert.ok(!calls.some(({ sql }) => /INSERT INTO reading_(sources|texts)/i.test(sql)), 'no second copy created');
  });
});

test('publication endpoints validate shape and hide foreign rows', async () => {
  const badField = mockRes();
  await controller.postPublish({ body: { textId: 5, nope: 1 }, user: { id: USER_ID } }, badField.res);
  assert.equal(badField.status(), 400);

  await withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    throw new Error(`Unexpected endpoint SQL: ${sql.slice(0, 60)}`);
  } }, async () => {
    const missing = mockRes();
    await controller.postPublish({ body: { textId: 777 }, user: { id: USER_ID } }, missing.res);
    assert.equal(missing.status(), 404);

    const gone = mockRes();
    await controller.getPublication({ params: { id: '777' }, user: { id: USER_ID } }, gone.res);
    assert.equal(gone.status(), 404);
  });

  const badId = mockRes();
  await controller.getPublication({ params: { id: 'nope' }, user: { id: USER_ID } }, badId.res);
  assert.equal(badId.status(), 400);
});

test('reading text response flags ownership for the publish gate', async () => {
  const cached = {
    annotations_json: [],
    sentences_json: [{ id: 0, text: '犬。', start: 0, end: 2 }],
    tokens_json: { tokens: [], truncated: false }
  };
  const rowFor = (ownerId) => [[{
    id: 5, ownerId, title: 'T', level: null, sourceType: 'user', metadata: {}, text: '犬。',
    ...cached, position: null, completedAt: null, timeSpentSeconds: 0
  }]];
  const runAs = async (ownerId) => withPoolStubs({ execute: async (sql) => {
    if (/FROM reading_texts rt LEFT JOIN/i.test(sql)) return rowFor(ownerId);
    if (/FROM (vocabulary|kanji|grammar_points|grammar_reference)/i.test(sql)) return [[]];
    throw new Error(`Unexpected ownership SQL: ${sql.slice(0, 60)}`);
  } }, async () => gradedReader.getReadingText(pool, USER_ID, 5));
  assert.equal((await runAs(USER_ID)).mine, true);
  assert.equal((await runAs(OTHER_ID)).mine, false);
  assert.equal((await runAs(null)).mine, false);
});
