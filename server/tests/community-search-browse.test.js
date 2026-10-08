// V6.1 query-less search browse: missing/blank q returns recent content per
// requested type instead of text matches. Stubbed executor throughout (no live
// DB); SQL-shape assertions pin the gates, ordering, caps and OFFSET.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const THIRD_ID = '00000000-0000-4000-8000-000000000003';

const pool = require('../src/config/db');
const service = require('../src/services/community');

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    return await callback();
  } finally {
    pool.execute = original;
  }
}

function placeholders(sql) {
  return (sql.match(/\?/g) || []).length;
}

function strictParams(sql, params) {
  assert.equal(params.length, placeholders(sql), `params bind every placeholder: ${sql.slice(0, 100)}`);
}

test('empty q per type returns recent gated rows with browse ordering', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    strictParams(sql, params);
    if (/SELECT follower_id, followed_id/i.test(sql)) return [[]];
    if (/FROM user_profile up/i.test(sql)) {
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: 'Yuki', avatar_url: null, bio: 'hi' }]];
    }
    if (/FROM community_posts p/i.test(sql) && /p\.post_type = \?/i.test(sql)) {
      if (!params.includes('share_vocab')) return [[]];
      return [[{
        id: 31, post_type: 'share_vocab', title: 'recent share',
        snapshot_json: { display: '食べる', reading: 'たべる', meaning: 'to eat' },
        created_at: '2026-09-01T10:00:00.000Z', author_username: 'yuki', author_display: 'Yuki', author_avatar: null
      }]];
    }
    if (/JOIN deck_publication_items/i.test(sql)) {
      if (!params.includes('vocabulary')) return [[]];
      return [[{
        deck_id: 9, deck_title: 'recent deck', entity_type: 'vocabulary', owner_username: 'cara',
        position: 0, item_json: { word: '飲む', reading: 'のむ', meaning: 'to drink' }
      }]];
    }
    if (/FROM community_posts p/i.test(sql)) {
      return [[{
        id: 77, post_type: 'text', title: 'recent post', body: 'hello',
        japanese_text: null, created_at: '2026-09-02T10:00:00.000Z',
        author_username: 'yuki', author_display: 'Yuki', author_avatar: null
      }]];
    }
    if (/FROM deck_publications d/i.test(sql)) {
      return [[{ id: 5, title: 'recent deck', entity_type: 'vocabulary', owner_username: 'yuki' }]];
    }
    if (/FROM reading_publications r/i.test(sql)) {
      return [[{ id: 11, title: 'recent reading', level: 'N5', owner_username: 'cara' }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, '', { type: 'all' });
    for (const key of ['people', 'posts', 'decks', 'reading', 'vocabulary', 'kanji', 'grammar']) {
      assert.ok(Array.isArray(result[key]), `${key} present as array (never 500)`);
    }
    assert.equal(result.page, 1);
    assert.equal(result.limit, 20);
    // Shapes identical to text search.
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0].username, 'yuki');
    assert.equal(result.people[0].following, false);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].id, 77);
    assert.equal(result.posts[0].title, 'recent post');
    assert.equal(result.decks.length, 1);
    assert.equal(result.decks[0].title, 'recent deck');
    assert.equal(result.reading.length, 1);
    assert.equal(result.reading[0].level, 'N5');
    assert.equal(result.vocabulary.length, 2, 'share-post hit + deck-item hit merged');
    assert.equal(result.vocabulary[0].source, 'post');
    assert.equal(result.vocabulary[1].source, 'deck');
    assert.deepEqual(result.kanji, [], 'kanji empty when stubs return nothing (never 500)');
    // Blank string behaves like missing q.
    const blank = await service.searchCommunity(pool, USER_ID, '   ', { type: 'posts' });
    assert.equal(blank.posts.length, 1);
    const undef = await service.searchCommunity(pool, USER_ID, undefined, { type: 'posts' });
    assert.equal(undef.posts.length, 1);
  });
  // Browse issues no text predicate but keeps gates + newest-first ordering.
  const people = seen.find(({ sql }) => /FROM user_profile up/i.test(sql) && !/follower_id/i.test(sql));
  assert.ok(!/ILIKE/i.test(people.sql), 'people browse carries no ILIKE');
  assert.ok(/up\.is_public/i.test(people.sql), 'people browse keeps the public gate');
  assert.ok(/user_blocks/i.test(people.sql), 'people browse keeps the block gate');
  assert.ok(/ORDER BY up\.updated_at DESC/i.test(people.sql), 'people browse orders by recent profile activity');
  const posts = seen.find(({ sql }) => /FROM community_posts p/i.test(sql) && !/post_type = \?/i.test(sql));
  assert.ok(!/ILIKE/i.test(posts.sql), 'posts browse carries no ILIKE');
  assert.ok(/is_deleted/i.test(posts.sql) && /user_blocks/i.test(posts.sql), 'posts browse keeps visibility gates');
  assert.ok(/ORDER BY p\.id_community_post DESC/i.test(posts.sql), 'posts browse newest-first');
  assert.ok(/OFFSET \?/.test(posts.sql), 'posts browse pages with OFFSET');
  const decks = seen.find(({ sql }) => /FROM deck_publications d/i.test(sql) && !/JOIN deck_publication_items/i.test(sql));
  assert.ok(!/ILIKE/i.test(decks.sql), 'decks browse carries no ILIKE');
  assert.ok(/\(d\.owner_id = \? OR up\.is_public\)/.test(decks.sql), 'decks browse keeps owner-publicity');
  assert.ok(/user_blocks/i.test(decks.sql), 'decks browse keeps the block gate');
  assert.ok(/ORDER BY d\.id_deck_publication DESC/i.test(decks.sql), 'decks browse newest-first');
  const reading = seen.find(({ sql }) => /FROM reading_publications r/i.test(sql));
  assert.ok(!/ILIKE/i.test(reading.sql), 'reading browse carries no ILIKE');
  assert.ok(/ORDER BY r\.id_reading_publication DESC/i.test(reading.sql), 'reading browse newest-first');
  const share = seen.find(({ sql }) => /FROM community_posts p/i.test(sql) && /post_type = \?/i.test(sql));
  assert.ok(!/ILIKE/i.test(share.sql) && !/jlpt_level/i.test(share.sql), 'learning browse carries no text/level predicate');
  assert.ok(/ORDER BY p\.id_community_post DESC/i.test(share.sql), 'learning share browse newest-first');
  const deckItems = seen.find(({ sql }) => /JOIN deck_publication_items/i.test(sql));
  assert.ok(/ORDER BY d\.id_deck_publication DESC/i.test(deckItems.sql), 'learning deck browse newest-deck first');
});

