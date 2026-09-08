// VAF-B API tests: POST /api/vocabulary/autofill + /autofill/entry.
// Transport-level stubs only (pool.execute): the REAL identity, reference,
// filters and response assembly all run. Auth via NODE_ENV=test +
// JLT_AUTH_BYPASS_FOR_TESTS; pool.getConnection throws to prove read-only
// (runtime pool only, SELECT-only, never allocate/activate/prune).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const TEST_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

const PIN = { source_id: '7', source_name: 'JMdict-Test', converter: 'fixture-converter', converter_version: '9.9.9', file_date: '2026-08-31' };
const NEUTRAL_HINT = 'No JMdict entry matches this exact text. You can still add it manually. Tip: type the dictionary form (e.g. 行く instead of 行った).';

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
    forms: [
      { surface: '橋', normalized: '橋', kind: 'keb', restr: [], is_common: 1, nokanji: 0 },
      { surface: 'はし', normalized: 'はし', kind: 'reb', restr: [], is_common: 1, nokanji: 0 }
    ],
    senses: [{ sense_no: 1, pos: ['n'], gloss_en: ['bridge'], stagk: [], stagr: [] }]
  },
  '3000002': {
    posSummary: ['n'], isCommon: 0,
    forms: [
      { surface: '箸', normalized: '箸', kind: 'keb', restr: [], is_common: 0, nokanji: 0 },
      { surface: 'はし', normalized: 'はし', kind: 'reb', restr: [], is_common: 0, nokanji: 0 }
    ],
    senses: [{ sense_no: 1, pos: ['n'], gloss_en: ['chopsticks'], stagk: [], stagr: [] }]
  },
  '3000003': {
    posSummary: ['n'], isCommon: 0,
    forms: [
      { surface: '端', normalized: '端', kind: 'keb', restr: [], is_common: 0, nokanji: 0 },
      { surface: 'はし', normalized: 'はし', kind: 'reb', restr: [], is_common: 0, nokanji: 0 }
    ],
    senses: [{ sense_no: 1, pos: ['n'], gloss_en: ['edge'], stagk: [], stagr: [] }]
  },
  '4000001': {
    posSummary: ['pn'], isCommon: 0,
    forms: [
      { surface: '田中', normalized: '田中', kind: 'keb', restr: [], is_common: 0, nokanji: 0 },
      { surface: 'たなか', normalized: 'たなか', kind: 'reb', restr: [], is_common: 0, nokanji: 0 }
    ],
    senses: [{ sense_no: 1, pos: ['pn'], gloss_en: ['Tanaka (surname)'], stagk: [], stagr: [] }]
  }
};

function q1Rows(params) {
  const rows = [];
  for (let offset = 0; offset + 2 < params.length + 1; offset += 3) {
    const [candidateIdx, normalized, kind] = [params[offset], params[offset + 1], params[offset + 2]];
    if (candidateIdx === undefined || normalized === undefined || kind === undefined) break;
    const matches = [];
    for (const [entryId, entry] of Object.entries(ENTRIES)) {
      for (const form of entry.forms) {
        if (form.normalized === normalized && form.kind === kind) matches.push({ entryId, form });
      }
    }
    matches.sort((a, b) => b.form.is_common - a.form.is_common || Number(a.entryId) - Number(b.entryId));
    const hits = matches.slice(0, 6);
    if (!hits.length) {
      rows.push({ ...PIN, candidate_idx: candidateIdx, key_normalized: normalized, key_kind: kind, entry_id: null, surface: null, form_normalized: null, form_kind: null, is_common: 0, nokanji: 0, restr: [] });
      continue;
    }
    for (const { entryId, form } of hits) {
      rows.push({ ...PIN, candidate_idx: candidateIdx, key_normalized: normalized, key_kind: kind, entry_id: entryId, surface: form.surface, form_normalized: form.normalized, form_kind: form.kind, is_common: form.is_common, nokanji: form.nokanji, restr: form.restr });
    }
  }
  return rows;
}

