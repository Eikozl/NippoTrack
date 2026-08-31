const { Pool } = require('pg');
const dotenv = require('dotenv');
const { postgresSslConfig } = require('./postgresSsl');
dotenv.config({ path: process.env.POSTGRES_ENV_FILE || '.env.postgres' });
dotenv.config({ path: process.env.POSTGRES_RUNTIME_ENV_FILE || '.env.runtime' });

function value(name, { allowEmpty = false } = {}) {
  const item = process.env[name];
  if (item === undefined || (!allowEmpty && item.trim() === '')) throw new Error(`Missing required environment variable: ${name}`);
  return item;
}

const allowTestFallback = process.env.NODE_ENV === 'test' && process.env.JLT_AUTH_BYPASS_FOR_TESTS === 'true';

function runtimeValue(name, fallbackName, options) {
  if (process.env[name] !== undefined) return value(name, options);
  if (!allowTestFallback) throw new Error(`Missing required runtime environment variable: ${name}`);
  return value(fallbackName, options);
}

const port = Number(runtimeValue('POSTGRES_RUNTIME_PORT', 'POSTGRES_PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('POSTGRES_RUNTIME_PORT must be an integer between 1 and 65535');

const sslMode = process.env.POSTGRES_RUNTIME_SSL || process.env.POSTGRES_SSL;
const timezone = process.env.POSTGRES_TIMEZONE || 'America/Santo_Domingo';
const user = runtimeValue('POSTGRES_RUNTIME_USER', 'POSTGRES_USER');
const poolMax = Number(process.env.POSTGRES_RUNTIME_POOL_MAX || 2);

if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 10) {
  throw new Error('POSTGRES_RUNTIME_POOL_MAX must be an integer between 1 and 10');
}

if (!allowTestFallback && user === 'postgres') {
  throw new Error('POSTGRES_RUNTIME_USER must be a dedicated non-admin role');
}

module.exports = new Pool({
  host: runtimeValue('POSTGRES_RUNTIME_HOST', 'POSTGRES_HOST'),
  port,
  user,
  password: runtimeValue('POSTGRES_RUNTIME_PASSWORD', 'POSTGRES_PASSWORD', { allowEmpty: true }),
  database: runtimeValue('POSTGRES_RUNTIME_DB', 'POSTGRES_DB'),
  max: poolMax,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'jlt-runtime',
  options: `-c TimeZone=${timezone}`,
  ssl: postgresSslConfig(sslMode, process.env.POSTGRES_RUNTIME_SSL_CA)
});
