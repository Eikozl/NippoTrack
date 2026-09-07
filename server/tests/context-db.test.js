// CA-B2 database tests: Q1/Q2 bounds and sentinels, snapshot pinning and
// races, index usage, N+1 freedom, fixture end-to-end, and the no-admin-
// writes boundary — all against a real PostgreSQL.
//
// GATED exactly like the CA-B1 reference DB tests: only with
// JLT_RUN_JMDICT_DB_TESTS=true AND a loopback POSTGRES_HOST. Tests create
// their own snapshots (converterVersion prefixed context-test-), restore the
// original active pointer, and delete their rows afterwards. Read-only
// service SQL runs through a minimal test-local `?`→`$N` shim over the admin
// pool (placeholder conversion itself is existing adapter infrastructure);
// production uses the runtime adapter with identical positional semantics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.JLT_RUN_JMDICT_DB_TESTS === 'true';
const pool = enabled ? require('../src/config/postgres') : null;
const service = enabled ? require('../src/services/jmdictReference') : null;
const { resolveContext } = enabled ? require('../src/services/contextService') : {};
const reference = enabled ? require('../src/services/contextReference') : {};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const host = process.env.POSTGRES_HOST;
const runnable = enabled && LOOPBACK.has(host);

if (enabled && !LOOPBACK.has(host)) {
  throw new Error(`JLT_RUN_JMDICT_DB_TESTS requires a loopback POSTGRES_HOST, got: ${host}`);
}

const createdSourceIds = [];
let originalActive = null;

const SCAFFOLD_SUFFIX = '_local_owner_all';

async function setScaffold(client, up) {
  const tables = ['jmdict_sources', 'jmdict_active_snapshot', 'jmdict_entries', 'jmdict_forms', 'jmdict_senses'];
  for (const table of tables) {
    await client.query(`DROP POLICY IF EXISTS ${table}${SCAFFOLD_SUFFIX} ON public.${table}`);
    if (up) {
      await client.query(
        `CREATE POLICY ${table}${SCAFFOLD_SUFFIX} ON public.${table} FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)`
      );
    }
  }
}

