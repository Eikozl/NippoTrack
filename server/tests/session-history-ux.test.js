const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';

// Session-history UX rework: the list endpoint enriches each session with a
// writing excerpt + related-link counts in ONE grouped query (no N+1), and
// the simplified form payload (no linking IDs, no writing_notes) preserves
// hidden existing data on edit.

test.after(async () => {
  try {
    const pool = require('../src/config/db');
    await pool.end();
  } catch {
    // Pool may already be ended when only unit tests ran; ignore.
  }
});

test('Session UX: list enriches cards in exactly two statements, pagination intact', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const seen = [];
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/SELECT COUNT\(\*\) AS total FROM study_sessions/i.test(sql)) {
      // No filters: user scoping is the only parameter.
      assert.deepEqual(params, [TEST_USER]);
      return [[{ total: 2 }]];
    }
    if (/FROM study_sessions s/i.test(sql)) {
      // No filters: [userId, limit, offset].
      assert.deepEqual(params, [TEST_USER, 20, 0]);
      return [[
        {
          id_session: 5, session_date: '2026-09-01', duration_minutes: 30, category: 'Writing',
          resource: 'Genki Ch. 4', notes: 'Felt good.',
          writing_title: 'My weekend', writing_excerpt: '今日は学校に行く',
          vocabulary_count: 3, kanji_count: 2, grammar_count: 0
        },
        {
          id_session: 4, session_date: '2026-08-30', duration_minutes: 15, category: 'Reading',
          resource: null, notes: null,
          writing_title: null, writing_excerpt: null,
          vocabulary_count: 0, kanji_count: 0, grammar_count: 0
        }
      ]];
    }
    return [[]];
  };
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions?limit=20`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.pagination, { page: 1, limit: 20, total: 2, totalPages: 1 });
    const first = body.items[0];
    assert.equal(first.writing_title, 'My weekend');
    assert.equal(first.writing_excerpt, '今日は学校に行く');
    assert.equal(first.vocabulary_count, 3);
    assert.equal(first.kanji_count, 2);
    assert.equal(first.grammar_count, 0);
    const second = body.items[1];
    assert.equal(second.writing_excerpt, null);
    assert.equal(second.vocabulary_count, 0);
    // Exactly two statements (count + grouped items): no per-card queries.
    assert.equal(seen.length, 2);
    const itemsQuery = seen.find(({ sql }) => /GROUP BY/i.test(sql));
    assert.match(itemsQuery.sql, /LEFT JOIN session_writings/);
    assert.match(itemsQuery.sql, /COUNT\(DISTINCT sv\.id_vocabulary\)/);
    assert.match(itemsQuery.sql, /COUNT\(DISTINCT sk\.id_kanji\)/);
    assert.match(itemsQuery.sql, /COUNT\(DISTINCT sg\.id_grammar\)/);
    assert.match(itemsQuery.sql, /LEFT\(w\.content, 400\)/);
    assert.match(itemsQuery.sql, /GROUP BY/);
    assert.doesNotMatch(itemsQuery.sql, /kanji_encounters|kanji_reference/);
    // Ownership scoping preserved; content travels only as a bounded excerpt.
    assert.ok(itemsQuery.params.includes(TEST_USER));
    assert.doesNotMatch(itemsQuery.sql, /SELECT w\.content/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    pool.execute = originalExecute;
  }
});

test('Session UX: simplified edit preserves hidden links and writing notes', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const statements = [];
  const existingWriting = { title: 'My weekend', content: '今日は学校に行く', notes: 'hidden writing notes to keep' };
  pool.execute = async (sql, params) => {
    statements.push({ sql, params });
    if (/FROM study_sessions WHERE id_session/i.test(sql)) {
      return [[{ id_session: 5, session_date: '2026-09-01', duration_minutes: 30, category: 'Writing', resource: 'Genki', notes: 'Good.' }]];
    }
    if (/FROM session_writings WHERE id_session/i.test(sql)) {
      return [[existingWriting]];
    }
    return [[]];
  };
  pool.getConnection = async () => ({
    async beginTransaction() {},
    async execute(sql, params) {
      statements.push({ sql, params });
      if (/SELECT title, content, notes FROM session_writings/i.test(sql)) return [[existingWriting]];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {}
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // Simplified-form payload: visible fields only, no *_ids, no writing_notes.
    const response = await fetch(`${base}/api/sessions/5`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_date: '2026-09-01',
        duration_minutes: 45,
        category: 'Writing',
        resource: 'Genki',
        notes: 'Updated notes.',
        writing_title: 'My weekend',
        writing_content: '今日は学校に行く'
      })
    });
    assert.equal(response.status, 200);
    // No relationship DELETE may run when linking IDs are omitted.
    assert.equal(statements.filter(({ sql }) => /DELETE FROM session_/i.test(sql)).length, 0);
    // The writing upsert carries the preserved hidden notes, not a wipe.
    const upsert = statements.find(({ sql }) => /INSERT INTO session_writings/i.test(sql));
    assert.ok(upsert, 'writing upsert must run');
    assert.deepEqual(upsert.params, [5, 'My weekend', '今日は学校に行く', 'hidden writing notes to keep']);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});

test('Session UX: create with the simplified contract still succeeds', async () => {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const statements = [];
  pool.execute = async (sql, params) => {
    statements.push({ sql, params });
    if (/FROM study_sessions WHERE id_session/i.test(sql)) {
      return [[{ id_session: 9, session_date: '2026-09-05', duration_minutes: 20, category: 'Reading', resource: null, notes: null }]];
    }
    return [[]];
  };
  pool.getConnection = async () => ({
    async beginTransaction() {},
    async execute(sql, params) {
      statements.push({ sql, params });
      if (/INSERT INTO study_sessions/i.test(sql)) return [{ insertId: 9 }];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {}
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_date: '2026-09-05',
        duration_minutes: 20,
        category: 'Reading',
        resource: '',
        notes: ''
      })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.id_session, 9);
    // No linking or writing writes for a bare simplified create.
    assert.equal(statements.filter(({ sql }) => /INSERT INTO session_/i.test(sql) && !/study_sessions/i.test(sql)).length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});
