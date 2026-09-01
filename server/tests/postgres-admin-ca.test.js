const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('administrative PostgreSQL connections retain Supabase CA validation when no custom CA is configured', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/config/postgres.js'), 'utf8');

  assert.match(source, /require\('\.\/supabaseCa'\)/);
  assert.match(source, /process\.env\.POSTGRES_SSL_CA\s*\|\|\s*supabaseCa/);
});
