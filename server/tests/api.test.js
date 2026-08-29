const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

async function startServer() {
  const server = app.listen(0);

  await new Promise((resolve) => {
    server.once('listening', resolve);
  });

  return server;
}

test('GET /api/health returns a valid JSON response', async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(typeof data.ok, 'boolean');
    assert.equal(typeof data.status, 'string');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('POST /api/study-sessions validates required fields', async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/study-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_minutes: 30 })
    });

    const data = await response.json();

    assert.equal(response.status, 400);
    assert.match(data.error, /session_date|category/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('GET /api/study-sessions/999 returns 404 when the record does not exist', async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/study-sessions/999999`);
    const data = await response.json();

    assert.equal(response.status, 404);
    assert.equal(data.error, 'study session not found');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('POST /api/vocabulary rejects invalid status values', async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/vocabulary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: 'テスト', meaning: 'test', status: 'Invalid' })
    });

    const data = await response.json();

    assert.equal(response.status, 400);
    assert.match(data.error, /status/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
