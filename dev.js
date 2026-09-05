const { spawn } = require('node:child_process');
const path = require('node:path');
const { selectDevelopmentServices, selectNpmExecutable } = require('./scripts/development-environment');
const { assertSafeDevelopmentEnvironment } = require('./scripts/production-guard');

const npmExecutable = selectNpmExecutable();
const services = selectDevelopmentServices(process.argv.slice(2));
const mode = process.argv.slice(2).includes('--integration') ? 'integration' : 'development';

// Fail closed: never spawn a development stack against Production. The
// guard inspects only non-secret environment identity and throws before
// any child process starts.
try {
  const api = services.find((service) => service.directory === 'server');
  assertSafeDevelopmentEnvironment({
    env: { ...process.env, ...(api ? api.environment : {}) },
    serverDir: path.join(__dirname, 'server'),
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
