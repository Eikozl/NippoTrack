const mysql = require('mysql2/promise');
require('dotenv').config();

const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'jlt',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  charset: 'utf8mb4'
};

async function main() {
  const pool = mysql.createPool(config);

  try {
    const [testRow] = await pool.query('SELECT 1 AS ok');
    const [tableRows] = await pool.query('SHOW TABLES');
    const tables = tableRows.map((row) => Object.values(row)[0]);

    const counts = {};
    for (const table of tables) {
      const [result] = await pool.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
      counts[table] = Number(result[0].total || 0);
    }

    console.log(JSON.stringify({
      connected: true,
      database: config.database,
      host: config.host,
      port: config.port,
      tables,
      counts
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      connected: false,
      database: config.database,
      host: config.host,
      port: config.port,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
