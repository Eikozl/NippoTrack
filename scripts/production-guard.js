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
// Enforced in three places, all development-entry only:
// - dev.js (root launcher) checks before spawning any service.
// - server/index.js checks before listening (Vercel uses api/index.js and
//   never executes that file, so deployments are unaffected).
// - assertSafeDbTarget (below) is called by DB-backed test/probe commands
//   that resolve their own connection target outside server startup.
// Explicit production startup (NODE_ENV=production) is never blocked.
// Explicit production startup (NODE_ENV=production) is never blocked.

const fs = require('node:fs');
const path = require('node:path');

const PRODUCTION_PROJECT_REF = 'milayuvlajmgrcxmrxdg';

const REFUSAL_MESSAGE = 'Refusing to start development server against Production. Use a safe local or integration environment instead.';

const CLIENT_REFUSAL_MESSAGE = 'Refusing to start development client against Production Supabase Auth. Use a safe local or integration environment instead.';

const MISMATCH_MESSAGE = 'Refusing to start development stack with mismatched Supabase Auth projects. Frontend and backend must use the same non-Production project.';

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

// Resolves the Supabase URL a Vite client WOULD use, mirroring Vite env
// precedence for the given mode: real process environment wins, then
// `.env.{mode}.local`, `.env.{mode}`, `.env.local`, `.env` (later wins).
// Only the non-secret URL and its source file are returned.
function resolveClientSupabaseUrl({ mode = 'development', clientDir, env = process.env } = {}) {
  const directory = clientDir || path.join(__dirname, '..', 'client');
  const names = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  let url;
  let source = 'process environment';
  for (const name of names) {
    const parsed = parseEnvFile(path.join(directory, name));
    if (parsed.VITE_SUPABASE_URL !== undefined) {
      url = parsed.VITE_SUPABASE_URL;
      source = name;
    }
  }
  if (env.VITE_SUPABASE_URL !== undefined) {
    url = env.VITE_SUPABASE_URL;
    source = 'process environment';
  }
  return { url, source };
}

// Fail-closed client guard: in any non-production Vite mode the resolved
// Supabase URL must carry an explicit non-Production project ref, because
// the client's compiled fallback (authClient.js) is the Production
// project. Mode 'production' (explicit builds/deploys) is never blocked.
function assertSafeClientEnvironment({ mode = 'development', clientDir, env = process.env } = {}) {
  if (mode === 'production') return resolveClientSupabaseUrl({ mode, clientDir, env });
  const resolved = resolveClientSupabaseUrl({ mode, clientDir, env });
  const ref = extractSupabaseRef(resolved.url);
  if (ref === PRODUCTION_PROJECT_REF) {
    throw new Error(`${CLIENT_REFUSAL_MESSAGE} (Production project ref '${PRODUCTION_PROJECT_REF}' detected via ${resolved.source}.)`);
  }
  if (!ref) {
    throw new Error(`${CLIENT_REFUSAL_MESSAGE} (No Supabase project configured via VITE_SUPABASE_URL for mode '${mode}'; the client would fall back to Production defaults.)`);
  }
  return resolved;
}

// Verifies frontend and backend authenticate against the SAME Supabase
// project (cross-project JWTs can never verify). Compares only the
// non-secret project refs. Explicit production mode is never blocked.
function assertAlignedEnvironments({ backendSupabaseUrl, clientSupabaseUrl, mode = 'development' } = {}) {
  if (mode === 'production') return { backendRef: extractSupabaseRef(backendSupabaseUrl), clientRef: extractSupabaseRef(clientSupabaseUrl) };
  const backendRef = extractSupabaseRef(backendSupabaseUrl);
  const clientRef = extractSupabaseRef(clientSupabaseUrl);
  if (!backendRef || !clientRef) {
    throw new Error(`${MISMATCH_MESSAGE} (Unresolvable Auth identity: backend '${backendRef || 'missing'}', client '${clientRef || 'missing'}'.)`);
  }
  if (backendRef !== clientRef) {
    throw new Error(`${MISMATCH_MESSAGE} (backend '${backendRef}' vs client '${clientRef}'.)`);
  }
  return { backendRef, clientRef };
}

// Direct-DB guard for commands that bypass server startup (ad-hoc probes,
// DB-backed test files, one-off scripts): they resolve their own target
// instead of going through assertSafeDevelopmentEnvironment, so they must
// check the EXPLICIT target before opening any connection. Refuses when the
// host or user resolves to the Production project ref; loopback and the
// disposable integration project pass. Inspects non-secret identity only.
// Never throws for missing values — callers validate their own config.
function assertSafeDbTarget({ host, user, source = 'explicit target' } = {}) {
  const hits = [];
  if (isProductionValue(host)) hits.push('host');
  if (isProductionValue(user)) hits.push('user');
  if (hits.length > 0) {
    throw new Error(
      `${REFUSAL_MESSAGE} (Production project ref '${PRODUCTION_PROJECT_REF}' detected via ${hits.join(', ')} from ${source}; refusing before any database connection.)`
    );
  }
  return { host: host === undefined ? null : String(host), user: user === undefined ? null : String(user), source };
}

module.exports = {
  PRODUCTION_PROJECT_REF,
  REFUSAL_MESSAGE,
  CLIENT_REFUSAL_MESSAGE,
  MISMATCH_MESSAGE,
  extractSupabaseRef,
  isProductionValue,
  parseEnvFile,
  resolveDevelopmentIdentity,
  assertSafeDevelopmentEnvironment,
  assertSafeDbTarget,
  resolveClientSupabaseUrl,
  assertSafeClientEnvironment,
  assertAlignedEnvironments
};
