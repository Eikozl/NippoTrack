const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

// Phase 10 — JLPT reference Kanji progress (GET /api/level/progress).
// Transparent reviewed-vs-reference counts per band + cumulative coverage.
// Collection membership alone never counts; only owned kanji with >= 1
// review event count as reviewed, >= 2 as repeated. Denominators come from
// the shared kanji_reference dataset, counted dynamically.
//
// Fixture model per user: { kanji: [{ refBand, ownBand, events }],
// reference: { N5, N4, ... }, exposure }
// The stub mirrors the service SQL's COALESCE(kr.jlpt_level, k.jlpt_level).

const DEFAULT_REFERENCE = { N5: 80, N4: 170, N3: 370, N2: 380, N1: 1000 };

function installProgressStub(fixtures, options = {}) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const seen = [];
  const num = (value) => (options.stringCounts ? String(value) : value);
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM kanji_reference WHERE character IN \(/i.test(sql)) return [[]];
    if (/FROM kanji k WHERE k\.user_id/i.test(sql)) return [[]];
    if (/FROM kanji_reference/i.test(sql) && /GROUP BY jlpt_level/i.test(sql)) {
      const reference = (fixtures.__reference || DEFAULT_REFERENCE);
      const rows = Object.entries(reference).map(([band, total]) => ({ band, total: num(total) }));
      if (options.reverseOrder) rows.reverse();
      return [rows];
    }
    if (/AS evidence/i.test(sql)) {
      const fixture = fixtures[params[0]] || { kanji: [], exposure: 0 };
      const groups = new Map();
      for (const entry of fixture.kanji) {
        const band = entry.refBand ?? entry.ownBand ?? null;
        const key = band || '__unclassified__';
        if (!groups.has(key)) groups.set(key, { band, collected: 0, reviewed: 0, repeated: 0 });
        const group = groups.get(key);
        group.collected += 1;
        if (entry.events >= 1) group.reviewed += 1;
        if (entry.events >= 2) group.repeated += 1;
      }
      let rows = [...groups.values()].map((group) => (/AS collected/i.test(sql)
        ? { band: group.band, collected: num(group.collected), reviewed: num(group.reviewed), repeated: num(group.repeated) }
        : {
            band: group.band,
            eligible: num(group.reviewed),
            retained: num(group.repeated)
          }));
      // pg GROUP BY has no ORDER BY: callers must be order-independent.
      if (options.reverseOrder) rows = rows.reverse();
      return [rows];
    }
    if (/SELECT \(SELECT COUNT\(\*\) FROM kanji/i.test(sql)) {
      const fixture = fixtures[params[0]] || { kanji: [], exposure: 0 };
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

async function getJson(base, path) {
  const response = await fetch(`${base}${path}`);
  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON error shape */ }
  return { status: response.status, body: payload };
}

const kanji = (band, events, overrides = {}) => ({ refBand: band, ownBand: band, events, ...overrides });
const many = (count, band, events, overrides = {}) => Array.from({ length: count }, () => kanji(band, events, overrides));

async function progressWith(fixtures, user = TEST_USER, stubOptions = {}) {
  const stub = installProgressStub(fixtures, stubOptions);
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = user;
  try {
    let result = null;
    await withServer(async (base) => { result = await getJson(base, '/api/level/progress'); });
    return { result, seen: stub.seen };
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
    restoreStub(stub);
  }
}

test('Phase 10: brand-new user gets zero reviewed progress across bands', async () => {
  const { result, seen } = await progressWith({ [TEST_USER]: { kanji: [], exposure: 0 } });
  assert.equal(result.status, 200);
  for (const band of ['N5', 'N4', 'N3', 'N2', 'N1']) {
    assert.equal(result.body.bands[band].reviewed, 0);
    assert.equal(result.body.bands[band].reviewedPercent, 0);
    assert.equal(result.body.bands[band].repeated, 0);
    assert.equal(result.body.bands[band].collected, 0);
  }
  assert.equal(result.body.summary.reviewed, 0);
  assert.ok(String(result.body.disclaimer).toLowerCase().includes('not official')
    || String(result.body.disclaimer).toLowerCase().includes('not an official')
    || String(result.body.disclaimer).includes('Not official'));
  assert.ok(!seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)), 'progress must be read-only');
});

