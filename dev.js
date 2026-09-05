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

let shuttingDown = false;
const children = [];

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill();
  }

  setTimeout(() => process.exit(exitCode), 250).unref();
}

for (const service of services) {
  console.log(`Starting ${service.name} from ./${service.directory}...`);
  const child = spawn(npmExecutable, service.npmArguments, {
    cwd: path.join(__dirname, service.directory),
    env: { ...process.env, ...service.environment },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  children.push(child);
  child.on('error', (error) => {
    console.error(`Unable to start ${service.name}: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`${service.name} stopped unexpectedly (${reason}).`);
    stop(code || 1);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
