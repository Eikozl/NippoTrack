// V6.1 Phase 4-backend: learning-item search (vocabulary/kanji/grammar) +
// Discover sections. Stubbed executor throughout (no live DB); SQL-shape
// assertions pin the privacy gates, behavioral pins cover merging, mapping,
// level recall and deterministic ranking.
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

function placeholders(sql) {
  return (sql.match(/\?/g) || []).length;
}

const SHARE_VOCAB_ROW = {
  id: 31, post_type: 'share_vocab', title: 'taberu share',
  snapshot_json: { display: '食べる', reading: 'たべる', meaning: 'to eat' },
  created_at: '2026-09-01T10:00:00.000Z',
  author_username: 'yuki', author_display: 'Yuki', author_avatar: null
};

const DECK_VOCAB_ROW = {
  deck_id: 9, deck_title: 'N4 verbs', entity_type: 'vocabulary',
  owner_username: 'cara', position: 2,
  item_json: { word: '飲む', reading: 'のむ', meaning: 'to drink', jlpt_level: 'N4' }
};

test('learning-item search happy path: share-post + deck-item hits merge with source flags', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    assert.equal(params.length, placeholders(sql), `params bind every placeholder: ${sql.slice(0, 80)}`);
    if (/JOIN deck_publication_items/i.test(sql)) return [[{ ...DECK_VOCAB_ROW }]];
    if (/FROM community_posts p/i.test(sql)) {
      return [[
        { ...SHARE_VOCAB_ROW },
        { ...SHARE_VOCAB_ROW, id: 32, snapshot_json: JSON.stringify({ display: '見る', reading: 'みる', meaning: 'to see' }) }
      ]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, 'taberu', { type: 'vocabulary' });
    assert.equal(result.vocabulary.length, 3, '2 share-post hits + 1 deck-item hit');
    const [first, second, third] = result.vocabulary;
    // Posts first (newest first), then deck hits.
    assert.equal(first.source, 'post');
    assert.equal(first.postId, 31);
    assert.equal(first.deckId, null);
    assert.equal(first.display, '食べる');
    assert.equal(first.reading, 'たべる');
    assert.equal(first.meaning, 'to eat');
    assert.equal(first.title, 'taberu share');
    assert.equal(first.authorUsername, 'yuki');
    // String snapshot_json parses identically to an object snapshot.
    assert.equal(second.display, '見る');
    assert.equal(third.source, 'deck');
    assert.equal(third.postId, null);
    assert.equal(third.deckId, 9);
    assert.equal(third.position, 2);
    assert.equal(third.display, '飲む');
    assert.equal(third.level, 'N4');
    assert.equal(third.title, 'N4 verbs');
    assert.equal(third.authorUsername, 'cara');
    // Untouched classes stay empty; paging keys present.
    assert.deepEqual(result.kanji, []);
    assert.deepEqual(result.grammar, []);
    assert.deepEqual(result.posts, []);
    assert.equal(result.page, 1);
  });
  assert.equal(seen.length, 2, 'one share-post query + one deck-item query (bounded)');
  const [share, deck] = seen;
  assert.ok(/p\.post_type = \?/.test(share.sql), 'share query filters the entity post type');
  assert.ok(share.params.includes('share_vocab'), 'vocabulary searches share_vocab posts');
  assert.ok(/ESCAPE/.test(share.sql) && /OFFSET \?/.test(share.sql), 'escaped ILIKE + real OFFSET');
  assert.ok(/user_blocks/i.test(share.sql) && /is_public/i.test(share.sql), 'share hits reuse the post visibility posture');
  assert.ok(/d\.entity_type = \?/.test(deck.sql) && deck.params.includes('vocabulary'), 'deck hits filter the entity type');
  assert.ok(/\(d\.owner_id = \? OR up\.is_public\)/.test(deck.sql), 'deck hits require a public owner unless self');
  assert.ok(/user_blocks/i.test(deck.sql), 'deck hits gate blocked pairs both ways');
  assert.ok(/'word'/.test(deck.sql), 'vocabulary matches the word snapshot key');
});