test('Phase 10: imported N1 kanji without reviews do not move reviewed progress', async () => {
  const { result } = await progressWith({
    [TEST_USER]: { kanji: many(20, 'N1', 0), exposure: 0 }
  });
  assert.equal(result.body.bands.N1.collected, 20);
  assert.equal(result.body.bands.N1.reviewed, 0);
  assert.equal(result.body.bands.N1.reviewedPercent, 0);
  assert.equal(result.body.bands.N1.unreviewedCollected, 20);
});

test('Phase 10: reviewed N5 kanji yield the correct numerator and dynamic denominator', async () => {
  const { result } = await progressWith({
    __reference: { ...DEFAULT_REFERENCE, N5: 80 },
    [TEST_USER]: { kanji: many(58, 'N5', 1), exposure: 0 }
  });
  assert.equal(result.body.bands.N5.referenceTotal, 80);
  assert.equal(result.body.bands.N5.reviewed, 58);
  assert.equal(result.body.bands.N5.reviewedPercent, 72.5);
});

test('Phase 10: repeated reviews stay unique and feed the repeated signal', async () => {
  const { result } = await progressWith({
    [TEST_USER]: { kanji: [...many(6, 'N5', 2), ...many(2, 'N5', 1)], exposure: 0 }
  });
  assert.equal(result.body.bands.N5.collected, 8);
  assert.equal(result.body.bands.N5.reviewed, 8);
  assert.equal(result.body.bands.N5.repeated, 6);
});

test('Phase 10: one kanji reviewed many times counts exactly once', async () => {
  const { result } = await progressWith({
    [TEST_USER]: { kanji: [kanji('N4', 25)], exposure: 0 }
  });
  assert.equal(result.body.bands.N4.collected, 1);
  assert.equal(result.body.bands.N4.reviewed, 1);
  assert.equal(result.body.bands.N4.repeated, 1);
});

test('Phase 10: unclassified kanji are never assigned to N5-N1', async () => {
  const { result } = await progressWith({
    [TEST_USER]: {
      kanji: [
        { refBand: null, ownBand: null, events: 3 },
        { refBand: null, ownBand: 'N9', events: 1 }
      ],
      exposure: 0
    }
  });
  for (const band of ['N5', 'N4', 'N3', 'N2', 'N1']) {
    assert.equal(result.body.bands[band].reviewed, 0);
    assert.equal(result.body.bands[band].collected, 0);
  }
  assert.equal(result.body.unclassified.collected, 2);
  assert.equal(result.body.unclassified.reviewed, 2);
});

test('Phase 10: reference totals are dynamic, not hardcoded', async () => {
  const { result } = await progressWith({
    __reference: { N5: 12, N4: 34, N3: 56, N2: 78, N1: 90 },
    [TEST_USER]: { kanji: many(6, 'N5', 1), exposure: 0 }
  });
  assert.equal(result.body.bands.N5.referenceTotal, 12);
  assert.equal(result.body.bands.N5.reviewedPercent, 50);
  assert.equal(result.body.bands.N2.referenceTotal, 78);
  assert.equal(result.body.summary.referenceTotal, 270);
});

test('Phase 10: cumulative coverage through N4 and N3 is correct', async () => {
  const { result } = await progressWith({
    __reference: { N5: 80, N4: 170, N3: 370, N2: 380, N1: 1000 },
    [TEST_USER]: { kanji: [...many(58, 'N5', 1), ...many(42, 'N4', 1), ...many(21, 'N3', 1)], exposure: 0 }
  });
  assert.deepEqual(
    { referenceTotal: result.body.cumulative.N4.referenceTotal, reviewed: result.body.cumulative.N4.reviewed },
    { referenceTotal: 250, reviewed: 100 }
  );
  assert.equal(result.body.cumulative.N4.reviewedPercent, 40);
  assert.deepEqual(
    { referenceTotal: result.body.cumulative.N3.referenceTotal, reviewed: result.body.cumulative.N3.reviewed },
    { referenceTotal: 620, reviewed: 121 }
  );
});