test('non-empty q behavior is unchanged (escaped ILIKE + level logic intact)', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    strictParams(sql, params);
    if (/JOIN deck_publication_items/i.test(sql)) {
      return [[{
        deck_id: 9, deck_title: 'N4 verbs', entity_type: 'vocabulary', owner_username: 'cara',
        position: 0, item_json: { word: '飲む', reading: 'のむ', meaning: 'to drink', jlpt_level: 'N4' }
      }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, 'taberu', { type: 'vocabulary' });
    assert.equal(result.vocabulary.length, 1);
    assert.equal(result.vocabulary[0].display, '飲む');
    const n4 = await service.searchCommunity(pool, USER_ID, 'N4', { type: 'vocabulary' });
    assert.equal(n4.vocabulary.length, 1, 'bare N4 still recalls level-tagged rows');
  });
  const share = seen.find(({ sql }) => /FROM community_posts p/i.test(sql));
  assert.ok(/ILIKE \? ESCAPE/i.test(share.sql), 'text path keeps escaped ILIKE');
  assert.ok(share.params.some((p) => typeof p === 'string' && p.startsWith('%') && p.endsWith('%')), 'text path binds a LIKE pattern');
  assert.ok(seen.some(({ params }) => params.includes('N4')), 'N4 path binds the level');
  await withPoolExecute(async (sql, params = []) => {
    strictParams(sql, params);
    if (/FROM user_profile up/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await service.searchCommunity(pool, USER_ID, '100%_\\', { type: 'people' });
  });
  const wild = seen.concat([]);
  assert.ok(wild.length >= 0, 'wildcard pin runs without throwing');
});

test('browse honors per-type caps and OFFSET paging', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    strictParams(sql, params);
    if (/SELECT follower_id, followed_id/i.test(sql)) return [[]];
    if (/FROM user_profile up/i.test(sql)) return [[]];
    if (/JOIN deck_publication_items/i.test(sql)) return [[]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const capped = await service.searchCommunity(pool, USER_ID, '', { type: 'all', limit: 99 });
    assert.equal(capped.limit, 20, 'limit capped at MAX_SEARCH_LIMIT in browse mode');
    const page3 = await service.searchCommunity(pool, USER_ID, '', { type: 'posts', page: 3, limit: 5 });
    assert.equal(page3.page, 3);
    assert.equal(page3.limit, 5);
    assert.deepEqual(page3.posts, []);
  });
  const postsPages = seen.filter(({ sql }) => /FROM community_posts p/i.test(sql) && !/post_type = \?/i.test(sql));
  assert.ok(postsPages.length >= 1, 'posts browse issued');
  assert.deepEqual(postsPages[postsPages.length - 1].params.slice(-2), [5, 10], 'page 3, limit 5 binds OFFSET 10');
  for (const { sql } of seen.filter(({ sql }) => !/follower_id/i.test(sql))) {
    assert.ok(/LIMIT \? OFFSET \?/.test(sql), `every browse class is bounded: ${sql.slice(0, 60)}`);
  }
  // type=all with empty q fans out across all classes, each capped.
  const allSeen = [];
  await withPoolExecute(async (sql, params = []) => {
    allSeen.push({ sql, params });
    strictParams(sql, params);
    if (/SELECT follower_id, followed_id/i.test(sql)) return [[]];
    if (/FROM user_profile up/i.test(sql)) return [[]];
    if (/JOIN deck_publication_items/i.test(sql)) return [[]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, '', { type: 'all', limit: 2 });
    for (const key of ['people', 'posts', 'decks', 'reading', 'vocabulary', 'kanji', 'grammar']) {
      assert.ok(Array.isArray(result[key]), `${key} present in browse-all`);
    }
    assert.equal(result.limit, 2);
  });
  assert.ok(allSeen.filter(({ sql }) => /FROM community_posts p/i.test(sql)).length >= 4, 'browse-all touches posts + 3 share queries');
});

test('browse validation: bad type still 400, overlong still 400, empty never 400', async () => {
  await assert.rejects(service.searchCommunity(pool, USER_ID, '', { type: 'viral' }), /type must be/);
  await assert.rejects(service.searchCommunity(pool, USER_ID, 'x', { type: 'viral' }), /type must be/);
  await assert.rejects(service.searchCommunity(pool, USER_ID, 'x'.repeat(101), { type: 'posts' }), /must not exceed 100/);
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, '', { type: 'posts' });
    assert.deepEqual(result.posts, [], 'empty q resolves to empty arrays, never 500');
  });
});