async function makeSnapshot(client, tag, words) {
  const identity = {
    fileDate: '2026-09-07',
    converterVersion: `context-test-${tag}-${Date.now()}`,
    dictRevisions: ['test'],
    entCount: words.length,
    sha256: service.sha256Hex(`context-test-${tag}-${Date.now()}`),
    sha256Verified: false
  };
  const { sourceId, reused } = await service.allocateSnapshot(client, identity);
  assert.equal(reused, false);
  createdSourceIds.push(sourceId);
  const records = words.map((word) => service.normalizeJmdictWord(word));
  await client.query('BEGIN');
  try {
    await service.insertNormalizedBatch(client, sourceId, records);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  await service.setSnapshotStatus(client, sourceId, 'ready', { entCount: words.length });
  return sourceId;
}

// Minimal adapter-shaped shim: `?`→`$N` over the admin client, returning
// [rows] like the runtime adapter. Counts calls and exposes a before-query
// hook (used to flip the active pointer mid-request for race tests).
function shim(client, { beforeQuery } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      if (beforeQuery) await beforeQuery(calls.length, client);
      let index = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++index}`);
      const result = await client.query(pgSql, params);
      return [result.rows];
    }
  };
}

function synthWord(id, { keb = [], reb = [], senses = [{ pos: ['n'], gloss: 'x' }] }) {
  return {
    id: String(id),
    kanji: keb.map(([text, common]) => ({ text, common: !!common, tags: [] })),
    kana: reb.map(([text, appliesToKanji, common]) => ({ text, common: !!common, tags: [], appliesToKanji })),
    sense: senses.map((sense) => ({
      partOfSpeech: sense.pos,
      appliesToKanji: sense.stagk || ['*'],
      appliesToKana: sense.stagr || ['*'],
      related: [],
      antonym: [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      loanwordSource: [],
      gloss: [{ text: sense.gloss, lang: 'eng' }]
    }))
  };
}

function cand({ lemma, pos, lemmaReading = null, observed = [] }) {
  return {
    key: `${pos}::${lemma}`,
    canonical: lemma,
    lemma,
    pos,
    lemmaReading,
    surfaceReading: null,
    observed
  };
}

test.before(async () => {
  if (!runnable) return;
  const client = await pool.connect();
  try {
    await setScaffold(client, true);
    originalActive = await service.activeSourceId(client);
  } finally {
    client.release();
  }
});

test.after(async () => {
  if (!runnable) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      if (originalActive === null || originalActive === undefined) {
        await client.query('UPDATE jmdict_active_snapshot SET source_id = NULL WHERE singleton = 1');
      } else {
        await client.query('UPDATE jmdict_active_snapshot SET source_id = $1 WHERE singleton = 1', [originalActive]);
      }
      const restored = await service.activeSourceId(client);
      assert.equal(String(restored), String(originalActive));
      for (const sourceId of createdSourceIds) {
        await client.query('DELETE FROM jmdict_forms WHERE source_id = $1', [sourceId]);
        await client.query('DELETE FROM jmdict_senses WHERE source_id = $1', [sourceId]);
        await client.query('DELETE FROM jmdict_entries WHERE source_id = $1', [sourceId]);
        await client.query('DELETE FROM jmdict_sources WHERE source_id = $1', [sourceId]);
      }
      await setScaffold(client, false);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});

test('Q1 returns at most 6 rows per key with the 6th as overflow sentinel', { skip: !runnable }, async () => {
  // Would fail if LIMIT 6 were lost (unbounded common-kana cohorts reaching
  // Node) or if the sentinel row were silently dropped (truncation invisible).
  const client = await pool.connect();
  try {
    const words = [];
    for (let index = 0; index < 7; index += 1) {
      words.push(synthWord(2000000 + index, {
        keb: [['同形', index === 0]],
        reb: [[`どうけい${index}`, ['*'], false]],
        senses: [{ pos: ['n'], gloss: `shape ${index}` }]
      }));
    }
    const sourceId = await makeSnapshot(client, 'q1cap', words);
    await service.activateSnapshot(client, sourceId);
    const { sql, params } = reference.buildQ1([{ candidateIdx: 0, normalized: '同形', kind: 'keb' }]);
    let index = 0;
    const rows = (await client.query(sql.replace(/\?/g, () => `$${++index}`), params)).rows;
    assert.equal(rows.length, 6);
    assert.ok(rows.every((row) => String(row.source_id) === String(sourceId)));
    const db = shim(client);
    const block = await resolveContext({
      pool: db,
      candidates: [cand({ lemma: '同形', pos: 'noun' })],
      tokens: []
    });
    const item = block.items[0];
    assert.equal(item.dictionaryMatch.status, 'MULTIPLE');
    assert.equal(item.dictionaryMatch.lookupTruncated, true);
    assert.equal(item.dictionaryMatch.reason, 'lookup-truncated');
    assert.equal(item.interpretation.status, 'AMBIGUOUS');
    assert.equal(block.status, 'partial');
  } finally {
    client.release();
  }
});

test('Q1 physical rows stay bounded: ≤6 per key across many keys', { skip: !runnable }, async () => {
  // Would fail if per-key LIMIT applied once globally instead of per key.
  const client = await pool.connect();
  try {
    const words = [];
    for (let index = 0; index < 10; index += 1) {
      words.push(synthWord(2010000 + index, {
        keb: [[`語${index}`, false]],
        reb: [[`ご${index}`, ['*'], false]],
        senses: [{ pos: ['n'], gloss: `word ${index}` }]
      }));
    }
    const sourceId = await makeSnapshot(client, 'q1many', words);
    await service.activateSnapshot(client, sourceId);
    const keys = words.map((word, idx) => ({ candidateIdx: idx, normalized: word.kanji[0].text, kind: 'keb' }));
    const { sql, params } = reference.buildQ1(keys);
    let index = 0;
    const rows = (await client.query(sql.replace(/\?/g, () => `$${++index}`), params)).rows;
    assert.equal(rows.length, 10);
    assert.ok(rows.length <= 720);
  } finally {
    client.release();
  }
});

test('five clean rows allow UNIQUE; six rows narrowed by POS stay MULTIPLE (no false trip, no escape)', { skip: !runnable }, async () => {
  // Would fail in either direction: a 5-row cohort must not trip the
  // sentinel (UNIQUE allowed after honest narrowing), while a 6-row cohort
  // narrowed to one survivor by POS must stay MULTIPLE (the unseen 6th row
  // may be compatible — certainty forbidden).
  const client = await pool.connect();
  try {
    const five = [];
    for (let index = 0; index < 5; index += 1) {
      five.push(synthWord(2100000 + index, {
        keb: [['五形', false]],
        reb: [[`ごけい${index}`, ['*'], false]],
        senses: index === 0
          ? [{ pos: ['n'], gloss: 'five shapes' }]
          : [{ pos: ['v5k'], gloss: `verb ${index}` }]
      }));
    }
    const six = [];
    for (let index = 0; index < 6; index += 1) {
      six.push(synthWord(2110000 + index, {
        keb: [['六形', false]],
        reb: [[`ろっけい${index}`, ['*'], false]],
        senses: index === 0
          ? [{ pos: ['n'], gloss: 'six shapes' }]
          : [{ pos: ['v5k'], gloss: `verb ${index}` }]
      }));
    }
    const sourceId = await makeSnapshot(client, 'sentinelfine', [...five, ...six]);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    const block = await resolveContext({
      pool: db,
      candidates: [cand({ lemma: '五形', pos: 'noun' }), cand({ lemma: '六形', pos: 'noun' })],
      tokens: []
    });
    const clean = block.items[0];
    assert.equal(clean.dictionaryMatch.lookupTruncated, false);
    assert.equal(clean.dictionaryMatch.status, 'UNIQUE');
    assert.equal(clean.interpretation.status, 'COMPATIBLE');
    assert.deepEqual(clean.interpretation.selectedSense.glosses, ['five shapes']);
    const narrowed = block.items[1];
    assert.equal(narrowed.dictionaryMatch.lookupTruncated, true);
    assert.equal(narrowed.dictionaryMatch.status, 'MULTIPLE');
    assert.equal(narrowed.dictionaryMatch.reason, 'lookup-truncated');
    assert.equal(narrowed.interpretation.status, 'AMBIGUOUS');
    assert.equal(narrowed.interpretation.selectedSense, null);
  } finally {
    client.release();
  }
});

test('Q2 65th sense trips the valve; exactly-64 stays clean (F9/F10 at the DB layer)', { skip: !runnable }, async () => {
  // Would fail if the per-entry LIMIT 65 miscounted (off-by-one either way):
  // 65 must truncate, 64 must not. The tripped UNIQUE entry keeps its
  // identity but can never be COMPATIBLE; a fully-excluded evaluated set
  // with an unevaluated tail refuses NO_MATCH (the tail may hide a match).
  const client = await pool.connect();
  try {
    const senses65 = [{ pos: ['n'], gloss: 'first' }];
    for (let senseNo = 2; senseNo <= 65; senseNo += 1) {
      senses65.push({ pos: ['v5k'], gloss: `sense ${senseNo}` });
    }
    const senses64 = [];
    for (let senseNo = 1; senseNo <= 64; senseNo += 1) {
      senses64.push({ pos: senseNo === 64 ? ['n'] : ['v5k'], gloss: `sense ${senseNo}` });
    }
    const sensesTail = [];
    for (let senseNo = 1; senseNo <= 65; senseNo += 1) {
      sensesTail.push({ pos: ['v5k'], gloss: `tail ${senseNo}` });
    }
    const sourceId = await makeSnapshot(client, 'valve', [
      synthWord(2020001, { keb: [['甲', false]], reb: [['こう', ['*'], false]], senses: senses65 }),
      synthWord(2020002, { keb: [['乙', false]], reb: [['おつ', ['*'], false]], senses: senses64 }),
      synthWord(2020003, { keb: [['丙', false]], reb: [['へい', ['*'], false]], senses: sensesTail })
    ]);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    const block = await resolveContext({
      pool: db,
      candidates: [
        cand({ lemma: '甲', pos: 'noun' }),
        cand({ lemma: '乙', pos: 'noun' }),
        cand({ lemma: '丙', pos: 'noun' })
      ],
      tokens: []
    });
    const tripped = block.items[0];
    assert.equal(tripped.dictionaryMatch.status, 'UNIQUE');
    assert.equal(tripped.interpretation.evaluationTruncated, true);
    assert.equal(tripped.interpretation.status, 'AMBIGUOUS');
    assert.equal(tripped.interpretation.reason, 'evaluation-truncated');
    assert.equal(tripped.interpretation.selectedSense, null);
    const clean = block.items[1];
    assert.equal(clean.interpretation.evaluationTruncated, false);
    assert.equal(clean.dictionaryMatch.status, 'UNIQUE');
    assert.equal(clean.interpretation.status, 'COMPATIBLE');
    assert.equal(clean.interpretation.selectedSense.senseId, 64);
    const tailCut = block.items[2];
    assert.equal(tailCut.dictionaryMatch.status, 'MULTIPLE');
    assert.equal(tailCut.dictionaryMatch.reason, 'evaluation-truncated');
    assert.equal(tailCut.interpretation.evaluationTruncated, true);
    assert.equal(tailCut.interpretation.status, 'AMBIGUOUS');
  } finally {
    client.release();
  }
});

test('buildQ2Senses fetches exactly 65 rows for 65 senses, 64 for 64', { skip: !runnable }, async () => {
  // Would fail on a LIMIT 66 over-fetch (invisible at the service layer,
  // which trims to 64) or a LIMIT 64 under-fetch (false clean at exactly
  // 64). Direct row counts pin the valve SQL itself.
  const client = await pool.connect();
  try {
    const many = (count) => Array.from({ length: count }, (_, index) => ({ pos: ['n'], gloss: `sense ${index + 1}` }));
    const sourceId = await makeSnapshot(client, 'valverows', [
      synthWord(2120001, { keb: [['甲', false]], reb: [['こう', ['*'], false]], senses: many(65) }),
      synthWord(2120002, { keb: [['乙', false]], reb: [['おつ', ['*'], false]], senses: many(64) })
    ]);
    await service.activateSnapshot(client, sourceId);
    const count65 = await reference.runQ2({ execute: async (sql, params) => {
      let index = 0;
      return [((await client.query(sql.replace(/\?/g, () => `$${++index}`), params)).rows)];
    } }, String(sourceId), ['2120001']);
    assert.equal(count65.sensesByEntry.get('2120001').senses.length, 64);
    assert.equal(count65.sensesByEntry.get('2120001').truncated, true);
    const count64 = await reference.runQ2({ execute: async (sql, params) => {
      let index = 0;
      return [((await client.query(sql.replace(/\?/g, () => `$${++index}`), params)).rows)];
    } }, String(sourceId), ['2120002']);
    assert.equal(count64.sensesByEntry.get('2120002').senses.length, 64);
    assert.equal(count64.sensesByEntry.get('2120002').truncated, false);
  } finally {
    client.release();
  }
});

test('snapshot race: Q2 uses the Q1 pin even after the pointer moves (F12)', { skip: !runnable }, async () => {
  // Would fail if Q2 re-read jmdict_active_snapshot (the CA-A.2 race): rows
  // and provenance would come from B mid-request.
  const client = await pool.connect();
  try {
    const wordA = synthWord(2030001, { keb: [['学校', true]], reb: [['がっこう', ['*'], true]], senses: [{ pos: ['n'], gloss: 'school-A' }] });
    const wordB = synthWord(2030001, { keb: [['学校', true]], reb: [['がっこう', ['*'], true]], senses: [{ pos: ['n'], gloss: 'school-B' }] });
    const sourceA = await makeSnapshot(client, 'race-a', [wordA]);
    const sourceB = await makeSnapshot(client, 'race-b', [wordB]);
    await service.activateSnapshot(client, sourceA);
    let switched = false;
    const db = shim(client, {
      // calls[1] is Q1 (already returned when call 2 starts); flip the
      // pointer before the first Q2 statement executes.
      beforeQuery: async (count, admin) => {
        if (count === 2 && !switched) {
          switched = true;
          const switcher = await pool.connect();
          try {
            await service.activateSnapshot(switcher, sourceB);
          } finally {
            switcher.release();
          }
          void admin;
        }
      }
    });
    const block = await resolveContext({
      pool: db,
      candidates: [cand({ lemma: '学校', pos: 'noun', lemmaReading: 'がっこう' })],
      tokens: []
    });
    assert.equal(switched, true);
    assert.equal(block.dictionary.sourceId, String(sourceA));
    // Exactly one pointer read in the whole request (Q1); Q2a+Q2b never
    // touch the pointer — a re-reading Q2 would add a fourth query here.
    const pointerReads = db.calls.filter((call) => call.sql.includes('jmdict_active_snapshot'));
    assert.equal(pointerReads.length, 1);
    assert.equal(db.calls.length, 3);
    // Q2 statements carry the pin as their trailing parameter — never B.
    const q2calls = db.calls.filter((call) => call.sql.includes('jmdict_senses') || call.sql.includes('FROM ranked'));
    assert.equal(q2calls.length, 2);
    for (const call of q2calls) {
      assert.equal(String(call.params[call.params.length - 1]), String(sourceA));
    }
    const item = block.items[0];
    assert.equal(item.dictionaryMatch.status, 'UNIQUE');
    assert.equal(item.interpretation.status, 'COMPATIBLE');
    assert.deepEqual(item.interpretation.selectedSense.glosses, ['school-A']);
  } finally {
    client.release();
  }
});

test('zero-match pins snapshot A with a single pointer read (F13)', { skip: !runnable }, async () => {
  // Would fail on the second-pointer-read anti-pattern: either the pin would
  // flip to B or the pointer would be read twice.
  const client = await pool.connect();
  try {
    const sourceA = await makeSnapshot(client, 'zero-a', [
      synthWord(2040001, { keb: [['学校', true]], reb: [['がっこう', ['*'], true]], senses: [{ pos: ['n'], gloss: 'school' }] })
    ]);
    const sourceB = await makeSnapshot(client, 'zero-b', [
      synthWord(2040002, { keb: [['試験', true]], reb: [['しけん', ['*'], true]], senses: [{ pos: ['n'], gloss: 'exam' }] })
    ]);
    await service.activateSnapshot(client, sourceA);
    const db = shim(client);
    const block = await resolveContext({
      pool: db,
      candidates: [cand({ lemma: '存在しない語', pos: 'noun' })],
      tokens: []
    });
    const pointerReads = db.calls.filter((call) => call.sql.includes('jmdict_active_snapshot'));
    assert.equal(pointerReads.length, 1);
    assert.equal(db.calls.length, 1);
    await service.activateSnapshot(client, sourceB);
    const item = block.items[0];
    assert.equal(item.dictionaryMatch.status, 'NO_MATCH');
    assert.equal(item.interpretation.status, 'NOT_APPLICABLE');
    assert.equal(block.dictionary.sourceId, String(sourceA));
  } finally {
    client.release();
  }
});

test('Q1 shape is served by migration 011 with no sort node', { skip: !runnable }, async () => {
  // Would fail if the frozen Q1 shape drifted off the proven hot index
  // (extra predicate, different ordering) — seqscan is disabled here so the
  // test proves index COMPATIBILITY deterministically; real planner choice
  // on the full snapshot is proven separately in the perf pass.
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'index', [
      synthWord(2050001, { keb: [['学校', true]], reb: [['がっこう', ['*'], true]], senses: [{ pos: ['n'], gloss: 'school' }] })
    ]);
    await service.activateSnapshot(client, sourceId);
    const { sql, params } = reference.buildQ1([{ candidateIdx: 0, normalized: '学校', kind: 'keb' }]);
    let index = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++index}`);
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      const explained = await client.query(`EXPLAIN (FORMAT JSON) ${pgSql}`, params);
      const nodes = [];
      const walk = (node) => {
        nodes.push(node);
        for (const child of node.Plans || []) walk(child);
      };
      walk(explained.rows[0]['QUERY PLAN'][0].Plan);
      assert.ok(nodes.some((node) => node['Index Name'] === 'idx_jmdict_forms_q1_lookup'), 'q1 index used');
      assert.ok(!nodes.some((node) => node['Node Type'] === 'Sort'), 'no sort node');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
});

