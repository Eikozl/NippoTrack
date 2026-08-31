const fs = require('node:fs/promises');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: process.env.POSTGRES_ENV_FILE || '.env.postgres' });

const password = process.env.JLT_RUNTIME_DB_PASSWORD;
if (!password) throw new Error('JLT_RUNTIME_DB_PASSWORD is required.');
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const envLine = (name, value) => `${name}=${JSON.stringify(value)}`;
const output = [
  envLine('POSTGRES_RUNTIME_HOST', required('POSTGRES_HOST')),
  envLine('POSTGRES_RUNTIME_PORT', required('POSTGRES_PORT')),
  envLine('POSTGRES_RUNTIME_USER', 'jlt_runtime'),
  envLine('POSTGRES_RUNTIME_PASSWORD', password),
  envLine('POSTGRES_RUNTIME_DB', required('POSTGRES_DB')),
  envLine('POSTGRES_RUNTIME_SSL', process.env.POSTGRES_SSL || 'disable'),
  'POSTGRES_RUNTIME_POOL_MAX=2',
  `SUPABASE_URL=${required('SUPABASE_URL')}`,
  `SUPABASE_PUBLISHABLE_KEY=${required('SUPABASE_PUBLISHABLE_KEY')}`,
  `SUPABASE_AUTH_REDIRECT_URL=${required('SUPABASE_AUTH_REDIRECT_URL')}`,
  ''
].join('\n');

fs.writeFile(path.join(__dirname, '..', '.env.runtime'), output, { mode: 0o600 })
  .then(() => console.log('Created ignored server/.env.runtime with dedicated runtime settings.'))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
