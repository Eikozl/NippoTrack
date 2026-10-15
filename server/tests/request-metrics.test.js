const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const { requestMetrics, countSql, getSnapshot, routeKey, templateKey, MAX_ROUTES } = require('../src/middleware/requestMetrics');
const { getMetrics } = require('../src/controllers/healthController');
const pool = require('../src/config/db');

function mockReqRes(method, url, status) {
  let finishHandler = null;
  const req = { method, originalUrl: url, url };
  const res = {
    statusCode: status,
    on(event, handler) { if (event === 'finish') finishHandler = handler; },
    finish() { if (finishHandler) finishHandler(); }
  };
  return { req, res };
}

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

test('routeKey normalizes ids and strips queries', () => {
  assert.equal(routeKey({ method: 'get', originalUrl: '/api/vocabulary/42?limit=10' }), 'GET /api/vocabulary/:id');
  assert.equal(routeKey({ method: 'POST', url: '/api/review/grade' }), 'POST /api/review/grade');
});

test('middleware records ok counts, latency and attributed SQL', () => {
  const marker = `/api/metrics-probe-${Date.now()}`;
  const { req, res } = mockReqRes('GET', marker, 200);
  requestMetrics(req, res, () => {
    countSql();
    countSql();
    res.finish();
  });
  const snap = getSnapshot();
  const entry = snap.routes[`GET ${marker}`];
  assert.ok(entry);
  assert.equal(entry.n, 1);
  assert.equal(entry.ok, 1);
  assert.equal(entry.sql, 2);
  assert.equal(entry.avgSql, 2);
  assert.ok(entry.avgMs >= 0);
});

test('templateKey prefers the Express template so usernames never persist', () => {
  assert.equal(
    templateKey({ method: 'GET', baseUrl: '/api/community', route: { path: '/profile/:username' } }),
    'GET /api/community/profile/:username'
  );
  assert.equal(
    templateKey({ method: 'GET', originalUrl: '/api/community/profile/victima-visible' }),
    'GET /api/community/profile/victima-visible'
  );
});

test('middleware stores the template key, not the raw username', () => {
  const marker = `/api/metrics-user-${Date.now()}`;
  const req = { method: 'GET', originalUrl: `${marker}/victima-visible`, baseUrl: '/api/community', route: { path: '/profile/:username' } };
  const { res } = mockReqRes('GET', `${marker}/victima-visible`, 404);
  requestMetrics(req, res, () => res.finish());
  const snap = getSnapshot();
  assert.ok(snap.routes['GET /api/community/profile/:username']);
  assert.ok(!JSON.stringify(snap.routes).includes('victima-visible'));
});

test('middleware buckets 4xx and 5xx separately', () => {
  const base = `/api/metrics-buckets-${Date.now()}`;
  for (const status of [404, 500]) {
    const { req, res } = mockReqRes('GET', `${base}?s=${status}`, status);
    requestMetrics(req, res, () => res.finish());
  }
  const entry = getSnapshot().routes[`GET ${base}`];
  assert.equal(entry.n, 2);
  assert.equal(entry.err4xx, 1);
  assert.equal(entry.err5xx, 1);
});

test('route map stays bounded', () => {
  for (let i = 0; i < MAX_ROUTES + 10; i++) {
    const { req, res } = mockReqRes('GET', `/api/metrics-cap-${Date.now()}-${i}`, 200);
    requestMetrics(req, res, () => res.finish());
  }
  assert.ok(Object.keys(getSnapshot().routes).length <= MAX_ROUTES);
});

test('getMetrics exposes aggregates without user data', async () => {
  let body;
  const res = { json(value) { body = value; } };
  await getMetrics({}, res);
  assert.ok(body && typeof body === 'object');
  assert.ok(body.routes && typeof body.routes === 'object');
  assert.ok(body.pool && typeof body.pool === 'object');
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Bearer|password|token|secret/i);
});