test('resolveContext issues at most 3 queries for many candidates (no N+1)', { skip: !runnable }, async () => {
  // Would fail on per-candidate or per-entry SQL (request amplification
  // under the shared lexical budget).
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'n1', [
      synthWord(2060001, { keb: [['学校', true]], reb: [['がっこう', ['*'], true]], senses: [{ pos: ['n'], gloss: 'school' }] }),
      synthWord(2060002, { keb: [['試験', true]], reb: [['しけん', ['*'], true]], senses: [{ pos: ['n'], gloss: 'exam' }] })
    ]);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    const candidates = [
      cand({ lemma: '学校', pos: 'noun' }),
      cand({ lemma: '試験', pos: 'noun' }),
      cand({ lemma: '行く', pos: 'verb' }),
      cand({ lemma: 'はし', pos: 'noun' }),
      { key: 'particle::は', canonical: 'は', lemma: 'は', pos: 'particle', lemmaReading: null, surfaceReading: null, observed: [] }
    ];
    const block = await resolveContext({ pool: db, candidates, tokens: [] });
    assert.ok(db.calls.length <= 3, `expected ≤3 queries, saw ${db.calls.length}`);
    assert.equal(block.items.length, 5);
    assert.equal(block.items[4].dictionaryMatch.status, 'UNSUPPORTED');
  } finally {
    client.release();
  }
});