function installStub({ vocabularyFixture = {}, throwVocabulary = false, pin = 'ok' } = {}) {
  const pool = require('../src/config/db');
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const seen = [];
  let getConnectionCalls = 0;
  pool.execute = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM vocabulary WHERE user_id = \?/i.test(sql)) {
      if (throwVocabulary) throw new Error('vocabulary lookup down');
      const [userId, ...keys] = params;
      assert.equal(params[0], userId, 'user_id first bind');
      assert.ok(!/JOIN/i.test(sql), 'never JOIN vocabulary<->jmdict');
      const rows = (vocabularyFixture[userId] || []).filter((row) => keys.includes(
        /AND word IN/i.test(sql) ? row.word : row.reading
      ));
      return [rows];
    }
    if (/FROM jmdict_sources/i.test(sql)) {
      // Entry verification carries status; pin-meta is sha256 only.
      if (/status/i.test(sql)) {
        const wanted = String(params[0]);
        if (wanted !== PIN.source_id) return [[]];
        return [[{
          source_id: PIN.source_id,
          source_name: PIN.source_name,
          converter: PIN.converter,
          converter_version: PIN.converter_version,
          file_date: PIN.file_date,
          sha256_verified: 1,
          status: 'ready'
        }]];
      }
      return [[{ sha256_verified: 1 }]];
    }
    if (/jmdict_active_snapshot/i.test(sql)) {
      if (pin === 'q1fail') throw new Error('reference lookup down');
      if (pin === 'absent') return [[]];
      return [q1Rows(params)];
    }
    if (/jmdict_senses/i.test(sql)) {
      if (pin === 'q2fail') throw new Error('sense fetch down');
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
    throw new Error(`unexpected SQL in autofill API test: ${sql.slice(0, 80)}`);
  };
  pool.getConnection = async () => {
    getConnectionCalls += 1;
    throw new Error('no connections in autofill API test (read-only via pool.execute)');
  };
  return {
    seen,
    getConnectionCalls: () => getConnectionCalls,
    vocabularyQueries() { return seen.filter((e) => /FROM vocabulary/i.test(e.sql)); },
    jmdictQueries() { return seen.filter((e) => /jmdict_/i.test(e.sql)); },
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

async function postAutofill(base, body) {
  const res = await fetch(`${base}/api/vocabulary/autofill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function postEntry(base, body) {
  const res = await fetch(`${base}/api/vocabulary/autofill/entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test('学校 UNIQUE+COMPATIBLE prefills reading and meaning', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: '学校' });
      assert.equal(status, 200);
      assert.equal(body.word, '学校');
      assert.equal(body.dictionaryMatch.status, 'UNIQUE');
      assert.equal(body.dictionaryMatch.selectedEntryId, '1000001');
      assert.equal(body.interpretation.status, 'COMPATIBLE');
      assert.equal(body.fieldHints.reading.action, 'prefill');
      assert.equal(body.fieldHints.reading.value, 'がっこう');
      assert.equal(body.fieldHints.reading.provenance, 'dictionary');
      assert.equal(body.fieldHints.meaning.action, 'prefill');
      assert.equal(body.fieldHints.meaning.value, 'school');
      assert.ok(body.pin && body.pin.sourceId === '7');
      assert.ok(body.item);
      assert.equal(body.hint, null);
      assert.equal(stub.getConnectionCalls(), 0);
    });
  } finally {
    stub.restore();
  }
});

test('行く UNIQUE+AMBIGUOUS keeps reading but chooses meaning with full-gloss senseChoices', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: '行く' });
      assert.equal(status, 200);
      assert.equal(body.dictionaryMatch.status, 'UNIQUE');
      assert.equal(body.interpretation.status, 'AMBIGUOUS');
      assert.equal(body.fieldHints.reading.action, 'prefill');
      assert.equal(body.fieldHints.reading.value, 'いく');
      assert.equal(body.fieldHints.meaning.action, 'choose');
      assert.equal(body.fieldHints.meaning.value, '');
      assert.equal(body.fieldHints.meaning.senseChoices.length, 2);
      assert.deepEqual(body.fieldHints.meaning.senseChoices[0].glosses, ['to go']);
      assert.deepEqual(body.fieldHints.meaning.senseChoices[1].glosses, ['to proceed']);
    });
  } finally {
    stub.restore();
  }
});

test('はし MULTIPLE blanks reading and offers bounded entryChoices, never alternatives[0]', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: 'はし' });
      assert.equal(status, 200);
      assert.equal(body.dictionaryMatch.status, 'MULTIPLE');
      assert.equal(body.dictionaryMatch.selectedEntryId, null);
      assert.equal(body.fieldHints.reading.action, 'blank');
      assert.equal(body.fieldHints.reading.value, null);
      assert.equal(body.fieldHints.meaning.action, 'choose');
      assert.equal(body.fieldHints.meaning.value, '');
      assert.ok(Array.isArray(body.fieldHints.meaning.entryChoices));
      assert.equal(body.fieldHints.meaning.entryChoices.length, 3);
    });
  } finally {
    stub.restore();
  }
});

