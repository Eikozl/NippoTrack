// V6.1 Phase 2a: one-level replies model + block/notification hardening.
// Stubbed executor throughout (no live DB needed); SQL-shape assertions pin
// the new gates the way 'gates carry the viewer' does elsewhere, plus a
// strict placeholder-binding pass mirroring community-feed's regression test
// (stubs ignore positions, only counting catches Postgres rejections).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const BLOCKED_ID = '00000000-0000-4000-8000-000000000003';

const pool = require('../src/config/db');
const service = require('../src/services/community');
const controller = require('../src/controllers/communityController');

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

const COMMENT_ROW = {
  id: 11, author_id: OTHER_ID, body: 'nice', created_at: '2026-10-07', updated_at: null,
  author_username: 'yuki', author_display: null, author_avatar: null
};

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

test('migration 041 enforces one-level replies at the DB level', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../db/migrations-postgres/041_community_replies.sql'), 'utf8'
  );
  // Additive-only model change on the real identity PK (id_post_comment;
  // there is no post_comments(id) column — the spec shorthand is corrected).
  assert.match(sql, /ADD COLUMN IF NOT EXISTS parent_comment_id/i);
  assert.match(sql, /REFERENCES post_comments\s*\(\s*id_post_comment\s*\)/i);
  assert.match(sql, /ON DELETE CASCADE/i);
  // One-level enforcement: BEFORE INSERT OR UPDATE trigger rejecting a
  // parent that is itself a reply, DROP+CREATE pattern per repo rules.
  assert.match(sql, /BEFORE INSERT OR UPDATE/i);
  assert.match(sql, /parent_comment_id IS NULL/i);
  assert.match(sql, /RAISE EXCEPTION/i);
  assert.match(sql, /DROP TRIGGER IF EXISTS trg_post_comments_one_level/i);
  assert.match(sql, /CREATE TRIGGER trg_post_comments_one_level/i);
  // Reply-thread + comment-list indexes, both partial and cheap.
  assert.match(sql, /idx_post_comments_parent[\s\S]*WHERE parent_comment_id IS NOT NULL/i);
  assert.match(sql, /WHERE NOT is_deleted/i);
  // Runtime boundary unchanged: RLS + revoke + least-privilege grant.
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE post_comments FROM PUBLIC/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE post_comments TO jlt_runtime/i);
});

