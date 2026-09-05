const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

// Phase 9 — Estimated study level (GET /api/level/estimate). Conservative,
// explainable heuristic over OWNED review evidence only: an owned kanji with
// >= 1 review event is eligible; >= 2 events is the "retained" signal.
// Collection membership, status, encounters, session links, Analyzer text,
// and other users' data must never promote the estimate.
//
// Fixture model per user: { kanji: [{ refBand, ownBand, events }], exposure }
// The stub mirrors the service SQL's COALESCE(kr.jlpt_level, k.jlpt_level).

function installLevelStub(fixtures, options = {}) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const seen = [];
  const num = (value) => (options.stringCounts ? String(value) : value);
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    const fixture = fixtures[params[0]] || { kanji: [], exposure: 0 };
    if (/AS evidence/i.test(sql)) {
      // Per-band aggregate: mirrors COALESCE(reference, owned) grouping.
      const groups = new Map();
      for (const entry of fixture.kanji) {
        if (!entry.events || entry.events < 1) continue;
        const band = entry.refBand ?? entry.ownBand ?? null;
        const key = band || '__unclassified__';
        if (!groups.has(key)) groups.set(key, { band, eligible: 0, retained: 0 });
        const group = groups.get(key);
        group.eligible += 1;
        if (entry.events >= 2) group.retained += 1;
      }
      let rows = [...groups.values()].map((group) => ({
        band: group.band,
        eligible: num(group.eligible),
        retained: num(group.retained)
      }));
      // pg GROUP BY has no ORDER BY: callers must be order-independent.
      if (options.reverseOrder) rows = rows.reverse();
      return [rows];
    }
    if (/FROM kanji_reference WHERE character IN \(/i.test(sql)) return [[]];
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) return [[]];
    if (/SELECT \(SELECT COUNT\(\*\) FROM kanji/i.test(sql)) {
      const reviewed = fixture.kanji.filter((entry) => entry.events >= 1).length;
      return [[{ collected: num(fixture.kanji.length), reviewed: num(reviewed), exposure: num(fixture.exposure || 0) }]];
    }
    return [[]];
  };
  return { originalExecute, seen };
}

function restoreStub(stub) {
  require('../src/config/db').execute = stub.originalExecute;
}

test.after(async () => {
  try {
    await require('../src/config/db').end();
  } catch {
    // Pool may already be ended; ignore.
  }
});

async function withServer(fn) {
  const app = require('../src/app');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function getEstimate(base) {
  const response = await fetch(`${base}/api/level/estimate`);
  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON error shape */ }
  return { status: response.status, body: payload };
}

const kanji = (band, events, overrides = {}) => ({ refBand: band, ownBand: band, events, ...overrides });
const many = (count, band, events, overrides = {}) => Array.from({ length: count }, () => kanji(band, events, overrides));

async function estimateWith(fixtures, user = TEST_USER, stubOptions = {}) {
  const stub = installLevelStub(fixtures, stubOptions);
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = user;
  try {
    let result = null;
    await withServer(async (base) => { result = await getEstimate(base); });
    return { result, seen: stub.seen };
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
    restoreStub(stub);
  }
}

test('Phase 9: brand-new user gets insufficient evidence, never N5', async () => {
  const { result, seen } = await estimateWith({ [TEST_USER]: { kanji: [], exposure: 0 } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.estimate, { level: null, status: 'insufficient_evidence', confidence: null, approachingBand: null });
  assert.ok(String(result.body.disclaimer).includes('not an official JLPT assessment'));
  assert.ok(!seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)), 'estimate must be read-only');
});

test('Phase 9: imported N1/N2 kanji without reviews do not move the estimate', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: [...many(20, 'N1', 0), ...many(15, 'N2', 0)], exposure: 0 }
  });
  assert.equal(result.body.estimate.status, 'insufficient_evidence');
  assert.equal(result.body.estimate.level, null);
  assert.equal(result.body.evidence.eligibleKanji, 0);
  assert.equal(result.body.evidence.unreviewedKanji, 35);
});

