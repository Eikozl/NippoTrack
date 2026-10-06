// V6.0 Community: posts CRUD, validation, ownership. Stubbed executor.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const pool = require('../src/config/db');
const service = require('../src/services/community');

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

const POST_ROW = {
  id: 7, author_id: USER_ID, post_type: 'example', title: null, body: null,
  japanese_text: '懐かしい', translation: 'nostalgic', entity_type: null, entity_id: null,
  deck_id: null, reading_id: null, like_count: 0, comment_count: 0, liked: false,
  author_username: 'yeferson', author_display: 'Yeferson', author_avatar: null,
  created_at: '2026-10-07', updated_at: null
};

test('createPost validates types and required fields', async () => {
  await assert.rejects(service.createPost(pool, USER_ID, { postType: 'meme', body: 'x' }), /post_type must be/);
  await assert.rejects(service.createPost(pool, USER_ID, { postType: 'text' }), /body is required/);
  await assert.rejects(service.createPost(pool, USER_ID, { postType: 'example', body: 'x' }), /japaneseText is required/);
  await assert.rejects(service.createPost(pool, USER_ID, { postType: 'text', body: 'x', entityType: 'vocabulary' }), /provided together/);
  await assert.rejects(service.createPost(pool, USER_ID, { postType: 'text', body: 'x', entityType: 'bogus', entityId: 1 }), /entityType must be/);
});

test('createPost links only owned entities and visible decks', async () => {
  await withPoolExecute(async (sql) => {
    if (/FROM vocabulary WHERE/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(
      service.createPost(pool, USER_ID, { postType: 'text', body: 'hi', entityType: 'vocabulary', entityId: 9 }),
      /not found/
    );
  });
  await withPoolExecute(async (sql) => {
    if (/FROM deck_publications WHERE/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(
      service.createPost(pool, USER_ID, { postType: 'share_deck', body: 'hi', deckId: 3 }),
      /not found/
    );
  });
});

test('createPost persists and returns the gated post', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/INSERT INTO community_posts/i.test(sql)) return [{ insertId: 7 }];
    if (/FROM community_posts p/i.test(sql)) return [[POST_ROW]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const post = await service.createPost(pool, USER_ID, { postType: 'example', japaneseText: '懐かしい', translation: 'nostalgic' });
    assert.equal(post.id, 7);
    assert.equal(post.mine, true);
    assert.ok(seen.some(({ sql }) => /INSERT INTO community_posts/i.test(sql)), 'insert issued');
  });
});

test('getPost hides private, deleted, and blocked posts with 404-shape null', async () => {
  await withPoolExecute(async () => [[{ ...POST_ROW, author_id: OTHER_ID }]], async () => {
    const post = await service.getPost(pool, USER_ID, 7);
    assert.equal(post.mine, false);
  });
  await withPoolExecute(async () => [[]], async () => {
    assert.equal(await service.getPost(pool, USER_ID, 777), null);
  });
  await assert.rejects(service.getPost(pool, USER_ID, 0), /positive integer/);
});

test('updatePost allows only title/body/translation on own posts', async () => {
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts WHERE/i.test(sql)) return [[{ post_type: 'text' }]];
    if (/UPDATE community_posts SET/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM community_posts p/i.test(sql)) return [[{ ...POST_ROW, body: 'edited' }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const post = await service.updatePost(pool, USER_ID, 7, { body: 'edited' });
    assert.equal(post.body, 'edited');
  });
  await assert.rejects(service.updatePost(pool, USER_ID, 7, { postType: 'text' }), /Unexpected field/);
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts WHERE/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await service.updatePost(pool, USER_ID, 7, { body: 'x' }), null);
  });
});

test('deletePost soft-deletes own posts only', async () => {
  await withPoolExecute(async () => [{ affectedRows: 1 }], async () => {
    assert.deepEqual(await service.deletePost(pool, USER_ID, 7), { deletedId: 7 });
  });
  await withPoolExecute(async () => [{ affectedRows: 0 }], async () => {
    assert.equal(await service.deletePost(pool, USER_ID, 7), null);
  });
});