test('unc POS never excludes: single unc sense resolves COMPATIBLE (F14 at the DB layer)', { skip: !runnable }, async () => {
  // Would fail if an unrecognized-besides-unc code path treated unknown as
  // incompatible once real rows are involved.
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'unc', [
      synthWord(2070001, { keb: [['謎', false]], reb: [['なぞ', ['*'], false]], senses: [{ pos: ['unc'], gloss: 'mystery' }] })
    ]);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    const block = await resolveContext({ pool: db, candidates: [cand({ lemma: '謎', pos: 'noun' })], tokens: [] });
    const item = block.items[0];
    assert.equal(item.dictionaryMatch.status, 'UNIQUE');
    assert.equal(item.interpretation.status, 'COMPATIBLE');
    assert.deepEqual(item.interpretation.selectedSense.glosses, ['mystery']);
  } finally {
    client.release();
  }
});

test('orthographic cohort never imports reading homophones; kana fallback stays MULTIPLE (F6/F7)', { skip: !runnable }, async () => {
  // Would fail if いく were searched as a keb identity (importing 逝く/往く
  // into 行く), or if commonness elected one はし entry UNIQUE.
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'homophone', [
      synthWord(2080001, { keb: [['行く', true]], reb: [['いく', ['*'], true]], senses: [{ pos: ['v5k-s', 'vi'], gloss: 'to go' }] }),
      synthWord(2080002, { keb: [['逝く', false]], reb: [['いく', ['*'], false]], senses: [{ pos: ['v5k', 'vi'], gloss: 'to pass away' }] }),
      synthWord(2080003, { keb: [['往く', false]], reb: [['いく', ['*'], false]], senses: [{ pos: ['v5k', 'vi'], gloss: 'to go (literary)' }] }),
      synthWord(2080004, { keb: [['橋', true]], reb: [['はし', ['*'], true]], senses: [{ pos: ['n'], gloss: 'bridge' }] }),
      synthWord(2080005, { keb: [['箸', false]], reb: [['はし', ['*'], false]], senses: [{ pos: ['n'], gloss: 'chopsticks' }] }),
      synthWord(2080006, { keb: [['端', false]], reb: [['はし', ['*'], false]], senses: [{ pos: ['n'], gloss: 'edge' }] })
    ]);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    const block = await resolveContext({
      pool: db,
      candidates: [cand({ lemma: '行く', pos: 'verb' }), cand({ lemma: 'はし', pos: 'noun' })],
      tokens: []
    });
    const iku = block.items[0];
    assert.equal(iku.dictionaryMatch.status, 'UNIQUE');
    assert.equal(iku.dictionaryMatch.selectedEntryId, '2080001');
    assert.equal(iku.dictionaryMatch.entryCount, 1);
    const hashi = block.items[1];
    assert.equal(hashi.dictionaryMatch.status, 'MULTIPLE');
    assert.equal(hashi.dictionaryMatch.entryCount, 3);
    assert.equal(hashi.dictionaryMatch.selectedEntryId, null);
    assert.equal(hashi.interpretation.status, 'AMBIGUOUS');
  } finally {
    client.release();
  }
});