test('Phase 10: progress is scoped to the requesting user', async () => {
  const fixtures = {
    [TEST_USER]: { kanji: many(3, 'N5', 1), exposure: 0 },
    [OTHER_USER]: { kanji: many(40, 'N5', 2), exposure: 0 }
  };
  const { result } = await progressWith(fixtures, TEST_USER);
  assert.equal(result.body.bands.N5.reviewed, 3);
  assert.equal(result.body.bands.N5.repeated, 0);
  const other = await progressWith(fixtures, OTHER_USER);
  assert.equal(other.result.body.bands.N5.reviewed, 40);
  assert.equal(other.result.body.bands.N5.repeated, 40);
});

test('Phase 10: Analyzer-style bulk imports without reviews do not inflate progress', async () => {
  const { result } = await progressWith({
    [TEST_USER]: { kanji: [...many(60, 'N5', 0), ...many(40, 'N4', 0), ...many(30, 'N3', 0)], exposure: 0 }
  });
  assert.equal(result.body.summary.reviewed, 0);
  assert.equal(result.body.summary.reviewedPercent, 0);
  assert.equal(result.body.bands.N5.collected, 60);
  assert.equal(result.body.bands.N5.reviewed, 0);
});

test('Phase 10: encounters-only exposure does not inflate progress', async () => {
  const { result } = await progressWith({ [TEST_USER]: { kanji: [], exposure: 25 } });
  assert.equal(result.body.summary.reviewed, 0);
  for (const band of ['N5', 'N4', 'N3', 'N2', 'N1']) {
    assert.equal(result.body.bands[band].reviewed, 0);
  }
});

test('Phase 10: results are deterministic across calls', async () => {
  const fixtures = {
    [TEST_USER]: { kanji: [...many(10, 'N5', 2), ...many(5, 'N4', 1)], exposure: 2 }
  };
  const first = await progressWith(fixtures);
  const second = await progressWith(fixtures, TEST_USER, { reverseOrder: true });
  assert.deepEqual(second.result.body, first.result.body);
});

test('Phase 10: bounded query count with no writes', async () => {
  const { result, seen } = await progressWith({
    [TEST_USER]: { kanji: many(10, 'N5', 1), exposure: 0 }
  });
  assert.equal(result.status, 200);
  const selects = seen.filter((entry) => /^\s*SELECT/i.test(entry.sql));
  assert.ok(selects.length <= 3, `expected a bounded query count, saw ${selects.length}`);
  assert.ok(!seen.some((entry) => /INSERT|UPDATE|DELETE/i.test(entry.sql)));
});

test('Phase 10: Phase 9 estimate stays compatible on the same evidence', async () => {
  const fixtures = {
    [TEST_USER]: { kanji: [...many(8, 'N5', 1), ...many(3, 'N4', 0)], exposure: 1 }
  };
  const stub = installProgressStub(fixtures);
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = TEST_USER;
  try {
    let estimate = null;
    let progress = null;
    await withServer(async (base) => {
      estimate = await getJson(base, '/api/level/estimate');
      progress = await getJson(base, '/api/level/progress');
    });
    assert.equal(estimate.body.estimate.level, 'N5');
    assert.equal(progress.body.bands.N5.reviewed, 8);
    assert.equal(progress.body.bands.N4.reviewed, 0);
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
    restoreStub(stub);
  }
});

test('Phase 10: owned-column band is used when the reference overlay is missing', async () => {
  const { result } = await progressWith({
    [TEST_USER]: { kanji: [{ refBand: null, ownBand: 'N4', events: 1 }], exposure: 0 }
  });
  assert.equal(result.body.bands.N4.reviewed, 1);
  assert.equal(result.body.bands.N4.collected, 1);
});

