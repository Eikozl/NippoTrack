const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('../../scripts/production-guard');
const { selectDevelopmentServices } = require('../../scripts/development-environment');

const PROD = 'milayuvlajmgrcxmrxdg';
const SAFE = 'mufxygohcjikhlktvrcy';
const FAKE_SECRET = 'fake-secret-password-for-tests-only-0123456789';

// Scaffold a fake server dir with the given runtime env file contents.
function fakeServerDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlt-guard-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const prodFile = {
  '.env.runtime': [
    `POSTGRES_RUNTIME_HOST=aws-0-us-east-2.pooler.supabase.com`,
    `POSTGRES_RUNTIME_USER=jlt_runtime.${PROD}`,
    `SUPABASE_URL=https://${PROD}.supabase.co`
  ].join('\n')
};

const localFile = {
  '.env.development': [
    'POSTGRES_RUNTIME_HOST=127.0.0.1',
    'POSTGRES_RUNTIME_PORT=5432',
    'POSTGRES_RUNTIME_USER=jlt_runtime',
    'POSTGRES_RUNTIME_DB=jlt_postgres',
    `SUPABASE_URL=https://${SAFE}.supabase.co`
  ].join('\n')
};

test('dev + Production project ref is rejected (all identity fields)', () => {
  const dir = fakeServerDir(prodFile);
  for (const mode of ['development', 'integration']) {
    assert.throws(
      () => guard.assertSafeDevelopmentEnvironment({ env: {}, serverDir: dir, mode }),
      /Refusing to start development server against Production/
    );
  }
  // Each individual identity field triggers refusal on its own.
  assert.ok(guard.isProductionValue(`https://${PROD}.supabase.co`));
  assert.ok(guard.isProductionValue(`jlt_runtime.${PROD}`));
  assert.ok(!guard.isProductionValue(`https://${SAFE}.supabase.co`));
  assert.ok(!guard.isProductionValue('127.0.0.1'));
});

test('dev + safe local env is allowed', () => {
  const dir = fakeServerDir(localFile);
  const identity = guard.assertSafeDevelopmentEnvironment({ env: { POSTGRES_RUNTIME_ENV_FILE: '.env.development' }, serverDir: dir, mode: 'development' });
  assert.equal(identity.sourceFile, '.env.development');
  assert.deepEqual(identity.productionHits, []);
});

test('dev:integration + disposable integration ref is allowed and unchanged', () => {
  const dir = fakeServerDir({
    '.env.integration': [
      `POSTGRES_RUNTIME_HOST=aws-0-us-west-2.pooler.supabase.com`,
      `POSTGRES_RUNTIME_USER=jlt_runtime.${SAFE}`,
      `SUPABASE_URL=https://${SAFE}.supabase.co`
    ].join('\n')
  });
  const identity = guard.assertSafeDevelopmentEnvironment({
    env: { POSTGRES_RUNTIME_ENV_FILE: '.env.integration' },
    serverDir: dir,
    mode: 'integration'
  });
  assert.deepEqual(identity.productionHits, []);
  // Launcher semantics for integration are unchanged.
  const services = selectDevelopmentServices(['--integration']);
  assert.equal(services[0].environment.POSTGRES_RUNTIME_ENV_FILE, '.env.integration');
  assert.deepEqual(services[1].npmArguments, ['run', 'dev', '--', '--mode', 'integration']);
});

test('explicit production mode is never blocked', () => {
  const dir = fakeServerDir(prodFile);
  const identity = guard.assertSafeDevelopmentEnvironment({ env: {}, serverDir: dir, mode: 'production' });
  assert.ok(identity.productionHits.length > 0, 'production identity is reported, not blocked');
});

test('missing environment identity fails closed', () => {
  const dir = fakeServerDir({});
  assert.throws(
    () => guard.assertSafeDevelopmentEnvironment({ env: {}, serverDir: dir, mode: 'development' }),
    /Refusing to start development server against Production/
  );
});

test('refusal messages never contain secret values', () => {
  const dir = fakeServerDir({
    '.env.runtime': [
      `POSTGRES_RUNTIME_HOST=aws-0-us-east-2.pooler.supabase.com`,
      `POSTGRES_RUNTIME_USER=jlt_runtime.${PROD}`,
      `POSTGRES_RUNTIME_PASSWORD=${FAKE_SECRET}`,
      `SUPABASE_URL=https://${PROD}.supabase.co`
    ].join('\n')
  });
  let message = '';
  try {
    guard.assertSafeDevelopmentEnvironment({ env: {}, serverDir: dir, mode: 'development' });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /Refusing to start development server against Production/);
  assert.ok(!message.includes(FAKE_SECRET), 'secret password must not leak into the error');
});

test('guard has no side effects on unrelated env variables', () => {
  const dir = fakeServerDir(localFile);
  const env = { POSTGRES_RUNTIME_ENV_FILE: '.env.development', UNRELATED_FLAG: 'keep-me', PORT: '3000' };
  guard.assertSafeDevelopmentEnvironment({ env, serverDir: dir, mode: 'development' });
  assert.deepEqual(env, { POSTGRES_RUNTIME_ENV_FILE: '.env.development', UNRELATED_FLAG: 'keep-me', PORT: '3000' });
});

test('explicit process env wins over env files (CI-style config)', () => {
  const dir = fakeServerDir(prodFile);
  const identity = guard.assertSafeDevelopmentEnvironment({
    env: {
      POSTGRES_RUNTIME_ENV_FILE: '.env.runtime',
      POSTGRES_RUNTIME_HOST: '127.0.0.1',
      POSTGRES_RUNTIME_USER: 'jlt_runtime',
      SUPABASE_URL: `https://${SAFE}.supabase.co`
    },
    serverDir: dir,
    mode: 'development'
  });
  assert.deepEqual(identity.productionHits, []);
});

test('plain dev launcher selects the safe local runtime file', () => {
  const services = selectDevelopmentServices([]);
  assert.equal(services[0].environment.POSTGRES_RUNTIME_ENV_FILE, '.env.development');
});