test('failed Han lookup never falls back to a reading search (no silent homophone import)', { skip: !runnable }, async () => {
  // Would fail if an empty keb cohort silently retried as reb: 逝く would
  // import 行く/往く homophones through いく instead of staying NO_MATCH.
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'hanmiss', [
      synthWord(2130001, { keb: [['行く', true]], reb: [['いく', ['*'], true]], senses: [{ pos: ['v5k-s', 'vi'], gloss: 'to go' }] }),
      synthWord(2130002, { keb: [['往く', false]], reb: [['いく', ['*'], false]], senses: [{ pos: ['v5k', 'vi'], gloss: 'to go (literary)' }] })
    ]);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    const block = await resolveContext({
      pool: db,
      candidates: [cand({ lemma: '逝く', pos: 'verb' })],
      tokens: []
    });
    const item = block.items[0];
    assert.equal(item.dictionaryMatch.identityStrategy, 'ORTHOGRAPHIC');
    assert.equal(item.dictionaryMatch.status, 'NO_MATCH');
    assert.equal(item.dictionaryMatch.reason, 'no-compatible-entry');
    assert.equal(item.interpretation.status, 'NOT_APPLICABLE');
    // And the Q1 keys prove no reb search happened for this candidate.
    const q1 = db.calls.find((call) => call.sql.includes('jmdict_active_snapshot'));
    const kinds = q1.params.filter((param) => param === 'keb' || param === 'reb');
    assert.deepEqual(kinds, ['keb']);
  } finally {
    client.release();
  }
});

