const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/db');

async function main() {
  const filename = process.argv[2];
  if (!filename || !/^\d{3}_v2_[a-z0-9_]+\.sql$/.test(filename)) {
    throw new Error('Provide one valid V2 migration filename.');
  }

  const migrationPath = path.join(__dirname, '../db/migrations', filename);
  const sql = await fs.readFile(migrationPath, 'utf8');
  const [databaseRows] = await pool.query('SELECT DATABASE() AS database_name');
  if (databaseRows[0]?.database_name !== 'jlt') throw new Error('The configured database is not jlt.');

  const statements = sql.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    await pool.query(statement);
  }
  console.log(JSON.stringify({ applied: filename, database: 'jlt' }));
}

main()
  .catch((error) => {
    console.error('Migration failed.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
