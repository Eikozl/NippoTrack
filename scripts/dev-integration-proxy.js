// Detached TCP proxy for integration mode: external probes hardcode port
// 3000 while the integration API listens on its own port (3101). Started by
// dev.js; outlives it by design (detached). SIGINT/SIGTERM close it cleanly.
const net = require('node:net');

const listenPort = Number(process.argv[2]) || 3000;
const targetPort = Number(process.argv[3]) || 3101;

if (listenPort === targetPort) {
  console.error(`proxy refuses to forward ${listenPort} to itself`);
  process.exitCode = 1;
  return;
}

const proxy = net.createServer((clientSocket) => {
  const serverSocket = net.connect({ port: targetPort, host: '127.0.0.1' }, () => {
    clientSocket.pipe(serverSocket);
    serverSocket.pipe(clientSocket);
  });
  serverSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => serverSocket.destroy());
});

proxy.on('error', (error) => {
  console.error(`proxy error: ${error?.message || error}`);
  process.exitCode = 1;
});

proxy.listen(listenPort, () => {
  console.log(`Proxy TCP ${listenPort} -> ${targetPort} started for probe compatibility`);
});

function shutdown() {
  try {
    proxy.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
