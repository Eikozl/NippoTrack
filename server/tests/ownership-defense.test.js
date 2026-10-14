const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const sessionsController = require('../src/controllers/sessionsController');
const vocabularyController = require('../src/controllers/vocabularyController');
const v2Controller = require('../src/controllers/v2Controller');
const reviewController = require('../src/controllers/reviewController');
const pool = require('../src/config/db');

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

function mockReq(userId, { params = {}, body = {} } = {}) {
  return { params, body, user: { id: userId } };
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

function fakeConnection(onExecute) {
  const calls = { commit: 0, rollback: 0, released: false, statements: [] };
  return {
    calls,
    async execute(sql, params) {
      calls.statements.push(String(sql));
      return onExecute(String(sql), params);
    },
    async beginTransaction() {},
    async commit() { calls.commit += 1; },
    async rollback() { calls.rollback += 1; },
    release() { calls.released = true; }
  };
}

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

// ---------------------------------------------------------- session_writings
test('getSession scopes the writing read to the owned session', async () => {
  const seen = [];
  const execute = async (sql, params) => {
    seen.push(String(sql));
    if (sql.includes('FROM session_writings')) {
      assert.ok(sql.includes('EXISTS'), 'writings query carries an ownership guard');
      assert.ok(sql.includes('s.user_id'), 'writings query binds the request user');
      assert.deepEqual(params, [2, USER_A]);
      return [[{ id_session_writing: 1, title: 't', content: 'hola', notes: null }]];
    }
    if (sql.includes('FROM study_sessions')) return [[{ id_session: 2 }]];
    return [[]];
  };
  await withPoolStubs({ execute }, async () => {
    const { res, status, body } = mockRes();
    await sessionsController.getSession(mockReq(USER_A, { params: { id: '2' } }), res);
    assert.equal(status(), 200);
    assert.equal(body().writing.content, 'hola');
  });
});

test('getSession on a foreign session never reads writings', async () => {
  const seen = [];
  const execute = async (sql) => {
    seen.push(String(sql));
    if (sql.includes('FROM study_sessions')) return [[]];
    return [[{ id_session_writing: 1 }]];
  };
  await withPoolStubs({ execute }, async () => {
    const { res, status } = mockRes();
    await sessionsController.getSession(mockReq(USER_A, { params: { id: '9' } }), res);
    assert.equal(status(), 404);
    assert.ok(!seen.some((sql) => sql.includes('FROM session_writings')), 'writings never queried');
  });
});

// ---------------------------------------------------------- usage_examples
test('getVocabulary scopes the examples read to the owned entry', async () => {
  const execute = async (sql, params) => {
    if (sql.includes('FROM vocabulary WHERE')) return [[{ id_vocabulary: 4, word: 'hola' }]];
    if (sql.includes('FROM usage_examples')) {
      assert.ok(sql.includes('EXISTS'), 'examples query carries an ownership guard');
      assert.ok(sql.includes('v.user_id'), 'examples query binds the request user');
      assert.deepEqual(params, [4, USER_A]);
      return [[{ id_usage_example: 7, sentence: 's', translation: null, notes: null }]];
    }
    return [[]];
  };
  await withPoolStubs({ execute }, async () => {
    const { res, status, body } = mockRes();
    await vocabularyController.getVocabulary(mockReq(USER_A, { params: { id: '4' } }), res);
    assert.equal(status(), 200);
    assert.equal(body().examples.length, 1);
  });
});

test('getVocabulary on a foreign entry never reads examples', async () => {
  const seen = [];
  const execute = async (sql) => {
    seen.push(String(sql));
    if (sql.includes('FROM vocabulary WHERE')) return [[]];
    return [[{ id_usage_example: 7 }]];
  };
  await withPoolStubs({ execute }, async () => {
    const { res, status } = mockRes();
    await vocabularyController.getVocabulary(mockReq(USER_A, { params: { id: '9' } }), res);
    assert.equal(status(), 404);
    assert.ok(!seen.some((sql) => sql.includes('FROM usage_examples')), 'examples never queried');
  });
});

// ---------------------------------------------------------------- v2 links
test('noteLinks.replace on a foreign note returns 404 without a transaction', async () => {
  let connectionsOpened = 0;
  const execute = async () => [[]];
  const getConnection = async () => { connectionsOpened += 1; throw new Error('must not open'); };
  await withPoolStubs({ execute, getConnection }, async () => {
    const { res, status } = mockRes();
    await v2Controller.noteLinks.replace(mockReq(USER_A, { params: { id: '9' }, body: { vocabulary: [] } }), res);
    assert.equal(status(), 404);
    assert.equal(connectionsOpened, 0);
  });
});

test('noteLinks.replace re-checks ownership inside the transaction', async () => {
  const connection = fakeConnection(async (sql) => {
    if (sql.includes('FROM notes WHERE')) return [[]];
    return [[{ id: 1 }]];
  });
  const execute = async (sql) => {
    if (sql.includes('FROM notes WHERE')) return [[{ id_note: 1 }]];
    return [[]];
  };
  const getConnection = async () => connection;
  await withPoolStubs({ execute, getConnection }, async () => {
    const { res, status } = mockRes();
    await v2Controller.noteLinks.replace(mockReq(USER_A, { params: { id: '1' }, body: { vocabulary: [4] } }), res);
    assert.equal(status(), 404);
    assert.equal(connection.calls.rollback, 1);
    assert.ok(connection.calls.released);
    assert.ok(!connection.calls.statements.some((sql) => sql.startsWith('DELETE FROM')), 'no links deleted');
  });
});

test('noteLinks.replace still updates owned links', async () => {
  const connection = fakeConnection(async (sql) => {
    if (sql.includes('FROM notes WHERE')) return [[{ id_note: 1 }]];
    if (sql.includes('FROM vocabulary WHERE')) return [[{ id_vocabulary: 4 }]];
    if (sql.startsWith('DELETE FROM')) return [{ affectedRows: 1 }];
    if (sql.startsWith('INSERT INTO')) return [{ affectedRows: 1 }];
    return [[]];
  });
  const execute = async (sql) => {
    if (sql.includes('FROM notes WHERE')) return [[{ id_note: 1 }]];
    return [[]];
  };
  const getConnection = async () => connection;
  await withPoolStubs({ execute, getConnection }, async () => {
    const { res, status, body } = mockRes();
    await v2Controller.noteLinks.replace(mockReq(USER_A, { params: { id: '1' }, body: { vocabulary: [4] } }), res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { success: true });
    assert.equal(connection.calls.commit, 1);
  });
});

// ------------------------------------------------------------- review_events
function gradeConnection(itemRow) {
  return fakeConnection(async (sql) => {
    if (sql.includes('FROM user_review_preferences')) {
      return [[{ card_types: null, weights: null, engine_mode: 'fixed', auto_pick: null, speech_rate: null }]];
    }
    if (sql.includes('FROM review_items')) return [itemRow ? [itemRow] : []];
    if (sql.includes('FROM vocabulary WHERE')) return [itemRow && itemRow.id_vocabulary === 4 ? [{ id_vocabulary: 4 }] : []];
    if (sql.startsWith('INSERT INTO review_events')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE review_items')) return [{ affectedRows: 1 }];
    return [[]];
  });
}

test('recordReview on a foreign item rolls back without writing events', async () => {
  const connection = gradeConnection({ id_review_item: 2, interval_days: 1, id_vocabulary: 99, id_kanji: null, id_grammar: null });
  const getConnection = async () => connection;
  await withPoolStubs({ getConnection }, async () => {
    const { res, status } = mockRes();
    await reviewController.recordReview(mockReq(USER_A, { params: { id: '2' }, body: { result: 'Again' } }), res);
    assert.equal(status(), 404);
    assert.equal(connection.calls.rollback, 1);
    assert.ok(!connection.calls.statements.some((sql) => sql.startsWith('INSERT INTO review_events')), 'no event written');
  });
});

test('recordReview on an owned item writes exactly one event', async () => {
  const connection = gradeConnection({ id_review_item: 1, interval_days: 1, id_vocabulary: 4, id_kanji: null, id_grammar: null });
  const getConnection = async () => connection;
  await withPoolStubs({ getConnection }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.recordReview(mockReq(USER_A, { params: { id: '1' }, body: { result: 'Again' } }), res);
    assert.equal(status(), 200);
    assert.equal(body().success, true);
    assert.equal(connection.calls.statements.filter((sql) => sql.startsWith('INSERT INTO review_events')).length, 1);
    assert.equal(connection.calls.commit, 1);
  });
});
