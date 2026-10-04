// V5.3a Review 2.0: card types, preferences, dynamic intervals, patterns.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const pool = require('../src/config/db');
const controller = require('../src/controllers/reviewController');
const engine = require('../src/services/reviewEngine');

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

test('GET /api/review/types returns available types and default preferences', async () => {
  await withPoolExecute(async (sql, params) => {
    assert.match(sql, /FROM user_review_preferences WHERE user_id = \?/);
    assert.deepEqual(params, [USER_ID]);
    return [[]];
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewTypes({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body().availableTypes, ['recognition', 'recall', 'cloze', 'audio']);
    assert.deepEqual(body().userPreferences.cardTypes, ['recognition']);
    assert.deepEqual(body().userPreferences.weights, {});
    assert.equal(body().userPreferences.engineMode, 'fixed');
  });
});

test('PUT /api/review/preferences validates input and upserts scoped to req.user.id', async () => {
  const invalid = mockRes();
  await controller.putReviewPreferences({ user: { id: USER_ID }, body: { cardTypes: ['recognition', 'typo'] } }, invalid.res);
  assert.equal(invalid.status(), 400);

  const empty = mockRes();
  await controller.putReviewPreferences({ user: { id: USER_ID }, body: { cardTypes: [] } }, empty.res);
  assert.equal(empty.status(), 400);

  const badWeight = mockRes();
  await controller.putReviewPreferences({ user: { id: USER_ID }, body: { cardTypes: ['recall'], weights: { recall: 150 } } }, badWeight.res);
  assert.equal(badWeight.status(), 400);

  const unknownField = mockRes();
  await controller.putReviewPreferences({ user: { id: USER_ID }, body: { cardTypes: ['recall'], sabotage: true } }, unknownField.res);
  assert.equal(unknownField.status(), 400);

  const calls = [];
  await withPoolExecute(async (sql, params) => {
    calls.push({ sql, params });
    return [{ affectedRows: 1 }];
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.putReviewPreferences({
      user: { id: USER_ID },
      body: { cardTypes: ['recognition', 'cloze'], weights: { cloze: 60 }, engineMode: 'dynamic' }
    }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body().userPreferences.cardTypes, ['recognition', 'cloze']);
    assert.deepEqual(body().userPreferences.weights, { cloze: 60 });
    assert.equal(body().userPreferences.engineMode, 'dynamic');
    assert.match(calls[0].sql, /INSERT INTO user_review_preferences/);
    assert.match(calls[0].sql, /ON CONFLICT \(user_id\) DO UPDATE/);
    assert.equal(calls[0].params[0], USER_ID);
  });
});

test('GET /api/review/due enriches items with supported card types and filters', async () => {
  const dueRows = [[
    { id_review_item: 1, item_type: 'Vocabulary', title: '水', meaning: 'water', reading: 'みず' },
    { id_review_item: 2, item_type: 'Kanji', title: '日', meaning: 'day', reading: null },
    { id_review_item: 3, item_type: 'Grammar', title: '〜ても', meaning: 'even if', reading: null }
  ]];

  await withPoolExecute(async () => dueRows, async () => {
    const all = mockRes();
    await controller.listDueReviewCards({ user: { id: USER_ID }, query: {} }, all.res);
    assert.equal(all.status(), 200);
    assert.equal(all.body().items.length, 3);
    assert.deepEqual(all.body().items[0].cardTypes, ['recognition', 'recall', 'cloze', 'audio']);
    assert.deepEqual(all.body().items[1].cardTypes, ['recognition', 'recall']);
    assert.deepEqual(all.body().items[2].cardTypes, ['recognition', 'cloze', 'audio']);
    assert.equal(all.body().items[0].entityType, 'vocabulary');

    const recallOnly = mockRes();
    await controller.listDueReviewCards({ user: { id: USER_ID }, query: { types: 'recall' } }, recallOnly.res);
    assert.deepEqual(recallOnly.body().items.map((item) => item.id_review_item), [1, 2]);

    const clozeOnly = mockRes();
    await controller.listDueReviewCards({ user: { id: USER_ID }, query: { types: 'cloze' } }, clozeOnly.res);
    assert.deepEqual(clozeOnly.body().items.map((item) => item.id_review_item), [1, 3]);

    const bad = mockRes();
    await controller.listDueReviewCards({ user: { id: USER_ID }, query: { types: 'recognition,typo' } }, bad.res);
    assert.equal(bad.status(), 400);
  });
});

test('facilityFromResults is neutral on empty history and clamped on mixed history', () => {
  assert.equal(engine.facilityFromResults([]), 1);
  assert.equal(engine.facilityFromResults(null), 1);
  assert.equal(engine.facilityFromResults(['Good', 'Good', 'Hard']), 1);
  // 1 correct / (1 correct + 1 wrong * 1.5) = 0.4
  assert.equal(engine.facilityFromResults(['Good', 'Again']), 0.4);
  // Heavy failure clamps at the 0.25 floor.
  assert.equal(engine.facilityFromResults(['Again', 'Again', 'Again', 'Again']), 0.25);
});

test('computeDynamicInterval follows the V5.3a formula with [1, 365] clamps', () => {
  assert.equal(engine.computeDynamicInterval({ result: 'Good', repetitions: 0, facility: 1 }), 7);
  assert.equal(engine.computeDynamicInterval({ result: 'Hard', repetitions: 0, facility: 1 }), 3);
  assert.equal(engine.computeDynamicInterval({ result: 'Again', repetitions: 0, facility: 1 }), 1);
  // facility 0.5, 2 repetitions: 7 * (1/0.5)^2 = 28
  assert.equal(engine.computeDynamicInterval({ result: 'Good', repetitions: 2, facility: 0.5 }), 28);
  // Upper clamp: 7 * 4^10 far exceeds 365.
  assert.equal(engine.computeDynamicInterval({ result: 'Good', repetitions: 10, facility: 0.25 }), 365);
  // Lower clamp is the base itself for Again.
  assert.equal(engine.computeDynamicInterval({ result: 'Again', repetitions: 0, facility: 0.25 }), 1);
  assert.throws(() => engine.computeDynamicInterval({ result: 'Perfect' }), /result must be Again, Hard, or Good/);
});

test('resolveIntervalDays keeps fixed mode byte-identical and applies dynamic mode from history', async () => {
  const fixedExecutor = {
    execute: async (sql, params) => {
      assert.match(sql, /FROM user_review_preferences WHERE user_id = \?/);
      assert.deepEqual(params, [USER_ID]);
      return [[]];
    }
  };
  const fixed = await engine.resolveIntervalDays(fixedExecutor, USER_ID, 55, 'Good');
  assert.deepEqual(fixed, { intervalDays: 7, engineMode: 'fixed' });

  const dynamicExecutor = {
    execute: async (sql, params) => {
      if (/FROM user_review_preferences/i.test(sql)) {
        return [[{ card_types: ['recognition'], weights: {}, engine_mode: 'dynamic' }]];
      }
      if (/FROM review_events/i.test(sql)) {
        assert.deepEqual(params, [55]);
        // Fetch order is newest-first (ORDER BY reviewed_at DESC); the engine
        // reverses to chronological [Again, Good] -> facility 0.4, streak 1.
        return [[{ result: 'Good' }, { result: 'Again' }]];
      }
      throw new Error(`Unexpected interval SQL: ${sql}`);
    }
  };
  const dynamic = await engine.resolveIntervalDays(dynamicExecutor, USER_ID, 55, 'Good');
  assert.equal(dynamic.engineMode, 'dynamic');
  // 7 * (1/0.4)^1 = 17.5 -> 18 (spec-verbatim lengthening, flagged in docs).
  assert.equal(dynamic.intervalDays, 18);
});

test('detectPatternsFromRows finds reading confusion, grammar bands, and frequent vocabulary', () => {
  const rows = [
    { id_review_item: 1, entityType: 'kanji', display: '校', level: 'N5', result: 'Again', readings: ['コウ', 'キョウ'] },
    { id_review_item: 1, entityType: 'kanji', display: '校', level: 'N5', result: 'Again', readings: ['コウ', 'キョウ'] },
    { id_review_item: 2, entityType: 'kanji', display: '行', level: 'N5', result: 'Again', readings: ['コウ'] },
    { id_review_item: 2, entityType: 'kanji', display: '行', level: 'N5', result: 'Again', readings: ['コウ'] },
    { id_review_item: 3, entityType: 'grammar', display: '〜ても', level: 'N4', result: 'Again' },
    { id_review_item: 3, entityType: 'grammar', display: '〜ても', level: 'N4', result: 'Again' },
    { id_review_item: 4, entityType: 'grammar', display: '〜ば', level: 'N4', result: 'Again' },
    { id_review_item: 4, entityType: 'grammar', display: '〜ば', level: 'N4', result: 'Again' },
    { id_review_item: 5, entityType: 'vocabulary', display: '水', level: 'N5', result: 'Again' },
    { id_review_item: 5, entityType: 'vocabulary', display: '水', level: 'N5', result: 'Again' },
    { id_review_item: 5, entityType: 'vocabulary', display: '水', level: 'N5', result: 'Again' }
  ];
  const patterns = engine.detectPatternsFromRows(rows);
  assert.equal(patterns.length, 3);
  const readingConfusion = patterns.find((pattern) => pattern.patternType === 'kanji-reading-confusion');
  assert.equal(readingConfusion.priority, 1);
  assert.equal(readingConfusion.affectedItems.length, 2);
  assert.ok(readingConfusion.affectedItems.every((item) => item.entityType === 'kanji'));
  const grammarBand = patterns.find((pattern) => pattern.patternType === 'grammar-family-failures');
  assert.equal(grammarBand.affectedItems.length, 2);
  assert.equal(grammarBand.affectedItems[0].level, 'N4');
  const frequent = patterns.find((pattern) => pattern.patternType === 'vocabulary-frequent-again');
  assert.equal(frequent.affectedItems.length, 1);
  assert.deepEqual(engine.detectPatternsFromRows([]), []);
});

test('PUT /api/review/preferences rejects non-boolean autoPick with 400', async () => {
  for (const autoPick of ['yes', 1, 0, 42, {}, [], ['recognition']]) {
    const mocked = mockRes();
    await controller.putReviewPreferences(
      { user: { id: USER_ID }, body: { cardTypes: ['recall'], autoPick } },
      mocked.res
    );
    assert.equal(mocked.status(), 400, `expected 400 for autoPick=${JSON.stringify(autoPick)}`);
    assert.match(mocked.body().error, /autoPick must be a boolean/);
  }
  // Unknown-field policy still applies alongside the new field.
  const unknown = mockRes();
  await controller.putReviewPreferences(
    { user: { id: USER_ID }, body: { cardTypes: ['recall'], autoPick: true, sabotage: true } },
    unknown.res
  );
  assert.equal(unknown.status(), 400);
});

test('PUT /api/review/preferences round-trips autoPick scoped to req.user.id', async () => {
  const calls = [];
  await withPoolExecute(async (sql, params) => {
    calls.push({ sql, params });
    return [{ affectedRows: 1 }];
  }, async () => {
    const explicitFalse = mockRes();
    await controller.putReviewPreferences({
      user: { id: USER_ID },
      body: { cardTypes: ['recall'], autoPick: false }
    }, explicitFalse.res);
    assert.equal(explicitFalse.status(), 200);
    assert.equal(explicitFalse.body().userPreferences.autoPick, false);
    assert.match(calls[0].sql, /INSERT INTO user_review_preferences/);
    assert.match(calls[0].sql, /auto_pick/);
    assert.match(calls[0].sql, /speech_rate/);
    assert.match(calls[0].sql, /ON CONFLICT \(user_id\) DO UPDATE/);
    assert.equal(calls[0].params[0], USER_ID);
    assert.equal(calls[0].params[4], false);
    assert.equal(calls[0].params[5], 1);

    const explicitTrue = mockRes();
    await controller.putReviewPreferences({
      user: { id: USER_ID },
      body: { cardTypes: ['recall'], weights: { recall: 10 }, engineMode: 'fixed', autoPick: true }
    }, explicitTrue.res);
    assert.equal(explicitTrue.status(), 200);
    assert.equal(explicitTrue.body().userPreferences.autoPick, true);
    assert.equal(calls[1].params[0], USER_ID);
    assert.equal(calls[1].params[4], true);
    assert.equal(calls[1].params[5], 1);

    // Omitted autoPick keeps the contract default (true), like engineMode.
    const omitted = mockRes();
    await controller.putReviewPreferences({
      user: { id: USER_ID },
      body: { cardTypes: ['recall'] }
    }, omitted.res);
    assert.equal(omitted.status(), 200);
    assert.equal(omitted.body().userPreferences.autoPick, true);
    assert.equal(calls[2].params[0], USER_ID);
    assert.equal(calls[2].params[4], true);
    assert.equal(calls[2].params[5], 1);
  });
});

test('PUT /api/review/preferences saves reported card-type payload with autoPick:true (no 400 Unexpected field)', async () => {
  await withPoolExecute(async () => [{ affectedRows: 1 }], async () => {
    const response = mockRes();
    await controller.putReviewPreferences({
      user: { id: USER_ID },
      body: { cardTypes: ['recognition', 'recall'], weights: { recognition: 50, recall: 50 }, autoPick: true }
    }, response.res);
    assert.equal(response.status(), 200);
    assert.equal(response.body().userPreferences.autoPick, true);
    assert.deepEqual(response.body().userPreferences.cardTypes, ['recognition', 'recall']);
  });
});

test('PUT /api/review/preferences rejects out-of-range speechRate with 400', async () => {
  for (const speechRate of ['fast', 0.2, 1.6, NaN, Infinity, {}, []]) {
    const mocked = mockRes();
    await controller.putReviewPreferences(
      { user: { id: USER_ID }, body: { cardTypes: ['recall'], speechRate } },
      mocked.res
    );
    assert.equal(mocked.status(), 400, `expected 400 for speechRate=${JSON.stringify(speechRate)}`);
    assert.match(mocked.body().error, /speechRate must be a number between 0.25 and 1.5/);
  }
  for (const speechRate of [0.25, 0.5, 1, 1.5]) {
    const mocked = mockRes();
    await withPoolExecute(async () => [{ affectedRows: 1 }], async () => {
      await controller.putReviewPreferences(
        { user: { id: USER_ID }, body: { cardTypes: ['recall'], speechRate } },
        mocked.res
      );
    });
    assert.equal(mocked.status(), 200, `expected 200 for speechRate=${speechRate}`);
    assert.equal(mocked.body().userPreferences.speechRate, speechRate);
  }
});

test('PUT /api/review/preferences round-trips speechRate scoped to req.user.id', async () => {
  const calls = [];
  await withPoolExecute(async (sql, params) => {
    calls.push({ sql, params });
    return [{ affectedRows: 1 }];
  }, async () => {
    const explicit = mockRes();
    await controller.putReviewPreferences({
      user: { id: USER_ID },
      body: { cardTypes: ['recall'], speechRate: 1.25 }
    }, explicit.res);
    assert.equal(explicit.status(), 200);
    assert.equal(explicit.body().userPreferences.speechRate, 1.25);
    assert.equal(calls[0].params[0], USER_ID);
    assert.equal(calls[0].params[calls[0].params.length - 1], 1.25);

    const omitted = mockRes();
    await controller.putReviewPreferences({
      user: { id: USER_ID },
      body: { cardTypes: ['recall'] }
    }, omitted.res);
    assert.equal(omitted.status(), 200);
    assert.equal(omitted.body().userPreferences.speechRate, 1);
  });
});

test('GET /api/review/types defaults speechRate for missing or legacy rows', async () => {
  await withPoolExecute(async () => [[]], async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewTypes({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().userPreferences.speechRate, 1);
  });

  await withPoolExecute(async () => [[{
    card_types: ['recall'], weights: {}, engine_mode: 'fixed', auto_pick: true
  }]], async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewTypes({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().userPreferences.speechRate, 1);
  });

  await withPoolExecute(async () => [[{
    card_types: ['recall'], weights: {}, engine_mode: 'fixed', auto_pick: true, speech_rate: 0.7
  }]], async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewTypes({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().userPreferences.speechRate, 0.7);
  });

  await withPoolExecute(async () => [[{
    card_types: ['recall'], weights: {}, engine_mode: 'fixed', auto_pick: true, speech_rate: 99
  }]], async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewTypes({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().userPreferences.speechRate, 1);
  });
});

test('GET /api/review/types defaults autoPick to true for missing or legacy rows', async () => {
  // No stored row at all.
  await withPoolExecute(async (sql, params) => {
    assert.match(sql, /FROM user_review_preferences WHERE user_id = \?/);
    assert.deepEqual(params, [USER_ID]);
    return [[]];
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewTypes({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().userPreferences.autoPick, true);
  });

  // Legacy pre-027 row without the auto_pick column selected.
  await withPoolExecute(async () => [[{
    card_types: ['recall'], weights: { recall: 20 }, engine_mode: 'dynamic'
  }]], async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewTypes({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().userPreferences.autoPick, true);
    assert.equal(body().userPreferences.engineMode, 'dynamic');
  });

  // Stored false survives both driver shapes (boolean false and adapter 0).
  for (const auto_pick of [false, 0]) {
    await withPoolExecute(async () => [[{
      card_types: ['recall'], weights: {}, engine_mode: 'fixed', auto_pick
    }]], async () => {
      const { res, status, body } = mockRes();
      await controller.getReviewTypes({ user: { id: USER_ID } }, res);
      assert.equal(status(), 200);
      assert.equal(body().userPreferences.autoPick, false);
    });
  }

  // Stored true survives both driver shapes (boolean true and adapter 1).
  for (const auto_pick of [true, 1]) {
    await withPoolExecute(async () => [[{
      card_types: ['recall'], weights: {}, engine_mode: 'fixed', auto_pick
    }]], async () => {
      const { res, status, body } = mockRes();
      await controller.getReviewTypes({ user: { id: USER_ID } }, res);
      assert.equal(status(), 200);
      assert.equal(body().userPreferences.autoPick, true);
    });
  }
});

test('GET /api/review/patterns detects, replaces stored rows, and returns the fresh set', async () => {
  const calls = [];
  await withPoolExecute(async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM review_events re/i.test(sql)) {
      // Ownership scoping: every user_id placeholder carries the caller.
      assert.equal(params.filter((value) => value === USER_ID).length, 6);
      return [[
        { id_review_event: 1, result: 'Again', id_review_item: 7, entityType: 'vocabulary', display: '学生', level: 'N5', onyomi: null, kunyomi: null },
        { id_review_event: 2, result: 'Again', id_review_item: 7, entityType: 'vocabulary', display: '学生', level: 'N5', onyomi: null, kunyomi: null },
        { id_review_event: 3, result: 'Again', id_review_item: 7, entityType: 'vocabulary', display: '学生', level: 'N5', onyomi: null, kunyomi: null }
      ]];
    }
    if (/DELETE FROM review_patterns/i.test(sql)) {
      assert.deepEqual(params, [USER_ID]);
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO review_patterns/i.test(sql)) {
      assert.equal(params[0], USER_ID);
      assert.equal(params[1], 'vocabulary-frequent-again');
      JSON.parse(params[2]);
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected patterns SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.getReviewPatterns({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().items.length, 1);
    assert.equal(body().items[0].patternType, 'vocabulary-frequent-again');
    assert.equal(body().items[0].priority, 2);
    assert.equal(body().items[0].affectedItems[0].display, '学生');
  });
});