test('typed 行った is NO_MATCH with neutral hint and proves no deinflection', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: '行った' });
      assert.equal(status, 200);
      assert.equal(body.dictionaryMatch.status, 'NO_MATCH');
      assert.equal(body.interpretation.status, 'NOT_APPLICABLE');
      assert.equal(body.fieldHints.reading.action, 'blank');
      assert.equal(body.fieldHints.meaning.action, 'blank');
      assert.equal(body.hint, NEUTRAL_HINT);
      const q1 = stub.seen.find((e) => /jmdict_active_snapshot/i.test(e.sql));
      assert.ok(q1, 'Q1 ran');
      const strings = q1.params.filter((p) => typeof p === 'string');
      assert.ok(strings.includes('行った'), 'Q1 keys contain the typed inflected form');
      assert.ok(!strings.includes('行く'), 'Q1 keys never contain the deinflected dictionary form');
    });
  } finally {
    stub.restore();
  }
});

test('proper-noun typed word gets ordinary exact lookup, never UNSUPPORTED', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: '田中' });
      assert.equal(status, 200);
      assert.notEqual(body.dictionaryMatch.status, 'UNSUPPORTED');
      assert.equal(body.dictionaryMatch.status, 'UNIQUE');
    });
  } finally {
    stub.restore();
  }
});

test('no snapshot degrades to UNAVAILABLE blanks, retryable false, pin null', async () => {
  const stub = installStub({ pin: 'absent' });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: '学校' });
      assert.equal(status, 200);
      assert.equal(body.dictionaryMatch.status, 'UNAVAILABLE');
      assert.equal(body.retryable, false);
      assert.equal(body.pin, null);
      assert.equal(body.fieldHints.reading.action, 'blank');
      assert.equal(body.fieldHints.meaning.action, 'blank');
    });
  } finally {
    stub.restore();
  }
});

test('transient Q1 failure degrades to UNAVAILABLE retryable true', async () => {
  const stub = installStub({ pin: 'q1fail' });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: '学校' });
      assert.equal(status, 200);
      assert.equal(body.dictionaryMatch.status, 'UNAVAILABLE');
      assert.equal(body.retryable, true);
      assert.equal(body.pin, null);
    });
  } finally {
    stub.restore();
  }
});

test('transient Q2 failure degrades to UNAVAILABLE retryable true with pin', async () => {
  const stub = installStub({ pin: 'q2fail' });
  try {
    await withServer(async (base) => {
      const { status, body } = await postAutofill(base, { word: '学校' });
      assert.equal(status, 200);
      assert.equal(body.dictionaryMatch.status, 'UNAVAILABLE');
      assert.equal(body.interpretation.status, 'UNAVAILABLE');
      assert.equal(body.retryable, true);
      assert.ok(body.pin && body.pin.sourceId === '7');
    });
  } finally {
    stub.restore();
  }
});

test('ownership exact maps to existing', async () => {
  const stub = installStub({ vocabularyFixture: { [TEST_USER]: [{ word: '学校', reading: 'がっこう' }] } });
  try {
    await withServer(async (base) => {
      const { body } = await postAutofill(base, { word: '学校' });
      assert.equal(body.ownership.state, 'existing');
      assert.equal(body.ownership.matches[0].word, '学校');
    });
  } finally {
    stub.restore();
  }
});

test('ownership reading-correlated maps to possible-match', async () => {
  const stub = installStub({ vocabularyFixture: { [TEST_USER]: [{ word: '他校', reading: 'がっこう' }] } });
  try {
    await withServer(async (base) => {
      const { body } = await postAutofill(base, { word: '学校' });
      assert.equal(body.ownership.state, 'possible-match');
      assert.ok(body.ownership.matches.length >= 1);
    });
  } finally {
    stub.restore();
  }
});

test('ownership clean miss maps to new', async () => {
  const stub = installStub({});
  try {
    await withServer(async (base) => {
      const { body } = await postAutofill(base, { word: '学校' });
      assert.equal(body.ownership.state, 'new');
      assert.deepEqual(body.ownership.matches, []);
    });
  } finally {
    stub.restore();
  }
});

