// V6.0 Community: feed tabs, pagination, batched counts, gating.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const pool = require('../src/config/db');
const service = require('../src/services/community');

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

const FEED_ROW = {
  id: 1, author_id: '00000000-0000-4000-8000-000000000009', post_type: 'text',
  title: null, body: 'hello', japanese_text: null, translation: null,
  entity_type: null, entity_id: null, deck_id: null, reading_id: null,
  like_count: 3, comment_count: 1, liked: true,
  author_username: 'yuki', author_display: 'Yuki', author_avatar: null,
  created_at: '2026-10-07', updated_at: null
};

function feedStub(rows, total = 1) {
  const calls = [];
  const stub = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT COUNT\(\*\) AS total FROM community_posts/i.test(sql)) return [[{ total: String(total) }]];
    if (/FROM community_posts p/i.test(sql)) return [rows];
    throw new Error(`Unexpected feed SQL: ${sql.slice(0, 70)}`);
  };
  return { calls, stub };
}

test('feed tabs validate and paginate with a bounded query count', async () => {
  await assert.rejects(service.listFeed(pool, USER_ID, { tab: 'viral' }), /tab must be/);
  for (const tab of ['latest', 'following', 'discover']) {
    const { calls, stub } = feedStub([FEED_ROW]);
    await withPoolExecute(stub, async () => {
      const result = await service.listFeed(pool, USER_ID, { tab, page: 1, limit: 20 });
      assert.equal(result.items.length, 1);
      assert.equal(result.total, 1);
      assert.equal(result.items[0].likeCount, 3);
      assert.equal(result.items[0].liked, true);
    });
    assert.ok(calls.length <= 3, `${tab} uses at most 3 queries, got ${calls.length}`);
    assert.ok(calls.every(({ params }) => params.includes(USER_ID)), `${tab} carries the viewer`);
    assert.ok(calls.some(({ sql }) => /user_blocks/i.test(sql)), `${tab} excludes blocked pairs`);
  }
});

test('following tab scopes to followed authors only', async () => {
  const { calls, stub } = feedStub([]);
  await withPoolExecute(stub, async () => {
    await service.listFeed(pool, USER_ID, { tab: 'following' });
  });
  assert.ok(calls.some(({ sql }) => /user_follows/i.test(sql)), 'following join present');
});

test('discover orders by engagement signal, latest by recency', async () => {
  const latest = feedStub([]);
  await withPoolExecute(latest.stub, async () => {
    await service.listFeed(pool, USER_ID, { tab: 'latest' });
  });
  assert.ok(latest.calls.some(({ sql }) => /ORDER BY p\.id_community_post DESC/i.test(sql)), 'latest is chronological');
  const discover = feedStub([]);
  await withPoolExecute(discover.stub, async () => {
    await service.listFeed(pool, USER_ID, { tab: 'discover' });
  });
  assert.ok(discover.calls.some(({ sql }) => /like_count DESC/i.test(sql)), 'discover leads with engagement');
});

test('empty feed skips enrichment and returns zeroed pagination', async () => {
  const { calls, stub } = feedStub([], 0);
  await withPoolExecute(stub, async () => {
    const result = await service.listFeed(pool, USER_ID, { tab: 'latest' });
    assert.deepEqual(result.items, []);
    assert.equal(result.totalPages, 0);
  });
  assert.equal(calls.length, 1, 'count only, no enrichment query');
});

test('feed limits are bounded', async () => {
  const { stub } = feedStub([]);
  await withPoolExecute(stub, async () => {
    const result = await service.listFeed(pool, USER_ID, { tab: 'latest', limit: 500 });
    assert.ok(result.limit <= 30, 'capped at MAX_FEED_LIMIT');
  });
});
