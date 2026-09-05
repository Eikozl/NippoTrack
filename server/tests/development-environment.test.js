const test = require('node:test');
const assert = require('node:assert/strict');

const { selectDevelopmentServices, selectNpmExecutable } = require('../../scripts/development-environment');

test('uses the native npm executable instead of nesting the parent npm CLI', () => {
  assert.equal(selectNpmExecutable('win32'), 'npm.cmd');
  assert.equal(selectNpmExecutable('linux'), 'npm');
});

test('normal development starts the API against the safe local runtime file, never Production fallthrough', () => {
  const services = selectDevelopmentServices([]);

  assert.deepEqual(services, [
    { name: 'API', directory: 'server', npmArguments: ['run', 'dev'], environment: { POSTGRES_RUNTIME_ENV_FILE: '.env.development' } },
    { name: 'frontend', directory: 'client', npmArguments: ['run', 'dev'], environment: {} }
  ]);
});

test('integration development selects matching API and Vite environments', () => {
  const services = selectDevelopmentServices(['--integration']);

  assert.deepEqual(services, [
    {
      name: 'API',
      directory: 'server',
      npmArguments: ['run', 'dev'],
      environment: { POSTGRES_RUNTIME_ENV_FILE: '.env.integration' }
    },
    {
      name: 'frontend',
      directory: 'client',
      npmArguments: ['run', 'dev', '--', '--mode', 'integration'],
      environment: {}
    }
  ]);
});
