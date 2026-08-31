const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/postgres');

const tables = ['vocabulary', 'kanji', 'grammar_points', 'study_sessions', 'goals', 'content_entries', 'notes', 'tags', 'kanji_vocabulary', 'session_vocabulary', 'session_kanji', 'session_grammar', 'session_writings', 'usage_examples', 'content_entry_sessions', 'note_study_sessions', 'note_vocabulary', 'note_kanji', 'note_grammar', 'tag_study_sessions', 'tag_vocabulary', 'tag_kanji', 'tag_grammar', 'review_items', 'review_events'];

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Provide an output path for the PostgreSQL backup.');
  const client = await pool.connect();
  try {
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    const data = {};
    for (const table of tables) {
      const result = await client.query(`SELECT * FROM public.${quoteIdentifier(table)}`);
      data[table] = result.rows;
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify({ format: 'jlt-postgres-logical-backup-v1', database, createdAt: new Date().toISOString(), data }, null, 2), 'utf8');
    console.log(JSON.stringify({ database, tables: tables.length, rows: Object.fromEntries(tables.map((table) => [table, data[table].length])), outputPath }, null, 2));
  } finally {
    client.release();
  }
}

main().catch((error) => { console.error('PostgreSQL backup failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