test('kanji and grammar types filter the right share post type and display key', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/JOIN deck_publication_items/i.test(sql)) {
      if (params.includes('kanji')) {
        return [[{ deck_id: 4, deck_title: 'N5 kanji', entity_type: 'kanji', owner_username: 'yuki', position: 0, item_json: { character_kanji: '水', meaning: 'water', jlpt_level: 'N5' } }]];
      }
      return [[{ deck_id: 6, deck_title: 'tai form', entity_type: 'grammar', owner_username: 'yuki', position: 1, item_json: { grammar_point: '〜たい', meaning: 'want to' } }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const kanji = await service.searchCommunity(pool, USER_ID, 'mizu', { type: 'kanji' });
    assert.deepEqual(kanji.vocabulary, [], 'vocabulary stays empty on a kanji search');
    assert.equal(kanji.kanji.length, 1);
    assert.equal(kanji.kanji[0].display, '水');
    assert.equal(kanji.kanji[0].reading, null, 'kanji snapshots carry no reading');
    assert.equal(kanji.kanji[0].level, 'N5');
    const grammar = await service.searchCommunity(pool, USER_ID, 'tai', { type: 'grammar' });
    assert.equal(grammar.grammar.length, 1);
    assert.equal(grammar.grammar[0].display, '〜たい');
    assert.equal(grammar.grammar[0].level, null, 'missing level maps to null, never garbage');
  });
  const shareQueries = seen.filter(({ sql }) => /FROM community_posts p/i.test(sql));
  assert.ok(shareQueries.some(({ params }) => params.includes('share_kanji')), 'kanji searches share_kanji posts');
  assert.ok(shareQueries.some(({ params }) => params.includes('share_grammar')), 'grammar searches share_grammar posts');
  const deckQueries = seen.filter(({ sql }) => /JOIN deck_publication_items/i.test(sql));
  assert.ok(deckQueries.some(({ sql }) => /'character_kanji'/.test(sql)), 'kanji matches the character snapshot key');
  assert.ok(deckQueries.some(({ sql }) => /'grammar_point'/.test(sql)), 'grammar matches the grammar_point snapshot key');
  await assert.rejects(service.searchCommunity(pool, USER_ID, 'x', { type: 'vocabulario' }), /type must be/);
});

