// CA-B2 API tests: additive context block on POST /api/analyze/text.
// Transport-level stubs only (pool.execute): the REAL parser, candidate
// builder, context service, filters and response assembly all run. Real-SQL
// correctness lives in context-db.test.js; here the wire contract is proven:
// flags, shape, degradation, caps, reason codes, and the closed status sets.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';

// Known flaky: kuromoji init can exceed its budget under contention, so a
// cold first run may come back 'unavailable'/timeout. Retry such runs ONCE;
// anything else (or a second failure) is a real failure. Scoped to the
// cold-init test below, never global.
async function retryOnceOnFlakyInit(fn) {
  try {
    await fn();
  } catch (error) {
    if (!/unavailable|timeout/i.test(String(error?.message || ''))) throw error;
    await fn();
  }
}

const PIN = { source_id: '7', source_name: 'JMdict-Test', converter: 'fixture-converter', converter_version: '9.9.9', file_date: '2026-08-31' };

// Minimal in-memory reference: one single-sense noun, one two-sense verb,
// one kana-homograph trio. Served through the real Q1/Q2 code path.
const ENTRIES = {
  '1000001': {
    posSummary: ['n'], isCommon: 1,
    forms: [
      { surface: '学校', normalized: '学校', kind: 'keb', restr: [], is_common: 1, nokanji: 0 },
      { surface: 'がっこう', normalized: 'がっこう', kind: 'reb', restr: [], is_common: 1, nokanji: 0 }
    ],
    senses: [{ sense_no: 1, pos: ['n'], gloss_en: ['school'], stagk: [], stagr: [] }]
  },
  '1000006': {
    posSummary: ['v5k-s', 'vi'], isCommon: 1,
    forms: [
      { surface: '行く', normalized: '行く', kind: 'keb', restr: [], is_common: 1, nokanji: 0 },
      { surface: 'いく', normalized: 'いく', kind: 'reb', restr: [], is_common: 1, nokanji: 0 }
    ],
    senses: [
      { sense_no: 1, pos: ['v5k-s', 'vi'], gloss_en: ['to go'], stagk: [], stagr: [] },
      { sense_no: 2, pos: ['v5k-s', 'vi'], gloss_en: ['to proceed'], stagk: [], stagr: [] }
    ]
  },
  '3000001': {
    posSummary: ['n'], isCommon: 1,
    forms: [{ surface: '橋', normalized: '橋', kind: 'keb', restr: [], is_common: 1, nokanji: 0 },
      { surface: 'はし', normalized: 'はし', kind: 'reb', restr: [], is_common: 1, nokanji: 0 }],
    senses: [{ sense_no: 1, pos: ['n'], gloss_en: ['bridge'], stagk: [], stagr: [] }]
  },
  '3000002': {
    posSummary: ['n'], isCommon: 0,
    forms: [{ surface: '箸', normalized: '箸', kind: 'keb', restr: [], is_common: 0, nokanji: 0 },
      { surface: 'はし', normalized: 'はし', kind: 'reb', restr: [], is_common: 0, nokanji: 0 }],
    senses: [{ sense_no: 1, pos: ['n'], gloss_en: ['chopsticks'], stagk: [], stagr: [] }]
  },
  '3000003': {
    posSummary: ['n'], isCommon: 0,
    forms: [{ surface: '端', normalized: '端', kind: 'keb', restr: [], is_common: 0, nokanji: 0 },
      { surface: 'はし', normalized: 'はし', kind: 'reb', restr: [], is_common: 0, nokanji: 0 }],
    senses: [{ sense_no: 1, pos: ['n'], gloss_en: ['edge'], stagk: [], stagr: [] }]
  }
};

