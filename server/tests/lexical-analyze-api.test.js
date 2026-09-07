// Phase 12-A — lexical API integration tests: backward compatibility,
// opt-in behavior, graceful degradation, Kanji survival. Each file runs in a
// fresh process, so parser-init assertions are isolated to this file.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

// vocabularyFixture: { [userId]: [{ word, reading }] }. Emulates SQL
// filtering honestly: wrong user sees nothing; word/reading IN filters apply.
function installStub({ vocabularyFixture = {}, throwVocabulary = false } = {}) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const seen = [];
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) return [[], []];
    if (/FROM kanji_reference/i.test(sql)) return [[], []];
    if (/FROM vocabulary WHERE user_id = \?/i.test(sql)) {
      if (throwVocabulary) throw new Error('vocabulary lookup down');
      const [userId, ...keys] = params;
      const rows = (vocabularyFixture[userId] || []).filter((row) => keys.includes(
        /AND word IN/i.test(sql) ? row.word : row.reading
      ));
      return [rows];
    }
    throw new Error(`unexpected SQL in lexical API test: ${sql}`);
  };
  pool.getConnection = async () => { throw new Error('no connections in lexical API test'); };
  return {
    seen,
    vocabularyQueries() {
      return seen.filter((entry) => /FROM vocabulary/i.test(entry.sql));
    },
    restore() {
      pool.execute = originalExecute;
      pool.getConnection = originalGetConnection;
    }
  };
}

