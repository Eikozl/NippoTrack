// Phase 12-A — japaneseParser service tests: lazy singleton, shared init,
// failure recovery, unknown/malformed input, error hygiene (no user text).
const test = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../src/services/japaneseParser');

test('status probe is side-effect-free and engine metadata is deterministic', () => {
  parser.resetParserForTests();
  const status = parser.getParserStatus();
  assert.equal(status.loaded, false);
  assert.equal(status.loading, false);
  assert.deepEqual(status.engine, {
    name: 'kuromoji',
    package: '@sglkc/kuromoji',
    packageVersion: require('@sglkc/kuromoji/package.json').version,
    dictionary: 'ipadic',
    dictionaryVersion: null,
    adapterVersion: 1
  });
  const again = parser.engineMetadata();
  assert.deepEqual(again, status.engine);
});

test('parse succeeds and marks the singleton loaded', async () => {
  parser.resetParserForTests();
  const { rawTokens, durationMs } = await parser.parseJapanese('俺は学校に行った。');
  assert.ok(Array.isArray(rawTokens) && rawTokens.length > 0);
  assert.equal(typeof durationMs, 'number');
  assert.equal(parser.getParserStatus().loaded, true);
  const surfaces = rawTokens.map((t) => t.surface_form);
  assert.ok(surfaces.includes('学校'));
});

test('concurrent first requests share one initialization', async () => {
  parser.resetParserForTests();
  const [a, b] = await Promise.all([parser.getTokenizer(), parser.getTokenizer()]);
  assert.equal(a, b);
});

test('init failure clears the memo so a later request retries', async () => {
  parser.resetParserForTests();
  const resolved = require.resolve('@sglkc/kuromoji');
  const real = require.cache[resolved];
  // Poison the engine module: builder throws synchronously.
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { builder: () => { throw new Error('boom'); } }
  };
  await assert.rejects(() => parser.getTokenizer(), (error) => error.name === 'ParserError');
  // Restore the real module: retry must succeed WITHOUT manual reset (memo auto-cleared).
  if (real) require.cache[resolved] = real;
  else delete require.cache[resolved];
  const tokenizer = await parser.getTokenizer();
  assert.ok(tokenizer && typeof tokenizer.tokenize === 'function');
  assert.equal(parser.getParserStatus().loaded, true);
});

test('unknown tokens are preserved, never fabricated', async () => {
  parser.resetParserForTests();
  const { rawTokens } = await parser.parseJapanese('ググる');
  const unknown = rawTokens.find((t) => t.word_type === 'UNKNOWN');
  assert.ok(unknown, 'expected an UNKNOWN span for ググる');
  assert.equal(unknown.surface_form, 'ググ');
  assert.ok(['', undefined, null, '*'].includes(unknown.reading));
});

test('malformed unicode fails as ParserError, never a raw crash', async () => {
  parser.resetParserForTests();
  await parser.parseJapanese('学校');
  try {
    await parser.parseJapanese('a�૿�');
    assert.ok(true, 'tolerated');
  } catch (error) {
    assert.equal(error.name, 'ParserError');
  }
  await assert.rejects(() => parser.parseJapanese(123), (error) => error.name === 'ParserError');
});

test('ParserError messages never echo user text', async () => {
  parser.resetParserForTests();
  const secret = '秘密のテキスト-αβγ-999';
  try {
    await parser.parseJapanese({ not: 'a string', marker: secret });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.name, 'ParserError');
    assert.ok(!String(error.message).includes(secret));
    assert.ok(!String(error.message).includes('秘密'));
  }
});

test('dictionary path resolves inside the installed package', () => {
  const fs = require('fs');
  const dicPath = parser.resolveDictionaryPath();
  assert.ok(dicPath.includes('@sglkc'), 'resolves within the pinned package');
  assert.ok(fs.existsSync(require('path').join(dicPath, 'base.dat.gz')), 'IPADIC base dictionary present');
});

test('remote dictionary contract: pinned CDN default, env override, complete-dir short-circuit', async () => {
  assert.ok(Array.isArray(parser.DICT_FILES) && parser.DICT_FILES.length >= 12, 'full blob manifest');
  assert.ok(parser.DICT_FILES.includes('base.dat.gz') && parser.DICT_FILES.includes('tid_pos.dat.gz'), 'key blobs listed');
  const previous = process.env.KUROMOJI_DICT_URL;
  try {
    delete process.env.KUROMOJI_DICT_URL;
    const base = parser.dictBaseUrl();
    assert.ok(base.startsWith('https://cdn.jsdelivr.net/npm/@sglkc/kuromoji@'), 'pinned public default');
    assert.ok(!base.endsWith('/'), 'no trailing slash');
    process.env.KUROMOJI_DICT_URL = 'https://mirror.example/dict/';
    assert.equal(parser.dictBaseUrl(), 'https://mirror.example/dict', 'env override wins, slash trimmed');
  } finally {
    if (previous === undefined) delete process.env.KUROMOJI_DICT_URL;
    else process.env.KUROMOJI_DICT_URL = previous;
  }
  // Local blobs present: zero network, resolves to the vendored dir.
  const local = parser.resolveDictionaryPath();
  assert.equal(parser.dictComplete(local), true, 'vendored blobs complete');
  assert.equal(await parser.ensureDictionaryPath(), local, 'local short-circuit, no download');
  assert.equal(parser.dictComplete('/definitely/not/a/dict'), false, 'missing dir reads incomplete');
});