function q1Rows(params) {
  // Faithful to the real Q1 shape: one pin row per key minimum (active CTE
  // CROSS JOIN keys), NULL entry columns on miss (LEFT JOIN LATERAL), up to
  // 6 matched rows on hit. An all-miss request still pins — it must NEVER
  // read as version-absent (which is reserved for zero returned rows, i.e.
  // no ready active snapshot at all).
  const rows = [];
  for (let offset = 0; offset + 2 < params.length + 1; offset += 3) {
    const [candidateIdx, normalized, kind] = [params[offset], params[offset + 1], params[offset + 2]];
    if (candidateIdx === undefined || normalized === undefined || kind === undefined) break;
    const matches = [];
    for (const [entryId, entry] of Object.entries(ENTRIES)) {
      for (const form of entry.forms) {
        if (form.normalized === normalized && form.kind === kind) {
          matches.push({ entryId, form });
        }
      }
    }
    matches.sort((a, b) => b.form.is_common - a.form.is_common || Number(a.entryId) - Number(b.entryId));
    const hits = matches.slice(0, 6);
    if (!hits.length) {
      rows.push({
        ...PIN,
        candidate_idx: candidateIdx,
        key_normalized: normalized,
        key_kind: kind,
        entry_id: null,
        surface: null,
        form_normalized: null,
        form_kind: null,
        is_common: 0,
        nokanji: 0,
        restr: []
      });
      continue;
    }
    for (const { entryId, form } of hits) {
      rows.push({
        ...PIN,
        candidate_idx: candidateIdx,
        key_normalized: normalized,
        key_kind: kind,
        entry_id: entryId,
        surface: form.surface,
        form_normalized: form.normalized,
        form_kind: form.kind,
        is_common: form.is_common,
        nokanji: form.nokanji,
        restr: form.restr
      });
    }
  }
  return rows;
}

function installStub({ vocabularyFixture = {}, throwVocabulary = false, pin = 'ok' } = {}) {
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
    if (/jmdict_active_snapshot/i.test(sql)) {
      if (pin === 'q1fail') throw new Error('reference lookup down');
      if (pin === 'absent') return [[]];
      return [q1Rows(params)];
    }
    if (/jmdict_senses/i.test(sql)) {
      if (pin === 'q2fail') throw new Error('sense fetch down');
      // Pin threading at the API layer: Q2 must carry the Q1 pin, never a
      // re-read (F12/F13 race semantics are proven on real SQL in
      // context-db.test.js; here the threading parameter is asserted).
      assert.equal(String(params[params.length - 1]), PIN.source_id, 'Q2 carries the pinned source id');
      const entryIds = params.slice(0, -1).map(String);
      const rows = [];
      for (const id of entryIds) {
        const entry = ENTRIES[id];
        if (!entry) continue;
        for (const sense of entry.senses) {
          rows.push({ entry_id: id, pos_summary: entry.posSummary, is_common: entry.isCommon, ...sense });
        }
      }
      return [rows];
    }
    if (/FROM ranked/i.test(sql)) {
      if (pin === 'q2fail') throw new Error('form fetch down');
      assert.equal(String(params[params.length - 1]), PIN.source_id, 'Q2 carries the pinned source id');
      const entryIds = params.slice(0, -1).map(String);
      const rows = [];
      for (const id of entryIds) {
        const entry = ENTRIES[id];
        if (!entry) continue;
        entry.forms.forEach((form, index) => {
          rows.push({ entry_id: id, ...form, rn: index + 1, total: entry.forms.length });
        });
      }
      return [rows];
    }
    throw new Error(`unexpected SQL in context API test: ${sql.slice(0, 80)}`);
  };
  pool.getConnection = async () => { throw new Error('no connections in context API test'); };
  return {
    seen,
    jmdictQueries() {
      return seen.filter((entry) => /jmdict_/i.test(entry.sql));
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

function itemByKey(context, key) {
  return context.items.find((item) => item.key === key);
}

test('context omitted: no context key, lexical untouched', async () => retryOnceOnFlakyInit(async () => {
  // Would fail if the additive block leaked into existing responses.
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const plain = await postAnalysis(base, { text: '学校に行く。' });
      assert.equal(plain.status, 200);
      assert.ok(!('lexical' in plain.body));
      assert.ok(!('context' in plain.body));
      const lexical = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true } });
      assert.equal(lexical.status, 200);
      assert.equal(lexical.body.lexical.status, 'ok');
      assert.ok(!('context' in lexical.body), 'no context without opt-in');
      assert.ok(!('context' in lexical.body.lexical), 'no nested context either');
    });
  } finally {
    stub.restore();
  }
}));