test('Phase 9: strong N5 review evidence yields a conservative N5', async () => {
  const { result } = await estimateWith({ [TEST_USER]: { kanji: many(8, 'N5', 1), exposure: 3 } });
  assert.deepEqual(result.body.estimate, { level: 'N5', status: 'estimated', confidence: 'low', approachingBand: null });
  assert.equal(result.body.distribution.N5.eligible, 8);
  assert.ok(result.body.reasoning.length >= 2);
  assert.ok(result.body.limitations.some((line) => /OpenJLPT/i.test(line)));
  assert.ok(result.body.limitations.some((line) => /exposure only/i.test(line)));
});

test('Phase 9: N5 + N4 foundation promotes to N4', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: [...many(8, 'N5', 2), ...many(6, 'N4', 1)], exposure: 0 }
  });
  assert.equal(result.body.estimate.level, 'N4');
  assert.equal(result.body.estimate.status, 'estimated');
});

test('Phase 9: partial N3 on a solid base stays N4 and approaches N3', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: [...many(8, 'N5', 2), ...many(6, 'N4', 1), ...many(2, 'N3', 1)], exposure: 0 }
  });
  assert.equal(result.body.estimate.level, 'N4');
  assert.equal(result.body.estimate.approachingBand, 'N3');
  assert.ok(result.body.reasoning.some((line) => /approaching N3/i.test(line)));
});

test('Phase 9: a handful of N1 kanji with a weak lower foundation is never N1', async () => {
  const weak = await estimateWith({
    [TEST_USER]: { kanji: [...many(6, 'N1', 2), ...many(2, 'N5', 1)], exposure: 0 }
  });
  assert.equal(weak.result.body.estimate.status, 'insufficient_evidence');
  const stray = await estimateWith({
    [TEST_USER]: { kanji: [...many(8, 'N5', 1), ...many(6, 'N1', 2)], exposure: 0 }
  });
  assert.equal(stray.result.body.estimate.level, 'N5');
});

test('Phase 9: one N3 kanji never makes N3', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: [...many(8, 'N5', 1), ...many(6, 'N4', 1), kanji('N3', 3)], exposure: 0 }
  });
  assert.equal(result.body.estimate.level, 'N4');
  assert.equal(result.body.estimate.approachingBand, 'N3');
});

test('Phase 9: unclassified reviewed kanji are counted but never mapped', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: many(7, null, 2), exposure: 0 }
  });
  assert.equal(result.body.estimate.status, 'insufficient_evidence');
  assert.equal(result.body.evidence.unclassifiedEligibleKanji, 7);
  assert.equal(result.body.evidence.classifiedEligibleKanji, 0);
  assert.ok(result.body.limitations.some((line) => /no reference JLPT classification/i.test(line)));
});

test('Phase 9: reviewed evidence counts, merely collected kanji do not', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: [...many(5, 'N5', 1), ...many(20, 'N5', 0)], exposure: 0 }
  });
  assert.equal(result.body.estimate.level, 'N5');
  assert.equal(result.body.evidence.eligibleKanji, 5);
  assert.equal(result.body.evidence.unreviewedKanji, 20);
});

test('Phase 9: repeated encounters alone cannot inflate the level', async () => {
  const { result } = await estimateWith({ [TEST_USER]: { kanji: many(4, 'N5', 0), exposure: 12 } });
  assert.equal(result.body.estimate.status, 'insufficient_evidence');
  assert.equal(result.body.evidence.exposureKanji, 12);
});

test('Phase 9: estimate is scoped to the requesting user', async () => {
  const fixtures = {
    [TEST_USER]: { kanji: [], exposure: 0 },
    [OTHER_USER]: { kanji: [...many(10, 'N5', 2), ...many(8, 'N4', 2)], exposure: 0 }
  };
  const stub = installLevelStub(fixtures);
  const previous = process.env.JLT_TEST_USER_ID;
  try {
    let own = null;
    let other = null;
    await withServer(async (base) => {
      const ownStart = stub.seen.length;
      process.env.JLT_TEST_USER_ID = TEST_USER;
      own = await getEstimate(base);
      const ownQueries = stub.seen.slice(ownStart);
      assert.ok(ownQueries.length > 0);
      for (const entry of ownQueries) {
        if (entry.params.length) assert.ok(entry.params.every((param) => param === TEST_USER));
      }
      const otherStart = stub.seen.length;
      process.env.JLT_TEST_USER_ID = OTHER_USER;
      other = await getEstimate(base);
      const otherQueries = stub.seen.slice(otherStart);
      assert.ok(otherQueries.length > 0);
      for (const entry of otherQueries) {
        if (entry.params.length) assert.ok(entry.params.every((param) => param === OTHER_USER));
      }
    });
    assert.equal(own.body.estimate.status, 'insufficient_evidence');
    assert.equal(other.body.estimate.level, 'N4');
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
    restoreStub(stub);
  }
});