test('all includes top hits of new types alongside legacy classes, capped', async () => {
  await withPoolExecute(async (sql, params = []) => {
    if (/FROM user_profile up/i.test(sql)) return [[]];
    if (/JOIN deck_publication_items/i.test(sql)) {
      if (!params.includes('vocabulary')) return [[]];
      return [[
        { deck_id: 1, deck_title: 'd1', entity_type: 'vocabulary', owner_username: 'a', position: 0, item_json: { word: 'w1', meaning: 'm1' } },
        { deck_id: 2, deck_title: 'd2', entity_type: 'vocabulary', owner_username: 'a', position: 0, item_json: { word: 'w2', meaning: 'm2' } }
      ]];
    }
    if (/FROM community_posts p/i.test(sql) && /p\.post_type = \?/i.test(sql)) {
      if (!params.includes('share_vocab')) return [[]];
      return [[
        { id: 41, post_type: 'share_vocab', title: null, snapshot_json: { display: 's1', meaning: 'm' }, created_at: '2026-09-01', author_username: 'a' },
        { id: 42, post_type: 'share_vocab', title: null, snapshot_json: { display: 's2', meaning: 'm' }, created_at: '2026-09-02', author_username: 'a' }
      ]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[]];
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    if (/SELECT follower_id, followed_id/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.searchCommunity(pool, USER_ID, 'w', { type: 'all', limit: 2 });
    for (const key of ['people', 'posts', 'decks', 'reading', 'vocabulary', 'kanji', 'grammar']) {
      assert.ok(Array.isArray(result[key]), `${key} present (legacy keys intact, new keys additive)`);
    }
    // 2 share-post + 2 deck-item hits merged then truncated to limit 2.
    assert.equal(result.vocabulary.length, 2, 'merged list capped at the requested limit');
    assert.deepEqual(result.kanji, []);
    assert.deepEqual(result.grammar, []);
  });
});

test('privacy is load-bearing: no raw library table is ever queried; both sources gate', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM user_profile up/i.test(sql)) return [[]];
    if (/JOIN deck_publication_items/i.test(sql)) return [[]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    if (/SELECT follower_id, followed_id/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await service.searchCommunity(pool, USER_ID, 'taberu', { type: 'all' });
    await service.searchCommunity(pool, USER_ID, 'N4', { type: 'vocabulary' });
    await service.searchCommunity(pool, USER_ID, 'mizu', { type: 'kanji' });
    await service.searchCommunity(pool, USER_ID, 'tai', { type: 'grammar' });
  });
  for (const { sql } of seen) {
    // A private library item is unreachable: the vocabulary/kanji/
    // grammar_points tables never appear as a read source.
    assert.ok(!/\bFROM\s+(vocabulary|kanji|grammar_points)\b/i.test(sql), `no raw library read: ${sql.slice(0, 70)}`);
    assert.ok(!/\bJOIN\s+(vocabulary|kanji|grammar_points)\b/i.test(sql), `no raw library join: ${sql.slice(0, 70)}`);
  }
  const shareQueries = seen.filter(({ sql }) => /FROM community_posts p/i.test(sql) && /snapshot_json/i.test(sql));
  assert.ok(shareQueries.length >= 3, 'learning share queries issued');
  for (const { sql, params } of shareQueries) {
    // A blocked author's shared item is filtered in SQL, same as posts.
    assert.ok(/user_blocks/i.test(sql), 'share hits exclude blocked pairs');
    assert.ok(/is_public/i.test(sql), 'share hits reuse the visibility posture');
    assert.ok(params.filter((p) => p === USER_ID).length >= 3, 'viewer binds every visibility position');
  }
  const deckQueries = seen.filter(({ sql }) => /JOIN deck_publication_items/i.test(sql));
  assert.ok(deckQueries.length >= 3, 'learning deck queries issued');
  for (const { sql } of deckQueries) {
    assert.ok(/\(d\.owner_id = \? OR up\.is_public\)/.test(sql), 'deck items require a public owner unless self');
    assert.ok(/user_blocks/i.test(sql), 'deck items exclude blocked pairs');
  }
});

test('N4 matches level-tagged shared material (deck jlpt_level + snapshot jlpt_level), plain text does not', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/JOIN deck_publication_items/i.test(sql)) {
      return [[{ deck_id: 9, deck_title: 'N4 verbs', entity_type: 'vocabulary', owner_username: 'cara', position: 0, item_json: { word: '飲む', reading: 'のむ', meaning: 'to drink', jlpt_level: 'N4' } }]];
    }
    if (/FROM community_posts p/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const n4 = await service.searchCommunity(pool, USER_ID, 'N4', { type: 'vocabulary' });
    assert.equal(n4.vocabulary.length, 1);
    assert.equal(n4.vocabulary[0].level, 'N4', 'level-tagged deck item recalled by a bare N4 query');
    const lower = await service.searchCommunity(pool, USER_ID, ' n4 ', { type: 'vocabulary' });
    assert.equal(lower.vocabulary.length, 1, 'level recall is case-insensitive and trim-tolerant');
    const plain = await service.searchCommunity(pool, USER_ID, 'nomu', { type: 'vocabulary' });
    assert.equal(plain.vocabulary.length, 1, 'text search still hits by display/reading/meaning');
  });
  const n4Queries = seen.filter(({ params }) => params.includes('N4'));
  assert.equal(n4Queries.length, 4, 'both N4-case searches bind the level on both sources (2 queries x 2 searches)');
  for (const { sql } of n4Queries) {
    assert.ok(/jlpt_level/i.test(sql), 'N4 queries carry the level predicate on snapshots that tag it');
  }
  for (const { sql, params } of seen.filter(({ sql }) => /JOIN deck_publication_items|p\.post_type = \?/i.test(sql))) {
    if (params.includes('N4')) {
      assert.ok(/jlpt_level/i.test(sql), 'N4 queries carry the level predicate on snapshots that tag it');
    } else {
      assert.ok(!/jlpt_level/i.test(sql), 'plain-text queries add no level predicate');
    }
  }
});

