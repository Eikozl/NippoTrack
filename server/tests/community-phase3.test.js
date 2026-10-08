// V6.1 Phase 3-backend: one-level replies + notification context + followed-by.
// Stubbed executor throughout (no live DB); SQL-shape assertions pin the new
// gates plus behavioral pins where stub rows carry the new projected columns.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const THIRD_ID = '00000000-0000-4000-8000-000000000003';

const pool = require('../src/config/db');
const service = require('../src/services/community');
const controller = require('../src/controllers/communityController');

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    return await callback();
  } finally {
    pool.execute = original;
  }
}

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

const VISIBLE_POST = {
  id: 7, author_id: OTHER_ID, post_type: 'text', title: 'Hello world post', body: 'hi',
  japanese_text: null, translation: null, entity_type: null, entity_id: null,
  deck_id: null, reading_id: null, like_count: 1, comment_count: 0, liked: false,
  author_username: 'yuki', author_display: null, author_avatar: null,
  created_at: '2026-10-07', updated_at: null
};

const TOP_ROW = {
  id: 11, author_id: OTHER_ID, body: 'top', created_at: '2026-10-07', updated_at: null,
  author_username: 'yuki', author_display: 'Yuki', author_avatar: null
};

test('reply create happy path notifies parent author once (kind reply)', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/SELECT id_post_comment AS pid/i.test(sql)) {
      return [[{ pid: 11, post: 7, author_id: OTHER_ID, parent: null, deleted: false }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/INSERT INTO post_comments/i.test(sql)) {
      assert.ok(/parent_comment_id/i.test(sql), 'reply insert carries parent column');
      assert.deepEqual(params.slice(-1), [11]);
      return [{ insertId: 12 }];
    }
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/INSERT INTO notifications/i.test(sql)) {
      assert.match(sql, /VALUES/i);
      assert.equal(params[2], 'reply');
      assert.equal(String(params[0]), String(OTHER_ID), 'notify parent author');
      assert.equal(params[3], 7);
      assert.equal(params[4], 12);
      return [{ insertId: 5 }];
    }
    if (/FROM post_comments c/i.test(sql)) {
      return [[{ id: 12, author_id: USER_ID, body: 'reply!', created_at: '2026-10-07', updated_at: null, parent: 11, author_username: 'me', author_display: null, author_avatar: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  }, async () => {
    const reply = await service.createComment(pool, USER_ID, 7, 'reply!', 11);
    assert.equal(reply.id, 12);
    assert.equal(reply.parentCommentId, 11);
    assert.equal(reply.mine, true);
  });
  const notifs = seen.filter(({ sql }) => /INSERT INTO notifications/i.test(sql));
  assert.equal(notifs.length, 1, 'exactly one inbox row (no double notify to post author)');
});

test('reply validation: nested and cross-post parents are 400, garbage never queries', async () => {
  await withPoolExecute(async () => { throw new Error('must not query on invalid input'); }, async () => {
    await assert.rejects(service.createComment(pool, USER_ID, 7, 'x', 0), /positive integer/);
    await assert.rejects(service.createComment(pool, USER_ID, 7, 'x', 'nope'), /positive integer/);
  });
  await withPoolExecute(async (sql) => {
    if (/SELECT id_post_comment AS pid/i.test(sql)) {
      return [[{ pid: 21, post: 7, author_id: OTHER_ID, parent: 11, deleted: false }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(service.createComment(pool, USER_ID, 7, 'nested?', 21), /one level/);
  });
  await withPoolExecute(async (sql) => {
    if (/SELECT id_post_comment AS pid/i.test(sql)) {
      return [[{ pid: 31, post: 999, author_id: OTHER_ID, parent: null, deleted: false }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(service.createComment(pool, USER_ID, 7, 'wrong post', 31), /same post/);
  });
  await withPoolExecute(async (sql) => {
    if (/SELECT id_post_comment AS pid/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(service.createComment(pool, USER_ID, 7, 'ghost', 777), /Parent comment not found/);
  });
  // Through the controller both surface as 400 (never silent, never 404).
  for (const parentCommentId of [21, 31]) {
    await withPoolExecute(async (sql) => {
      if (/SELECT id_post_comment AS pid/i.test(sql)) {
        const nested = parentCommentId === 21;
        return [[{ pid: parentCommentId, post: nested ? 7 : 999, author_id: OTHER_ID, parent: nested ? 11 : null, deleted: false }]];
      }
      if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
      throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
    }, async () => {
      const { res, status } = mockRes();
      await controller.createComment(
        { body: { body: 'x', parentCommentId }, params: { id: '7' }, user: { id: USER_ID } },
        res
      );
      assert.equal(status(), 400);
    });
  }
});

test('reply across a block still lands but writes no inbox row', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/SELECT id_post_comment AS pid/i.test(sql)) {
      return [[{ pid: 11, post: 7, author_id: OTHER_ID, parent: null, deleted: false }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 12 }];
    if (/FROM user_blocks/i.test(sql)) return [[{ 1: 1 }]];
    if (/FROM post_comments c/i.test(sql)) {
      return [[{ id: 12, author_id: USER_ID, body: 'hi', created_at: '2026-10-07', updated_at: null, parent: 11, author_username: 'me', author_display: null, author_avatar: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const reply = await service.createComment(pool, USER_ID, 7, 'hi', 11);
    assert.equal(reply.id, 12, 'the reply itself still lands');
  });
  assert.ok(seen.some(({ sql }) => /FROM user_blocks/i.test(sql)), 'notify path checks block first');
  assert.ok(!seen.some(({ sql }) => /INSERT INTO notifications/i.test(sql)), 'no inbox row across a block');
});

test('no self-notif on reply-to-self; post author not re-notified', async () => {
  // Self-reply: parent author == replier → no notification at all.
  const seenSelf = [];
  await withPoolExecute(async (sql, params = []) => {
    seenSelf.push({ sql, params });
    if (/SELECT id_post_comment AS pid/i.test(sql)) {
      return [[{ pid: 11, post: 7, author_id: USER_ID, parent: null, deleted: false }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[{ ...VISIBLE_POST, author_id: THIRD_ID }]];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 12 }];
    if (/FROM post_comments c/i.test(sql)) {
      return [[{ id: 12, author_id: USER_ID, body: 'self', created_at: '2026-10-07', updated_at: null, parent: 11, author_username: 'me', author_display: null, author_avatar: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const reply = await service.createComment(pool, USER_ID, 7, 'self', 11);
    assert.equal(reply.parentCommentId, 11);
  });
  assert.ok(!seenSelf.some(({ sql }) => /INSERT INTO notifications/i.test(sql)), 'self-reply writes no inbox row');

  // Reply to a third-party comment on someone else's post → only the parent
  // author is notified (post author gets nothing extra).
  const seenThird = [];
  await withPoolExecute(async (sql, params = []) => {
    seenThird.push({ sql, params });
    if (/SELECT id_post_comment AS pid/i.test(sql)) {
      return [[{ pid: 11, post: 7, author_id: THIRD_ID, parent: null, deleted: false }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 12 }];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 5 }];
    if (/FROM post_comments c/i.test(sql)) {
      return [[{ id: 12, author_id: USER_ID, body: 'r', created_at: '2026-10-07', updated_at: null, parent: 11, author_username: 'me', author_display: null, author_avatar: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await service.createComment(pool, USER_ID, 7, 'r', 11);
  });
  const notifs = seenThird.filter(({ sql }) => /INSERT INTO notifications/i.test(sql));
  assert.equal(notifs.length, 1);
  assert.equal(String(notifs[0].params[0]), String(THIRD_ID), 'parent author notified');
  assert.equal(notifs[0].params[2], 'reply');
});

test('reply edit is author-only; delete is author-or-post-owner; both gate on post', async () => {
  // Edit happy (author) + edit denied (non-author → null).
  await withPoolExecute(async (sql) => {
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/UPDATE post_comments SET/i.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(await service.updateComment(pool, USER_ID, 12, 'edited reply'), { id: 12, body: 'edited reply' });
  });
  await withPoolExecute(async (sql) => {
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/UPDATE post_comments SET/i.test(sql)) return [{ affectedRows: 0 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await service.updateComment(pool, THIRD_ID, 12, 'hijack'), null);
  });
  // Delete by author and by post owner both succeed with one UPDATE whose
  // predicate carries the author-or-owner branch; cleanup covers both kinds.
  for (const deleter of [USER_ID, OTHER_ID]) {
    const seen = [];
    await withPoolExecute(async (sql, params = []) => {
      seen.push({ sql, params });
      if (/UPDATE post_comments SET/i.test(sql)) return [{ affectedRows: 1 }];
      if (/^DELETE FROM notifications/i.test(sql.trim())) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
    }, async () => {
      assert.deepEqual(await service.deleteComment(pool, deleter, 12), { deletedId: 12 });
    });
    const update = seen.find(({ sql }) => /UPDATE post_comments SET/i.test(sql));
    assert.ok(/author_id = \? OR EXISTS/i.test(update.sql), 'author-or-post-owner predicate');
    const cleanup = seen.find(({ sql }) => /^DELETE FROM notifications/i.test(sql.trim()));
    assert.ok(/'comment'/.test(cleanup.sql) && /'reply'/.test(cleanup.sql), 'both inbox kinds cleaned');
  }
  // Hidden parent post → edit resolves to 404-shape null without touching row.
  const seenHidden = [];
  await withPoolExecute(async (sql, params = []) => {
    seenHidden.push({ sql, params });
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await service.updateComment(pool, USER_ID, 12, 'x'), null);
  });
  assert.ok(!seenHidden.some(({ sql }) => /UPDATE post_comments SET/i.test(sql)), 'no edit on hidden threads');
});

test('listComments embeds block-filtered replies with replyCount; top-level paging unchanged', async () => {
  const seen = [];
  const replyRows = [
    { id: 21, author_id: THIRD_ID, body: 'r1', created_at: '2026-10-07', updated_at: null, parent: 11, author_username: 'cara', author_display: null, author_avatar: null },
    { id: 22, author_id: USER_ID, body: 'r2 edited', created_at: '2026-10-07', updated_at: '2026-10-08', parent: 11, author_username: 'me', author_display: null, author_avatar: null }
  ];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/GROUP BY c\.parent_comment_id/i.test(sql)) return [[{ parent: 11, total: '2' }]];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '2' }]];
    if (/FROM post_comments c/i.test(sql)) {
      if (/parent_comment_id IN/i.test(sql)) return [replyRows];
      return [[TOP_ROW, { ...TOP_ROW, id: 12, author_id: THIRD_ID, body: 'second' }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.listComments(pool, USER_ID, 7, { page: 1, limit: 20 });
    assert.equal(result.total, 2, 'top-level total only (replies excluded from paging)');
    assert.equal(result.items.length, 2);
    const first = result.items[0];
    assert.equal(first.replyCount, 2);
    assert.equal(first.replies.length, 2);
    assert.equal(first.replies[0].id, 21);
    assert.equal(first.replies[0].parentCommentId, 11);
    assert.equal(first.replies[0].edited, false);
    assert.equal(first.replies[1].edited, true, 'edited derives from updated_at divergence');
    assert.equal(first.replies[1].mine, true);
    assert.equal(result.items[1].replyCount, 0);
    assert.deepEqual(result.items[1].replies, []);
    // Top-level shape stable: existing keys plus additive replies/replyCount.
    for (const item of result.items) {
      assert.ok('replyCount' in item && 'replies' in item, 'additive fields present');
      assert.ok('id' in item && 'authorId' in item && 'body' in item && 'createdAt' in item, 'existing keys stable');
    }
  });
  const commentQueries = seen.filter(({ sql }) => /FROM post_comments c/i.test(sql));
  assert.ok(commentQueries.length >= 3, `top count + top page + batched replies, got ${commentQueries.length}`);
  for (const { sql, params } of commentQueries) {
    assert.ok(/user_blocks/i.test(sql), 'every comment query excludes blocked pairs');
    assert.ok(/up\.is_public/i.test(sql), 'every comment query enforces author publicity');
    assert.ok(params.filter((p) => p === USER_ID).length >= 3, 'viewer binds every gate position');
  }
  const topPage = commentQueries.find(({ sql }) => /LIMIT \? OFFSET \?/i.test(sql));
  assert.ok(/parent_comment_id IS NULL/i.test(topPage.sql), 'top-level page filters to parents only');
});

test('listComments caps replies at 20 while replyCount stays total', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: 100 + i, author_id: THIRD_ID, body: `r${i}`, created_at: '2026-10-07', updated_at: null,
    parent: 11, author_username: 'cara', author_display: null, author_avatar: null
  }));
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/GROUP BY c\.parent_comment_id/i.test(sql)) return [[{ parent: 11, total: '25' }]];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
    if (/FROM post_comments c/i.test(sql)) {
      if (/parent_comment_id IN/i.test(sql)) return [many];
      return [[TOP_ROW]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.listComments(pool, USER_ID, 7, {});
    assert.equal(result.items[0].replyCount, 25, 'replyCount reflects the full total');
    assert.equal(result.items[0].replies.length, 20, 'replies array capped at 20 (documented)');
  });
});

test('reports on replies reuse the comment report path', async () => {
  await withPoolExecute(async (sql) => {
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/SELECT author_id FROM post_comments/i.test(sql)) return [[{ author_id: OTHER_ID }]];
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[]];
    if (/INSERT INTO content_reports/i.test(sql)) return [{ insertId: 21 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(
      await service.createReport(pool, USER_ID, { targetType: 'comment', targetId: 12, reason: 'spam' }),
      { id: 21 },
      'a reply id reports through targetType comment'
    );
  });
  await withPoolExecute(async (sql) => {
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/SELECT author_id FROM post_comments/i.test(sql)) return [[{ author_id: USER_ID }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(
      service.createReport(pool, USER_ID, { targetType: 'comment', targetId: 12, reason: 'spam' }),
      /own comment/
    );
  });
});

test('notification rows carry excerpt + actorDisplayName; pagination untouched', async () => {
  const longTitle = 'a'.repeat(100);
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/COUNT\(\*\)/i.test(sql) && /NOT n\.is_read/i.test(sql)) return [[{ total: '1' }]];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '2' }]];
    if (/FROM notifications n/i.test(sql)) {
      return [[
        { id: 9, actor_id: OTHER_ID, kind: 'like', postId: 7, commentId: null, isRead: false, actor_username: 'yuki', actor_display: 'Yuki', actor_avatar: null, createdAt: '2026-10-07', post_title: longTitle, post_japanese: null, post_body: 'fallback' },
        { id: 8, actor_id: THIRD_ID, kind: 'follow', postId: null, commentId: null, isRead: true, actor_username: 'cara', actor_display: null, actor_avatar: null, createdAt: '2026-10-06', post_title: null, post_japanese: null, post_body: null }
      ]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const inbox = await service.listNotifications(pool, USER_ID, { page: 1, limit: 20 });
    assert.equal(inbox.total, 2);
    assert.equal(inbox.unread, 1);
    assert.equal(inbox.page, 1);
    const [like, follow] = inbox.items;
    assert.equal(like.actorUsername, 'yuki');
    assert.equal(like.actorDisplay, 'Yuki');
    assert.equal(like.actorDisplayName, 'Yuki', 'canonical display-name key present');
    assert.ok(typeof like.excerpt === 'string' && like.excerpt.length > 0, 'excerpt present for post-linked rows');
    assert.ok(like.excerpt.endsWith('…'), 'long titles truncate ellipsis-style like the summary');
    assert.ok(like.excerpt.length <= 81, `excerpt bounded (80 + ellipsis), got ${like.excerpt.length}`);
    assert.equal(follow.excerpt, null, 'follow rows (no post) yield null excerpt');
    assert.equal(follow.actorDisplayName, null);
  });
  const page = seen.find(({ sql }) => /ORDER BY n\.id_notification DESC/i.test(sql));
  assert.ok(/p\.title AS post_title/i.test(page.sql), 'page projects post title for excerpts');
  assert.ok(/p\.japanese_text AS post_japanese/i.test(page.sql), 'page projects japanese_text for excerpts');
  assert.ok(/p\.body AS post_body/i.test(page.sql), 'page projects body for excerpts');
});

test('getCommunityProfile exposes viewerFollowing/followsYou/mutual in one batched query', async () => {
  const profile = [[{
    user_id: OTHER_ID, username: 'yuki', display_name: 'Yuki', bio: null, avatar_url: null,
    is_public: true, jlpt_level: null, target_jlpt: null, interests: null
  }]];
  const run = async (followRow) => withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) return profile;
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/FROM community_posts WHERE author_id/i.test(sql)) return [[{ posts: 1, followers: 2, following: 1 }]];
    if (/SELECT EXISTS.*user_follows/i.test(sql)) return [[followRow]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => service.getCommunityProfile(pool, USER_ID, 'yuki'));
  const mutual = await run({ following: 1, followed_by: 1 });
  assert.equal(mutual.following, true, 'legacy following kept for compat');
  assert.equal(mutual.viewerFollowing, true);
  assert.equal(mutual.followsYou, true);
  assert.equal(mutual.mutual, true);
  const oneWay = await run({ following: 1, followed_by: 0 });
  assert.equal(oneWay.viewerFollowing, true);
  assert.equal(oneWay.followsYou, false);
  assert.equal(oneWay.mutual, false);
  const none = await run({ following: 0, followed_by: 0 });
  assert.equal(none.viewerFollowing, false);
  assert.equal(none.followsYou, false);
  assert.equal(none.mutual, false);
  // Self scope issues no follow query at all (block check still runs per existing shape).
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: USER_ID, username: 'me', display_name: null, bio: null, avatar_url: null, is_public: false, jlpt_level: null, target_jlpt: null, interests: null }]];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/FROM vocabulary/i.test(sql)) return [[{ posts: 0, followers: 0, following: 0, vocabulary: 1, kanji: 0, grammar: 0 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const self = await service.getCommunityProfile(pool, USER_ID, 'me');
    assert.equal(self.isSelf, true);
    assert.equal(self.viewerFollowing, false);
    assert.equal(self.followsYou, false);
    assert.equal(self.mutual, false);
  });
  assert.ok(!seen.some(({ sql }) => /SELECT EXISTS.*user_follows/i.test(sql)), 'self scope issues no follow-direction check (counts queries still run)');
});

