// Bulkhead for the synchronous immersion engine: max 2 concurrent analyses
// per process; excess requests get 429 + Retry-After before parsing.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const {
  acquireImmersionSlot,
  MAX_CONCURRENT_IMMERSION_ANALYSES,
  IMMERSION_BUSY_RETRY_AFTER_SECONDS
} = require('../src/services/immersionPipeline');
const immersionController = require('../src/controllers/immersionController');
const lookupController = require('../src/controllers/lookupController');
const storiesController = require('../src/controllers/storiesController');
const pool = require('../src/config/db');

function mockRes() {
  let statusCode = 200;
  let body;
  const headers = {};
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; },
    set(name, value) { headers[String(name).toLowerCase()] = String(value); return res; }
  };
  return { res, status: () => statusCode, body: () => body, headers: () => headers };
}

async function withExecuteStub(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

function analysisStubs() {
  return async (sql, params = []) => {
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) {
      return [[{ character: '行', onyomi: ['コウ'], kunyomi: ['いく'], meanings: ['go'], jlpt_level: 'N5' }]];
    }
    if (/FROM kanji WHERE user_id = \? AND character_kanji IN/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE user_id = \? AND word IN/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE user_id = \? AND reading IN/i.test(sql)) return [[], []];
    if (/gloss/i.test(sql)) return [[{ surface: '行く', gloss: 'to go' }]];
    if (/grammar_reference/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  };
}

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

test('slot budget is two, third caller is refused, release is idempotent', () => {
  assert.equal(MAX_CONCURRENT_IMMERSION_ANALYSES, 2);
  const first = acquireImmersionSlot();
  const second = acquireImmersionSlot();
  assert.ok(first && second);
  assert.equal(acquireImmersionSlot(), null);
  first();
  const third = acquireImmersionSlot();
  assert.ok(third);
  first();
  second();
  third();
  const reopened = [acquireImmersionSlot(), acquireImmersionSlot()];
  assert.ok(reopened[0] && reopened[1]);
  assert.equal(acquireImmersionSlot(), null);
  reopened.forEach((release) => release());
});

test('immersion analyze returns 429 with Retry-After when saturated', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    await withExecuteStub(async () => { throw new Error('DB must not be hit on 429'); }, async () => {
      const { res, status, body, headers } = mockRes();
      await immersionController.analyzeImmersionText({ user: { id: USER_ID }, body: { text: 'よく行く' } }, res);
      assert.equal(status(), 429);
      assert.equal(headers()['retry-after'], String(IMMERSION_BUSY_RETRY_AFTER_SECONDS));
      assert.match(body().error, /retry/i);
    });
  } finally {
    held.forEach((release) => release());
  }
});

test('immersion validation still 400s before the bulkhead', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    await withExecuteStub(async () => { throw new Error('DB must not be hit on validation failure'); }, async () => {
      for (const body of [{}, { text: '' }, { text: 42 }]) {
        const { res, status } = mockRes();
        await immersionController.analyzeImmersionText({ user: { id: USER_ID }, body }, res);
        assert.equal(status(), 400);
      }
    });
  } finally {
    held.forEach((release) => release());
  }
});

test('immersion request after rejection succeeds once a slot frees', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    const busy = mockRes();
    await immersionController.analyzeImmersionText({ user: { id: USER_ID }, body: { text: 'よく行く' } }, busy.res);
    assert.equal(busy.status(), 429);
  } finally {
    held.forEach((release) => release());
  }
  await withExecuteStub(analysisStubs(), async () => {
    const { res, status, body } = mockRes();
    await immersionController.analyzeImmersionText({ user: { id: USER_ID }, body: { text: 'よく行く' } }, res);
    assert.equal(status(), 200);
    assert.ok(body() && body().candidates);
  });
  const freed = [acquireImmersionSlot(), acquireImmersionSlot()];
  assert.ok(freed[0] && freed[1]);
  freed.forEach((release) => release());
});

