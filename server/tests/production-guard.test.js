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

const prodClientFiles = { '.env.local': 'VITE_SUPABASE_URL=https://milayuvlajmgrcxmrxdg.supabase.co' };

test('development client + Production ref is rejected', () => {
  const dir = fakeServerDir(prodClientFiles);
  assert.throws(
    () => guard.assertSafeClientEnvironment({ mode: 'development', clientDir: dir, env: {} }),
    /Refusing to start development client against Production Supabase Auth/
  );
});

test('development client prefers .env.development.local over Production .env.local', () => {
  const dir = fakeServerDir({
    '.env.local': 'VITE_SUPABASE_URL=https://milayuvlajmgrcxmrxdg.supabase.co',
    '.env.development.local': 'VITE_SUPABASE_URL=https://mufxygohcjikhlktvrcy.supabase.co'
  });
  const resolved = guard.assertSafeClientEnvironment({ mode: 'development', clientDir: dir, env: {} });
  assert.equal(resolved.source, '.env.development.local');
});

test('integration client resolves the disposable ref', () => {
  const dir = fakeServerDir({
    '.env.local': 'VITE_SUPABASE_URL=https://milayuvlajmgrcxmrxdg.supabase.co',
    '.env.integration.local': 'VITE_SUPABASE_URL=https://mufxygohcjikhlktvrcy.supabase.co'
  });
  const resolved = guard.assertSafeClientEnvironment({ mode: 'integration', clientDir: dir, env: {} });
  assert.equal(guard.extractSupabaseRef(resolved.url), 'mufxygohcjikhlktvrcy');
});

test('explicit process env wins over client files', () => {
  const dir = fakeServerDir(prodClientFiles);
  const resolved = guard.assertSafeClientEnvironment({
    mode: 'development',
    clientDir: dir,
    env: { VITE_SUPABASE_URL: 'https://mufxygohcjikhlktvrcy.supabase.co' }
  });
  assert.equal(resolved.source, 'process environment');
});

test('missing client URL fails closed (compiled fallback is Production)', () => {
  const dir = fakeServerDir({});
  assert.throws(
    () => guard.assertSafeClientEnvironment({ mode: 'development', clientDir: dir, env: {} }),
    /Refusing to start development client against Production Supabase Auth/
  );
});

test('production-mode client is never blocked', () => {
  const dir = fakeServerDir(prodClientFiles);
  const resolved = guard.assertSafeClientEnvironment({ mode: 'production', clientDir: dir, env: {} });
  assert.equal(guard.extractSupabaseRef(resolved.url), 'milayuvlajmgrcxmrxdg');
});

test('frontend/backend mismatch is rejected', () => {
  assert.throws(
    () => guard.assertAlignedEnvironments({
      backendSupabaseUrl: 'https://mufxygohcjikhlktvrcy.supabase.co',
      clientSupabaseUrl: 'https://milayuvlajmgrcxmrxdg.supabase.co',
      mode: 'development'
    }),
    /mismatched Supabase Auth projects/
  );
  assert.throws(
    () => guard.assertAlignedEnvironments({ backendSupabaseUrl: '', clientSupabaseUrl: 'https://mufxygohcjikhlktvrcy.supabase.co', mode: 'development' }),
    /mismatched Supabase Auth projects/
  );
});

test('aligned non-Production refs pass and report refs', () => {
  const result = guard.assertAlignedEnvironments({
    backendSupabaseUrl: 'https://mufxygohcjikhlktvrcy.supabase.co',
    clientSupabaseUrl: 'https://mufxygohcjikhlktvrcy.supabase.co',
    mode: 'integration'
  });
  assert.deepEqual(result, { backendRef: 'mufxygohcjikhlktvrcy', clientRef: 'mufxygohcjikhlktvrcy' });
});

