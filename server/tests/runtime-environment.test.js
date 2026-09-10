const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRuntimeEnvironment } = require('../src/config/runtimeEnvironment');

function tempDirectory(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jlt-runtime-env-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

test('explicit runtime environment overrides the base file without replacing process values', () => {
  const directory = tempDirectory({
    '.env.postgres': [
      'SUPABASE_URL=https://milayuvlajmgrcxmrxdg.supabase.co',
      'POSTGRES_RUNTIME_USER=jlt_runtime.milayuvlajmgrcxmrxdg'
    ].join('\n'),
    '.env.integration': [
      'SUPABASE_URL=https://mufxygohcjikhlktvrcy.supabase.co',
      'POSTGRES_RUNTIME_USER=jlt_runtime.mufxygohcjikhlktvrcy'
    ].join('\n')
  });

  const resolved = resolveRuntimeEnvironment({
    directory,
    env: {
      POSTGRES_RUNTIME_ENV_FILE: '.env.integration',
      POSTGRES_RUNTIME_POOL_MAX: '3'
    }
  });

  assert.equal(resolved.SUPABASE_URL, 'https://mufxygohcjikhlktvrcy.supabase.co');
  assert.equal(resolved.POSTGRES_RUNTIME_USER, 'jlt_runtime.mufxygohcjikhlktvrcy');
  assert.equal(resolved.POSTGRES_RUNTIME_POOL_MAX, '3');
});

test('process environment has higher precedence than either env file', () => {
  const directory = tempDirectory({
    '.env.postgres': 'SUPABASE_URL=https://milayuvlajmgrcxmrxdg.supabase.co',
    '.env.integration': 'SUPABASE_URL=https://mufxygohcjikhlktvrcy.supabase.co'
  });

  const resolved = resolveRuntimeEnvironment({
    directory,
    env: {
      POSTGRES_RUNTIME_ENV_FILE: '.env.integration',
      SUPABASE_URL: 'https://explicit-project.supabase.co'
    }
  });

  assert.equal(resolved.SUPABASE_URL, 'https://explicit-project.supabase.co');
});