test('Phase 10: pure builder clamps repeated/reviewed and reports unreviewed', async () => {
  const { buildJlptProgress } = require('../src/services/jlptProgress');
  const payload = buildJlptProgress({
    referenceTotals: { N5: 10 },
    bandRows: [{ band: 'N5', collected: 4, reviewed: 9, repeated: 12 }],
    unclassified: { collected: 1, reviewed: 0 }
  });
  assert.equal(payload.bands.N5.reviewed, 4);
  assert.equal(payload.bands.N5.repeated, 4);
  assert.equal(payload.bands.N5.unreviewedCollected, 0);
  assert.equal(payload.bands.N5.reviewedPercent, 40);
});

test('Phase 10: string counts from pg stay numeric', async () => {
  const { result } = await progressWith(
    { [TEST_USER]: { kanji: [...many(6, 'N5', 2), ...many(2, 'N5', 1)], exposure: 0 } },
    TEST_USER,
    { stringCounts: true }
  );
  assert.equal(result.body.bands.N5.collected, 8);
  assert.equal(result.body.bands.N5.reviewed, 8);
  assert.equal(result.body.bands.N5.repeated, 6);
  assert.equal(result.body.bands.N5.reviewedPercent, 10);
});

test('Phase 10: empty reference band yields null percent instead of NaN', async () => {
  const { result } = await progressWith({
    __reference: { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0 },
    [TEST_USER]: { kanji: many(3, 'N5', 1), exposure: 0 }
  });
  assert.equal(result.body.bands.N5.reviewed, 3);
  assert.equal(result.body.bands.N5.reviewedPercent, null);
  assert.equal(result.body.cumulative.N5.reviewedPercent, null);
  assert.equal(result.body.summary.reviewedPercent, null);
});

test('Phase 10: shrunk denominators report truthful over-100 percents', async () => {
  const { result } = await progressWith({
    __reference: { N5: 4, N4: 170, N3: 370, N2: 380, N1: 1000 },
    [TEST_USER]: { kanji: many(6, 'N5', 1), exposure: 0 }
  });
  assert.equal(result.body.bands.N5.reviewed, 6);
  assert.equal(result.body.bands.N5.reviewedPercent, 150);
});

test('Phase 10: summary and cumulative carry the repeated signal', async () => {
  const { result } = await progressWith({
    [TEST_USER]: { kanji: [...many(6, 'N5', 2), ...many(4, 'N4', 2)], exposure: 0 }
  });
  assert.equal(result.body.summary.repeated, 10);
  assert.equal(result.body.cumulative.N4.repeated, 10);
  assert.equal(result.body.cumulative.N5.repeated, 6);
});

test('Phase 10: unclassified bucket keeps collected/reviewed/repeated', async () => {
  const { result } = await progressWith({
    [TEST_USER]: { kanji: [{ refBand: null, ownBand: null, events: 2 }], exposure: 0 }
  });
  assert.deepEqual(result.body.unclassified, { collected: 1, reviewed: 1, repeated: 1 });
});

test('Phase 10: pure builder tolerates null inputs and negatives', async () => {
  const { buildJlptProgress } = require('../src/services/jlptProgress');
  const payload = buildJlptProgress({ referenceTotals: null, bandRows: null, unclassified: null });
  for (const band of ['N5', 'N4', 'N3', 'N2', 'N1']) {
    assert.equal(payload.bands[band].reviewed, 0);
    assert.equal(payload.bands[band].reviewedPercent, null);
  }
  const negative = buildJlptProgress({
    referenceTotals: { N5: -5 },
    bandRows: [{ band: 'N5', collected: -2, reviewed: -1, repeated: -1 }],
    unclassified: { collected: -1, reviewed: -1, repeated: -1 }
  });
  assert.equal(negative.bands.N5.collected, 0);
  assert.equal(negative.unclassified.collected, 0);
});
