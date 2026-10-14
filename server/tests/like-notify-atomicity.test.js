const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const { toggleLike, followUser } = require('../src/services/community');

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const AUTHOR_ID = '00000000-0000-4000-8000-0000000000b2';

// Stateful mock emulating PostgreSQL ON CONFLICT DO NOTHING semantics:
// a conflicting INSERT reports affectedRows 0 instead of inserting.
function makeExecutor() {
  const state = { likes: new Set(), follows: new Set(), notifications: [], notifId: 0 };
  const barriers = [];
  const executor = {
    state,
    // Forces the next `count` matching SELECTs to all complete before any
    // of them resolves, reproducing the like+like race deterministically.
    barrierOnce(pattern, count) {
      barriers.push({ pattern, count, waiting: [] });
    },
    async execute(sql, params) {
      if (sql.includes('FROM community_posts p')) {
        return [[{
          id: 1, author_id: AUTHOR_ID, post_type: 'text', title: null, body: 'b',
          japanese_text: null, translation: null, entity_type: null, entity_id: null,
          deck_id: null, reading_id: null, snapshot_json: '{}',
          like_count: 0, comment_count: 0, author_username: 'author',
          author_display: null, author_avatar: null,
          created_at: '2026-10-13T00:00:00.000Z', updated_at: null
        }]];
      }
      for (const barrier of barriers) {
        if (barrier.pattern.test(sql) && barrier.waiting.length < barrier.count) {
          await new Promise((resolve) => {
            barrier.waiting.push(resolve);
            if (barrier.waiting.length === barrier.count) barrier.waiting.splice(0).forEach((fn) => fn());
          });
        }
      }
      if (/SELECT 1 FROM post_likes/i.test(sql)) {
        const key = `${params[0]}:${params[1]}`;
        return [state.likes.has(key) ? [{ '1': 1 }] : []];
      }
      if (sql.startsWith('INSERT INTO post_likes')) {
        const key = `${params[0]}:${params[1]}`;
        if (state.likes.has(key)) return [{ affectedRows: 0 }];
        state.likes.add(key);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM post_likes')) {
        state.likes.delete(`${params[0]}:${params[1]}`);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM notifications')) return [{ affectedRows: 1 }];
      if (/FROM user_profile WHERE username/i.test(sql)) {
        return [[{ user_id: AUTHOR_ID, is_public: 1 }]];
      }
      if (sql.startsWith('INSERT INTO user_follows')) {
        const key = `${params[0]}:${params[1]}`;
        if (state.follows.has(key)) return [{ affectedRows: 0 }];
        state.follows.add(key);
        return [{ affectedRows: 1 }];
      }
      if (/FROM user_blocks/i.test(sql)) return [[]];
      if (sql.startsWith('INSERT INTO notifications')) {
        state.notifId += 1;
        state.notifications.push({ id: state.notifId, kind: params[2] });
        return [{ insertId: state.notifId }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  return executor;
}

test('concurrent likes on the same post notify exactly once', async () => {
  const executor = makeExecutor();
  executor.barrierOnce(/SELECT 1 FROM post_likes/i, 2);
  const [first, second] = await Promise.all([
    toggleLike(executor, USER_ID, 1),
    toggleLike(executor, USER_ID, 1)
  ]);
  assert.equal(first.liked, true);
  assert.equal(second.liked, true);
  assert.equal(executor.state.likes.size, 1);
  assert.equal(executor.state.notifications.length, 1);
});

test('unlike still removes the like without notifying', async () => {
  const executor = makeExecutor();
  const liked = await toggleLike(executor, USER_ID, 1);
  assert.equal(liked.liked, true);
  assert.equal(executor.state.notifications.length, 1);
  const unliked = await toggleLike(executor, USER_ID, 1);
  assert.equal(unliked.liked, false);
  assert.equal(executor.state.likes.size, 0);
  assert.equal(executor.state.notifications.length, 1);
});

test('concurrent follows notify exactly once', async () => {
  const executor = makeExecutor();
  const [first, second] = await Promise.all([
    followUser(executor, USER_ID, 'author'),
    followUser(executor, USER_ID, 'author')
  ]);
  assert.ok(first && second);
  assert.equal(executor.state.follows.size, 1);
  assert.equal(executor.state.notifications.filter((n) => n.kind === 'follow').length, 1);
});
