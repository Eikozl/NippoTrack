const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const postgres = require('../src/config/postgres');

const ORDER = [
  'vocabulary', 'kanji', 'grammar_points', 'study_sessions', 'goals', 'content_entries', 'notes', 'tags',
  'kanji_vocabulary', 'session_vocabulary', 'session_kanji', 'session_grammar', 'session_writings', 'usage_examples',
  'content_entry_sessions', 'note_study_sessions', 'note_vocabulary', 'note_kanji', 'note_grammar',
  'tag_study_sessions', 'tag_vocabulary', 'tag_kanji', 'tag_grammar', 'review_items', 'review_events'
];
const IDS = { vocabulary: 'id_vocabulary', kanji: 'id_kanji', grammar_points: 'id_grammar', study_sessions: 'id_session', session_writings: 'id_session_writing', usage_examples: 'id_usage_example', goals: 'id_goal', content_entries: 'id_content_entry', notes: 'id_note', tags: 'id_tag', review_items: 'id_review_item', review_events: 'id_review_event' };
const BOOLEAN_COLUMNS = new Set(['is_active']);
const quote = (identifier) => `"${identifier}"`;
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function valuesFor(row) {
  return Object.entries(row).map(([key, value]) => BOOLEAN_COLUMNS.has(key) && value !== null ? Boolean(value) : value);
}

async function main() {
  const backupPath = process.argv[2];
  if (!backupPath) throw new Error('Provide the immutable MariaDB backup path.');
  const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
  if (backup.format !== 'jlt-logical-backup-v1' || backup.database !== 'jlt') throw new Error('Backup is not a JLT MariaDB logical backup.');
  if (ORDER.some((table) => !Array.isArray(backup.data[table]))) throw new Error('Backup does not contain every JLT application table.');

  const client = await postgres.connect();
  try {
    const existing = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations'`);
    if (existing.rows.length !== ORDER.length) throw new Error('PostgreSQL baseline table set is incomplete.');
    for (const table of ORDER) {
      const result = await client.query(`SELECT count(*)::integer AS total FROM ${quote(table)}`);
      if (result.rows[0].total !== 0) throw new Error(`PostgreSQL target is not empty: ${table}.`);
    }
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4100, 2)');
    const imported = {};
    for (const table of ORDER) {
      const rows = backup.data[table];
      imported[table] = rows.length;
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`;
      for (const row of rows) await client.query(sql, valuesFor(row));
    }
    for (const [table, id] of Object.entries(IDS)) {
      const max = await client.query(`SELECT max(${quote(id)})::bigint AS value FROM ${quote(table)}`);
      const value = Number(max.rows[0].value || 0);
      const sequence = await client.query('SELECT pg_get_serial_sequence($1, $2) AS name', [table, id]);
      await client.query('SELECT setval($1::regclass, $2, $3)', [sequence.rows[0].name, value || 1, value > 0]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ backupPath, backupSha256: digest(backup), imported }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
main().catch((error) => { console.error('PostgreSQL data migration failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => postgres.end());
