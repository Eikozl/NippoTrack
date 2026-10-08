// FROZEN (MariaDB legacy): docs-only marker, zero behavior change — do not extend; use postgres:backup for Postgres.
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/mariadbSource');

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Provide an output path for the backup.');

  const [databaseRows] = await pool.query('SELECT DATABASE() AS database_name');
  const database = databaseRows[0]?.database_name;
  if (database !== 'jlt') throw new Error('The configured database is not jlt.');

  const [tableRows] = await pool.query('SHOW TABLES');
  const tables = tableRows.map((row) => Object.values(row)[0]).sort();
  const schema = {};
  const data = {};

  for (const table of tables) {
    const [createRows] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
    const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
    schema[table] = createRows[0]['Create Table'];
    data[table] = rows;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify({
    format: 'jlt-logical-backup-v1',
    database,
    createdAt: new Date().toISOString(),
    schema,
    data
  }, null, 2), 'utf8');

  console.log(JSON.stringify({ database, tables, outputPath }, null, 2));
}

main()
  .catch((error) => {
    console.error('Database backup failed.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