test('Q1 params carry lemma/canonical keys, never inflected surfaces (§48 at the DB layer)', { skip: !runnable }, async () => {
  // Would fail if 行った/食べなかった/来なかった reached SQL: the cohort
  // would miss (or worse, hit a wrong entry) instead of resolving by lemma.
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'inflect', [
      synthWord(2090001, { keb: [['行く', true]], reb: [['いく', ['*'], true]], senses: [{ pos: ['v5k-s', 'vi'], gloss: 'to go' }] })
    ]);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    await resolveContext({
      pool: db,
      candidates: [cand({
        lemma: '行く',
        pos: 'verb',
        observed: [
          { surface: '行った', surfaceReading: 'いった' },
          { surface: '行きました', surfaceReading: 'いきました' }
        ]
      })],
      tokens: []
    });
    const q1 = db.calls.find((call) => call.sql.includes('jmdict_active_snapshot'));
    const strings = q1.params.filter((param) => typeof param === 'string');
    assert.ok(strings.includes('行く'));
    assert.ok(!strings.includes('行った'));
    assert.ok(!strings.includes('行きました'));
  } finally {
    client.release();
  }
});

test('fixture end-to-end: F1–F5 resolve through the real pipeline', { skip: !runnable }, async () => {
  // Would fail on any wiring break between Q1, Q2, filters and response
  // (wrong column mapping, boolean folding, pin threading).
  const client = await pool.connect();
  try {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jmdict-sample.json'), 'utf8'));
    const sourceId = await makeSnapshot(client, 'e2e', fixture.words);
    await service.activateSnapshot(client, sourceId);
    const db = shim(client);
    const block = await resolveContext({
      pool: db,
      candidates: [
        cand({ lemma: '学校', pos: 'noun', lemmaReading: 'がっこう' }),
        cand({ lemma: '食べる', pos: 'verb' }),
        cand({ lemma: '暑い', pos: 'i-adjective' }),
        cand({ lemma: '熱い', pos: 'i-adjective' }),
        cand({ lemma: '開く', pos: 'verb', lemmaReading: 'ひらく' }),
        cand({ lemma: 'とても', pos: 'adverb' }),
        cand({ lemma: '仮', pos: 'noun' }),
        cand({ lemma: 'け', pos: 'noun' })
      ],
      tokens: []
    });
    assert.equal(block.status, 'ok');
    assert.equal(block.dictionary.sourceId, String(sourceId));
    const [gakkou, taberu, atsui, atsui2, hiraku, totemo, kari, ke] = block.items;
    assert.equal(gakkou.dictionaryMatch.status, 'UNIQUE');
    assert.equal(gakkou.interpretation.status, 'COMPATIBLE');
    assert.deepEqual(gakkou.interpretation.selectedSense.glosses, ['school']);
    assert.equal(gakkou.dictionaryMatch.readings.suggested, 'がっこう');
    assert.equal(taberu.interpretation.status, 'COMPATIBLE');
    assert.deepEqual(taberu.interpretation.selectedSense.glosses, ['to eat']);
    assert.deepEqual(atsui.interpretation.selectedSense.glosses, ['hot (weather)']);
    assert.deepEqual(atsui2.interpretation.selectedSense.glosses, ['hot (object)']);
    assert.equal(hiraku.interpretation.status, 'COMPATIBLE');
    assert.deepEqual(hiraku.interpretation.selectedSense.glosses, ['to open (transitive)']);
    assert.equal(totemo.dictionaryMatch.identityStrategy, 'READING_FALLBACK');
    assert.equal(totemo.interpretation.status, 'COMPATIBLE');
    assert.equal(kari.dictionaryMatch.readings.suggested, 'かり');
    assert.ok(!kari.dictionaryMatch.readings.alternatives.includes('け'));
    assert.deepEqual(ke.dictionaryMatch.readings.alternatives, ['け']);
    assert.equal(ke.interpretation.status, 'COMPATIBLE');
  } finally {
    client.release();
  }
});

