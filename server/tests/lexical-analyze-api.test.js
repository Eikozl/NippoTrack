// Phase 12-A — lexical API integration tests: backward compatibility,
// opt-in behavior, graceful degradation, Kanji survival. Each file runs in a
// fresh process, so parser-init assertions are isolated to this file.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';

function installStub() {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const seen = [];
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) return [[], []];
    if (/FROM kanji_reference/i.test(sql)) return [[], []];
    throw new Error(`unexpected SQL in lexical API test: ${sql}`);
  };
  pool.getConnection = async () => { throw new Error('no connections in lexical API test'); };
  return {
    seen,
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

test('lexical requests stay behind authentication', async () => {
  const stub = installStub();
  const savedNodeEnv = process.env.NODE_ENV;
  const savedBypass = process.env.JLT_AUTH_BYPASS_FOR_TESTS;
  delete process.env.JLT_AUTH_BYPASS_FOR_TESTS;
  process.env.NODE_ENV = 'production';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/analyze/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '学校', lexical: { enabled: true } })
      });
      assert.equal(res.status, 401);
      assert.equal(stub.seen.length, 0);
    });
  } finally {
    process.env.NODE_ENV = savedNodeEnv;
    process.env.JLT_AUTH_BYPASS_FOR_TESTS = savedBypass;
    stub.restore();
  }
});
