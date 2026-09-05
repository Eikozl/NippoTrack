// Centralized development-environment production guard (fail-closed).
//
// A generic development command must never silently target Production.
// This helper inspects ONLY non-secret environment identity (Supabase
// project ref, database host/user) and aborts development-mode startup
// when it resolves to the known Production project.
//
// Canonical source of the Production ref: `defaultSupabaseUrl` in
// server/src/auth/supabase.js. Project refs are public environment
// identity (they appear in hostnames); never put secrets here.
//
// Enforced in two places, both development-entry only:
// - dev.js (root launcher) checks before spawning any service.
// - server/index.js checks before listening (Vercel uses api/index.js and
//   never executes that file, so deployments are unaffected).
// Explicit production startup (NODE_ENV=production) is never blocked.

const fs = require('node:fs');
const path = require('node:path');

const PRODUCTION_PROJECT_REF = 'milayuvlajmgrcxmrxdg';

const REFUSAL_MESSAGE = 'Refusing to start development server against Production. Use a safe local or integration environment instead.';

// Extracts a Supabase project ref from non-secret identity values:
// - 'https://<ref>.supabase.co' (SUPABASE_URL)
// - '<ref>.supabase.co'
// - 'role.<ref>' (PostgreSQL user form, e.g. 'jlt_runtime.<ref>')
// Returns null when no ref can be determined. Never throws.
function extractSupabaseRef(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  let match = text.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co(?:[/:].*)?$/i);
  if (match) return match[1].toLowerCase();
  match = text.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  if (match) return match[1].toLowerCase();
  match = text.match(/\.([a-z0-9]{20})$/);
  if (match) return match[1].toLowerCase();
  return null;
}

function isProductionValue(value) {
  return extractSupabaseRef(value) === PRODUCTION_PROJECT_REF;
}

// Minimal KEY=VALUE reader for env files (no dotenv dependency so the root
// launcher can use it). Returns {} when the file does not exist.
function parseEnvFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const parsed = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !(key in parsed)) parsed[key] = value;
  }
  return parsed;
}

// Resolves the database/auth identity the API server WOULD use, mirroring
// server/src/config/postgresRuntime.js dotenv precedence: explicit process
// environment wins over the runtime env file, which wins over nothing.
// Only non-secret identity fields are returned.
function resolveDevelopmentIdentity({ env = process.env, serverDir } = {}) {
  const sourceFile = env.POSTGRES_RUNTIME_ENV_FILE || '.env.runtime';
  const directory = serverDir || path.join(__dirname, '..', 'server');
  // Mirrors server/src/config/postgresRuntime.js load order: .env.postgres
  // first, then the runtime env file. Explicit process environment wins
  // over both (dotenv never overrides existing variables).
  const baseValues = parseEnvFile(path.join(directory, env.POSTGRES_ENV_FILE || '.env.postgres'));
  const fileValues = parseEnvFile(path.join(directory, sourceFile));
  const get = (name) => {
    if (env[name] !== undefined) return env[name];
    if (fileValues[name] !== undefined) return fileValues[name];
    return baseValues[name];
  };
  const candidates = {
    POSTGRES_RUNTIME_HOST: get('POSTGRES_RUNTIME_HOST'),
    POSTGRES_RUNTIME_USER: get('POSTGRES_RUNTIME_USER'),
    SUPABASE_URL: get('SUPABASE_URL')
  };
  const productionHits = Object.keys(candidates).filter((key) => isProductionValue(candidates[key]));
  return { sourceFile, candidates, productionHits };
}

// Throws in development/integration mode when the resolved identity is
// Production OR when no usable non-Production identity is configured (the
// server's compiled fallbacks point at Production, so unknown means
// unsafe). Mode 'production' (explicit NODE_ENV=production) is never
// blocked. The thrown message contains only the non-secret ref/field
// names, never secret values.
function assertSafeDevelopmentEnvironment({ env = process.env, serverDir, mode = 'development' } = {}) {
  if (mode === 'production') return resolveDevelopmentIdentity({ env, serverDir });
  const identity = resolveDevelopmentIdentity({ env, serverDir });
  if (identity.productionHits.length > 0) {
    throw new Error(`${REFUSAL_MESSAGE} (Production project ref '${PRODUCTION_PROJECT_REF}' detected via ${identity.productionHits.join(', ')} from ${identity.sourceFile}.)`);
  }
  const supabaseRef = extractSupabaseRef(identity.candidates.SUPABASE_URL);
  if (!supabaseRef) {
    throw new Error(`${REFUSAL_MESSAGE} (No Supabase project configured via SUPABASE_URL in ${identity.sourceFile}; the server would fall back to Production defaults.)`);
  }
  return identity;
}

module.exports = {
  PRODUCTION_PROJECT_REF,
  REFUSAL_MESSAGE,
  extractSupabaseRef,
  isProductionValue,
  parseEnvFile,
  resolveDevelopmentIdentity,
  assertSafeDevelopmentEnvironment
};