test('lexical + context resolves UNIQUE/COMPATIBLE and UNIQUE/AMBIGUOUS additively', async () => {
  // Would fail if context broke the lexical block shape, or if the two-axis
  // result did not survive the HTTP layer intact.
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.status, 'ok');
      const context = body.lexical.context;
      assert.equal(context.status, 'ok');
      assert.equal(context.retryable, false);
      // Provenance echoes the pinned snapshot fixture, never constants —
      // fails against the old hardcoded source/converter.
      assert.deepEqual(context.dictionary, { source: 'JMdict-Test', version: '9.9.9', fileDate: '2026-08-31', converter: 'fixture-converter', sourceId: '7' });
      const gakkou = itemByKey(context, 'noun::学校');
      assert.equal(gakkou.dictionaryMatch.status, 'UNIQUE');
      assert.equal(gakkou.dictionaryMatch.identityStrategy, 'ORTHOGRAPHIC');
      assert.equal(gakkou.dictionaryMatch.selectedEntryId, '1000001');
      assert.equal(gakkou.dictionaryMatch.readings.suggested, 'がっこう');
      assert.equal(gakkou.dictionaryMatch.readings.provenance, 'dictionary');
      assert.equal(gakkou.interpretation.status, 'COMPATIBLE');
      assert.deepEqual(gakkou.interpretation.selectedSense.glosses, ['school']);
      const iku = itemByKey(context, 'verb::行く');
      assert.equal(iku.dictionaryMatch.status, 'UNIQUE');
      assert.equal(iku.dictionaryMatch.readings.suggested, 'いく');
      assert.equal(iku.interpretation.status, 'AMBIGUOUS');
      assert.equal(iku.interpretation.selectedSense, null);
      assert.equal(iku.interpretation.compatibleSenses.length, 2);
      assert.deepEqual(context.summary.dictionary, { UNIQUE: 2, MULTIPLE: 0, NO_MATCH: 0, UNSUPPORTED: 0, UNAVAILABLE: 0 });
      assert.deepEqual(context.summary.interpretation, { COMPATIBLE: 1, AMBIGUOUS: 1, NOT_APPLICABLE: 0, UNAVAILABLE: 0 });
      assert.equal(typeof context.durationMs, 'number');
    });
  } finally {
    stub.restore();
  }
});

test('kana homograph stays MULTIPLE/AMBIGUOUS; unknown lemma is NO_MATCH', async () => {
  // Would fail if commonness elected 橋 UNIQUE, or if a completed empty
  // lookup were reported as anything but NO_MATCH.
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const hashi = await postAnalysis(base, { text: 'はし', lexical: { enabled: true }, context: { enabled: true } });
      assert.equal(hashi.status, 200);
      const item = itemByKey(hashi.body.lexical.context, 'noun::はし');
      assert.equal(item.dictionaryMatch.status, 'MULTIPLE');
      assert.equal(item.dictionaryMatch.entryCount, 3);
      assert.equal(item.dictionaryMatch.selectedEntryId, null);
      assert.equal(item.interpretation.status, 'AMBIGUOUS');
      const hon = await postAnalysis(base, { text: '学校と本', lexical: { enabled: true }, context: { enabled: true } });
      const honItem = itemByKey(hon.body.lexical.context, 'noun::本');
      assert.equal(honItem.dictionaryMatch.status, 'NO_MATCH');
      assert.equal(honItem.dictionaryMatch.reason, 'no-compatible-entry');
      assert.equal(honItem.interpretation.status, 'NOT_APPLICABLE');
      // Zero-match path carries the same actual provenance (same single Q1
      // round trip, no second pointer read) — fails against hardcoded labels.
      assert.deepEqual(hon.body.lexical.context.dictionary, { source: 'JMdict-Test', version: '9.9.9', fileDate: '2026-08-31', converter: 'fixture-converter', sourceId: '7' });
    });
  } finally {
    stub.restore();
  }
});