test('immersion slot releases when analysis fails mid-parse', async () => {
  await withExecuteStub(async () => { throw new Error('database unavailable'); }, async () => {
    const { res, status } = mockRes();
    await immersionController.analyzeImmersionText({ user: { id: USER_ID }, body: { text: 'よく行く' } }, res);
    assert.equal(status(), 503);
  });
  const freedAfterError = [acquireImmersionSlot(), acquireImmersionSlot()];
  assert.ok(freedAfterError[0] && freedAfterError[1]);
  freedAfterError.forEach((release) => release());
});

test('three simultaneous real parses yield two results and one 429', async () => {
  const dense = '日本語能力試験漢字語彙文法読解聴解'.repeat(63).slice(0, 1000);
  await withExecuteStub(analysisStubs(), async () => {
    const calls = [0, 1, 2].map(() => {
      const { res, status } = mockRes();
      return immersionController.analyzeImmersionText({ user: { id: USER_ID }, body: { text: dense } }, res)
        .then(() => status());
    });
    const statuses = await Promise.all(calls);
    assert.deepEqual([...statuses].sort(), [200, 200, 429]);
  });
  const freed = [acquireImmersionSlot(), acquireImmersionSlot()];
  assert.ok(freed[0] && freed[1]);
  freed.forEach((release) => release());
});

test('lookup define-sentence shares the same budget', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    await withExecuteStub(async () => { throw new Error('DB must not be hit on 429'); }, async () => {
      const { res, status, body, headers } = mockRes();
      await lookupController.defineSentence({ user: { id: USER_ID }, body: { sentence: 'よく行く' } }, res);
      assert.equal(status(), 429);
      assert.equal(headers()['retry-after'], String(IMMERSION_BUSY_RETRY_AFTER_SECONDS));
      assert.match(body().error, /retry/i);
      const invalid = mockRes();
      await lookupController.defineSentence({ user: { id: USER_ID }, body: {} }, invalid.res);
      assert.equal(invalid.status(), 400);
    });
  } finally {
    held.forEach((release) => release());
  }
  await withExecuteStub(analysisStubs(), async () => {
    const { res, status, body } = mockRes();
    await lookupController.defineSentence({ user: { id: USER_ID }, body: { sentence: 'よく行く' } }, res);
    assert.equal(status(), 200);
    assert.equal(body().sentence, 'よく行く');
  });
});

function storyStubs(seen) {
  return async (sql, params = []) => {
    seen.push(String(sql));
    if (/FROM content_entries WHERE id_content_entry/i.test(sql)) {
      return [[{ id_content_entry: 9, user_id: USER_ID, source_text: 'よく行く', processing_status: 'pending' }]];
    }
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) {
      return [[{ character: '行', onyomi: ['コウ'], kunyomi: ['いく'], meanings: ['go'], jlpt_level: 'N5' }]];
    }
    if (/FROM kanji WHERE user_id = \? AND character_kanji IN/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE user_id = \? AND word IN/i.test(sql)) return [[]];
    if (/FROM vocabulary WHERE user_id = \? AND reading IN/i.test(sql)) return [[], []];
    if (/gloss/i.test(sql)) return [[{ surface: '行く', gloss: 'to go' }]];
    if (/grammar_reference/i.test(sql)) return [[]];
    if (/INSERT INTO content_entries/i.test(sql)) return [{ insertId: 9 }];
    if (/UPDATE content_entries SET extracted_json/i.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  };
}

test('stories extract shares the budget and leaves the row pending on 429', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    const seen = [];
    await withExecuteStub(storyStubs(seen), async () => {
      const { res, status, body, headers } = mockRes();
      await storiesController.postExtract({ params: { id: '9' }, user: { id: USER_ID } }, res);
      assert.equal(status(), 429);
      assert.equal(headers()['retry-after'], String(IMMERSION_BUSY_RETRY_AFTER_SECONDS));
      assert.match(body().error, /retry/i);
      assert.ok(!seen.some((sql) => /kanji_reference|UPDATE content_entries/i.test(sql)), 'no parse and no write on 429');
    });
  } finally {
    held.forEach((release) => release());
  }
});

