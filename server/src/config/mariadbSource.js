// Migration-source / rollback-only connection. Never import this into application routes.
const mysql = require('mysql2/promise');
require('dotenv').config({ path: process.env.MARIADB_ENV_FILE || '.env' });

function required(name, allowEmpty = false) {
  const value = process.env[name];
  if (value === undefined || (!allowEmpty && value.trim() === '')) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
const port = Number(required('DB_PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT must be an integer between 1 and 65535');

module.exports = mysql.createPool({ host: required('DB_HOST'), port, user: required('DB_USER'), password: required('DB_PASSWORD', true), database: required('DB_NAME'), waitForConnections: true, connectionLimit: 3, queueLimit: 0, charset: 'utf8mb4' });