test('ownership lookup throw maps to unavailable, never new', async () => {
  const stub = installStub({ throwVocabulary: true });
  try {
    await withServer(async (base) => {
      const { body } = await postAutofill(base, { word: '学校' });
      assert.equal(body.ownership.state, 'unavailable');
      assert.equal(body.dictionaryMatch.status, 'UNIQUE', 'dictionary survives vocabulary outage');
    });
  } finally {
    stub.restore();
  }
});

test('includeOwnership=false skips vocabulary queries entirely', async () => {
  const stub = installStub({});
  try {
    await withServer(async (base) => {
      const { body } = await postAutofill(base, { word: '学校', includeOwnership: false });
      assert.equal(body.ownership, null);
      assert.equal(stub.vocabularyQueries().length, 0);
    });
  } finally {
    stub.restore();
  }
});

test('entry drill returns ok with diet entry and full glosses under pin', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postEntry(base, { sourceId: 7, entryId: 1000001 });
      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
      assert.equal(body.pin.sourceId, '7');
      assert.equal(body.entry.entryId, '1000001');
      assert.deepEqual(body.senses[0].glosses, ['school']);
      assert.equal(body.nextCursor, null);
      assert.equal(body.truncated, false);
      assert.equal(stub.getConnectionCalls(), 0);
      for (const q of stub.seen) {
        assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|TRUNCATE)\b/i.test(q.sql), 'SELECT-only');
      }
      assert.equal(stub.seen.filter((e) => /jmdict_active_snapshot/i.test(e.sql)).length, 0, 'entry never re-reads the active pointer');
    });
  } finally {
    stub.restore();
  }
});

test('entry overflow snapshot-unavailable returns 200 unavailable payload', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status, body } = await postEntry(base, { sourceId: 9999, entryId: 1000001 });
      assert.equal(status, 200);
      assert.equal(body.status, 'unavailable');
      assert.equal(body.reason, 'snapshot-unavailable');
      assert.equal(body.retryable, false);
    });
  } finally {
    stub.restore();
  }
});

test('entry malformed ids return 400', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      for (const bad of [
        { sourceId: 0, entryId: 1 },
        { sourceId: 'abc', entryId: 1 },
        { sourceId: 7, entryId: -5 },
        { sourceId: 7, entryId: 1.5 },
        { sourceId: 7, entryId: 1, senseCursor: 65 },
        { sourceId: 7, entryId: 1, senseCursor: -1 }
      ]) {
        const { status } = await postEntry(base, bad);
        assert.equal(status, 400, JSON.stringify(bad));
      }
    });
  } finally {
    stub.restore();
  }
});

test('entry well-formed but absent under pin returns 404', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      const { status } = await postEntry(base, { sourceId: 7, entryId: 9999999 });
      assert.equal(status, 404);
    });
  } finally {
    stub.restore();
  }
});

test('autofill validation errors are 400, never fake 200', async () => {
  const stub = installStub();
  try {
    await withServer(async (base) => {
      for (const bad of [{}, { word: '' }, { word: '   ' }, { word: 'a'.repeat(101) }, { word: 123 }]) {
        const { status } = await postAutofill(base, bad);
        assert.equal(status, 400, JSON.stringify(bad).slice(0, 40));
      }
    });
  } finally {
    stub.restore();
  }
});

test('multi-user isolation: A-word invisible to B', async () => {
  const stub = installStub({ vocabularyFixture: { [TEST_USER]: [{ word: '学校', reading: 'がっこう' }] } });
  const saved = process.env.JLT_TEST_USER_ID;
  try {
    await withServer(async (base) => {
      process.env.JLT_TEST_USER_ID = TEST_USER;
      const asA = await postAutofill(base, { word: '学校' });
      assert.equal(asA.body.ownership.state, 'existing');
      process.env.JLT_TEST_USER_ID = OTHER_USER;
      const asB = await postAutofill(base, { word: '学校' });
      assert.equal(asB.body.ownership.state, 'new');
    });
  } finally {
    if (saved === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = saved;
    stub.restore();
  }
});

test('unauthenticated autofill is real 401', async () => {
  const stub = installStub();
  const savedNode = process.env.NODE_ENV;
  const savedBypass = process.env.JLT_AUTH_BYPASS_FOR_TESTS;
  process.env.NODE_ENV = 'production';
  process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'false';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/vocabulary/autofill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: '学校' })
      });
      assert.equal(res.status, 401);
    });
  } finally {
    process.env.NODE_ENV = savedNode;
    process.env.JLT_AUTH_BYPASS_FOR_TESTS = savedBypass;
    stub.restore();
  }
});
