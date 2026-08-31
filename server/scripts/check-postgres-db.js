const pool = require('../src/config/postgres');
async function main() {
  await pool.query(`SET TIME ZONE '${(process.env.POSTGRES_TIMEZONE || 'America/Santo_Domingo').replace(/'/g, "''")}'`);
  const result = await pool.query("SELECT current_database() AS database_name, current_user AS database_user, current_setting('server_version') AS server_version, current_setting('TimeZone') AS timezone, (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS table_count");
  console.log(JSON.stringify(result.rows[0]));
}
main().catch((error) => { console.error('PostgreSQL database check failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
