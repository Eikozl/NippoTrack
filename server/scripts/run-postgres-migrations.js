const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/postgres');
const migrationsDirectory = path.join(__dirname, '../db/migrations-postgres');
const migrationPattern = /^\d{3}_[a-z0-9_]+\.sql$/;

async function main() {
  const files = (await fs.readdir(migrationsDirectory)).filter((name) => migrationPattern.test(name)).sort();
  if (!files.length) throw new Error('No PostgreSQL migrations were found.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4100, 1)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename varchar(255) PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const applied = await client.query('SELECT filename, checksum FROM schema_migrations');
    const checksums = new Map(applied.rows.map((row) => [row.filename, row.checksum]));
    const newlyApplied = [];
    for (const filename of files) {
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = checksums.get(filename);
      if (existing) { if (existing !== checksum) throw new Error(`Checksum mismatch for applied migration: ${filename}`); continue; }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, checksum]);
      newlyApplied.push(filename);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: newlyApplied, skipped: files.length - newlyApplied.length }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
main().catch((error) => { console.error('PostgreSQL migration failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
