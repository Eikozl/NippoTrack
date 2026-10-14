const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Importing the verifier must not connect; the pg Pool only connects on
// first query. Dummy env covers the config's required variables in case no
// local .env file is present.
for (const [key, value] of Object.entries({
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'jlt_test_user',
  POSTGRES_PASSWORD: 'jlt-test-password-for-import-only-0000',
  POSTGRES_DB: 'jlt_test_db'
})) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const { EXPECTED_APPLICATION_TABLES, checkSchemaIntegrity } = require('../scripts/verify-postgres-runtime-security');

function rows(names) {
  return names.map((relname) => ({ relname }));
}

test('expected application inventory matches the current schema', () => {
  assert.equal(EXPECTED_APPLICATION_TABLES.size, 64);
  for (const name of ['vocabulary', 'review_items', 'community_posts', 'deck_publications', 'user_profile', 'weekly_insights', 'jmdict_entries']) {
    assert.ok(EXPECTED_APPLICATION_TABLES.has(name), `expected set contains ${name}`);
  }
});

test('checkSchemaIntegrity passes on the exact inventory', () => {
  assert.equal(checkSchemaIntegrity(rows([...EXPECTED_APPLICATION_TABLES])), null);
});

test('checkSchemaIntegrity reports an unexpected table', () => {
  const drift = checkSchemaIntegrity(rows([...EXPECTED_APPLICATION_TABLES, 'attacker_table']));
  assert.ok(drift);
  assert.deepEqual(drift.missing, []);
  assert.deepEqual(drift.unexpected, ['attacker_table']);
});

test('checkSchemaIntegrity reports a missing table', () => {
  const names = [...EXPECTED_APPLICATION_TABLES].filter((name) => name !== 'vocabulary');
  const drift = checkSchemaIntegrity(rows(names));
  assert.ok(drift);
  assert.deepEqual(drift.missing, ['vocabulary']);
  assert.deepEqual(drift.unexpected, []);
});

// Forcing function against staleness: the expected set must equal the tables
// created across server/db/migrations-postgres (minus known transients).
// A migration that legitimately adds a table fails here until the set in
// verify-postgres-runtime-security.js is extended on purpose.
test('expected inventory matches tables created by migrations', () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations-postgres');
  const files = fs.readdirSync(dir).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.ok(files.length >= 48, `expected at least 48 migrations, found ${files.length}`);
  const transient = new Set(['jmdict_entries_new']);
  const created = new Set();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) {
      if (!transient.has(match[1])) created.add(match[1]);
    }
  }
  const missing = [...created].filter((name) => !EXPECTED_APPLICATION_TABLES.has(name));
  const extra = [...EXPECTED_APPLICATION_TABLES].filter((name) => !created.has(name));
  assert.deepEqual(missing, [], `migration-created tables absent from expected set: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `expected tables with no creating migration: ${extra.join(', ')}`);
});