test('context without lexical: HTTP 200 with lexical-required, no lexical block', async () => {
  // Would fail if double opt-in collapsed into a 400 or silently enabled
  // the parser (request amplification against the lexical budget).
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行く。', context: { enabled: true } });
      assert.equal(status, 200);
      assert.ok(!('lexical' in body));
      assert.equal(body.context.status, 'unavailable');
      assert.equal(body.context.reason, 'lexical-required');
      assert.equal(body.context.retryable, false);
      assert.deepEqual(body.context.items, []);
    });
  } finally {
    stub.restore();
  }
});

test('reference absent: HTTP 200, lexical ok, context version-absent and non-retryable', async () => {
  // Would fail if a missing dictionary import 500'd or poisoned Kanji.
  const stub = installStub({ pin: 'absent' });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.kanji));
      assert.equal(body.lexical.status, 'ok');
      assert.equal(body.lexical.context.status, 'unavailable');
      assert.equal(body.lexical.context.reason, 'version-absent');
      assert.equal(body.lexical.context.retryable, false);
      assert.ok(body.lexical.context.warnings.includes('version-absent'));
    });
  } finally {
    stub.restore();
  }
});

test('reference Q1 failure: HTTP 200 with retryable query failure; Q2 failure degrades per item', async () => {
  // Would fail if a reference outage destroyed Kanji/lexical, or if a Q2
  // failure were misreported as NO_MATCH (unevaluated ≠ no match).
  const down = installStub({ pin: 'q1fail' });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.status, 'ok');
      assert.equal(body.lexical.context.status, 'unavailable');
      assert.equal(body.lexical.context.reason, 'reference-query-failed');
      assert.equal(body.lexical.context.retryable, true);
    });
  } finally {
    down.restore();
  }
  const q2down = installStub({ pin: 'q2fail' });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      assert.equal(status, 200);
      const context = body.lexical.context;
      assert.equal(context.status, 'partial');
      assert.equal(context.retryable, true);
      const gakkou = itemByKey(context, 'noun::学校');
      assert.equal(gakkou.dictionaryMatch.status, 'UNAVAILABLE');
      assert.equal(gakkou.interpretation.status, 'UNAVAILABLE');
      assert.equal(gakkou.interpretation.reason, 'sense-evaluation-failed');
    });
  } finally {
    q2down.restore();
  }
});

test('vocabulary matching outage does not take context down', async () => {
  // Would fail if the user-scoped matching failure path swallowed the
  // independent global reference resolution.
  const stub = installStub({ throwVocabulary: true });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.matching.available, false);
      assert.equal(body.lexical.context.status, 'ok');
      assert.equal(itemByKey(body.lexical.context, 'noun::学校').interpretation.status, 'COMPATIBLE');
    });
  } finally {
    stub.restore();
  }
});

test('context uses at most 3 reference queries per request', async () => {
  // Would fail on per-candidate/per-entry SQL inside the shared budget.
  const stub = installStub();
  try {
    await withServer(async (base) => {
      await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      assert.ok(stub.jmdictQueries().length <= 3, `saw ${stub.jmdictQueries().length} reference queries`);
    });
  } finally {
    stub.restore();
  }
});