test('comment writes stay single-level; nested reply payloads are rejected', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 11 }];
    if (/FROM post_comments c/i.test(sql)) return [[COMMENT_ROW]];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 4 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await service.createComment(pool, USER_ID, 7, 'nice');
  });
  const insert = seen.find(({ sql }) => /INSERT INTO post_comments/i.test(sql));
  assert.ok(insert, 'comment insert issued');
  assert.ok(!/parent_comment_id/i.test(insert.sql), 'top-level write carries no parent column');
  // V6.1 Phase 3: the HTTP layer now ACCEPTS parentCommentId (one-level
  // replies). Unknown-field rejection still applies to anything else.
  await withPoolExecute(async (sql) => {
    if (/SELECT id_post_comment AS pid/i.test(sql)) {
      return [[{ pid: 11, post: 7, author_id: OTHER_ID, parent: null, deleted: false }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/INSERT INTO post_comments/i.test(sql)) {
      assert.ok(/parent_comment_id/i.test(sql), 'reply insert carries the parent column');
      return [{ insertId: 12 }];
    }
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 4 }];
    if (/FROM post_comments c/i.test(sql)) {
      return [[{ id: 12, author_id: USER_ID, body: 'reply', created_at: '2026-10-07', updated_at: null, parent: 11, author_username: 'me', author_display: null, author_avatar: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.createComment(
      { body: { body: 'reply', parentCommentId: 11 }, params: { id: '7' }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 201);
    assert.equal(body().parentCommentId, 11);
  });
  // Anything else is still an unexpected field (400, never silent).
  const bad = mockRes();
  await controller.createComment(
    { body: { body: 'x', bogus: 1 }, params: { id: '7' }, user: { id: USER_ID } },
    bad.res
  );
  assert.equal(bad.status(), 400);
  assert.match(bad.body().error, /Unexpected field/);
});

test('listComments hides blocked-pair and private-profile comments both ways', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
    if (/FROM post_comments c/i.test(sql)) return [[COMMENT_ROW]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.listComments(pool, USER_ID, 7, {});
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
  });
  for (const { sql, params } of seen.filter(({ sql }) => /FROM post_comments c/i.test(sql))) {
    assert.ok(/user_blocks/i.test(sql), 'blocked pairs excluded from comment queries');
    assert.ok(/up\.is_public/i.test(sql), 'comment-author publicity enforced');
    assert.ok(params.filter((p) => p === USER_ID).length >= 3, 'viewer binds every gate position');
  }
  const count = seen.find(({ sql }) => /COUNT\(\*\)/i.test(sql));
  assert.ok(/JOIN user_profile/i.test(count.sql), 'comment total joins the author profile for the same gates');
});

test('listFollows filters members to public, unblocked profiles', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: OTHER_ID, is_public: true }]];
    // NOTE: member COUNT/SELECT carry an embedded FROM user_blocks inside
    // NOT EXISTS, so they are matched before the standalone block check.
    // The viewerFollowing IN-query (Phase 3) sorts before the member reads.
    if (/SELECT followed_id FROM user_follows WHERE follower_id/i.test(sql)) return [[]];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
    if (/FROM user_follows f/i.test(sql)) {
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: null, avatar_url: null, bio: null }]];
    }
    if (/FROM user_blocks/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.listFollows(pool, USER_ID, 'yuki', 'followers', {});
    assert.equal(result.total, 1);
    assert.equal(result.items[0].username, 'yuki');
    assert.equal(result.items[0].viewerFollowing, false);
  });
  const memberQueries = seen.filter(({ sql }) => /FROM user_follows f/i.test(sql));
  assert.equal(memberQueries.length, 2, 'count + page both filtered');
  for (const { sql, params } of memberQueries) {
    assert.ok(/up\.is_public/i.test(sql), 'private-profile members excluded');
    assert.ok(/user_blocks/i.test(sql), 'blocked members excluded both ways');
    assert.ok(params.filter((p) => p === USER_ID).length >= 3, 'viewer binds every gate position');
  }
});

test('notifications exclude deleted and no-longer-visible posts', async () => {
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
    assert.equal(inbox.total, 2);
    assert.equal(inbox.unread, 1);
  });
  const notifQueries = seen.filter(({ sql }) => /FROM notifications n/i.test(sql));
  assert.equal(notifQueries.length, 3, 'total + unread + page all re-check the post');
  for (const { sql } of notifQueries) {
    assert.ok(/NOT p\.is_deleted/i.test(sql), 'deleted posts drop out of the inbox');
    assert.ok(/user_blocks/i.test(sql), 'blocked/private posts drop out of the inbox');
    assert.ok(/n\.id_community_post IS NULL/i.test(sql), 'follow notifications (no post) still pass');
  }
});

test('notification summary excludes deleted and no-longer-visible posts', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/GROUP BY/i.test(sql)) return [[{ kind: 'like', count: '2' }, { kind: 'follow', count: '1' }]];
    if (/n\.kind = 'like'/i.test(sql)) return [[{ id: 7, title: 'hello', japanese_text: null }]];
    if (/n\.kind = 'comment'/i.test(sql)) return [[]];
    if (/n\.kind = 'follow'/i.test(sql)) return [[{ username: 'yuki', display_name: null }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const summary = await service.getNotificationSummary(pool, USER_ID);
    assert.equal(summary.unread, 3);
    assert.equal(summary.likes.count, 2);
    assert.equal(summary.likes.posts[0].title, 'hello');
    assert.deepEqual(summary.follows.actors, ['yuki']);
  });
  const postQueries = seen.filter(({ sql }) => /community_posts p/i.test(sql));
  assert.equal(postQueries.length, 3, 'counts + like/comment previews re-check the post');
  for (const { sql } of postQueries) {
    assert.ok(/NOT p\.is_deleted/i.test(sql), 'deleted posts drop out of the summary');
    assert.ok(/user_blocks/i.test(sql), 'blocked/private posts drop out of the summary');
  }
});