async function withServer(fn) {
  const app = require('../src/app');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postAnalysis(base, body) {
  const res = await fetch(`${base}/api/analyze/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test('lexical-disabled requests are byte-compatible and never load the parser', async () => {
  const parser = require('../src/services/japaneseParser');
  parser.resetParserForTests();
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行った。' });
      assert.equal(status, 200);
      assert.ok(!('lexical' in body), 'no lexical key without opt-in');
      assert.equal(body.source, 'pasted_text');
      assert.ok(Array.isArray(body.kanji));
      assert.equal(parser.getParserStatus().loaded, false);
    });
  } finally {
    stub.restore();
  }
});

test('lexical-enabled requests return the additive block with normalized tokens', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行った。', lexical: { enabled: true } });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.kanji), 'Kanji payload intact');
      const lexical = body.lexical;
      assert.equal(lexical.status, 'ok');
      assert.equal(lexical.engine.name, 'kuromoji');
      assert.equal(lexical.engine.dictionary, 'ipadic');
      assert.ok(Array.isArray(lexical.tokens) && lexical.tokens.length > 0);
      const school = lexical.tokens.find((t) => t.surface === '学校');
      assert.equal(school.lemma, '学校');
      assert.equal(school.pos, 'noun');
      const itta = lexical.tokens.find((t) => t.surface === '行っ');
      assert.equal(itta.lemma, '行く');
      for (const token of lexical.tokens) {
        assert.ok(!('surface_form' in token) && !('basic_form' in token), 'no raw vendor fields leak');
        assert.ok('surfaceReading' in token && 'lemmaReading' in token);
      }
    });
  } finally {
    stub.restore();
  }
});

test('kana-only input with opt-in still returns lexical tokens and empty kanji', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: 'あいうえお', lexical: { enabled: true } });
      assert.equal(status, 200);
      assert.deepEqual(body.kanji, []);
      assert.equal(body.lexical.status, 'ok');
      assert.ok(body.lexical.tokens.length > 0);
    });
  } finally {
    stub.restore();
  }
});

test('over-long lexical input degrades honestly; Kanji still covers full text', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const text = '学校'.repeat(3000); // 6000 chars: Kanji-ok, lexical-capped
      const { status, body } = await postAnalysis(base, { text, lexical: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.status, 'unavailable');
      assert.equal(body.lexical.reason, 'lexical-text-too-long');
      assert.deepEqual(body.lexical.tokens, []);
      assert.ok(typeof body.lexical.limit === 'number');
      assert.ok(body.uniqueKanjiCount > 0, 'Kanji analysis still ran');
      assert.ok(!JSON.stringify(body.lexical).includes('学校'.repeat(10)), 'no input echo in fallback');
    });
  } finally {
    stub.restore();
  }
});

test('lexical cap boundary: 2000 chars ok, 2001 chars unavailable', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const atCap = await postAnalysis(base, { text: 'あ'.repeat(2000), lexical: { enabled: true } });
      assert.equal(atCap.status, 200);
      assert.equal(atCap.body.lexical.status, 'ok');
      const overCap = await postAnalysis(base, { text: 'あ'.repeat(2001), lexical: { enabled: true } });
      assert.equal(overCap.status, 200);
      assert.equal(overCap.body.lexical.status, 'unavailable');
      assert.equal(overCap.body.lexical.reason, 'lexical-text-too-long');
    });
  } finally {
    stub.restore();
  }
});

test('parser failure degrades to unavailable with Kanji intact and no text echo', async () => {
  const parser = require('../src/services/japaneseParser');
  parser.resetParserForTests();
  const resolved = require.resolve('@sglkc/kuromoji');
  const real = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true,
    exports: { builder: () => { throw new Error('boom'); } }
  };
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const text = '学校に行った。';
      const { status, body } = await postAnalysis(base, { text, lexical: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.status, 'unavailable');
      assert.equal(body.lexical.reason, 'parser-unavailable');
      assert.deepEqual(body.lexical.tokens, []);
      assert.equal(body.lexical.retryable, true);
      assert.ok(Array.isArray(body.kanji));
      assert.ok(!JSON.stringify(body.lexical).includes(text), 'no user text in degraded block');
    });
  } finally {
    if (real) require.cache[resolved] = real;
    else delete require.cache[resolved];
    stub.restore();
  }
});

// ---------------- Phase 12-B: candidates, diet, matching, limiter ----------------

test('lexical block carries diet tokens, candidates, summary, and top-level engine', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行った。', lexical: { enabled: true } });
      assert.equal(status, 200);
      const lexical = body.lexical;
      assert.equal(lexical.status, 'ok');
      assert.ok(lexical.engine && lexical.engine.name === 'kuromoji');
      for (const token of lexical.tokens) {
        assert.ok(!('engine' in token), 'payload diet: no per-token engine repetition');
        assert.ok(!('surface_form' in token), 'no raw vendor fields');
      }
      assert.ok(Array.isArray(lexical.candidates) && lexical.candidates.length > 0);
      assert.ok(Array.isArray(lexical.unverified));
      const school = lexical.candidates.find((c) => c.canonical === '学校');
      assert.ok(school, '学校 candidate present');
      assert.equal(school.occurrences, 1);
      assert.deepEqual(Object.keys(lexical.summary).sort(),
        ['ambiguous', 'candidates', 'existing', 'new', 'unavailable', 'unverified'].sort());
      assert.equal(lexical.matching.available, true);
      assert.equal(typeof lexical.durationMs, 'number');
      assert.ok(!lexical.tokens.some((t) => t.pos === 'particle' && t.isContentWord), 'no particle content words');
    });
  } finally {
    stub.restore();
  }
});

test('lemma matching marks owned vocabulary existing (行った → 行く)', async () => {
  const stub = installStub({
    vocabularyFixture: { [TEST_USER]: [{ word: '行く', reading: 'いく' }, { word: '学校', reading: 'がっこう' }] }
  });
  try {
    await withServer(async (base) => {
      const { body } = await postAnalysis(base, { text: '学校に行った。', lexical: { enabled: true } });
      const byCanonical = new Map(body.lexical.candidates.map((c) => [c.canonical, c]));
      assert.equal(byCanonical.get('行く').match.state, 'existing');
      assert.equal(byCanonical.get('学校').match.state, 'existing');
      assert.equal(body.lexical.summary.existing, 2);
      assert.ok(stub.vocabularyQueries().length <= 2, 'bounded set-based lookup, no N+1');
      for (const query of stub.vocabularyQueries()) {
        assert.equal(query.params[0], TEST_USER, 'matching scoped to the requesting user');
      }
    });
  } finally {
    stub.restore();
  }
});

test('matching is user-isolated: another user sees new, never existing', async () => {
  const stub = installStub({
    vocabularyFixture: { [TEST_USER]: [{ word: '行く', reading: 'いく' }] }
  });
  const savedTestUser = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = OTHER_USER;
  try {
    await withServer(async (base) => {
      const { body } = await postAnalysis(base, { text: '学校に行った。', lexical: { enabled: true } });
      const byCanonical = new Map(body.lexical.candidates.map((c) => [c.canonical, c]));
      assert.equal(byCanonical.get('行く').match.state, 'new');
      assert.equal(body.lexical.summary.existing, 0);
    });
  } finally {
    if (savedTestUser === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = savedTestUser;
    stub.restore();
  }
});

test('vocabulary lookup failure marks candidates unavailable, never all-new', async () => {
  const stub = installStub({ throwVocabulary: true });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行った。', lexical: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.status, 'ok');
      assert.equal(body.lexical.matching.available, false);
      assert.ok(body.lexical.candidates.length > 0);
      for (const candidate of body.lexical.candidates) {
        assert.equal(candidate.match.state, 'unavailable');
      }
      assert.equal(body.lexical.summary.new, 0);
      assert.ok(body.lexical.summary.unavailable > 0);
      assert.ok(body.lexical.warnings.some((w) => /matching is unavailable/i.test(w)));
    });
  } finally {
    stub.restore();
  }
});

test('lexical rate limit degrades the block while Kanji survives', async () => {
  const { tryConsumeLexical, resetLexicalLimitsForTests, LEXICAL_LIMIT_MAX } = require('../src/services/lexicalRateLimit');
  resetLexicalLimitsForTests(); // order-independent: start from an empty budget
  for (let i = 0; i < LEXICAL_LIMIT_MAX; i++) {
    assert.equal(tryConsumeLexical({ userId: TEST_USER }).allowed, true);
  }
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行った。', lexical: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.status, 'unavailable');
      assert.equal(body.lexical.reason, 'lexical-rate-limited');
      assert.equal(body.lexical.retryable, true);
      assert.ok(Array.isArray(body.kanji), 'Kanji analysis still completed');
      // Kanji-only traffic from the same user is unaffected by the lexical budget.
      const kanjiOnly = await postAnalysis(base, { text: '学校に行った。' });
      assert.equal(kanjiOnly.status, 200);
      assert.ok(!('lexical' in kanjiOnly.body));
    });
  } finally {
    resetLexicalLimitsForTests();
    stub.restore();
  }
});

test('emoji/astral input parses with valid offsets and Kanji intact', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const text = '学校🎉に行った𠀋。';
      const { status, body } = await postAnalysis(base, { text, lexical: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.status, 'ok');
      const chars = Array.from(text);
      for (const token of body.lexical.tokens) {
        assert.equal(chars.slice(token.start, token.end).join(''), token.surface);
      }
      assert.ok(Array.isArray(body.kanji));
    });
  } finally {
    stub.restore();
  }
});

test('candidate Add uses the existing vocabulary contract without bypass', async () => {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const statements = [];
  const fakeConnection = {
    beginTransaction: async () => {},
    release: async () => {},
    commit: async () => { statements.push('COMMIT'); },
    rollback: async () => { statements.push('ROLLBACK'); },
    execute: async (sql) => {
      statements.push(sql.split('\n')[0].trim());
      if (/^INSERT INTO vocabulary/i.test(sql.trim())) return [{ insertId: 7 }, []];
      if (/^DELETE FROM kanji_vocabulary/i.test(sql.trim())) return [[], []];
      if (/^INSERT INTO kanji_vocabulary/i.test(sql.trim())) return [[], []];
      if (/FROM kanji WHERE user_id/i.test(sql)) return [[], []];
      if (/^INSERT INTO kanji_encounters/i.test(sql)) return [[], []];
      throw new Error(`unexpected connection SQL: ${sql}`);
    }
  };
  pool.execute = async (sql, params) => {
    statements.push(`pool:${sql.split(' ').slice(0, 3).join(' ')}`);
    if (/FROM vocabulary WHERE id_vocabulary/i.test(sql)) {
      return [[{ id_vocabulary: 7, word: '行く', reading: null, meaning: 'to go', jlpt_level: null, status: 'New', notes: null }]];
    }
    throw new Error(`unexpected pool SQL: ${sql}`);
  };
  pool.getConnection = async () => fakeConnection;
  try {
    await withServer(async (base) => {
      // Valid analyzer prefill (lemma word + user-supplied meaning) → 201.
      const created = await fetch(`${base}/api/vocabulary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: '行く', meaning: 'to go' })
      });
      assert.equal(created.status, 201);
      const createdBody = await created.json();
      assert.equal(createdBody.word, '行く');
      assert.ok(statements.includes('COMMIT'), 'transaction committed through the normal path');
      // Missing meaning → 400 with no connection opened (validation first).
      let connections = 0;
      pool.getConnection = async () => { connections += 1; throw new Error('must not connect'); };
      const invalid = await fetch(`${base}/api/vocabulary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: '行く' })
      });
      assert.equal(invalid.status, 400);
      assert.equal(connections, 0);
    });
  } finally {
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});