function discoverStub(candidates, learners) {
  return async (sql, params = []) => {
    const count = placeholders(sql);
    assert.equal(params.length, count, `params bind every placeholder: ${sql.slice(0, 90)}`);
    if (/GROUP BY up\.user_id/i.test(sql)) return [learners];
    if (/INTERVAL '7 days'/i.test(sql)) return [candidates];
    if (/FROM deck_publications d/i.test(sql)) {
      return [[{ id: 5, title: 'N5 starter', entity_type: 'vocabulary', owner_username: 'yuki', created_at: '2026-09-20', items: 10 }]];
    }
    if (/FROM reading_publications r/i.test(sql)) {
      return [[{ id: 11, title: 'Momotaro', level: 'N5', owner_username: 'cara', created_at: '2026-09-21' }]];
    }
    if (/post_type = 'question'/i.test(sql)) {
      return [[{
        id: 71, author_id: OTHER_ID, post_type: 'question', title: null, body: 'how to use wa vs ga?',
        japanese_text: null, translation: null, entity_type: null, entity_id: null, deck_id: null, reading_id: null,
        snapshot_json: {}, like_count: 0, comment_count: 0, liked: false,
        author_username: 'yuki', author_display: null, author_avatar: null,
        created_at: '2026-09-22', updated_at: null
      }]];
    }
    if (/SELECT follower_id, followed_id/i.test(sql)) {
      return [[{ follower_id: THIRD_ID, followed_id: USER_ID }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
}

function candidateRow(overrides) {
  return {
    id: 1, author_id: OTHER_ID, post_type: 'text', title: null, body: 'hello',
    japanese_text: null, translation: null, entity_type: null, entity_id: null,
    deck_id: null, reading_id: null, snapshot_json: {},
    like_count: 0, comment_count: 0, liked: false,
    author_username: 'yuki', author_display: null, author_avatar: null,
    created_at: new Date(Date.now() - 3600000).toISOString(), updated_at: null,
    ...overrides
  };
}

test('discover returns exact section shape, capped and gated', async () => {
  const now = Date.now();
  const candidates = [
    // Newer + engaging beats older + merely popular (freshness competes).
    candidateRow({ id: 101, like_count: 5, comment_count: 5, created_at: new Date(now - 3600000).toISOString() }),
    candidateRow({ id: 102, like_count: 20, comment_count: 0, created_at: new Date(now - 6 * 86400000).toISOString() }),
    candidateRow({ id: 103, like_count: 0, comment_count: 0, created_at: new Date(now - 2 * 3600000).toISOString() })
  ];
  const learners = [
    { user_id: OTHER_ID, username: 'yuki', display_name: 'Yuki', avatar_url: null, bio: 'N4 learner', last_post_id: 90, last_active: '2026-09-25' },
    { user_id: THIRD_ID, username: 'cara', display_name: null, avatar_url: null, bio: null, last_post_id: 80, last_active: '2026-09-24' }
  ];
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    return discoverStub(candidates, learners)(sql, params);
  }, async () => {
    const discover = await service.getDiscover(pool, USER_ID);
    assert.deepEqual(Object.keys(discover).sort(), ['content', 'learners', 'popular', 'questions'], 'exact top-level keys');
    assert.deepEqual(Object.keys(discover.content).sort(), ['decks', 'readings'], 'content splits decks/readings');
    // learners: deterministic recency order + batched follow flags.
    assert.equal(discover.learners.length, 2);
    assert.equal(discover.learners[0].username, 'yuki');
    assert.equal(discover.learners[0].following, false, 'unfollowed by construction, still derived from edges');
    assert.equal(discover.learners[0].followsYou, false);
    assert.equal(discover.learners[1].username, 'cara');
    assert.equal(discover.learners[1].followsYou, true, 'batched followsYou flag');
    assert.equal(discover.learners[0].lastActiveAt, '2026-09-25');
    // popular: exact scores, freshness-led order.
    assert.deepEqual(discover.popular.map((p) => p.id), [101, 102, 103]);
    assert.deepEqual(discover.popular.map((p) => p.score), [44, 32, 24]);
    for (const post of discover.popular) {
      assert.ok('score' in post && 'authorUsername' in post && 'likeCount' in post, 'post shape + additive score');
    }
    // content + questions shapes.
    assert.equal(discover.content.decks.length, 1);
    assert.equal(discover.content.decks[0].itemCount, 10);
    assert.equal(discover.content.readings[0].level, 'N5');
    assert.equal(discover.questions.length, 1);
    assert.equal(discover.questions[0].postType, 'question');
  });
  const sectionQueries = seen.filter(({ sql }) => !/SELECT follower_id/i.test(sql));
  assert.equal(sectionQueries.length, 5, 'five bounded section queries + one batched edge query');
  for (const { sql, params } of sectionQueries) {
    if (/GROUP BY|INTERVAL|question|deck_publications|reading_publications/i.test(sql)) {
      assert.ok(/user_blocks/i.test(sql), `every section excludes blocked pairs: ${sql.slice(0, 60)}`);
      assert.ok(params.includes(USER_ID), 'every section binds the viewer');
    }
  }
  const learnersQuery = seen.find(({ sql }) => /GROUP BY up\.user_id/i.test(sql));
  assert.ok(/p\.author_id <> \?/.test(learnersQuery.sql), 'learners exclude self');
  assert.ok(/NOT EXISTS \(SELECT 1 FROM user_follows/i.test(learnersQuery.sql), 'learners exclude already-followed authors');
  assert.ok(/INTERVAL '30 days'/.test(learnersQuery.sql), 'learners windowed to recent activity');
  assert.deepEqual(learnersQuery.params.slice(-1), [5], 'learners capped at 5');
  const decksQuery = seen.find(({ sql }) => /FROM deck_publications d/i.test(sql));
  assert.ok(/\(d\.owner_id = \? OR up\.is_public\)/.test(decksQuery.sql), 'content decks require a public owner unless self');
  assert.deepEqual(decksQuery.params.slice(-1), [5], 'content decks capped at 5');
  const readingsQuery = seen.find(({ sql }) => /FROM reading_publications r/i.test(sql));
  assert.ok(/\(r\.owner_id = \? OR p\.is_public\)/.test(readingsQuery.sql), 'content readings require a public owner unless self');
  const popularQuery = seen.find(({ sql }) => /INTERVAL '7 days'/i.test(sql));
  assert.ok(/LIMIT \?/.test(popularQuery.sql), 'popular pool bounded');
  assert.deepEqual(popularQuery.params.slice(-1), [50], 'popular candidate pool capped at 50');
});

test('popularScore is exact, deterministic and documented', async () => {
  const fixed = new Date('2026-09-20T12:00:00.000Z').getTime();
  // score = likes + comments*3 + freshnessBonus; fresh post opens at +24.
  assert.equal(service.popularScore(10, 2, new Date(fixed).toISOString(), fixed), 10 + 6 + 24);
  // -1 per 12h: 13h old loses exactly 1.
  assert.equal(service.popularScore(0, 0, new Date(fixed - 13 * 3600000).toISOString(), fixed), 23);
  // Floored at 0 after 12 days.
  assert.equal(service.popularScore(5, 0, new Date(fixed - 13 * 86400000).toISOString(), fixed), 5);
  // Future timestamps clamp (never negative age inflating the bonus).
  assert.equal(service.popularScore(1, 0, new Date(fixed + 3600000).toISOString(), fixed), 1 + 0 + 24);
  // Same input → same output, always.
  const args = [7, 3, new Date(fixed - 50000000).toISOString(), fixed];
  assert.equal(service.popularScore(...args), service.popularScore(...args), 'deterministic');
  // Garbage counts coerce to 0, never NaN.
  assert.equal(service.popularScore('lots', null, new Date(fixed).toISOString(), fixed), 24);
});

test('legacy ?tab=discover feed behavior is untouched', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/SELECT COUNT\(\*\) AS total FROM community_posts/i.test(sql)) return [[{ total: '1' }]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const result = await service.listFeed(pool, USER_ID, { tab: 'discover' });
    assert.deepEqual(result.items, []);
  });
  assert.ok(seen.some(({ sql }) => /ORDER BY like_count DESC/i.test(sql)), 'legacy discover tab still engagement-ordered');
});

