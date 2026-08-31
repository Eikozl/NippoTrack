const test = require('node:test');
const assert = require('node:assert/strict');
const { postgresSslConfig } = require('../src/config/postgresSsl');

test('PostgreSQL TLS verifies certificates and requires a CA for verify-full', () => {
  assert.equal(postgresSslConfig('disable'), undefined);
  assert.deepEqual(postgresSslConfig('require'), { rejectUnauthorized: true });
  assert.deepEqual(postgresSslConfig('require', 'root-ca'), { rejectUnauthorized: true, ca: 'root-ca' });
  assert.deepEqual(postgresSslConfig('verify-full', 'root\\nca'), { rejectUnauthorized: true, ca: 'root\nca' });
  assert.throws(() => postgresSslConfig('verify-full'), /POSTGRES_RUNTIME_SSL_CA/);
  assert.throws(() => postgresSslConfig('unexpected'), /Invalid PostgreSQL SSL mode/);
});
