const mysql = require('mysql2/promise');
require('dotenv').config();

function requireEnvironment(name, { allowEmpty = false } = {}) {
  const value = process.env[name];

  if (value === undefined || (!allowEmpty && value.trim() === '')) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const port = Number(requireEnvironment('DB_PORT'));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('DB_PORT must be an integer between 1 and 65535');
}

const pool = mysql.createPool({
  host: requireEnvironment('DB_HOST'),
  port,
  user: requireEnvironment('DB_USER'),
  password: requireEnvironment('DB_PASSWORD', { allowEmpty: true }),
  database: requireEnvironment('DB_NAME'),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

module.exports = pool;
