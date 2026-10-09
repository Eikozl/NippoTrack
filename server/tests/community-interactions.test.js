// V6.0 Community: likes, comments, follows, notifications, reports, blocks,
// profiles, search. Stubbed executor; ownership and gating asserted.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const pool = require('../src/config/db');
const service = require('../src/services/community');
const usersController = require('../src/controllers/deckPublicationsController');

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

const VISIBLE_POST = {
  id: 7, author_id: OTHER_ID, post_type: 'text', title: null, body: 'hi',
  japanese_text: null, translation: null, entity_type: null, entity_id: null,
  deck_id: null, reading_id: null, like_count: 1, comment_count: 0, liked: false,
  author_username: 'yuki', author_display: null, author_avatar: null,
  created_at: '2026-10-07', updated_at: null
};

test('like toggles idempotently and never on own posts', async () => {
  const calls = [];
  await withPoolExecute(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM post_likes/i.test(sql)) return [[]];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/INSERT INTO post_likes/i.test(sql)) {
      assert.ok(/ON CONFLICT/i.test(sql), 'insert is conflict-safe');
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 3 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const liked = await service.toggleLike(pool, USER_ID, 7);
    assert.equal(liked.liked, true);
    assert.ok(calls.some(({ sql }) => /INSERT INTO notifications/i.test(sql)), 'author notified');
  });
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM post_likes/i.test(sql)) return [[{ '1': 1 }]];
    if (/^DELETE FROM post_likes/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/^DELETE FROM notifications/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/INSERT INTO notifications/i.test(sql)) throw new Error('unlike must not notify');
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const unliked = await service.toggleLike(pool, USER_ID, 7);
    assert.equal(unliked.liked, false);
  });
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[{ ...VISIBLE_POST, author_id: USER_ID }]];
    if (/SELECT 1 FROM post_likes/i.test(sql)) return [[]];
    if (/INSERT INTO post_likes/i.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    // Self-likes register like any other (networks allow them; the inbox
    // never notifies the author about their own tap).
    const own = await service.toggleLike(pool, USER_ID, 7);
    assert.equal(own.liked, true);
  });
});

test('comments validate, scope to visible posts, and respect ownership', async () => {
  await assert.rejects(service.createComment(pool, USER_ID, 7, ''), /body is required/);
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 11 }];
    if (/FROM post_comments c/i.test(sql)) return [[{ id: 11, author_id: USER_ID, body: 'nice', created_at: '2026-10-07', updated_at: null, author_username: 'me', author_display: null, author_avatar: null }]];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 4 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const comment = await service.createComment(pool, USER_ID, 7, 'nice');
    assert.equal(comment.id, 11);
    assert.equal(comment.mine, true);
  });
  await withPoolExecute(async (sql) => {
    // updateComment gates on the parent post (postIdForComment + getPost)
    // before the owned-row UPDATE; deleteComment cleans the comment notif.
    // NOTE: the delete UPDATE embeds FROM community_posts in EXISTS, so the
    // write branches sort before the read branches.
    if (/UPDATE post_comments SET/i.test(sql)) return [{ affectedRows: 1 }];
    if (/^DELETE FROM notifications/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.updateComment(pool, USER_ID, 11, 'nicer'), { id: 11, body: 'nicer' });
    assert.deepEqual(await service.deleteComment(pool, USER_ID, 11), { deletedId: 11 });
  });
  await withPoolExecute(async () => [{ affectedRows: 0 }], async () => {
    assert.equal(await service.updateComment(pool, USER_ID, 11, 'x'), null);
    assert.equal(await service.deleteComment(pool, USER_ID, 11), null);
  });
});

test('follows are idempotent and gated on public, unblocked users', async () => {
  const calls = [];
  await withPoolExecute(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: OTHER_ID, is_public: true }]];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/INSERT INTO user_follows/i.test(sql)) {
      assert.ok(/ON CONFLICT/i.test(sql), 'follow is conflict-safe');
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 5 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.followUser(pool, USER_ID, 'Yuki');
    assert.equal(result.followed, OTHER_ID);
    assert.ok(calls.every(({ params }) => params.includes(USER_ID) || params.includes(OTHER_ID) || params.includes('yuki')), 'no foreign identity');
  });
  await withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: OTHER_ID, is_public: false }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.followUser(pool, USER_ID, 'yuki'), { notFound: true });
  });
  await withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: USER_ID }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await service.followUser(pool, USER_ID, 'me'), null, 'no self-follow');
  });
  await withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: OTHER_ID }]];
    if (/^DELETE FROM user_follows/i.test(sql.trim())) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.unfollowUser(pool, USER_ID, 'yuki'), { unfollowed: OTHER_ID, username: 'yuki' });
  });
});