test('Phase 9: same evidence always yields the same result', async () => {
  const fixtures = { [TEST_USER]: { kanji: [...many(9, 'N5', 2), ...many(5, 'N4', 1)], exposure: 4 } };
  const first = await estimateWith(fixtures);
  const second = await estimateWith(fixtures);
  assert.deepEqual(second.result.body, first.result.body);
});

test('Phase 9: threshold boundaries behave exactly', async () => {
  const four = await estimateWith({ [TEST_USER]: { kanji: many(4, 'N5', 1), exposure: 0 } });
  assert.equal(four.result.body.estimate.status, 'insufficient_evidence');
  const five = await estimateWith({ [TEST_USER]: { kanji: many(5, 'N5', 1), exposure: 0 } });
  assert.equal(five.result.body.estimate.level, 'N5');
  const n4Four = await estimateWith({
    [TEST_USER]: { kanji: [...many(9, 'N5', 1), ...many(4, 'N4', 1)], exposure: 0 }
  });
  assert.equal(n4Four.result.body.estimate.level, 'N5');
  assert.equal(n4Four.result.body.estimate.approachingBand, 'N4');
  const n4Five = await estimateWith({
    [TEST_USER]: { kanji: [...many(9, 'N5', 1), ...many(5, 'N4', 1)], exposure: 0 }
  });
  assert.equal(n4Five.result.body.estimate.level, 'N4');
});

test('Phase 9: confidence tracks evidence volume and repetition', async () => {
  const small = await estimateWith({ [TEST_USER]: { kanji: many(6, 'N5', 1), exposure: 0 } });
  assert.equal(small.result.body.estimate.confidence, 'low');
  const medium = await estimateWith({ [TEST_USER]: { kanji: many(16, 'N5', 1), exposure: 0 } });
  assert.equal(medium.result.body.estimate.confidence, 'moderate');
  const large = await estimateWith({ [TEST_USER]: { kanji: many(55, 'N5', 2), exposure: 0 } });
  assert.equal(large.result.body.estimate.confidence, 'high');
  const unrepeated = await estimateWith({ [TEST_USER]: { kanji: many(55, 'N5', 1), exposure: 0 } });
  assert.equal(unrepeated.result.body.estimate.confidence, 'moderate');
});

