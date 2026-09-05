const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

// Phase 7 — Batch Kanji Import (strategy A: reuse individual POST /api/kanji
// sequentially; no batch endpoint). These tests prove the reused endpoint
// satisfies every batch requirement: per-item results, duplicates,
// isolation, race safety, transaction behavior, bounded writes, and no
// session/encounter side effects.

function installKanjiStub({ ownedByUser, references, failInsertFor = null }) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const seen = [];
  let nextId = 100;
  const rollbacks = [];
  const payloadFor = (character) => ({
    character_kanji: character,
    meaning: `${character}-meaning`,
    onyomi: `${character}-on`,
    kunyomi: `${character}-kun`,
    jlpt_level: 'N5',
    status: 'New'
  });
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM kanji WHERE user_id = \? AND character_kanji = \?/i.test(sql)) {
      const owned = ownedByUser[params[0]] || new Map();
      const row = owned.get(params[1]);
      return [row ? [row] : []];
    }
    if (/FROM kanji_reference WHERE character = \?/i.test(sql)) {
      return [references.has(params[0]) ? [{ reference_id: references.get(params[0]) }] : []];
    }
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) {
      // Batched discovery/coverage lookup: requester's kanji for IN chars.
      const owned = ownedByUser[params[0]] || new Map();
      return [params.slice(1).filter((ch) => owned.has(ch)).map((ch) => owned.get(ch))];
    }
    if (/FROM kanji WHERE/i.test(sql)) {
      // fetchEntityById after insert: echo the created row.
      const owned = ownedByUser[params[1]] || new Map();
      const row = [...owned.values()].find((candidate) => candidate.id_kanji === params[0]);
      return [row ? [row] : []];
    }
    return [[]];
  };
  pool.getConnection = async () => {
    const connection = {
      committed: false,
      async beginTransaction() {},
      async execute(sql, params) {
        seen.push({ sql, params, via: 'connection' });
        if (/^INSERT INTO kanji /i.test(sql)) {
          const character = params[0];
          if (failInsertFor === character) {
            const error = new Error('boom');
            throw error;
          }
          const owned = ownedByUser[params[7]] || new Map();
          if (owned.has(character)) {
            // A concurrent request won the race: unique constraint fires and
            // the controller recovers with a user-scoped 409.
            const error = new Error('duplicate key value violates unique constraint');
            error.code = '23505';
            throw error;
          }
          const row = { id_kanji: nextId++, character_kanji: character, meaning: params[1], jlpt_level: params[4], status: params[5] };
          owned.set(character, row);
          ownedByUser[params[7]] = owned;
          return [{ insertId: row.id_kanji }];
        }
        if (/INSERT INTO review_items/i.test(sql)) return [{ affectedRows: 1 }];
        return [{ affectedRows: 1 }];
      },
      async commit() { connection.committed = true; },
      async rollback() { rollbacks.push(true); },
      release() {}
    };
    return connection;
  };
  return { originalExecute, originalGetConnection, seen, rollbacks, payloadFor };
}

function restoreStub(handles) {
  const pool = require('../src/config/db');
  pool.execute = handles.originalExecute;
  pool.getConnection = handles.originalGetConnection;
}

test.after(async () => {
  try {
    const pool = require('../src/config/db');
    await pool.end();
  } catch {
    // Pool may already be ended when only unit tests ran; ignore.
  }
});

async function postKanji(base, payload) {
  const response = await fetch(`${base}/api/kanji`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error shape */ }
  return { status: response.status, body };
}

