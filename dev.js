const { spawn } = require('node:child_process');
const path = require('node:path');
const { selectDevelopmentServices } = require('./scripts/development-environment');

const npmCli = process.env.npm_execpath;
const npmExecutable = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const services = selectDevelopmentServices(process.argv.slice(2));

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
  const npmArguments = npmCli ? [npmCli, ...service.npmArguments] : service.npmArguments;
  const child = spawn(npmExecutable, npmArguments, {
    cwd: path.join(__dirname, service.directory),
    env: { ...process.env, ...service.environment },
    stdio: 'inherit',
    shell: !npmCli && process.platform === 'win32'
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