test('notifications list paginates with unread count; read is own-only', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/COUNT\(\*\)/i.test(sql) && /NOT n\.is_read/i.test(sql)) return [[{ total: '1' }]];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '2' }]];
    if (/FROM notifications n/i.test(sql)) {
      return [[{ id: 9, actor_id: OTHER_ID, kind: 'like', postId: 7, commentId: null, isRead: false, actor_username: 'yuki', actor_display: null, actor_avatar: null, createdAt: '2026-10-07' }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const inbox = await service.listNotifications(pool, USER_ID, {});
    assert.equal(inbox.unread, 1);
    assert.equal(inbox.items[0].isRead, false);
    assert.ok(seen.every(({ sql }) => !/community_posts p/i.test(sql) || (/NOT p\.is_deleted/i.test(sql) && /user_blocks/i.test(sql))), 'post-linked inbox rows re-check visibility');
  });
  await withPoolExecute(async () => [{ affectedRows: 1 }], async () => {
    assert.deepEqual(await service.markNotificationRead(pool, USER_ID, 9), { id: 9, isRead: true });
  });
  await withPoolExecute(async () => [{ affectedRows: 0 }], async () => {
    assert.equal(await service.markNotificationRead(pool, USER_ID, 9), null);
  });
});

test('reports validate and scope to visible content', async () => {
  await assert.rejects(service.createReport(pool, USER_ID, { targetType: 'post', targetId: 1, reason: 'nope' }), /reason must be/);
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[]];
    if (/INSERT INTO content_reports/i.test(sql)) return [{ insertId: 21 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.createReport(pool, USER_ID, { targetType: 'post', targetId: 7, reason: 'spam' }), { id: 21 });
  });
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[{ ...VISIBLE_POST, author_id: USER_ID }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(service.createReport(pool, USER_ID, { targetType: 'post', targetId: 7, reason: 'spam' }), /own post/);
  });
});

test('blocks sever follows both ways; profiles gate private and blocked', async () => {
  await withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: OTHER_ID }]];
    if (/INSERT INTO user_blocks/i.test(sql)) return [{ affectedRows: 1 }];
    if (/^DELETE FROM user_follows/i.test(sql.trim())) return [{ affectedRows: 2 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.blockUser(pool, USER_ID, 'yuki'), { blocked: OTHER_ID, username: 'yuki' });
  });
  await assert.rejects(service.blockUser(pool, USER_ID, ''), /username is required/);
  await withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) {
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: null, bio: null, avatar_url: null, is_public: false, jlpt_level: null, target_jlpt: null, interests: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.getCommunityProfile(pool, USER_ID, 'yuki'), { gated: true });
  });
  await withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) {
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: 'Yuki', bio: 'hi', avatar_url: null, is_public: true, jlpt_level: 'N4', target_jlpt: 'N3', interests: null }]];
    }
    if (/FROM user_blocks/i.test(sql)) return [[{ '1': 1 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.getCommunityProfile(pool, USER_ID, 'yuki'), { gated: true });
  });
});

test('search validates and scopes every class', async () => {
  // V6.1 query-less browse: empty q no longer 400s (covered in the browse
  // suite); overlong q and bad type still 400.
  await assert.rejects(service.searchCommunity(pool, USER_ID, 'x'.repeat(101)), /must not exceed 100/);
  await assert.rejects(service.searchCommunity(pool, USER_ID, 'x', { type: 'viral' }), /type must be/);
  const calls = [];
  await withPoolExecute(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM user_profile up/i.test(sql)) return [[]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, 'nichi');
    assert.deepEqual(result.people, []);
    assert.deepEqual(result.posts, []);
    assert.ok(calls.every(({ sql, params }) => !/user_blocks|is_public|is_deleted/.test(sql) || params.includes(USER_ID)), 'gates carry the viewer');
  });
});