test('Phase 7: batch of several valid missing kanji all import (201 each)', async () => {
  const app = require('../src/app');
  const references = new Map([['学', 1], ['校', 2], ['行', 3]]);
  const stub = installKanjiStub({ ownedByUser: { [TEST_USER]: new Map() }, references });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const results = [];
    for (const character of ['学', '校', '行']) {
      results.push(await postKanji(base, stub.payloadFor(character)));
    }
    assert.deepEqual(results.map((result) => result.status), [201, 201, 201]);
    assert.deepEqual(results.map((result) => result.body.character_kanji), ['学', '校', '行']);
    // Ownership derived server-side from the authenticated user.
    const inserts = stub.seen.filter(({ sql }) => /^INSERT INTO kanji /i.test(sql));
    assert.equal(inserts.length, 3);
    for (const insert of inserts) assert.deepEqual(insert.params[7], TEST_USER);
    // Bounded writes: one review item per kanji, no session/encounter writes.
    assert.equal(stub.seen.filter(({ sql }) => /INSERT INTO review_items/i.test(sql)).length, 3);
    assert.equal(stub.seen.filter(({ sql }) => /kanji_encounters|session_writings/i.test(sql)).length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});

test('Phase 7: mixture of already-owned and missing yields 409 + 201', async () => {
  const app = require('../src/app');
  const references = new Map([['学', 1], ['日', 2]]);
  const ownedRow = (character) => ({ id_kanji: 7, character_kanji: character, meaning: 'day', jlpt_level: 'N5', status: 'New' });
  const stub = installKanjiStub({
    ownedByUser: { [TEST_USER]: new Map([['日', ownedRow('日')]]) },
    references
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ownedResult = await postKanji(base, stub.payloadFor('日'));
    assert.equal(ownedResult.status, 409);
    const missingResult = await postKanji(base, stub.payloadFor('学'));
    assert.equal(missingResult.status, 201);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});

test('Phase 7: duplicate characters in one batch resolve to 201 then 409', async () => {
  const app = require('../src/app');
  const stub = installKanjiStub({ ownedByUser: { [TEST_USER]: new Map() }, references: new Map([['学', 1]]) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const outcomes = [];
    for (const character of ['学', '学']) {
      outcomes.push(await postKanji(base, stub.payloadFor(character)));
    }
    assert.deepEqual(outcomes.map((result) => result.status), [201, 409]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});

test('Phase 7: invalid item fails without blocking the rest of the batch', async () => {
  const app = require('../src/app');
  const stub = installKanjiStub({ ownedByUser: { [TEST_USER]: new Map() }, references: new Map([['学', 1], ['校', 2]]) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const invalid = await postKanji(base, { ...stub.payloadFor('校'), meaning: '' });
    assert.equal(invalid.status, 400);
    const valid = await postKanji(base, stub.payloadFor('学'));
    assert.equal(valid.status, 201);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});

test('Phase 7: character owned by another user does not conflict (isolation)', async () => {
  const app = require('../src/app');
  const ownedRow = (character) => ({ id_kanji: 42, character_kanji: character, meaning: 'day', jlpt_level: 'N5', status: 'New' });
  const stub = installKanjiStub({
    ownedByUser: { [OTHER_USER]: new Map([['日', ownedRow('日')]]) },
    references: new Map([['日', 2]])
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await postKanji(base, stub.payloadFor('日'));
    assert.equal(result.status, 201);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});

test('Phase 7: concurrent duplicate imports resolve duplicate-safe (201 + 409)', async () => {
  const app = require('../src/app');
  const stub = installKanjiStub({ ownedByUser: { [TEST_USER]: new Map() }, references: new Map([['競', 9]]) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const outcomes = await Promise.all([
      postKanji(base, stub.payloadFor('競')),
      postKanji(base, stub.payloadFor('競'))
    ]);
    assert.deepEqual(outcomes.map((result) => result.status).sort(), [201, 409]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});

test('Phase 7: insert failure rolls back the item transaction and reports an error', async () => {
  const app = require('../src/app');
  const stub = installKanjiStub({
    ownedByUser: { [TEST_USER]: new Map() },
    references: new Map([['学', 1]]),
    failInsertFor: '学'
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await postKanji(base, stub.payloadFor('学'));
    assert.ok(result.status >= 500, `expected 5xx, saw ${result.status}`);
    assert.equal(stub.rollbacks.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});

test('Phase 7: batch import leaves session content and encounters untouched', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const references = new Map([['学', 1]]);
  const stub = installKanjiStub({ ownedByUser: { [TEST_USER]: new Map() }, references });
  // Layer session reads on top of the kanji stub (delegate to the installed
  // stub, never to the real pool).
  const stubExecute = pool.execute;
  pool.execute = async (sql, params) => {
    if (/FROM study_sessions WHERE/i.test(sql)) {
      return [[{ id_session: 5, session_date: '2026-09-01', duration_minutes: 30, category: 'Writing', resource: null, notes: null }]];
    }
    if (/FROM session_writings/i.test(sql)) {
      return [[{ id_session_writing: 9, title: 'oct', content: '今日は学校に行く', notes: null }]];
    }
    return stubExecute(sql, params);
  };
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const before = await (await fetch(`${base}/api/sessions/5`)).json();
    assert.equal(before.writing.content, '今日は学校に行く');
    const imported = await postKanji(base, stub.payloadFor('学'));
    assert.equal(imported.status, 201);
    const after = await (await fetch(`${base}/api/sessions/5`)).json();
    assert.equal(after.writing.content, '今日は学校に行く');
    assert.deepEqual(after.kanjiDiscovery.characters, before.kanjiDiscovery.characters);
    const gaku = after.kanjiDiscovery.kanji.find((entry) => entry.character === '学');
    assert.equal(gaku.discoveryState, 'alreadyInCollection');
    // No encounter rows are generated merely by importing.
    assert.equal(stub.seen.filter(({ sql }) => /kanji_encounters/i.test(sql)).length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restoreStub(stub);
  }
});