test('mismatch errors never contain secret values', () => {
  let message = '';
  try {
    guard.assertAlignedEnvironments({
      backendSupabaseUrl: 'https://mufxygohcjikhlktvrcy.supabase.co',
      clientSupabaseUrl: 'https://milayuvlajmgrcxmrxdg.supabase.co',
      mode: 'development'
    });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /mismatched Supabase Auth projects/);
  assert.ok(!message.includes(FAKE_SECRET));
});

test('direct DB target: Production ref refuses before any connection', () => {
  // Would fail if a probe/test checked only loopback shape and let a
  // Production user/host through (the CA-B2 accidental-read path).
  // Pure: no database is contacted — refusal happens on identity alone.
  assert.throws(
    () => guard.assertSafeDbTarget({ host: 'aws-0-us-east-2.pooler.supabase.com', user: `jlt_runtime.${PROD}`, source: 'probe' }),
    /refusing before any database connection/
  );
  assert.throws(
    () => guard.assertSafeDbTarget({ host: '127.0.0.1', user: `jlt_runtime.${PROD}`, source: 'probe' }),
    /Production project ref/
  );
  assert.throws(
    () => guard.assertSafeDbTarget({ host: `https://${PROD}.supabase.co`, user: 'postgres', source: 'probe' }),
    /Production project ref/
  );
});

test('direct DB target: integration and loopback targets are allowed', () => {
  const integration = guard.assertSafeDbTarget({
    host: 'aws-0-us-west-2.pooler.supabase.com',
    user: `jlt_runtime.${SAFE}`,
    source: 'integration test'
  });
  assert.equal(integration.user, `jlt_runtime.${SAFE}`);
  const local = guard.assertSafeDbTarget({ host: '127.0.0.1', user: 'jlt_agent', source: 'local test' });
  assert.equal(local.host, '127.0.0.1');
  const localhost = guard.assertSafeDbTarget({ host: 'localhost', user: 'postgres', source: 'local test' });
  assert.equal(localhost.host, 'localhost');
});

test('exact DB target guard requires one resolvable identity equal to the declared ref', () => {
  const verified = guard.assertExpectedDbTarget({
    host: 'aws-0-us-west-2.pooler.supabase.com',
    user: `postgres.${SAFE}`,
    expectedRef: SAFE,
    source: 'integration admin config'
  });
  assert.equal(verified.resolvedRef, SAFE);
  assert.equal(verified.expectedRef, SAFE);

  assert.throws(
    () => guard.assertExpectedDbTarget({ host: 'aws-0-us-west-2.pooler.supabase.com', user: 'postgres', expectedRef: SAFE, source: 'integration admin config' }),
    /could not resolve the expected Supabase project ref/
  );
  assert.throws(
    () => guard.assertExpectedDbTarget({ host: 'aws-0-us-west-2.pooler.supabase.com', user: 'postgres.abcdefghijklmnopqrst', expectedRef: SAFE, source: 'integration admin config' }),
    /expected Supabase project ref/
  );
  assert.throws(
    () => guard.assertExpectedDbTarget({ host: 'aws-0-us-west-2.pooler.supabase.com', user: `postgres.${PROD}`, expectedRef: SAFE, source: 'integration admin config' }),
    /Production project ref/
  );
});

test('Production maintenance requires the exact target and an explicit acknowledgement', () => {
  const target = {
    host: 'aws-0-us-east-2.pooler.supabase.com',
    user: `postgres.${PROD}`,
    expectedRef: PROD,
    source: 'production admin config'
  };

  assert.throws(
    () => guard.assertExpectedDbTarget(target),
    /explicit Production-maintenance acknowledgement/
  );
  assert.throws(
    () => guard.assertExpectedDbTarget({ ...target, productionMaintenanceAcknowledgement: 'incorrect' }),
    /explicit Production-maintenance acknowledgement/
  );
  assert.deepEqual(
    guard.assertExpectedDbTarget({
      ...target,
      productionMaintenanceAcknowledgement: guard.PRODUCTION_MAINTENANCE_ACKNOWLEDGEMENT
    }),
    {
      host: target.host,
      user: target.user,
      source: target.source,
      expectedRef: PROD,
      resolvedRef: PROD
    }
  );
});
