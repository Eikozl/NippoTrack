const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/postgres');
const { importKanjiReferences } = require('../src/services/kanjiReference');

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Provide a JSON array file path: npm run kanji-reference:import -- path/to/references.json');

  const raw = await fs.readFile(path.resolve(inputPath), 'utf8');
  const references = JSON.parse(raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await importKanjiReferences(client, references);
    await client.query('COMMIT');
    console.log(JSON.stringify(result));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error('Kanji reference import failed.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
