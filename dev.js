const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { selectDevelopmentServices } = require('./scripts/development-environment');
const { assertSafeDevelopmentEnvironment, assertSafeClientEnvironment, assertAlignedEnvironments } = require('./scripts/production-guard');

const args = process.argv.slice(2);
const services = selectDevelopmentServices(args);
const mode = args.includes('--integration') ? 'integration' : 'development';
// Old instant-exit behavior stays available; by default dev.js now waits
// until both servers answer health checks (Vite cold start takes minutes).
const waitForHealth = !args.includes('--no-wait');

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

// The API port lives in the env file the server boots with — never assume
// 3000. Vite keeps its configured strict port (overridable for exotic rigs).
function readDotenvValue(filePath, key) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match && match[1] === key) {
        let value = match[2].trim();
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch { /* fall through to the default below */ }
  return undefined;
}

const apiEnvFile = mode === 'integration' ? '.env.integration' : '.env.development';
const apiPort = Number(readDotenvValue(path.join(__dirname, 'server', apiEnvFile), 'PORT')) || (mode === 'integration' ? 3101 : 3000);
const vitePort = Number(process.env.DEV_VITE_PORT) || 5173;
const startupTimeoutMs = Number(process.env.DEV_STARTUP_TIMEOUT_MS) || 180000;
const startupTargets = [
  { name: 'API', hosts: ['127.0.0.1', '::1'], port: apiPort, requestPath: '/api/health' },
  { name: 'frontend', hosts: ['127.0.0.1', '::1'], port: vitePort, requestPath: '/' }
];

function tcpOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(open);
    };
    const socket = net.connect({ host, port });
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

function httpOk(host, port, requestPath, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const request = http.get({ host, port, path: requestPath, timeout: timeoutMs }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      res.resume();
      done(ok);
    });
    request.once('error', () => done(false));
    request.once('timeout', () => {
      try { request.destroy(); } catch { /* ignore */ }
      done(false);
    });
  });
}

// Two phases per target: fast TCP first (the port exists), then HTTP 2xx
// (the server actually serves). Backoff grows 3s → 5s → 10s → 30s so a
// cold Vite start is not hammered; progress logs every 10s.
const BACKOFF_MS = [3000, 5000, 10000, 30000];

async function waitForTarget(target, deadline) {
  const started = Date.now();
  let attempt = 0;
  let lastProgress = 0;
  const reachable = async () => {
    // Vite/Node may bind IPv6-only or IPv4-only for "localhost": try both.
    for (const host of target.hosts) {
      if (await tcpOpen(host, target.port)) {
        if (await httpOk(host, target.port, target.requestPath)) return true;
      }
    }
    return false;
  };
  for (;;) {
    if (await reachable()) return true;
    if (Date.now() >= deadline) return false;
    const elapsed = Date.now() - started;
    if (elapsed - lastProgress >= 10000) {
      lastProgress = elapsed;
      console.log(`Waiting for ${target.name} (port ${target.port})... ${Math.round(elapsed / 1000)}s elapsed`);
    }
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
    if (Date.now() >= deadline) return false;
  }
}

function tailFile(filePath, lines = 40) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log captured)';
  }
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    }
  } catch { /* cleanup is best-effort */ }
}