test('wire carries no LIKELY, no confidence scores, and a bounded payload', async () => {
  // Would fail if the removed integer-confidence gate resurfaced anywhere —
  // scanned across UNIQUE, MULTIPLE, NO_MATCH and UNAVAILABLE responses, not
  // just the happy path (a MULTIPLE-only or UNAVAILABLE-only leak would
  // otherwise slip through).
  const stub = installStub();
  const wires = [];
  try {
    await withServer(async (base) => {
      const clean = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      wires.push(JSON.stringify(clean.body.lexical.context));
      const multi = await postAnalysis(base, { text: 'はし', lexical: { enabled: true }, context: { enabled: true } });
      wires.push(JSON.stringify(multi.body.lexical.context));
      assert.ok(Buffer.byteLength(JSON.stringify(clean.body), 'utf8') <= 1024 * 1024, 'whole response under body limit');
      assert.ok(Buffer.byteLength(wires[0], 'utf8') <= 100 * 1024, 'context block under 100 KB');
      assert.ok(!wires[0].includes('"doc"'), 'no entry docs on the wire');
      for (const item of clean.body.lexical.context.items) {
        assert.ok(['UNIQUE', 'MULTIPLE', 'NO_MATCH', 'UNSUPPORTED', 'UNAVAILABLE'].includes(item.dictionaryMatch.status));
        assert.ok(['COMPATIBLE', 'AMBIGUOUS', 'NOT_APPLICABLE', 'UNAVAILABLE'].includes(item.interpretation.status));
      }
    });
  } finally {
    stub.restore();
  }
  const q2down = installStub({ pin: 'q2fail' });
  try {
    await withServer(async (base) => {
      const failed = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      wires.push(JSON.stringify(failed.body.lexical.context));
    });
  } finally {
    q2down.restore();
  }
  for (const wire of wires) {
    assert.ok(!wire.includes('LIKELY'));
    assert.ok(!wire.toLowerCase().includes('likely'));
    assert.ok(!wire.includes('confidence'));
  }
});

test('unknown-token input yields an honest empty context, not an error', async () => {
  // Would fail if zero candidates crashed resolution or invented a pin.
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAnalysis(base, { text: 'ググった', lexical: { enabled: true }, context: { enabled: true } });
      assert.equal(status, 200);
      assert.equal(body.lexical.context.status, 'ok');
      assert.deepEqual(body.lexical.context.items, []);
      assert.equal(body.lexical.context.dictionary, null);
    });
  } finally {
    stub.restore();
  }
});

test('selectedEntryId exists only for UNIQUE across every status on the wire', async () => {
  // Would fail against the old MULTIPLE branch, which assigned the sole
  // visible survivor as selectedEntryId: CA-B3 must never read identity
  // from a non-UNIQUE match. (UNSUPPORTED is unreachable through this
  // endpoint — proper nouns travel in `unverified`, never in `candidates` —
  // so it is covered at the service layer instead; see context-unit.)
  const stub = installStub();
  const seen = { UNIQUE: 0, MULTIPLE: 0, NO_MATCH: 0, UNAVAILABLE: 0 };
  try {
    await withServer(async (base) => {
      const clean = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      const multi = await postAnalysis(base, { text: 'はし', lexical: { enabled: true }, context: { enabled: true } });
      const miss = await postAnalysis(base, { text: '学校と本', lexical: { enabled: true }, context: { enabled: true } });
      for (const body of [clean.body, multi.body, miss.body]) {
        for (const item of body.lexical.context.items) {
          seen[item.dictionaryMatch.status] += 1;
          if (item.dictionaryMatch.status === 'UNIQUE') {
            assert.ok(item.dictionaryMatch.selectedEntryId, `${item.key} UNIQUE keeps identity`);
          } else {
            assert.equal(item.dictionaryMatch.selectedEntryId, null, `${item.key} ${item.dictionaryMatch.status} must not elect identity`);
          }
        }
      }
    });
  } finally {
    stub.restore();
  }
  const q2down = installStub({ pin: 'q2fail' });
  try {
    await withServer(async (base) => {
      const { body } = await postAnalysis(base, { text: '学校に行く。', lexical: { enabled: true }, context: { enabled: true } });
      for (const item of body.lexical.context.items) {
        seen[item.dictionaryMatch.status] += 1;
        assert.equal(item.dictionaryMatch.selectedEntryId, null, `UNAVAILABLE ${item.key} must not elect identity`);
      }
    });
  } finally {
    q2down.restore();
  }
  assert.ok(seen.UNIQUE > 0 && seen.MULTIPLE > 0 && seen.NO_MATCH > 0 && seen.UNAVAILABLE > 0,
    `scan covered every wire-reachable status: ${JSON.stringify(seen)}`);
});
