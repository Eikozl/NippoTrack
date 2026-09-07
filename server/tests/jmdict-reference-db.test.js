// CA-B1 database tests: schema, security posture, importer lifecycle, integrity,
// and snapshot rollback against a real PostgreSQL.
//
// GATED: runs only with JLT_RUN_JMDICT_DB_TESTS=true AND a loopback
// POSTGRES_HOST (127.0.0.1/localhost/::1). Every other environment skips.
// Tests create their own snapshots (converterVersion prefixed jmdict-test-),
// restore the original active pointer, and delete their rows afterwards.
// They never touch production data, user tables, or other snapshots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.JLT_RUN_JMDICT_DB_TESTS === 'true';
const pool = enabled ? require('../src/config/postgres') : null;
const service = enabled ? require('../src/services/jmdictReference') : null;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const host = process.env.POSTGRES_HOST;
const runnable = enabled && LOOPBACK.has(host);

if (enabled && !LOOPBACK.has(host)) {
  throw new Error(`JLT_RUN_JMDICT_DB_TESTS requires a loopback POSTGRES_HOST, got: ${host}`);
}

const fixture = enabled
  ? JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jmdict-sample.json'), 'utf8'))
  : null;

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code);
}

const createdSourceIds = [];
let originalActive = null;

// Local-verification scaffold: loopback admin connections run as the table
// owner without BYPASSRLS, so FORCE RLS would block even owner writes.
// Canonical admin connections use the postgres superuser (BYPASSRLS), exactly
// like the kanji-reference importer. These helpers create and remove a
// same-purpose local policy; the posture test below allowlists ONLY this
// known scaffold name alongside the frozen runtime policy and fails on any
// other policy, so a stray permissive policy can never hide behind it.
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

function fixtureRecords() {
  return fixture.words.map((word) => service.normalizeJmdictWord(word));
}

