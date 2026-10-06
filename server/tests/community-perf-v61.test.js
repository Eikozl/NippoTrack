 // V6.1 Phase 7-perf single-query feed counts plus unread badge plus blocked paging.
 const test = require('node:test');
 const assert = require('node:assert/strict');
 process.env.NODE_ENV = 'test';
 process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
 const USER_ID = '00000000-0000-4000-8000-000000000001';
 const OTHER_ID = '00000000-0000-4000-8000-000000000002';
 const pool = require('../src/config/db');
 const service = require('../src/services/community');
 const controller = require('../src/controllers/communityController');
 async function withPoolExecute(stub, callback) {
   const original = pool.execute;
   pool.execute = stub;
   try { await callback(); } finally { pool.execute = original; }
 }
 function placeholders(sql) { return (sql.match(/\?/g) || []).length; }
function mockRes() {
   let statusCode = 200;
   let body;
   const res = { status(code) { statusCode = code; return res; }, json(value) { body = value; return res; } };
   return { res: res, status: function() { return statusCode; }, body: function() { return body; } };
 }
 const FEED_ROW = {
   id: 1, author_id: OTHER_ID, post_type: 'text',
   title: null, body: 'hello', japanese_text: null, translation: null,
   entity_type: null, entity_id: null, deck_id: null, reading_id: null,
   like_count: 3, comment_count: 1, liked: 1,
   author_username: 'yuki', author_display: 'Yuki', author_avatar: null,
   created_at: '2026-10-07', updated_at: null
 };
 test('feed counts come from LEFT JOIN plus GROUP BY in one trip, same numbers', async function() {
   const seen = [];
   const stub = async function(sql, params) {
     params = params || [];
     seen.push({ sql: sql, params: params });
     assert.equal(params.length, placeholders(sql), 'params bind every placeholder');
     if (/SELECT COUNT/.test(sql) && /FROM community_posts p/i.test(sql)) { return [[{ total: '1' }]]; }
     if (/FROM community_posts p/i.test(sql)) { return [[FEED_ROW]]; }
     throw new Error('Unexpected feed SQL');
   };
   await withPoolExecute(stub, async function() {
     const result = await service.listFeed(pool, USER_ID, { tab: 'latest', page: 1, limit: 20 });
     assert.equal(result.items.length, 1);
     assert.equal(result.items[0].likeCount, 3);
     assert.equal(result.items[0].commentCount, 1);
     assert.equal(result.items[0].liked, true);
     const post = await service.getPost(pool, USER_ID, 1);
     assert.equal(post.likeCount, 3);
     assert.equal(post.commentCount, 1);
     assert.equal(post.liked, true);
   });
   assert.ok(seen.length <= 4, 'bounded query count');
   const page = seen.filter(function(entry) { return /FROM community_posts p/i.test(entry.sql) && /LIMIT/.test(entry.sql); })[0];
   assert.ok(/LEFT JOIN post_likes/i.test(page.sql), 'likes join present');
   assert.ok(/LEFT JOIN post_comments/i.test(page.sql), 'comments join present');
   assert.ok(/GROUP BY/i.test(page.sql), 'grouped in one query');
   assert.ok(/COUNT/.test(page.sql) && /DISTINCT/.test(page.sql), 'distinct counts avoid fan-out miscount');
   const detail = seen.filter(function(entry) { return /WHERE p.id_community_post/i.test(entry.sql); })[0];
   assert.ok(/GROUP BY/i.test(detail.sql), 'detail grouped too');
 });
 test('unread-count is one indexed COUNT with shape and scoping', async function() {
   const seen = [];
   await withPoolExecute(async function(sql, params) {
     params = params || [];
     seen.push({ sql: sql, params: params });
     assert.equal(params.length, placeholders(sql), 'unread binds one placeholder');
     if (/FROM notifications/i.test(sql)) { return [[{ total: '3' }]]; }
     throw new Error('Unexpected unread SQL');
   }, async function() {
     const unread = await service.getUnreadCount(pool, USER_ID);
     assert.equal(unread, 3);
     const m = mockRes();
     await controller.getUnreadCount({ user: { id: USER_ID } }, m.res);
     assert.equal(m.status(), 200);
     assert.deepEqual(m.body(), { unread: 3 });
   });
   assert.equal(seen.length, 2, 'service plus controller each one query');
   for (const entry of seen) {
     assert.ok(/COUNT/.test(entry.sql), 'count only');
     assert.ok(entry.params[0] === USER_ID, 'scoped to caller');
     assert.ok(!/JOIN community_posts/i.test(entry.sql), 'no post join, index covered');
     assert.ok(!/LIMIT/.test(entry.sql) || /COUNT/.test(entry.sql), 'no row select');
   }
 });
 test('blocked list is bounded with default 20 and max 50', async function() {
   async function runWith(options, total, rows) {
     const seen = [];
     const stub = async function(sql, params) {
       params = params || [];
       seen.push({ sql: sql, params: params });
       assert.equal(params.length, placeholders(sql), 'blocked binds every placeholder');
       if (/COUNT/.test(sql) && /FROM user_blocks/i.test(sql)) { return [[{ total: String(total) }]]; }
       if (/FROM user_blocks b/i.test(sql)) { return [rows]; }
       throw new Error('Unexpected blocked SQL');
     };
     let out;
     await withPoolExecute(stub, async function() { out = await service.listBlockedUsers(pool, USER_ID, options); });
     return { out: out, seen: seen };
   }
   const row = { user_id: OTHER_ID, username: 'cara', display_name: null, avatar_url: null };
   const d = await runWith({}, 1, [row]);
   assert.equal(d.out.limit, 20, 'default 20');
   assert.equal(d.out.items[0].username, 'cara');
   const m = await runWith({ limit: 500 }, 1, [row]);
   assert.equal(m.out.limit, 50, 'clamped to max 50');
   const p = await runWith({ page: 3, limit: 5 }, 12, [row]);
   assert.equal(p.out.page, 3);
   const pageQuery = p.seen.filter(function(e) { return /LIMIT/.test(e.sql); })[0];
   assert.deepEqual(pageQuery.params.slice(-2), [5, 10], 'page 3 limit 5 binds offset 10');
   const e = await runWith({}, 0, []);
   assert.deepEqual(e.out.items, []);
   assert.equal(e.out.totalPages, 0);
   assert.equal(e.seen.length, 1, 'empty skips page query');
 });
 test('discover popular and questions use JOIN counts with placeholder binding', async function() {
   const seen = [];
   await withPoolExecute(async function(sql, params) {
     params = params || [];
     seen.push({ sql: sql, params: params });
     assert.equal(params.length, placeholders(sql), 'discover binds every placeholder');
     if (/GROUP BY up.user_id/i.test(sql)) { return [[]]; }
     if (/INTERVAL/.test(sql)) { return [[FEED_ROW]]; }
     if (/FROM deck_publications/i.test(sql)) { return [[]]; }
     if (/FROM reading_publications/i.test(sql)) { return [[]]; }
     if (/post_type/.test(sql)) { return [[FEED_ROW]]; }
     if (/SELECT follower_id/i.test(sql)) { return [[]]; }
     throw new Error('Unexpected discover SQL');
   }, async function() { await service.getDiscover(pool, USER_ID); });
   const popular = seen.filter(function(e) { return /INTERVAL/.test(e.sql); })[0];
   assert.ok(/LEFT JOIN/i.test(popular.sql), 'popular joined');
   assert.ok(/GROUP BY/i.test(popular.sql), 'popular grouped');
   const questions = seen.filter(function(e) { return /post_type/.test(e.sql); })[0];
   assert.ok(/GROUP BY/i.test(questions.sql), 'questions grouped');
 });
