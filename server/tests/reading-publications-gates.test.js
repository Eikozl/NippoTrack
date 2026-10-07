// V6.1 regression: getReadingPublication viewer gate must use a TYPED null
// guard (?::uuid). A bare `CASE WHEN ? IS NULL` throws PG 42P18
// ("could not determine data type of parameter $1") on live Postgres —
// stub executors never evaluate types, so this pins the SQL shape.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const pool = require('../src/config/db');
const service = require('../src/services/readingPublications');

function placeholders(sql) { return (sql.match(/\?/g) || []).length; }
async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try { await callback(); } finally { pool.execute = original; }
}
function pubRow(ownerId, overrides) {
  return {
    id: 7, owner_id: ownerId, title: 'Re:Zero excerpt', description: null,
    level: 'N3', text: 'テスト', translations_json: {}, is_public: 1,
    created_at: '2026-10-07', owner_username: 'yuki', owner_display: 'Yuki',
    owner_is_public: 1, viewer_blocked: 0,
    ...(overrides || {})
  };
}

test('viewer gate uses typed null guard, never bare WHEN ? IS NULL', async function() {
  const seen = [];
  const stub = async function(sql, params) {
    params = params || [];
    seen.push(String(sql));
    assert.equal(params.length, placeholders(sql), 'params bind every placeholder');
    return [[pubRow(OTHER_ID)]];
  };
  await withPoolExecute(stub, async function() {
    const result = await service.getReadingPublication(pool, 7, USER_ID);
    assert.equal(result.id, 7);
  });
  const select = seen.find((sql) => /viewer_blocked/i.test(sql));
  assert.ok(select, 'gate query computes viewer_blocked');
  assert.ok(/\?::uuid\s+IS NULL/i.test(select), 'nullable viewer guard is type-cast (?::uuid)');
  assert.ok(!/WHEN\s+\?\s+IS NULL/i.test(select), 'no bare untyped WHEN ? IS NULL (PG 42P18)');
});

test('blocked viewer resolves to 404-shape null, owner bypasses gates', async function() {
  const blocked = async function() { return [[pubRow(OTHER_ID, { viewer_blocked: 1 })]]; };
  await withPoolExecute(blocked, async function() {
    assert.equal(await service.getReadingPublication(pool, 7, USER_ID), null);
  });
  const owner = async function() { return [[pubRow(USER_ID, { is_public: 0, owner_is_public: 0, viewer_blocked: 1 })]]; };
  await withPoolExecute(owner, async function() {
    const result = await service.getReadingPublication(pool, 7, USER_ID);
    assert.equal(result.mine, true);
  });
});
