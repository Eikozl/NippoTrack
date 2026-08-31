const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const pool = require('../src/config/db');

async function server() { const instance = app.listen(0); await new Promise((resolve) => instance.once('listening', resolve)); return instance; }
async function json(instance, path, options) { const response = await fetch(`http://127.0.0.1:${instance.address().port}${path}`, options); return { response, data: await response.json() }; }

test('PostgreSQL runtime preserves core API contracts against migrated data', { skip: process.env.JLT_RUN_POSTGRES_INTEGRATION !== 'true' }, async () => {
  const instance = await server();
  try {
    const health = await json(instance, '/api/health');
    assert.deepEqual(health.data, { ok: true, status: 'healthy', database: 'jlt' });
    const vocabulary = await json(instance, '/api/vocabulary?limit=100');
    assert.equal(vocabulary.data.pagination.total, 41);
    const options = await json(instance, '/api/vocabulary/options?search=nihongo');
    assert.equal(options.data.items[0].word, '日本語');
    const session = await json(instance, '/api/sessions/15');
    assert.equal(session.response.status, 200);
    const dashboard = await json(instance, '/api/dashboard');
    assert.equal(dashboard.data.vocabularyCount, 41);
  } finally {
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
});

test.after(async () => pool.end());