test('discover controller returns sections; search rejects garbage', async () => {
  await withPoolExecute(discoverStub([], []), async () => {
    const { res, status, body } = mockRes();
    await controller.getDiscover({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    const payload = body();
    assert.deepEqual(Object.keys(payload).sort(), ['content', 'learners', 'popular', 'questions']);
  });
  // V6.1 query-less browse: empty q browses recent gated rows (never 400).
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[]];
    if (/JOIN deck_publication_items/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const browse = await service.searchCommunity(pool, USER_ID, '', { type: 'vocabulary' });
    assert.deepEqual(browse.vocabulary, [], 'empty q browses (no rejection)');
    assert.equal(browse.page, 1);
    const blank = await service.searchCommunity(pool, USER_ID, '   ', { type: 'vocabulary' });
    assert.deepEqual(blank.vocabulary, [], 'blank q browses too');
  });
  await assert.rejects(service.searchCommunity(pool, USER_ID, 'x'.repeat(101), { type: 'kanji' }), /must not exceed 100/);
});

test('every phase-4 query binds exactly its placeholders like Postgres would', async () => {
  const calls = [];
  const strict = async (sql, params = []) => {
    calls.push({ sql, params });
    assert.equal(params.length, placeholders(sql), `param count must match placeholders: ${sql.slice(0, 100)}`);
    if (/FROM user_profile up/i.test(sql) && !/GROUP BY/i.test(sql)) return [[]];
    if (/GROUP BY up\.user_id/i.test(sql)) return [[]];
    if (/JOIN deck_publication_items/i.test(sql)) return [[]];
    if (/FROM community_posts p/i.test(sql)) {
      if (/ILIKE/i.test(sql) || /post_type = \?/i.test(sql) || /INTERVAL/i.test(sql)) return [[]];
      return [[{
        id: 1, author_id: OTHER_ID, post_type: 'text', title: null, body: 'hi',
        japanese_text: null, translation: null, entity_type: null, entity_id: null,
        deck_id: null, reading_id: null, snapshot_json: {}, like_count: 0, comment_count: 0,
        liked: false, author_username: 'yuki', author_display: null, author_avatar: null,
        created_at: '2026-09-01', updated_at: null
      }]];
    }
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    if (/SELECT follower_id, followed_id FROM user_follows/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
  await withPoolExecute(strict, async () => {
    await service.searchCommunity(pool, USER_ID, 'taberu', { type: 'all', page: 2, limit: 5 });
    await service.searchCommunity(pool, USER_ID, 'N4', { type: 'vocabulary' });
    await service.searchCommunity(pool, USER_ID, 'mizu', { type: 'kanji' });
    await service.searchCommunity(pool, USER_ID, 'tai', { type: 'grammar' });
    await service.getDiscover(pool, USER_ID);
  });
  assert.ok(calls.length > 15, `touched a realistic query count, got ${calls.length}`);
});