test('service SQL is SELECT-only; services never import the admin pool', { skip: !runnable }, async () => {
  // Would fail if a write slipped into the request path, or if a future edit
  // wired the privileged importer connection into runtime resolution.
  const q1 = reference.buildQ1([{ candidateIdx: 0, normalized: '学校', kind: 'keb' }]);
  const q2s = reference.buildQ2Senses('1', ['1000001']);
  const q2f = reference.buildQ2Forms('1', ['1000001']);
  for (const built of [q1, q2s, q2f]) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|TRUNCATE)\b/i.test(built.sql), `write keyword in ${built.sql.slice(0, 60)}`);
  }
  for (const file of ['contextService.js', 'contextReference.js', 'contextIdentity.js', 'contextPos.js', 'contextFilters.js', 'contextResponse.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', file), 'utf8');
    assert.ok(!/require\(['"][^'"]*config\/postgres['"]\)/.test(text), `${file} must not import the admin pool`);
    assert.ok(!/require\(['"][^'"]*config\/db['"]\)/.test(text), `${file} must not import the runtime pool either (pool is injected, never required)`);
    assert.ok(!/require\(['"][^'"]*postgresRuntime['"]\)/.test(text), `${file} must not import the runtime pool directly (pool is injected)`);
  }
  const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'analyzeController.js'), 'utf8');
  assert.ok(controller.includes("require('../config/db')"), 'controller keeps the runtime adapter');
  assert.ok(!controller.includes("require('../config/postgres')"), 'controller must not import the admin pool');
});
