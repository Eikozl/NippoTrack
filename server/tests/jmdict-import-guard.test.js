const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('JMdict importer checks its database target before opening the admin pool', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/import-jmdict-reference.js'), 'utf8');

  assert.match(source, /assertExpectedDbTarget/);
  assert.match(
    source,
    /assertExpectedDbTarget\(\{ host: process\.env\.POSTGRES_HOST, user: process\.env\.POSTGRES_USER, source: process\.env\.POSTGRES_ENV_FILE \|\| '\.env\.postgres' \}\)/
  );
});
