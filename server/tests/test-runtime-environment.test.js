const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const serverDirectory = path.resolve(__dirname, '..');

test('the checked-in test environment initializes the runtime pool without local runtime files', () => {
  const result = spawnSync(
    process.execPath,
    ['--env-file=.env.test', '-e', "require('./src/config/postgresRuntime')"],
    {
      cwd: serverDirectory,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        POSTGRES_ENV_FILE: '.env.ci-missing',
        POSTGRES_RUNTIME_ENV_FILE: '.env.ci-missing'
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
});