async function main() {
  // Pre-flight: a stale server on these ports would make health checks pass
  // against the wrong process and new spawns fail to bind. Warn loudly.
  for (const target of startupTargets) {
    let alreadyUp = false;
    for (const host of target.hosts) {
      if (await tcpOpen(host, target.port, 1000)) { alreadyUp = true; break; }
    }
    if (alreadyUp) {
      console.log(`WARNING: port ${target.port} already answers before startup (stale ${target.name}?). Health checks may hit that process.`);
    }
  }
  const children = [];
  for (const service of services) {
    // node runs directly (no npm/cmd shell): the CLIs are node scripts, and
    // a plain executable inherits file-descriptor stdio on every platform
    // (proven: shell/cmd layers silently lose child output on Windows).
    // Coupling note: mirrors `npm run dev` in server/client package.json
    // (nodemon index.js / vite [--mode integration]).
    const nodeArgs = service.directory === 'server'
      ? [path.join(__dirname, 'server', 'node_modules', 'nodemon', 'bin', 'nodemon.js'), 'index.js']
      : [path.join(__dirname, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), ...(mode === 'integration' ? ['--mode', 'integration'] : [])];
    const logPath = path.join(os.tmpdir(), `nippotrack-dev-${service.directory}.log`);
    let stdio = 'ignore';
    try {
      const out = fs.openSync(logPath, 'a');
      stdio = ['ignore', out, out];
    } catch { /* without a log file the child stays silent */ }
    console.log(`Starting ${service.name} from ./${service.directory} in background (log: ${logPath})...`);
    const child = spawn(process.execPath, nodeArgs, {
      cwd: path.join(__dirname, service.directory),
      env: { ...process.env, ...service.environment },
      detached: true,
      stdio,
      windowsHide: true,
      shell: false
    });
    child.logPath = logPath;
    child.on('error', (error) => {
      console.error(`Unable to start ${service.name}: ${error.message}`);
      process.exitCode = 1;
    });
    children.push(child);
    if (!waitForHealth) child.unref();
  }

  // Proxy TCP 3000 -> apiPort for probe compatibility, integration mode
  // only: external probes hardcode port 3000 while the integration API
  // listens on its own port (3101). Detached daemon so it outlives this
  // launcher; tracked for cleanup when startup fails. Dev mode never
  // creates it (the API already owns 3000 there).
  if (mode === 'integration' && apiPort !== 3000) {
    if (await tcpOpen('127.0.0.1', 3000, 1000)) {
      console.log('Port 3000 already answers in integration mode (stale proxy?) — skipping proxy startup.');
    } else {
      const proxyLog = path.join(os.tmpdir(), 'nippotrack-dev-proxy.log');
      let proxyStdio = 'ignore';
      try {
        const proxyOut = fs.openSync(proxyLog, 'a');
        proxyStdio = ['ignore', proxyOut, proxyOut];
      } catch { /* proxy stays silent without a log file */ }
      const proxyChild = spawn(process.execPath, [path.join(__dirname, 'scripts', 'dev-integration-proxy.js'), '3000', String(apiPort)], {
        cwd: __dirname,
        env: process.env,
        detached: true,
        stdio: proxyStdio,
        windowsHide: true,
        shell: false
      });
      proxyChild.logPath = proxyLog;
      proxyChild.on('error', (error) => {
        console.error(`Unable to start integration proxy: ${error.message}`);
      });
      children.push(proxyChild);
      if (!waitForHealth) proxyChild.unref();
      // The proxy binds fast; block only briefly so its startup message
      // lands before health checks begin.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log(tailFile(proxyLog, 5));
    }
  } else if (mode === 'integration') {
    console.log('Integration API already on port 3000 — no proxy needed.');
  }

  if (!waitForHealth) return;

  const stopOnSignal = (signal) => {
    console.log(`\nReceived ${signal}: stopping spawned servers...`);
    for (const child of children) killTree(child);
    process.exit(130);
  };
  process.once('SIGINT', () => stopOnSignal('SIGINT'));
  process.once('SIGTERM', () => stopOnSignal('SIGTERM'));

  const deadline = Date.now() + startupTimeoutMs;
  let failed = null;
  for (const target of startupTargets) {
    console.log(`Waiting for ${target.name} (port ${target.port})...`);
    if (!(await waitForTarget(target, deadline))) {
      failed = target;
      break;
    }
    console.log(`${target.name} is healthy.`);
  }

  if (!failed) {
    console.log('Development servers are running.');
    for (const child of children) child.unref();
    return;
  }

  console.error(`\nStartup timed out waiting for ${failed.name} (port ${failed.port}). Showing log tails:`);
  for (const child of children) {
    console.error(`\n--- ${child.logPath} ---`);
    console.error(tailFile(child.logPath));
  }
  console.error('\nCleaning up spawned servers...');
  for (const child of children) killTree(child);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
