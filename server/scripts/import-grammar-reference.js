const pool = require('../src/config/postgres');
const { importGrammarReferences } = require('../src/services/grammarReferenceStore');

async function main() {
  const client = await pool.connect();
  try { await client.query('BEGIN'); console.log(JSON.stringify(await importGrammarReferences(client))); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
main().catch((error) => { console.error('Grammar reference import failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
