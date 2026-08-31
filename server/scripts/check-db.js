const pool = require('../src/config/mariadbSource');

async function main() {
  try {
    const [databaseRows] = await pool.query('SELECT DATABASE() AS database_name');
    const [tableRows] = await pool.query('SHOW TABLES');
    const tables = tableRows.map((row) => Object.values(row)[0]);
    const counts = {};

    for (const table of tables) {
      const [result] = await pool.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
      counts[table] = Number(result[0].total || 0);
    }

    console.log(JSON.stringify({
      connected: databaseRows[0]?.database_name === 'jlt',
      database: databaseRows[0]?.database_name || null,
      tables,
      counts
    }, null, 2));
  } catch (error) {
    console.error('Database check failed. Review the server-side environment configuration and MariaDB availability.');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