test('comment self-reports are rejected; deleted comments resolve to 404-shape null', async () => {
  // Self-report: author lookup returns the reporter.
  await withPoolExecute(async (sql) => {
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/SELECT author_id FROM post_comments/i.test(sql)) return [[{ author_id: USER_ID }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(
      service.createReport(pool, USER_ID, { targetType: 'comment', targetId: 11, reason: 'spam' }),
      /own comment/
    );
  });
  // Deleted comment: postIdForComment filters NOT is_deleted → null (404).
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM post_comments/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(
      await service.createReport(pool, USER_ID, { targetType: 'comment', targetId: 11, reason: 'spam' }),
      null
    );
  });
  assert.ok(seen.some(({ sql }) => /NOT is_deleted/i.test(sql)), 'deleted comments are invisible to reports');
  // Third-party comment on a visible post still reports.
  await withPoolExecute(async (sql) => {
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/SELECT author_id FROM post_comments/i.test(sql)) return [[{ author_id: OTHER_ID }]];
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[]];
    if (/INSERT INTO content_reports/i.test(sql)) return [{ insertId: 21 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.deepEqual(
      await service.createReport(pool, USER_ID, { targetType: 'comment', targetId: 11, reason: 'spam' }),
      { id: 21 }
    );
  });
});

test('unlike and comment delete clean their orphan notifications, best-effort', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM post_likes/i.test(sql)) return [[{ '1': 1 }]];
    if (/^DELETE FROM post_likes/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/^DELETE FROM notifications/i.test(sql.trim())) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const unliked = await service.toggleLike(pool, USER_ID, 7);
    assert.equal(unliked.liked, false);
  });
  const unlikeCleanup = seen.find(({ sql }) => /^DELETE FROM notifications/i.test(sql.trim()));
  assert.ok(unlikeCleanup, 'unlike deletes the like notification');
  assert.match(unlikeCleanup.sql, /kind = 'like'/i);
  assert.deepEqual(unlikeCleanup.params, [OTHER_ID, USER_ID, 7], 'cleanup targets the author inbox for this actor+post');
  // Cleanup failure never fails the unlike itself.
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM post_likes/i.test(sql)) return [[{ '1': 1 }]];
    if (/^DELETE FROM post_likes/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/^DELETE FROM notifications/i.test(sql.trim())) throw new Error('inbox unavailable');
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const unliked = await service.toggleLike(pool, USER_ID, 7);
    assert.equal(unliked.liked, false);
  });
  // Comment delete cleans the comment notification; failure is tolerated too.
  const seenDelete = [];
  const deleteStub = (failCleanup) => async (sql, params = []) => {
    seenDelete.push({ sql, params });
    if (/UPDATE post_comments SET/i.test(sql)) return [{ affectedRows: 1 }];
    if (/^DELETE FROM notifications/i.test(sql.trim())) {
      if (failCleanup) throw new Error('inbox unavailable');
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  };
  await withPoolExecute(deleteStub(false), async () => {
    assert.deepEqual(await service.deleteComment(pool, USER_ID, 11), { deletedId: 11 });
  });
  const commentCleanup = seenDelete.find(({ sql }) => /^DELETE FROM notifications/i.test(sql.trim()));
  assert.ok(commentCleanup, 'comment delete removes the comment notification');
  // V6.1 Phase 3: cleanup covers both comment + reply inbox rows (same table).
  assert.match(commentCleanup.sql, /'comment'/i);
  assert.match(commentCleanup.sql, /'reply'/i);
  assert.deepEqual(commentCleanup.params, [11]);
  await withPoolExecute(deleteStub(true), async () => {
    assert.deepEqual(await service.deleteComment(pool, USER_ID, 11), { deletedId: 11 });
  });
});

test('updateComment gates on parent-post visibility before touching the row', async () => {
  // Validation still runs first: no query is issued for garbage input.
  await withPoolExecute(async () => { throw new Error('must not query on invalid input'); }, async () => {
    await assert.rejects(service.updateComment(pool, USER_ID, 11, ''), /body is required/);
    await assert.rejects(service.updateComment(pool, USER_ID, 0, 'x'), /positive integer/);
  });
  // Hidden parent (deleted/private/blocked → getPost null): 404-shape null,
  // and the owned-row UPDATE is never issued.
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await service.updateComment(pool, USER_ID, 11, 'edited'), null);
  });
  assert.ok(!seen.some(({ sql }) => /UPDATE post_comments SET/i.test(sql)), 'no edit on hidden threads');
});

