const { Pool } = require('pg');
const { postgresSslConfig } = require('./postgresSsl');
require('dotenv').config({ path: process.env.POSTGRES_ENV_FILE || '.env.postgres' });

function requireEnvironment(name, { allowEmpty = false } = {}) {
  const value = process.env[name];
  if (value === undefined || (!allowEmpty && value.trim() === '')) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const port = Number(requireEnvironment('POSTGRES_PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('POSTGRES_PORT must be an integer between 1 and 65535');

const sslMode = process.env.POSTGRES_SSL;
const timezone = process.env.POSTGRES_TIMEZONE || 'America/Santo_Domingo';

const pool = new Pool({
  host: requireEnvironment('POSTGRES_HOST'), port, user: requireEnvironment('POSTGRES_USER'),
  password: requireEnvironment('POSTGRES_PASSWORD', { allowEmpty: true }), database: requireEnvironment('POSTGRES_DB'),
  max: 10, idleTimeoutMillis: 30_000, application_name: 'jlt-postgres-migrations',
  options: `-c TimeZone=${timezone}`,
  ssl: postgresSslConfig(sslMode, process.env.POSTGRES_SSL_CA, 'POSTGRES_SSL_CA')
});

module.exports = pool;
