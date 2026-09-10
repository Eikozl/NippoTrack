const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

function readEnvFile(directory, name) {
  try {
    return dotenv.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

// The runtime file is intentionally layered over the base admin file. This
// keeps an explicit process environment highest priority while allowing the
// integration runtime to replace an admin file's project identity.
function resolveRuntimeEnvironment({ env = process.env, directory = process.cwd() } = {}) {
  const baseFile = env.POSTGRES_ENV_FILE || '.env.postgres';
  const runtimeFile = env.POSTGRES_RUNTIME_ENV_FILE || '.env.runtime';
  return {
    ...readEnvFile(directory, baseFile),
    ...readEnvFile(directory, runtimeFile),
    ...env
  };
}

function loadRuntimeEnvironment(options) {
  const env = options?.env || process.env;
  const resolved = resolveRuntimeEnvironment({ ...options, env });
  Object.assign(env, resolved);
  return resolved;
}

module.exports = { resolveRuntimeEnvironment, loadRuntimeEnvironment };