test('searchCommunity people rows carry following/followsYou from one batched edge query', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM user_profile up/i.test(sql)) {
      return [[
        { user_id: OTHER_ID, username: 'yuki', display_name: null, avatar_url: null, bio: null },
        { user_id: THIRD_ID, username: 'cara', display_name: null, avatar_url: null, bio: null }
      ]];
    }
    if (/SELECT follower_id, followed_id FROM user_follows/i.test(sql)) {
      return [[
        { follower_id: USER_ID, followed_id: OTHER_ID },
        { follower_id: THIRD_ID, followed_id: USER_ID }
      ]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, 'a', { type: 'people' });
    assert.equal(result.people.length, 2);
    const yuki = result.people.find((p) => p.username === 'yuki');
    const cara = result.people.find((p) => p.username === 'cara');
    assert.equal(yuki.following, true, 'viewer follows yuki');
    assert.equal(yuki.followsYou, false);
    assert.equal(cara.following, false);
    assert.equal(cara.followsYou, true, 'cara follows viewer');
  });
  const edgeQueries = seen.filter(({ sql }) => /SELECT follower_id, followed_id FROM user_follows/i.test(sql));
  assert.equal(edgeQueries.length, 1, 'single batched edge query (no per-row N+1)');
  // Empty people → no edge query at all.
  const seenEmpty = [];
  await withPoolExecute(async (sql, params = []) => {
    seenEmpty.push({ sql, params });
    if (/FROM user_profile up/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, 'zzz-no-match', { type: 'people' });
    assert.deepEqual(result.people, []);
  });
  assert.ok(!seenEmpty.some(({ sql }) => /SELECT follower_id, followed_id/i.test(sql)), 'no edge query on empty people');
});