async function makeSnapshot(client, tag, words) {
  const identity = {
    fileDate: '2026-09-07',
    converterVersion: `jmdict-test-${tag}-${Date.now()}`,
    dictRevisions: ['test'],
    entCount: words.length,
    sha256: service.sha256Hex(`jmdict-test-${tag}-${Date.now()}`),
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

test('composite snapshot PK keeps same ent_seq with different content per snapshot', { skip: !runnable }, async () => {
  // Bug guarded: mutable PRIMARY KEY(ent_seq) — the second import would
  // overwrite the first and both reads would return identical checksums.
  const client = await pool.connect();
  try {
    const first = await makeSnapshot(client, 'pk-a', fixture.words.slice(0, 2));
    const altered = JSON.parse(JSON.stringify(fixture.words.slice(0, 2)));
    altered[0].sense[0].gloss = [{ text: 'altered school', lang: 'eng' }];
    const second = await makeSnapshot(client, 'pk-b', altered);
    const rows = await client.query(
      'SELECT source_id, checksum FROM jmdict_entries WHERE ent_seq = 1000001 AND source_id IN ($1, $2) ORDER BY source_id',
      [first, second]
    );
    assert.equal(rows.rowCount, 2);
    assert.notEqual(rows.rows[0].checksum, rows.rows[1].checksum);
  } finally {
    client.release();
  }
});

test('invalid snapshot status and duplicate identity are rejected', { skip: !runnable }, async () => {
  // Bug guarded: lifecycle/status columns without CHECK/UNIQUE enforcement.
  const client = await pool.connect();
  try {
    await rejectsWithCode(
      client.query("INSERT INTO jmdict_sources (file_date, converter_version, sha256, importer_version, status) VALUES ('2026-09-07', 'x', $1, 't', 'bogus')", ['0'.repeat(64)]),
      '23514'
    );
    const identity = {
      fileDate: '2026-09-07', converterVersion: `jmdict-test-dup-${Date.now()}`,
      sha256: service.sha256Hex(`dup-${Date.now()}`)
    };
    const first = await service.allocateSnapshot(client, identity);
    createdSourceIds.push(first.sourceId);
    await service.setSnapshotStatus(client, first.sourceId, 'ready');
    const second = await service.allocateSnapshot(client, identity);
    assert.equal(second.reused, true);
    assert.equal(Number(second.sourceId), Number(first.sourceId));
    const entries = await client.query('SELECT COUNT(1)::int AS c FROM jmdict_entries WHERE source_id = $1', [first.sourceId]);
    assert.equal(entries.rows[0].c, 0);
  } finally {
    client.release();
  }
});

test('active pointer rejects dangling sources', { skip: !runnable }, async () => {
  // Bug guarded: pointer referencing a nonexistent snapshot (version-absent
  // must come from NULL, never from a dangling id).
  const client = await pool.connect();
  try {
    await rejectsWithCode(
      client.query('UPDATE jmdict_active_snapshot SET source_id = 2147483647 WHERE singleton = 1'),
      '23503'
    );
  } finally {
    client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('jlt_runtime is SELECT-only on all five tables with forced RLS', { skip: !runnable }, async () => {
  // Bug guarded: runtime-write or privilege regression; missing forced RLS;
  // unexpected policies; wrong table owner; anon/authenticated/PUBLIC access.
  const client = await pool.connect();
  try {
    const tables = ['jmdict_sources', 'jmdict_active_snapshot', 'jmdict_entries', 'jmdict_forms', 'jmdict_senses'];
    for (const table of tables) {
      const privs = await client.query(
        `SELECT privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege_type
         WHERE n.nspname = 'public' AND c.relname = $1 AND has_table_privilege('jlt_runtime', c.oid, privilege_type)`,
        [table]
      );
      assert.deepEqual(privs.rows.map((row) => row.privilege_type), ['SELECT']);
      const rls = await client.query(
        "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = $1",
        [table]
      );
      assert.equal(rls.rows[0].enabled, true);
      assert.equal(rls.rows[0].forced, true);
      assert.notEqual(rls.rows[0].owner, 'jlt_runtime');
      const policies = await client.query(
        "SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname",
        [table]
      );
      // Exactly the frozen runtime SELECT policy, plus at most the documented
      // local-verification scaffold (FOR ALL TO the test connection role).
      // Any other policy — especially to PUBLIC/anon/authenticated — fails.
      const names = policies.rows.map((row) => row.policyname).sort();
      assert.ok(
        names.includes(`${table}_runtime_select`) &&
        names.every((name) => name === `${table}_runtime_select` || name === `${table}${SCAFFOLD_SUFFIX}`),
        `unexpected policy set on ${table}: ${names.join(',')}`
      );
      const runtime = policies.rows.find((row) => row.policyname === `${table}_runtime_select`);
      assert.equal(runtime.cmd, 'SELECT');
      assert.equal(String(runtime.roles), '{jlt_runtime}');
      for (const row of policies.rows) {
        if (row.policyname.endsWith(SCAFFOLD_SUFFIX)) {
          assert.equal(row.cmd, 'ALL');
          assert.ok(!row.roles.includes('public') && !row.roles.includes('{anon}') && !row.roles.includes('{authenticated}'));
        }
      }
    }
    const leaked = await client.query(
      `SELECT COUNT(1)::int AS c FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN pg_roles r CROSS JOIN LATERAL UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) privilege_type
       WHERE n.nspname = 'public' AND c.relname LIKE 'jmdict%'
         AND r.rolname IN ('anon', 'authenticated')
         AND has_table_privilege(r.oid, c.oid, privilege_type)`
    );
    assert.equal(leaked.rows[0].c, 0);
    const publique = await client.query(
      `SELECT COUNT(1)::int AS c FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) e
       WHERE n.nspname = 'public' AND c.relname LIKE 'jmdict%' AND e.grantee = 0`
    );
    assert.equal(publique.rows[0].c, 0);
  } finally {
    client.release();
  }
});

test('no user-table foreign key points into JMdict reference', { skip: !runnable }, async () => {
  // Bug guarded: a future migration coupling user deletes to dictionary rows.
  const client = await pool.connect();
  try {
    const inbound = await client.query(
      `SELECT conrelid::regclass::text AS from_table, confrelid::regclass::text AS to_table
       FROM pg_constraint WHERE contype = 'f' AND confrelid::regclass::text LIKE 'jmdict%'
         AND conrelid::regclass::text NOT LIKE 'jmdict%'`
    );
    assert.deepEqual(inbound.rows, []);
  } finally {
    client.release();
  }
});

test('fixture import verifies with exact C1 counts', { skip: !runnable }, async () => {
  // Bug guarded: integrity/audit queries disagreeing with known fixture data.
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'counts', fixture.words);
    const checks = await service.verifySnapshot(client, sourceId);
    assert.ok(checks.every((check) => check.ok));
    const audit = await service.auditSnapshot(client, sourceId);
    assert.equal(audit.entries, 7);
    assert.equal(audit.kebForms + audit.rebForms, audit.forms);
    assert.equal(audit.senses, 11);
    assert.equal(audit.entriesWithStagk, 2);
    assert.equal(audit.entriesWithStagr, 1);
    assert.equal(audit.formsNokanji, 1);
    assert.equal(audit.maxSensesPerEntry, 3);
    assert.ok(audit.maxSensesPerEntry <= audit.evalValve);
  } finally {
    client.release();
  }
});

test('foreign-key constraints reject orphan form and sense rows', { skip: !runnable }, async () => {
  // Bug guarded: missing composite FKs letting orphans accumulate silently.
  const client = await pool.connect();
  try {
    const sourceId = await makeSnapshot(client, 'fk', fixture.words.slice(0, 1));
    await rejectsWithCode(
      client.query(
        "INSERT INTO jmdict_forms (source_id, entry_id, surface, normalized, kind) VALUES ($1, 424242, 'x', 'x', 'keb')",
        [sourceId]
      ),
      '23503'
    );
    await rejectsWithCode(
      client.query(
        "INSERT INTO jmdict_senses (source_id, entry_id, sense_no, gloss_en) VALUES ($1, 424242, 1, '{x}')",
        [sourceId]
      ),
      '23503'
    );
  } finally {
    client.release();
  }
});

test('rollback restores previous snapshot content without reimport', { skip: !runnable }, async () => {
  // Bug guarded: mutable snapshots (rollback serves new content), pointer
  // confusion, or reimport-dependent recovery. MUST fail on PRIMARY
  // KEY(ent_seq) architecture: B would have destroyed A's row.
  const client = await pool.connect();
  const readGloss = async (sourceId) => (await client.query(
    'SELECT gloss_en FROM jmdict_senses WHERE source_id = $1 AND entry_id = 1000001 ORDER BY sense_no LIMIT 1',
    [sourceId]
  )).rows[0].gloss_en;
  try {
    const first = await makeSnapshot(client, 'rb-a', fixture.words.slice(0, 1));
    const altered = JSON.parse(JSON.stringify(fixture.words.slice(0, 1)));
    altered[0].sense[0].gloss = [{ text: 'altered school', lang: 'eng' }];
    const second = await makeSnapshot(client, 'rb-b', altered);
    await service.activateSnapshot(client, first);
    assert.deepEqual(await readGloss(first), ['school']);
    await service.activateSnapshot(client, second);
    assert.equal(await service.activeSourceId(client), String(second));
    assert.deepEqual(await readGloss(second), ['altered school']);
    const rolled = await service.rollbackSnapshot(client);
    assert.equal(Number(rolled.sourceId), Number(first));
    assert.deepEqual(await readGloss(rolled.sourceId), ['school']);
  } finally {
    client.release();
  }
});

test('activation and pruning guards hold', { skip: !runnable }, async () => {
  // Bug guarded: activating half-imported snapshots, pruning the live
  // snapshot, or destroying the rollback target.
  const client = await pool.connect();
  try {
    const first = await makeSnapshot(client, 'guard-a', fixture.words.slice(0, 1));
    const second = await makeSnapshot(client, 'guard-b', fixture.words.slice(1, 2));
    // Non-ready snapshot cannot activate.
    const third = await (async () => {
      const identity = {
        fileDate: '2026-09-07', converterVersion: `jmdict-test-guard-c-${Date.now()}`,
        sha256: service.sha256Hex(`guard-c-${Date.now()}`)
      };
      const allocated = await service.allocateSnapshot(client, identity);
      createdSourceIds.push(allocated.sourceId);
      return allocated.sourceId;
    })();
    await assert.rejects(service.activateSnapshot(client, third), /only ready snapshots may activate/);
    await assert.rejects(service.activateSnapshot(client, 2147483647), /snapshot not found/);
    await service.activateSnapshot(client, first);
    await assert.rejects(service.pruneSnapshot(client, first), /refusing to prune the ACTIVE snapshot/);
    // Never-activated ready snapshot prunes cleanly.
    await service.pruneSnapshot(client, second);
    const gone = await client.query('SELECT COUNT(1)::int AS c FROM jmdict_sources WHERE source_id = $1', [second]);
    assert.equal(gone.rows[0].c, 0);
    createdSourceIds.splice(createdSourceIds.indexOf(second), 1);
    // Rollback target is protected: activate third after readying it.
    await service.setSnapshotStatus(client, third, 'ready');
    await service.activateSnapshot(client, third);
    await assert.rejects(service.pruneSnapshot(client, first), /rollback-target/);
  } finally {
    client.release();
  }
});

test('failed import never moves the active pointer', { skip: !runnable }, async () => {
  // Bug guarded: partial/failed imports corrupting or switching live data.
  const client = await pool.connect();
  try {
    const before = await service.activeSourceId(client);
    const identity = {
      fileDate: '2026-09-07', converterVersion: `jmdict-test-fail-${Date.now()}`,
      sha256: service.sha256Hex(`fail-${Date.now()}`)
    };
    const { sourceId } = await service.allocateSnapshot(client, identity);
    createdSourceIds.push(sourceId);
    const broken = JSON.parse(JSON.stringify(fixture.words[0]));
    broken.sense[0].appliesToKanji = ['存在しない'];
    await assert.rejects(
      (async () => {
        const records = [service.normalizeJmdictWord(broken)];
        await client.query('BEGIN');
        try {
          await service.insertNormalizedBatch(client, sourceId, records);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      })(),
      /stagk target has no keb/
    );
    await service.setSnapshotStatus(client, sourceId, 'failed');
    assert.equal(await service.activeSourceId(client), before);
    const status = await client.query('SELECT status FROM jmdict_sources WHERE source_id = $1', [sourceId]);
    assert.equal(status.rows[0].status, 'failed');
  } finally {
    client.release();
  }
});