test('linked content ids are positive integers (400 on garbage, no query)', async () => {
  const failOnQuery = async () => { throw new Error('must not query on invalid input'); };
  await withPoolExecute(failOnQuery, async () => {
    await assert.rejects(
      service.createPost(pool, USER_ID, { postType: 'text', body: 'hi', entityType: 'vocabulary', entityId: 'abc' }),
      /entityId must be a positive integer/
    );
    await assert.rejects(
      service.createPost(pool, USER_ID, { postType: 'share_deck', deckId: 'nope' }),
      /deckId must be a positive integer/
    );
    await assert.rejects(
      service.createPost(pool, USER_ID, { postType: 'share_reading', readingId: 0 }),
      /readingId must be a positive integer/
    );
  });
  // Blocked-party visibility constant (unused here) keeps the intent explicit.
  assert.equal(BLOCKED_ID.length, 36);
});

test('every touched query binds exactly its placeholders like Postgres would', async () => {
  const calls = [];
  const strict = async (sql, params = []) => {
    calls.push({ sql, params });
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(params.length, placeholders, `param count must match placeholders: ${sql.slice(0, 100)}`);
    if (/INSERT INTO community_posts/i.test(sql)) return [{ insertId: 7 }];
    // NOTE: the delete UPDATE embeds FROM community_posts in EXISTS, so the
    // comment write branches sort before the post read branch.
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 11 }];
    if (/UPDATE post_comments SET/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT id_post_comment AS pid/i.test(sql)) return [[{ pid: 11, post: 7, author_id: OTHER_ID, parent: null, deleted: false }]];
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/SELECT author_id FROM post_comments/i.test(sql)) return [[{ author_id: OTHER_ID }]];
    if (/SELECT parent_comment_id AS parent/i.test(sql)) return [[]];
    if (/GROUP BY c\.parent_comment_id/i.test(sql)) return [[]];
    if (/FROM post_comments c/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
      if (/GROUP BY/i.test(sql)) return [[]];
      return [[COMMENT_ROW]];
    }
    if (/SELECT 1 FROM post_likes/i.test(sql)) return [[]];
    if (/INSERT INTO post_likes/i.test(sql)) return [{ affectedRows: 1 }];
    if (/^DELETE FROM post_likes/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 4 }];
    if (/^DELETE FROM notifications/i.test(sql.trim())) return [{ affectedRows: 1 }];
    if (/UPDATE notifications SET/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM notifications n/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
      if (/GROUP BY/i.test(sql)) return [[{ kind: 'like', count: '1' }]];
      return [[{ id: 9, actor_id: OTHER_ID, kind: 'like', postId: 7, commentId: null, isRead: false, actor_username: 'yuki', actor_display: null, actor_avatar: null, createdAt: '2026-10-07', post_title: 'hello', post_japanese: null, post_body: null }]];
    }
    if (/SELECT followed_id FROM user_follows WHERE follower_id/i.test(sql)) return [[]];
    if (/FROM user_follows f/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '1' }]];
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: null, avatar_url: null, bio: null }]];
    }
    if (/SELECT EXISTS.*user_follows/i.test(sql)) return [[{ following: 1, followed_by: 0 }]];
    if (/FROM user_profile WHERE username/i.test(sql)) return [[{ user_id: OTHER_ID, is_public: true }]];
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[]];
    if (/INSERT INTO content_reports/i.test(sql)) return [{ insertId: 21 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
  await withPoolExecute(strict, async () => {
    await service.listComments(pool, USER_ID, 7, {});
    await service.updateComment(pool, USER_ID, 11, 'edited');
    await service.deleteComment(pool, USER_ID, 11);
    await service.listFollows(pool, USER_ID, 'yuki', 'followers', {});
    await service.listFollows(pool, USER_ID, 'yuki', 'following', {});
    await service.listNotifications(pool, USER_ID, {});
    await service.listNotifications(pool, USER_ID, { unreadOnly: true });
    await service.getNotificationSummary(pool, USER_ID);
    await service.toggleLike(pool, USER_ID, 7);
    await service.createReport(pool, USER_ID, { targetType: 'post', targetId: 7, reason: 'spam' });
    await service.createReport(pool, USER_ID, { targetType: 'comment', targetId: 11, reason: 'spam' });
  });
  assert.ok(calls.length > 20, `touched a realistic query count, got ${calls.length}`);
});