test('Phase 9: analyzing advanced text never inflates the estimate', async () => {
  const stub = installLevelStub({ [TEST_USER]: { kanji: many(3, 'N5', 1), exposure: 0 } });
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = TEST_USER;
  try {
    await withServer(async (base) => {
      const before = await getEstimate(base);
      const analysis = await fetch(`${base}/api/analyze/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '憂鬱な魑魅魍魎が薔薇を齎す' })
      });
      assert.equal(analysis.status, 200);
      const after = await getEstimate(base);
      assert.deepEqual(after.body, before.body);
      assert.equal(after.body.estimate.status, 'insufficient_evidence');
      // Analysis plus estimation issued no writes between them.
      assert.ok(!stub.seen.some((entry) => /INSERT|UPDATE|DELETE|FOR UPDATE/i.test(entry.sql)));
    });
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
    restoreStub(stub);
  }
});

test('Phase 9: owned band falls back to user metadata when reference is missing', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: many(6, null, 1, { ownBand: 'N5' }), exposure: 0 }
  });
  assert.equal(result.body.estimate.level, 'N5');
  assert.equal(result.body.evidence.unclassifiedEligibleKanji, 0);
});

test('Phase 9: estimate needs only two bounded aggregate queries', async () => {
  const { result, seen } = await estimateWith({ [TEST_USER]: { kanji: many(6, 'N5', 1), exposure: 0 } });
  assert.equal(result.status, 200);
  // Exact bound: no hidden third query (reference audit, session read, …).
  assert.equal(seen.length, 2);
  const levelQueries = seen.filter((entry) => /AS evidence|SELECT \(SELECT COUNT\(\*\) FROM kanji/i.test(entry.sql));
  assert.equal(levelQueries.length, 2);
  for (const entry of seen) {
    assert.ok(!/INSERT|UPDATE|DELETE|FOR UPDATE/i.test(entry.sql));
  }
});

test('Phase 9: band SQL joins review evidence and prefers the reference band', async () => {
  const { result, seen } = await estimateWith({
    [TEST_USER]: { kanji: [...many(5, 'N5', 1), ...many(5, 'N5', 1, { refBand: 'N4', ownBand: 'N5' })], exposure: 0 }
  });
  const bandQuery = seen.find((entry) => /AS evidence/i.test(entry.sql));
  assert.ok(bandQuery, 'expected the per-band aggregate query');
  assert.match(bandQuery.sql, /COALESCE\(kr\.jlpt_level, k\.jlpt_level\)/);
  assert.match(bandQuery.sql, /JOIN review_items ri ON ri\.id_kanji = k\.id_kanji/);
  assert.match(bandQuery.sql, /JOIN review_events re ON re\.id_review_item = ri\.id_review_item/);
  assert.match(bandQuery.sql, /WHERE k\.user_id = \?/);
  // Reference wins over conflicting user metadata (COALESCE direction).
  assert.equal(result.body.estimate.level, 'N4');
});

test('Phase 9: cumulative foundation promotes through N3 and stops at gaps', async () => {
  const promoted = await estimateWith({
    [TEST_USER]: { kanji: [...many(8, 'N5', 2), ...many(6, 'N4', 1), ...many(5, 'N3', 1)], exposure: 0 }
  });
  assert.equal(promoted.result.body.estimate.level, 'N3');
  const gap = await estimateWith({
    [TEST_USER]: { kanji: [...many(8, 'N5', 1), ...many(6, 'N4', 1), ...many(5, 'N2', 2)], exposure: 0 }
  });
  assert.equal(gap.result.body.estimate.level, 'N4');
  assert.equal(gap.result.body.estimate.approachingBand, null);
});

test('Phase 9: pg string counts coerce to the same estimate', async () => {
  const numeric = await estimateWith({
    [TEST_USER]: { kanji: [...many(9, 'N5', 2), ...many(5, 'N4', 1)], exposure: 4 }
  });
  const stub = installLevelStub({
    [TEST_USER]: { kanji: [...many(9, 'N5', 2), ...many(5, 'N4', 1)], exposure: 4 }
  }, { stringCounts: true });
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = TEST_USER;
  try {
    let stringy = null;
    await withServer(async (base) => { stringy = await getEstimate(base); });
    assert.deepEqual(stringy.body.estimate, numeric.result.body.estimate);
    assert.deepEqual(stringy.body.evidence, numeric.result.body.evidence);
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
    restoreStub(stub);
  }
});

test('Phase 9: band-row order and dirty band labels do not change the result', async () => {
  const fixtures = {
    [TEST_USER]: {
      kanji: [...many(5, ' n5 ', 1, { refBand: ' n5 ', ownBand: null }), ...many(4, 'N4', 1)],
      exposure: 0
    }
  };
  const forward = await estimateWith(fixtures);
  const reversed = await estimateWith(fixtures, TEST_USER, { reverseOrder: true });
  assert.equal(forward.result.body.estimate.level, 'N5');
  assert.equal(forward.result.body.estimate.approachingBand, 'N4');
  assert.deepEqual(reversed.result.body.estimate, forward.result.body.estimate);
  assert.deepEqual(reversed.result.body.distribution, forward.result.body.distribution);
});

test('Phase 9: server payload feeds the client dashboard model directly', async () => {
  const { result } = await estimateWith({
    [TEST_USER]: { kanji: [...many(8, 'N5', 2), ...many(6, 'N4', 1)], exposure: 0 }
  });
  assert.equal(result.status, 200);
  const { levelEstimateModel } = await import('../../client/src/levelEstimate.js');
  const model = levelEstimateModel(result.body);
  assert.ok(model, 'client model must accept the live server payload');
  assert.equal(model.metricValue, result.body.estimate.level);
  assert.equal(model.disclaimer, result.body.disclaimer);
  assert.match(model.metricNote, /JLT estimate/);
});
