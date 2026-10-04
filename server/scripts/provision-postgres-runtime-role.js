const pool = require('../src/config/postgres');

const role = process.env.JLT_RUNTIME_DB_USER || 'jlt_runtime';
const password = process.env.JLT_RUNTIME_DB_PASSWORD;

if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error('JLT_RUNTIME_DB_USER must be a lowercase PostgreSQL role name.');
if (!password) throw new Error('JLT_RUNTIME_DB_PASSWORD is required and must be stored separately from the migration/admin credential.');
if (password.length < 24) throw new Error('JLT_RUNTIME_DB_PASSWORD must contain at least 24 characters.');

async function main() {
  const client = await pool.connect();
  try {
    const capability = await client.query('SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user');
    if (!capability.rows[0]?.rolcreaterole) throw new Error('The migration/admin connection must have CREATEROLE to provision jlt_runtime.');

    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rowCount) {
      const statement = (await client.query("SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L', $1::text, $2::text) AS sql", [role, password])).rows[0].sql;
      await client.query(statement);
    } else {
      const statement = (await client.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L', $1::text, $2::text) AS sql", [role, password])).rows[0].sql;
      await client.query(statement);
    }
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(role)}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(role)}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(role)}`);
    // Narrow back to the verifier's least-privilege map (mirrors
    // readOnlyRuntimeTables / appendOnlyRuntimeTables in
    // verify-postgres-runtime-security.js): reference snapshots stay
    // SELECT-only, encounters stay append-only. Conditional on existence:
    // provision may run before migrations create these tables, and a
    // REVOKE on a missing table would roll back the whole transaction.
    const narrowTargets = [
      { table: 'grammar_reference', revoke: 'INSERT, UPDATE, DELETE' },
      { table: 'kanji_reference', revoke: 'INSERT, UPDATE, DELETE' },
      { table: 'jmdict_sources', revoke: 'INSERT, UPDATE, DELETE' },
      { table: 'jmdict_active_snapshot', revoke: 'INSERT, UPDATE, DELETE' },
      { table: 'jmdict_entries', revoke: 'INSERT, UPDATE, DELETE' },
      { table: 'jmdict_forms', revoke: 'INSERT, UPDATE, DELETE' },
      { table: 'jmdict_senses', revoke: 'INSERT, UPDATE, DELETE' },
      { table: 'kanji_encounters', revoke: 'UPDATE, DELETE' }
    ];
    const existing = await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY ($1)`,
      [narrowTargets.map((entry) => entry.table)]
    );
    const present = new Set(existing.rows.map((row) => row.relname));
    for (const { table, revoke } of narrowTargets) {
      if (!present.has(table)) continue;
      await client.query(`REVOKE ${revoke} ON TABLE public.${quoteIdentifier(table)} FROM ${quoteIdentifier(role)}`);
    }
    await client.query(`REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM ${quoteIdentifier(role)}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(role)}`);
    await client.query(`ALTER ROLE ${quoteIdentifier(role)} SET TimeZone TO 'America/Santo_Domingo'`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ role, createdOrRotated: true, credentials: 'provided-by-environment' }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

main().catch((error) => { console.error('Runtime role provisioning failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
