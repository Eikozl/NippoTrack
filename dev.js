const { spawn } = require('node:child_process');
const path = require('node:path');
const { selectDevelopmentServices, selectNpmExecutable } = require('./scripts/development-environment');
const { assertSafeDevelopmentEnvironment, assertSafeClientEnvironment, assertAlignedEnvironments } = require('./scripts/production-guard');

const npmExecutable = selectNpmExecutable();
const services = selectDevelopmentServices(process.argv.slice(2));
const mode = process.argv.slice(2).includes('--integration') ? 'integration' : 'development';

// Fail closed: never spawn a development stack against Production, and
// never spawn a stack whose frontend/backend Supabase Auth projects differ
// (cross-project JWTs can never verify). The guard inspects only
// non-secret environment identity and throws before any child starts.
try {
  const api = services.find((service) => service.directory === 'server');
  const apiEnv = { ...process.env, ...(api ? api.environment : {}) };
  const backend = assertSafeDevelopmentEnvironment({
    env: apiEnv,
    serverDir: path.join(__dirname, 'server'),
    mode
  });
  const frontend = services.find((service) => service.directory === 'client');
  const clientMode = frontend && frontend.npmArguments.includes('integration') ? 'integration' : 'development';
  const client = assertSafeClientEnvironment({
    mode: clientMode,
    clientDir: path.join(__dirname, 'client'),
    env: process.env
  });
  assertAlignedEnvironments({
    backendSupabaseUrl: backend.candidates.SUPABASE_URL,
    clientSupabaseUrl: client.url,
    mode
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  return;
}

// Option A — detached spawn (CI/automation friendly): the parent validates
// the environment above, launches both long-running servers in background,
// and exits immediately so the launcher never hangs. Verify with
// `curl http://localhost:5173` and the API health endpoint; stop background
// servers via Task Manager / `taskkill` (Windows) or `kill` (POSIX). Because
// stdio is detached, use `npm run dev:server` / `npm run dev:client` in
// separate terminals when you need live logs and crash output.
for (const service of services) {
  console.log(`Starting ${service.name} from ./${service.directory} in background...`);
  const child = spawn(npmExecutable, service.npmArguments, {
    cwd: path.join(__dirname, service.directory),
    env: { ...process.env, ...service.environment },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32'
  });

  child.on('error', (error) => {
    console.error(`Unable to start ${service.name}: ${error.message}`);
    process.exitCode = 1;
  });
  child.unref();
}
