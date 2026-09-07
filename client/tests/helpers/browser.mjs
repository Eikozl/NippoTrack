// Optional real-browser gate: JLT_BROWSER must name an installed Chromium binary.
// No browser download, external API, persistent server, or browser framework.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export async function browserFixture() {
  const profile = await mkdtemp(join(tmpdir(), 'jlt-browser-'));
  const vite = await createServer({
    configFile: false, root: new URL('../..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    envDir: false, define: { 'import.meta.env.VITE_API_BASE_URL': '""' },
    plugins: [tailwindcss(), {
      name: 'isolated-test-auth', enforce: 'pre',
      load(id) { if (id.replaceAll('\\', '/').endsWith('/src/authClient.js')) return 'export const accessToken = async () => null;'; },
      configureServer(server) {
        server.middlewares.use('/__stabilization', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module">import "/src/styles.css"</script><div id="app"></div><div id="modal-root"></div><div id="toast-region"></div>');
        });
      }
    }], server: { host: '127.0.0.1', port: 0, hmr: false }
  });
  let child, socket;
  const pending = new Map();
  let sequence = 0;
  const close = async () => {
    socket?.close();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, delay(3000)]);
    }
    await vite.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  };
  try {
    await vite.listen();
    child = spawn(process.env.JLT_BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); }
    }
    if (!port) throw new Error('Isolated browser did not become ready within 10 seconds');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      let result;
      try { result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); }
      catch (error) { throw new Error(`${error.message}: ${expression.slice(0,120)}`); }
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const url = `http://127.0.0.1:${vite.httpServer.address().port}/__stabilization`;
    console.log(`Isolated browser PID ${child.pid}; Vite ${url}; CDP port ${port}`);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) { if (await evaluate('!!document.getElementById("app") && !!document.querySelector("style")')) break; await delay(50); }
    return { send, evaluate, close, url };
  } catch (error) { await close(); throw error; }
}