test('listFollows member rows carry viewerFollowing from one batched IN-query', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: OTHER_ID, is_public: true }]];
    if (/SELECT followed_id FROM user_follows WHERE follower_id/i.test(sql)) {
      return [[{ followed_id: THIRD_ID }]];
    }
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '2' }]];
    if (/FROM user_follows f/i.test(sql)) {
      return [[
        { user_id: OTHER_ID, username: 'yuki', display_name: null, avatar_url: null, bio: null },
        { user_id: THIRD_ID, username: 'cara', display_name: null, avatar_url: null, bio: null }
      ]];
    }
    if (/FROM user_blocks/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.listFollows(pool, USER_ID, 'yuki', 'followers', {});
    assert.equal(result.items.length, 2);
    const yuki = result.items.find((m) => m.username === 'yuki');
    const cara = result.items.find((m) => m.username === 'cara');
    assert.equal(yuki.viewerFollowing, false);
    assert.equal(cara.viewerFollowing, true);
  });
  const batched = seen.filter(({ sql }) => /SELECT followed_id FROM user_follows WHERE follower_id/i.test(sql));
  assert.equal(batched.length, 1, 'single batched IN-query (no per-row N+1)');
});

test('every phase-3 query binds exactly its placeholders like Postgres would', async () => {
  const calls = [];
  const strict = async (sql, params = []) => {
    calls.push({ sql, params });
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(params.length, placeholders, `param count must match placeholders: ${sql.slice(0, 100)}`);
    if (/SELECT id_post_comment AS pid/i.test(sql)) return [[{ pid: 11, post: 7, author_id: OTHER_ID, parent: null, deleted: false }]];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 12 }];
    if (/UPDATE post_comments SET/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/SELECT author_id FROM post_comments/i.test(sql)) return [[{ author_id: OTHER_ID }]];
    if (/GROUP BY c\.parent_comment_id/i.test(sql)) return [[{ parent: 11, total: '1' }]];
    if (/FROM post_comments c/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
      if (/GROUP BY/i.test(sql)) return [[{ parent: 11, total: '1' }]];
      if (/parent_comment_id IN/i.test(sql)) {
        return [[{ id: 21, author_id: THIRD_ID, body: 'r', created_at: '2026-10-07', updated_at: null, parent: 11, author_username: 'cara', author_display: null, author_avatar: null }]];
      }
      return [[TOP_ROW]];
    }
    if (/SELECT followed_id FROM user_follows WHERE follower_id/i.test(sql)) return [[]];
    if (/SELECT follower_id, followed_id FROM user_follows/i.test(sql)) return [[]];
    if (/SELECT EXISTS.*user_follows/i.test(sql)) return [[{ following: 1, followed_by: 0 }]];
    if (/FROM user_follows f/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: null, avatar_url: null, bio: null }]];
    }
    if (/FROM user_profile WHERE username/i.test(sql)) {
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: null, bio: null, avatar_url: null, is_public: true, jlpt_level: null, target_jlpt: null, interests: null }]];
    }
    if (/FROM user_profile up/i.test(sql)) {
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: null, avatar_url: null, bio: null }]];
    }
    if (/FROM community_posts WHERE author_id/i.test(sql)) return [[{ posts: 1, followers: 0, following: 0 }]];
    if (/FROM vocabulary/i.test(sql)) return [[{ posts: 1, followers: 0, following: 0, vocabulary: 1, kanji: 0, grammar: 0 }]];
    if (/FROM notifications n/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
      return [[{ id: 9, actor_id: OTHER_ID, kind: 'reply', postId: 7, commentId: 12, isRead: false, actor_username: 'yuki', actor_display: null, actor_avatar: null, createdAt: '2026-10-07', post_title: 'hello', post_japanese: null, post_body: null }]];
    }
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 4 }];
    if (/^DELETE FROM notifications/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[]];
    if (/INSERT INTO content_reports/i.test(sql)) return [{ insertId: 21 }];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
  await withPoolExecute(strict, async () => {
    await service.createComment(pool, USER_ID, 7, 'top');
    await service.createComment(pool, USER_ID, 7, 'reply', 11);
    await service.listComments(pool, USER_ID, 7, {});
    await service.updateComment(pool, USER_ID, 12, 'edited');
    await service.deleteComment(pool, USER_ID, 12);
    await service.listNotifications(pool, USER_ID, {});
    await service.getCommunityProfile(pool, USER_ID, 'yuki');
    await service.searchCommunity(pool, USER_ID, 'yuki', { type: 'people' });
    await service.listFollows(pool, USER_ID, 'yuki', 'followers', {});
    await service.createReport(pool, USER_ID, { targetType: 'comment', targetId: 12, reason: 'spam' });
  });
  assert.ok(calls.length > 25, `touched a realistic query count, got ${calls.length}`);
});
