const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('Vercel topology serves the Vite SPA and preserves every Express API path', () => {
  const app = require('../src/app');
  const rootApiHandler = require(path.join(root, 'api/index.js'));
  const nestedApiHandler = require(path.join(root, 'api/[...path].js'));
  assert.equal(typeof rootApiHandler, 'function');
  assert.equal(typeof nestedApiHandler, 'function');
  assert.equal(nestedApiHandler, app);

  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(config.buildCommand, 'npm --prefix client run build');
  assert.equal(config.installCommand, 'npm ci && npm --prefix server ci && npm --prefix client ci');
  assert.equal(config.outputDirectory, 'client/dist');
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: '/api?__jlt_path=:path*' },
    { source: '/((?!api(?:/|$)).*)', destination: '/index.html' }
  ]);

  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.start, 'npm --prefix server start');
  assert.equal(scripts['install:all'], 'npm ci && npm --prefix server ci && npm --prefix client ci');
});