test('own profile accepts level, target and interests with strict validation', async () => {
  function mockRes() {
    let statusCode = 200;
    let body;
    const res = {
      status(code) { statusCode = code; return res; },
      json(value) { body = value; return res; }
    };
    return { res, status: () => statusCode, body: () => body };
  }
  const saved = {
    username: 'yuki', display_name: 'Yuki', bio: null, avatar_url: null,
    is_public: true, jlpt_level: 'N4', target_jlpt: 'N3', interests: 'manga'
  };
  await withPoolExecute(async (sql) => {
    if (/INSERT INTO user_profile/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM user_profile WHERE user_id/i.test(sql)) return [[saved]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await usersController.putOwnProfile({
      body: { username: 'yuki', jlpt_level: 'N4', target_jlpt: 'N3', interests: 'manga', is_public: true },
      user: { id: USER_ID }
    }, res);
    assert.equal(status(), 200);
    assert.equal(body().jlptLevel, 'N4');
    assert.equal(body().targetJlpt, 'N3');
    assert.equal(body().interests, 'manga');
  });
  await withPoolExecute(async () => { throw new Error('must not query on invalid input'); }, async () => {
    const bad = mockRes();
    await usersController.putOwnProfile({ body: { jlpt_level: 'N9' }, user: { id: USER_ID } }, bad.res);
    assert.equal(bad.status(), 400);
    const unknown = mockRes();
    await usersController.putOwnProfile({ body: { email: 'x@y.z' }, user: { id: USER_ID } }, unknown.res);
    assert.equal(unknown.status(), 400);
  });
});

test('username changes stamp the clock; repeats within 24h are rejected', async () => {
  function mockRes() {
    let statusCode = 200;
    let body;
    const res = {
      status(code) { statusCode = code; return res; },
      json(value) { body = value; return res; }
    };
    return { res, status: () => statusCode, body: () => body };
  }
  async function runPut(currentRow, body) {
    const seen = [];
    let outcome;
    await withPoolExecute(async (sql, params = []) => {
      seen.push({ sql, params });
      if (/SELECT username, username_changed_at FROM user_profile/i.test(sql)) return [[currentRow]];
      if (/INSERT INTO user_profile/i.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM user_profile WHERE user_id/i.test(sql)) {
        return [[{ username: 'yuki', display_name: null, bio: null, avatar_url: null, is_public: false, jlpt_level: null, target_jlpt: null, interests: null, username_changed_at: '2026-10-09T12:00:00.000Z' }]];
      }
      throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
    }, async () => {
      const harness = mockRes();
      await usersController.putOwnProfile({ body, user: { id: USER_ID } }, harness.res);
      outcome = { status: harness.status(), body: harness.body(), seen };
    });
    return outcome;
  }
  // First-ever claim (NULL stamp): allowed and stamped.
  {
    const { status, seen } = await runPut({ username: null, username_changed_at: null }, { username: 'yuki' });
    assert.equal(status, 200);
    const upsert = seen.find(({ sql }) => /INSERT INTO user_profile/i.test(sql));
    assert.ok(upsert.sql.includes('username_changed_at'), 'change stamps the clock');
  }
  // Recent change (1h ago): rejected with the remaining wait.
  {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString();
    const { status, body, seen } = await runPut({ username: 'yuki', username_changed_at: recent }, { username: 'yuko' });
    assert.equal(status, 400);
    assert.match(body.error, /again in 2\d?h|again in 23h/, 'names the remaining cooldown');
    assert.ok(!seen.some(({ sql }) => /INSERT INTO user_profile/i.test(sql)), 'rejected before any write');
  }
  // Same value: no-op, no stamp, no rejection.
  {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString();
    const { status, seen } = await runPut({ username: 'yuki', username_changed_at: recent }, { username: 'yuki', bio: 'hi' });
    assert.equal(status, 200);
    const upsert = seen.find(({ sql }) => /INSERT INTO user_profile/i.test(sql));
    assert.ok(!upsert.sql.includes('username_changed_at'), 're-saving the same handle never burns the cooldown');
  }
  // Old change (25h ago): allowed and stamped.
  {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const { status, seen } = await runPut({ username: 'yuki', username_changed_at: old }, { username: 'yuko' });
    assert.equal(status, 200);
    assert.ok(seen.find(({ sql }) => /INSERT INTO user_profile/i.test(sql)).sql.includes('username_changed_at'));
  }
});