test('stories extract keeps 404/400 ahead of the bulkhead', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    await withExecuteStub(async (sql) => {
      if (/FROM content_entries WHERE id_content_entry/i.test(sql)) return [[]];
      throw new Error('DB must not go past the ownership gate');
    }, async () => {
      const { res, status } = mockRes();
      await storiesController.postExtract({ params: { id: '404' }, user: { id: USER_ID } }, res);
      assert.equal(status(), 404);
    });
  } finally {
    held.forEach((release) => release());
  }
});

test('stories extract succeeds after rejection and frees the slot', async () => {
  const fetchOnly = async (sql) => {
    if (/FROM content_entries WHERE id_content_entry/i.test(sql)) {
      return [[{ id_content_entry: 9, user_id: USER_ID, source_text: 'よく行く', processing_status: 'pending' }]];
    }
    throw new Error('must not analyze on 429');
  };
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    await withExecuteStub(fetchOnly, async () => {
      const busy = mockRes();
      await storiesController.postExtract({ params: { id: '9' }, user: { id: USER_ID } }, busy.res);
      assert.equal(busy.status(), 429);
    });
  } finally {
    held.forEach((release) => release());
  }
  const seen = [];
  await withExecuteStub(storyStubs(seen), async () => {
    const { res, status, body } = mockRes();
    await storiesController.postExtract({ params: { id: '9' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().story_id, 9);
    assert.ok(body().extracted && Array.isArray(body().extracted.kanji));
    assert.ok(seen.some((sql) => /UPDATE content_entries SET extracted_json/i.test(sql)), 'persistence still runs');
  });
  const freed = [acquireImmersionSlot(), acquireImmersionSlot()];
  assert.ok(freed[0] && freed[1]);
  freed.forEach((release) => release());
});

test('stories extract releases the slot when analysis fails', async () => {
  await withExecuteStub(async (sql) => {
    if (/FROM content_entries WHERE id_content_entry/i.test(sql)) {
      return [[{ id_content_entry: 9, user_id: USER_ID, source_text: 'よく行く', processing_status: 'pending' }]];
    }
    throw new Error('database unavailable mid-parse');
  }, async () => {
    const { res, status } = mockRes();
    await storiesController.postExtract({ params: { id: '9' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 503);
  });
  const freed = [acquireImmersionSlot(), acquireImmersionSlot()];
  assert.ok(freed[0] && freed[1]);
  freed.forEach((release) => release());
});

test('stories creation with auto-extract takes no slot and writes nothing on 429', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    const seen = [];
    await withExecuteStub(storyStubs(seen), async () => {
      const { res, status } = mockRes();
      await storiesController.postStory({ user: { id: USER_ID }, body: { title: 't', text: 'よく行く' } }, res);
      assert.equal(status(), 429);
      assert.ok(!seen.some((sql) => /INSERT INTO content_entries|kanji_reference/i.test(sql)), 'no row and no parse on 429');
    });
  } finally {
    held.forEach((release) => release());
  }
});

test('stories creation without extraction bypasses the budget', async () => {
  const held = [acquireImmersionSlot(), acquireImmersionSlot()];
  try {
    const seen = [];
    await withExecuteStub(storyStubs(seen), async () => {
      const { res, status, body } = mockRes();
      await storiesController.postStory({ user: { id: USER_ID }, body: { title: 't', text: 'よく行く', auto_extract: false } }, res);
      assert.equal(status(), 201);
      assert.equal(body().story_id, 9);
      assert.equal(body().extracted, null);
    });
  } finally {
    held.forEach((release) => release());
  }
});

test('three simultaneous story extracts yield two results and one 429', async () => {
  const seen = [];
  await withExecuteStub(storyStubs(seen), async () => {
    const calls = [0, 1, 2].map(() => {
      const { res, status } = mockRes();
      return storiesController.postExtract({ params: { id: '9' }, user: { id: USER_ID } }, res)
        .then(() => status());
    });
    const statuses = await Promise.all(calls);
    assert.deepEqual([...statuses].sort(), [200, 200, 429]);
  });
  const freed = [acquireImmersionSlot(), acquireImmersionSlot()];
  assert.ok(freed[0] && freed[1]);
  freed.forEach((release) => release());
});
