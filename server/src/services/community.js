// V6.0 Social Community service: posts, feed, likes, comments, follows,
// notifications, reports, blocks, community search. Read/write exclusively
// through req.user.id (never trusts client identity); every visibility
// decision is enforced here, never frontend-only.
//
// Visibility model (V6.0 minimum = Public):
// - A post is visible to viewer V iff NOT is_deleted AND is_public AND
//   (author is V OR author profile is_public) AND no block either way.
// - Private-profile authors are visible to themselves only.
// - Feeds never return emails or private study data — only the public
//   profile columns (username, display_name, avatar_url, bio).
const { ConflictError, ValidationError } = require('../errors/http');

const POST_TYPES = ['text', 'example', 'question', 'progress', 'share_deck', 'share_reading', 'share_vocab', 'share_kanji', 'share_grammar'];
const ENTITY_TYPES = ['vocabulary', 'kanji', 'grammar'];
const FEED_TABS = ['latest', 'following', 'discover'];
const REPORT_REASONS = ['spam', 'harassment', 'inappropriate', 'misleading', 'other'];
const MAX_FEED_LIMIT = 30;
const MAX_SEARCH_LIMIT = 20;
// V6.1 Phase 3: one-level replies embed at most 20 children per top-level
// comment (documented cap; deeper paging later if needed). Notification
// excerpts truncate like the summary (ellipsis style) at 80 chars.
const MAX_REPLIES_PER_COMMENT = 20;
const MAX_NOTIFICATION_EXCERPT = 80;

function assertPostType(value) {
  if (!POST_TYPES.includes(value)) throw new ValidationError(`post_type must be one of: ${POST_TYPES.join(', ')}.`);
  return value;
}

function cleanText(value, max, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${name} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string.`);
  const text = value.trim();
  if (required && !text) throw new ValidationError(`${name} is required.`);
  if (text.length > max) throw new ValidationError(`${name} must not exceed ${max} characters.`);
  return text || null;
}

function cleanId(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${name} is required.`);
    return null;
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(`${name} must be a positive integer.`);
  return id;
}

// Shared visibility predicate fragment for post listings/detail. Viewer sees
// own rows plus public rows from public profiles, minus any blocked pair.
// NOTE: the fragment carries THREE placeholders (author + both block
// directions) — every caller must spread visibilityParams(viewerId), never a
// single viewerId, or Postgres rejects the binding on real data (stubs that
// ignore positions cannot catch this; only counting catches it).
function visibilityWhere(alias, profileAlias) {
  return `(${alias}.author_id = ? OR (${alias}.is_public AND ${profileAlias}.is_public))`
    + ` AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ${alias}.author_id) OR (b.blocker_id = ${alias}.author_id AND b.blocked_id = ?))`;
}

function visibilityParams(viewerId) {
  return [viewerId, viewerId, viewerId];
}

// V6.1 Phase 7-perf single-query feed counts via LEFT JOIN plus GROUP BY.
const POST_COUNT_JOINS = 'LEFT JOIN post_likes pl ON pl.id_community_post = p.id_community_post ' + 'LEFT JOIN post_comments pc ON pc.id_community_post = p.id_community_post AND NOT pc.is_deleted ' + 'LEFT JOIN post_likes vl ON vl.id_community_post = p.id_community_post AND vl.user_id = ?';
const POST_COUNT_SELECT = 'COUNT(DISTINCT pl.user_id) AS like_count, ' + 'COUNT(DISTINCT pc.id_post_comment) AS comment_count, ' + 'MAX(CASE WHEN vl.user_id IS NOT NULL THEN 1 ELSE 0 END) AS liked';
const POST_GROUP_BY = 'GROUP BY p.id_community_post, p.author_id, p.post_type, p.title, p.body, p.japanese_text, p.translation, ' + 'p.entity_type, p.entity_id, p.deck_id, p.reading_id, p.snapshot_json, p.created_at, p.updated_at, ' + 'up.username, up.display_name, up.avatar_url';
const MAX_BLOCKED_LIMIT = 50;

// Phase 2b: LIKE metacharacters (%, _, \) in the raw query must not act as
// wildcards — q="%" would otherwise enumerate the whole directory. Every
// search ILIKE pairs with ESCAPE '\' and the pattern is pre-escaped here.
function escapeLikePattern(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// V6.1 Phase 4: learning-item search (vocabulary/kanji/grammar) reads ONLY
// already-shared rows — never raw private library tables. Two sources:
//
// (a) share posts (share_vocab/share_kanji/share_grammar) visible to the
//     viewer through the same visibilityWhere posture as every other post
//     surface. The snapshot_json display/reading/meaning keys are written by
//     validateLinkedContent at publish time from the author's OWN row, so a
//     hit here re-publishes what the author already chose to share.
// (b) snapshot items of qualifying public decks: deck_publications rows that
//     are public AND owned by a public profile (self rows always pass) AND
//     unblocked both ways — the Phase 2b owner-publicity posture.
//
// No query in this section touches vocabulary/kanji/grammar_points directly;
// a regression test pins that (any FROM on those tables fails the suite).
const LEARNING_SEARCH = {
  vocabulary: { sharePostType: 'share_vocab', displayKey: 'word' },
  kanji: { sharePostType: 'share_kanji', displayKey: 'character_kanji' },
  grammar: { sharePostType: 'share_grammar', displayKey: 'grammar_point' }
};
const SEARCH_TYPES = ['all', 'posts', 'people', 'decks', 'reading', 'vocabulary', 'kanji', 'grammar'];

// Level-tagged recall: a bare level query ("N4", case-insensitive, stray
// whitespace tolerated) ALSO matches snapshots tagged with that level, not
// just text containing "N4". Where the column exists:
// - deck items: item_json->>'jlpt_level' (snapshot columns include jlpt_level
//   per deckSharing ENTITY, so this recalls reliably);
// - share posts: snapshot_json->>'jlpt_level' (forward-compatible; snapshots
//   minted by the current validateLinkedContent carry display/reading/meaning
//   only, so N4 recall on legacy share posts is limited to text matches).
// Raw library jlpt_level columns are never queried (privacy posture above).
function parseLevelQuery(text) {
  const normalized = String(text || '').trim().toUpperCase().replace(/\s+/g, '');
  return /^N[1-5]$/.test(normalized) ? normalized : null;
}

// Tolerant jsonb reader: pg parses jsonb to objects, stubs hand back strings
// or objects; garbage yields {} (never throws inside a mapper).
function parseJsonb(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to {} — a corrupt snapshot hides one hit, never 500s.
    }
  }
  return {};
}

function mapSharePostHit(row) {
  const snap = parseJsonb(row.snapshot_json);
  return {
    source: 'post',
    postId: Number(row.id),
    deckId: null,
    position: null,
    display: snap.display ?? null,
    reading: snap.reading ?? null,
    meaning: snap.meaning ?? null,
    level: snap.jlpt_level ?? snap.jlptLevel ?? null,
    title: row.title || null,
    authorUsername: row.author_username || null
  };
}

function mapDeckItemHit(row, displayKey) {
  const item = parseJsonb(row.item_json);
  return {
    source: 'deck',
    postId: null,
    deckId: Number(row.deck_id),
    position: row.position !== null && row.position !== undefined ? Number(row.position) : null,
    display: item[displayKey] ?? item.display ?? null,
    reading: item.reading ?? null,
    meaning: item.meaning ?? null,
    level: item.jlpt_level ?? item.jlptLevel ?? null,
    title: row.deck_title || null,
    authorUsername: row.owner_username || null
  };
}

// V6.1 query-less browse ordering (EXACT — also restated in the
// searchCommunity header; change both if this ever changes):
// - posts:    ORDER BY p.id_community_post DESC (monotonic → newest first)
// - decks:    ORDER BY d.id_deck_publication DESC (newest first)
// - reading:  ORDER BY r.id_reading_publication DESC (newest first)
// - people:   ORDER BY up.updated_at DESC, up.username ASC (recently-touched
//             public profiles first, username tiebreak). user_profile carries
//             no created_at, so updated_at is the only recency signal; a
//             recent-post-activity join would hide profiles without posts and
//             change directory semantics, so browse keeps directory semantics.
// - vocabulary/kanji/grammar: share-post hits ORDER BY p.id DESC then
//             deck-item hits ORDER BY d.id DESC, i.position ASC, merged
//             (posts then decks) and truncated to safeLimit — the same
//             deterministic merge as text search, minus the text predicate.
// Every browse query reuses its text-search gate posture verbatim
// (visibilityWhere / owner-publicity / both-ways block); only the ILIKE +
// level predicates are omitted. Same per-type caps (MAX_SEARCH_LIMIT) and
// same OFFSET paging; same hit shapes; empty arrays when nothing, never 500.
// One learning-item type, two bounded gated queries merged deterministically:
// share-post hits (newest first) then deck-item hits (newest deck, position
// order), truncated to `limit`. Both sources page with the same OFFSET; deep
// pages may thin the merged list — acceptable for capped typeahead search.
// displayKey is an internal constant per type (never user input).
async function browseLearningType(executor, viewerId, learningType, { safeLimit, offset }) {
  const def = LEARNING_SEARCH[learningType];
  const postPromise = executor.execute(
    `SELECT p.id_community_post AS id, p.post_type, p.title, p.snapshot_json, p.created_at,
       up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
      FROM community_posts p
      JOIN user_profile up ON up.user_id = p.author_id
      WHERE NOT p.is_deleted AND ${visibilityWhere('p', 'up')}
        AND p.post_type = ?
      ORDER BY p.id_community_post DESC LIMIT ? OFFSET ?`,
    [...visibilityParams(viewerId), def.sharePostType, safeLimit, offset]
  );
  // FROM deck_publications (not the items table) so the Phase 2b
  // owner-publicity + block posture reads exactly like the deck browse above.
  const deckPromise = executor.execute(
    `SELECT d.id_deck_publication AS deck_id, d.title AS deck_title, d.entity_type,
       up.username AS owner_username, i.position AS position, i.item_json AS item_json
      FROM deck_publications d
      JOIN deck_publication_items i ON i.id_deck_publication = d.id_deck_publication
      LEFT JOIN user_profile up ON up.user_id = d.owner_id
      WHERE d.is_public AND d.entity_type = ?
        AND (d.owner_id = ? OR up.is_public)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = d.owner_id) OR (b.blocker_id = d.owner_id AND b.blocked_id = ?))
      ORDER BY d.id_deck_publication DESC, i.position ASC LIMIT ? OFFSET ?`,
    [learningType, viewerId, viewerId, viewerId, safeLimit, offset]
  );
  const [[postRows], [deckRows]] = await Promise.all([postPromise, deckPromise]);
  const hits = [];
  for (const row of Array.isArray(postRows) ? postRows : []) hits.push(mapSharePostHit(row));
  for (const row of Array.isArray(deckRows) ? deckRows : []) hits.push(mapDeckItemHit(row, def.displayKey));
  return hits.slice(0, safeLimit);
}

async function searchLearningType(executor, viewerId, learningType, { like, level, safeLimit, offset }) {
  const def = LEARNING_SEARCH[learningType];
  const postLevelFilter = level ? ` OR UPPER(COALESCE(p.snapshot_json->>'jlpt_level', '')) = ?` : '';
  const postParams = level
    ? [...visibilityParams(viewerId), def.sharePostType, like, like, like, level, safeLimit, offset]
    : [...visibilityParams(viewerId), def.sharePostType, like, like, like, safeLimit, offset];
  const postPromise = executor.execute(
    `SELECT p.id_community_post AS id, p.post_type, p.title, p.snapshot_json, p.created_at,
       up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
      FROM community_posts p
      JOIN user_profile up ON up.user_id = p.author_id
      WHERE NOT p.is_deleted AND ${visibilityWhere('p', 'up')}
        AND p.post_type = ?
        AND (COALESCE(p.snapshot_json->>'display', '') ILIKE ? ESCAPE '\\'
          OR COALESCE(p.snapshot_json->>'reading', '') ILIKE ? ESCAPE '\\'
          OR COALESCE(p.snapshot_json->>'meaning', '') ILIKE ? ESCAPE '\\'${postLevelFilter})
      ORDER BY p.id_community_post DESC LIMIT ? OFFSET ?`,
    postParams
  );
  // FROM deck_publications (not the items table) so the Phase 2b
  // owner-publicity + block posture reads exactly like the deck search above.
  const itemLevelFilter = level ? ` OR UPPER(COALESCE(i.item_json->>'jlpt_level', '')) = ?` : '';
  const deckParams = level
    ? [learningType, viewerId, viewerId, viewerId, like, like, like, level, safeLimit, offset]
    : [learningType, viewerId, viewerId, viewerId, like, like, like, safeLimit, offset];
  const deckPromise = executor.execute(
    `SELECT d.id_deck_publication AS deck_id, d.title AS deck_title, d.entity_type,
       up.username AS owner_username, i.position AS position, i.item_json AS item_json
      FROM deck_publications d
      JOIN deck_publication_items i ON i.id_deck_publication = d.id_deck_publication
      LEFT JOIN user_profile up ON up.user_id = d.owner_id
      WHERE d.is_public AND d.entity_type = ?
        AND (d.owner_id = ? OR up.is_public)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = d.owner_id) OR (b.blocker_id = d.owner_id AND b.blocked_id = ?))
        AND (COALESCE(i.item_json->>'${def.displayKey}', '') ILIKE ? ESCAPE '\\'
          OR COALESCE(i.item_json->>'reading', '') ILIKE ? ESCAPE '\\'
          OR COALESCE(i.item_json->>'meaning', '') ILIKE ? ESCAPE '\\'${itemLevelFilter})
      ORDER BY d.id_deck_publication DESC, i.position ASC LIMIT ? OFFSET ?`,
    deckParams
  );
  const [[postRows], [deckRows]] = await Promise.all([postPromise, deckPromise]);
  const hits = [];
  for (const row of Array.isArray(postRows) ? postRows : []) hits.push(mapSharePostHit(row));
  for (const row of Array.isArray(deckRows) ? deckRows : []) hits.push(mapDeckItemHit(row, def.displayKey));
  return hits.slice(0, safeLimit);
}

// V6.1 Phase 3: notification excerpts reuse the summary truncation style
// (slice + ellipsis) at 80 chars, sourced from title → japanese_text →
// body. Follow notifications (no post) yield null; empty posts yield null.
function notificationExcerpt(title, japaneseText, body) {
  const text = String(title || japaneseText || body || '').trim();
  if (!text) return null;
  return text.length > MAX_NOTIFICATION_EXCERPT ? `${text.slice(0, MAX_NOTIFICATION_EXCERPT)}…` : text;
}

function isEditedRow(row) {
  if (!row || !row.created_at || !row.updated_at) return false;
  return String(row.created_at) !== String(row.updated_at);
}

function mapPost(row, viewerId) {
  let snapshot = null;
  try {
    const parsed = row.snapshot_json && typeof row.snapshot_json === 'object' && !Array.isArray(row.snapshot_json)
      ? row.snapshot_json
      : JSON.parse(row.snapshot_json || '{}');
    snapshot = parsed && typeof parsed === 'object' && Object.keys(parsed).length ? parsed : null;
  } catch {
    snapshot = null;
  }
  // V6.1 Phase 5: verified study-progress snapshot. Progress posts minted
  // with includeStats:true carry a server-computed stats object as their
  // whole snapshot_json (flat shape, same keys as getShareStats). The `stats`
  // key is additive: progress posts expose their snapshot again as `stats`
  // (null when no verified snapshot); every other post type reports null
  // here so share-post display snapshots are never mistaken for metrics.
  // `snapshot` stays for back-compat.
  const stats = row.post_type === 'progress' && snapshot ? snapshot : null;
  return {
    id: Number(row.id),
    authorId: row.author_id,
    mine: String(row.author_id) === String(viewerId),
    postType: row.post_type,
    stats,
    title: row.title || null,
    body: row.body || null,
    japaneseText: row.japanese_text || null,
    translation: row.translation || null,
    entityType: row.entity_type || null,
    entityId: row.entity_id !== null && row.entity_id !== undefined ? Number(row.entity_id) : null,
    deckId: row.deck_id !== null && row.deck_id !== undefined ? Number(row.deck_id) : null,
    readingId: row.reading_id !== null && row.reading_id !== undefined ? Number(row.reading_id) : null,
    snapshot,
    likeCount: Number(row.like_count || 0),
    commentCount: Number(row.comment_count || 0),
    liked: row.liked === true || row.liked === 1,
    authorUsername: row.author_username || null,
    authorDisplay: row.author_display || null,
    authorAvatar: row.author_avatar || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null
  };
}

async function validateLinkedContent(executor, authorId, payload) {
  // Linked entities must be owned by the author (never another learner's
  // private rows); linked decks/readings must be public-or-own. Returns the
  // normalized link fields or throws 404-style ValidationError.
  const entityType = payload.entityType ?? null;
  const entityId = payload.entityId ?? null;
  if ((entityType === null) !== (entityId === null)) {
    throw new ValidationError('entityType and entityId must be provided together.');
  }
  // Linked ids are normalized here: garbage is a 400 (cleanId), never a
  // silent miss or a raw value into SQL; valid ids behave as before.
  const cleanEntityId = entityId === null ? null : cleanId(entityId, 'entityId');
  let snapshot = {};
  if (entityType !== null) {
    if (!ENTITY_TYPES.includes(entityType)) throw new ValidationError('entityType must be vocabulary, kanji, or grammar.');
    const table = entityType === 'vocabulary' ? 'vocabulary' : entityType === 'kanji' ? 'kanji' : 'grammar_points';
    const pk = entityType === 'vocabulary' ? 'id_vocabulary' : entityType === 'kanji' ? 'id_kanji' : 'id_grammar';
    const columns = entityType === 'vocabulary'
      ? 'word AS display, reading, meaning'
      : entityType === 'kanji'
        ? 'character_kanji AS display, NULL AS reading, meaning'
        : 'grammar_point AS display, NULL AS reading, meaning';
    const [rows] = await executor.execute(`SELECT ${columns} FROM ${table} WHERE ${pk} = ? AND user_id = ?`, [cleanEntityId, authorId]);
    const entry = Array.isArray(rows) ? rows[0] : null;
    if (!entry) throw new ValidationError('Linked learning item not found.');
    snapshot = { display: entry.display, reading: entry.reading || null, meaning: entry.meaning || null };
  }
  const rawDeckId = payload.deckId ?? null;
  const deckId = rawDeckId === null ? null : cleanId(rawDeckId, 'deckId');
  if (deckId !== null) {
    const [rows] = await executor.execute(
      `SELECT d.title, d.entity_type, d.owner_id, (SELECT COUNT(*) FROM deck_publication_items i WHERE i.id_deck_publication = d.id_deck_publication) AS items
       FROM deck_publications d WHERE d.id_deck_publication = ? AND (d.owner_id = ? OR d.is_public = TRUE)`,
      [deckId, authorId]
    );
    const deck = Array.isArray(rows) ? rows[0] : null;
    if (!deck) throw new ValidationError('Linked deck not found.');
    // Phase 2b (F7): linking a blocker's/blocked user's deck is rejected with
    // the same 404-style message, so link checks cannot oracle block state.
    if (String(deck.owner_id) !== String(authorId)) {
      const [blocked] = await executor.execute(
        'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
        [authorId, deck.owner_id, deck.owner_id, authorId]
      );
      if (Array.isArray(blocked) && blocked[0]) throw new ValidationError('Linked deck not found.');
    }
    snapshot = { ...snapshot, title: deck.title, entityType: deck.entity_type, itemCount: Number(deck.items || 0) };
  }
  const rawReadingId = payload.readingId ?? null;
  const readingId = rawReadingId === null ? null : cleanId(rawReadingId, 'readingId');
  if (readingId !== null) {
    const [rows] = await executor.execute(
      `SELECT title, level, owner_id, char_length(text) AS chars FROM reading_publications
       WHERE id_reading_publication = ? AND (owner_id = ? OR is_public = TRUE)`,
      [readingId, authorId]
    );
    const text = Array.isArray(rows) ? rows[0] : null;
    if (!text) throw new ValidationError('Linked reading text not found.');
    // Phase 2b (F7): same block gate as linked decks, same 404-style message.
    if (String(text.owner_id) !== String(authorId)) {
      const [blocked] = await executor.execute(
        'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
        [authorId, text.owner_id, text.owner_id, authorId]
      );
      if (Array.isArray(blocked) && blocked[0]) throw new ValidationError('Linked reading text not found.');
    }
    snapshot = { ...snapshot, title: text.title, level: text.level || null, chars: Number(text.chars || 0) };
  }
  return { entityType, entityId: cleanEntityId, deckId, readingId, snapshot };
}

function validatePostBody(postType, body) {
  if (postType === 'text' || postType === 'question' || postType === 'progress') {
    return cleanText(body.body, 2000, 'body', { required: true });
  }
  return cleanText(body.body, 2000, 'body');
}

// V6.1 Phase 5 (#7 real study-progress posts): verified share stats.
//
// Every number below reuses an EXISTING dashboard/study predicate — no new
// statistics engine, no client-supplied numbers, never another learner's
// rows (all predicates bind the caller's userId only):
// - vocabCount/kanjiCount/grammarCount: same COUNT(*) ownership predicates
//   as dashboardController.getDashboard (vocabulary/kanji/grammar_points
//   WHERE user_id = ?).
// - streakDays: same active-day rule + counting as
//   dashboardController.getActivity (distinct study_sessions dates plus
//   reading_study_days with seconds >= 300, counted back from the effective
//   today). longestStreak intentionally NOT exposed (unneeded for sharing).
// - studiedMinutesMonth: same source tables/predicates as getDashboard's
//   minutes_week (study_sessions.duration_minutes + reading_study_days
//   seconds/60) but over the last 30 days inclusive
//   (effectiveToday-29 .. effectiveToday) — there is NO existing month
//   query, the week window is the closest existing one, so the exact window
//   ships in `studiedMinutesWindow` and `asOf`. Documented deviation, not a
//   new engine.
// - reviewsDue: same due predicate as dashboardController.getStudyNow
//   (review_items due_on <= CURRENT_DATE joined to OWNED vocabulary/kanji/
//   grammar rows, excluding interval_days = 0 never-reviewed placeholders);
//   total only, no breakdown.
// - readingsFinished: same table as getStudyNow's incomplete-reading source
//   (user_reading_progress), COUNT WHERE completed_at IS NOT NULL. Single
//   cheap aggregate; fails open to 0 on legacy schemas without the table
//   (mirrors the dashboard's reading fail-open posture).
// Bounded: one round of parallel queries (7 at most, each single-row or
// small), all user-scoped. `?today=` anchors the streak/month windows on
// the client's local date like the dashboard; absent param keeps the DB
// CURRENT_DATE fallback.
const SHARE_STATS_WINDOW_DAYS = 30;

function shareIsoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function shareDayNumber(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
}

function shareShiftDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function resolveShareToday(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError('today must be a YYYY-MM-DD date.');
  }
  return value;
}

async function getShareStats(executor, userId, { today = null } = {}) {
  const requested = resolveShareToday(today);
  let effectiveToday = requested;
  if (!effectiveToday) {
    const [todayRows] = await executor.execute("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today");
    const raw = Array.isArray(todayRows) ? todayRows[0]?.today : null;
    const iso = shareIsoDate(raw || new Date());
    effectiveToday = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date().toISOString().slice(0, 10);
  }
  const windowStart = shareShiftDays(effectiveToday, -(SHARE_STATS_WINDOW_DAYS - 1));
  const countsPromise = executor.execute(
    'SELECT (SELECT COUNT(*) FROM vocabulary WHERE user_id = ?) AS vocab, (SELECT COUNT(*) FROM kanji WHERE user_id = ?) AS kanji, (SELECT COUNT(*) FROM grammar_points WHERE user_id = ?) AS grammar',
    [userId, userId, userId]
  );
  const sessionDatesPromise = executor.execute(
    "SELECT to_char(session_date, 'YYYY-MM-DD') AS date FROM study_sessions WHERE user_id = ? GROUP BY session_date ORDER BY session_date ASC",
    [userId]
  );
  const readingDaysPromise = executor.execute(
    "SELECT to_char(day, 'YYYY-MM-DD') AS date FROM reading_study_days WHERE user_id = ? AND seconds >= 300 GROUP BY day ORDER BY day ASC",
    [userId]
  ).catch(() => [[]]);
  const sessionMinutesPromise = executor.execute(
    'SELECT COALESCE(SUM(duration_minutes), 0) AS minutes FROM study_sessions WHERE user_id = ? AND session_date BETWEEN ?::date AND ?::date',
    [userId, windowStart, effectiveToday]
  );
  const readingMinutesPromise = executor.execute(
    'SELECT COALESCE(SUM(seconds), 0) / 60 AS minutes FROM reading_study_days WHERE user_id = ? AND day BETWEEN ?::date AND ?::date',
    [userId, windowStart, effectiveToday]
  ).catch(() => [[]]);
  const duePromise = executor.execute(
    `SELECT
      (SELECT COUNT(*) FROM review_items ri
        JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary
        WHERE ri.due_on <= CURRENT_DATE AND ri.id_vocabulary IS NOT NULL AND ri.id_kanji IS NULL AND ri.id_grammar IS NULL
          AND v.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)) AS due_vocabulary,
      (SELECT COUNT(*) FROM review_items ri
        JOIN kanji k ON k.id_kanji = ri.id_kanji
        WHERE ri.due_on <= CURRENT_DATE AND ri.id_kanji IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_grammar IS NULL
          AND k.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)) AS due_kanji,
      (SELECT COUNT(*) FROM review_items ri
        JOIN grammar_points g ON g.id_grammar = ri.id_grammar
        WHERE ri.due_on <= CURRENT_DATE AND ri.id_grammar IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_kanji IS NULL
          AND g.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)) AS due_grammar`,
    [userId, userId, userId]
  );
  const readingsFinishedPromise = executor.execute(
    'SELECT COUNT(*) AS total FROM user_reading_progress WHERE user_id = ? AND completed_at IS NOT NULL',
    [userId]
  ).catch(() => [[]]);
  const [[countRows], [sessionDateRows], [readingDayRows], [sessionMinRows], [readingMinRows], [dueRows], [finishedRows]] = await Promise.all([
    countsPromise, sessionDatesPromise, readingDaysPromise, sessionMinutesPromise, readingMinutesPromise, duePromise, readingsFinishedPromise
  ]);
  const counts = Array.isArray(countRows) ? countRows[0] || {} : {};
  const sessionDates = (Array.isArray(sessionDateRows) ? sessionDateRows : []).map((row) => shareIsoDate(row.date));
  const readingDates = (Array.isArray(readingDayRows) ? readingDayRows : []).map((row) => shareIsoDate(row.date));
  const active = new Set([...sessionDates, ...readingDates].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  let streakDays = 0;
  for (let day = shareDayNumber(effectiveToday); active.has(new Date(day * 86400000).toISOString().slice(0, 10)); day -= 1) streakDays += 1;
  const sessionMinutes = Number((Array.isArray(sessionMinRows) ? sessionMinRows[0] : null)?.minutes || 0);
  const readingMinutes = Number((Array.isArray(readingMinRows) ? readingMinRows[0] : null)?.minutes || 0);
  const due = Array.isArray(dueRows) ? dueRows[0] || {} : {};
  const finished = Array.isArray(finishedRows) ? finishedRows[0] || {} : {};
  return {
    streakDays,
    vocabCount: Number(counts.vocab || 0),
    kanjiCount: Number(counts.kanji || 0),
    grammarCount: Number(counts.grammar || 0),
    studiedMinutesMonth: Math.round(sessionMinutes + readingMinutes),
    studiedMinutesWindow: `${windowStart}..${effectiveToday} (last ${SHARE_STATS_WINDOW_DAYS} days inclusive, study sessions + reading)`,
    reviewsDue: Number(due.due_vocabulary || 0) + Number(due.due_kanji || 0) + Number(due.due_grammar || 0),
    readingsFinished: Number(finished.total || 0),
    asOf: effectiveToday
  };
}

async function createPost(executor, authorId, payload) {
  const postType = assertPostType(payload.postType);
  // Phase 5: client-supplied numbers are NEVER trusted. Only includeStats:true
  // triggers a server-computed snapshot via getShareStats; stats/snapshot/
  // snapshot_json keys in the payload are silently ignored (never read) so a
  // forged body cannot mint fake metrics. progress posts may still carry a
  // manual body message alongside the verified snapshot.
  const includeStats = payload.includeStats ?? null;
  let wantStats = false;
  if (includeStats !== undefined && includeStats !== null && includeStats !== false) {
    if (includeStats !== true) throw new ValidationError('includeStats must be true or omitted.');
    wantStats = true;
  }
  if (wantStats && postType !== 'progress') throw new ValidationError('includeStats is only allowed on progress posts.');
  const title = cleanText(payload.title, 200, 'title');
  const body = validatePostBody(postType, payload);
  const japaneseText = postType === 'example'
    ? cleanText(payload.japaneseText, 2000, 'japaneseText', { required: true })
    : cleanText(payload.japaneseText, 2000, 'japaneseText');
  const translation = cleanText(payload.translation, 2000, 'translation');
  const links = await validateLinkedContent(executor, authorId, payload);
  // Single write: the snapshot is a point-in-time reading, so no transaction
  // spans the stat reads + INSERT (no multi-write atomicity to preserve).
  // Reuses posts.snapshot_json from 039 — no migration.
  const snapshot = wantStats ? await getShareStats(executor, authorId) : (links.snapshot || {});
  const [result] = await executor.execute(
    `INSERT INTO community_posts (author_id, post_type, title, body, japanese_text, translation, entity_type, entity_id, deck_id, reading_id, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) RETURNING id_community_post AS insertId`,
    [authorId, postType, title, body, japaneseText, translation, links.entityType, links.entityId, links.deckId, links.readingId, JSON.stringify(snapshot)]
  );
  const id = Number(result?.insertId ?? (Array.isArray(result) ? result[0]?.insertId : undefined));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Unable to create the post.');
  return getPost(executor, authorId, id);
}

async function getPost(executor, viewerId, postId) {
  const id = cleanId(postId, 'post');
  const [rows] = await executor.execute(
    'SELECT p.id_community_post AS id, p.author_id, p.post_type, p.title, p.body, p.japanese_text, p.translation, ' +
    'p.entity_type, p.entity_id, p.deck_id, p.reading_id, p.snapshot_json, p.created_at, ' +
    'p.updated_at, ' +
    'up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar, ' +
    POST_COUNT_SELECT +
    ' FROM community_posts p ' +
    'JOIN user_profile up ON up.user_id = p.author_id ' +
    POST_COUNT_JOINS +
    ' WHERE p.id_community_post = ? AND NOT p.is_deleted AND ' + visibilityWhere('p', 'up') +
    ' ' + POST_GROUP_BY,
    [viewerId, id, ...visibilityParams(viewerId)]
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? mapPost(row, viewerId) : null;
}

async function listFeed(executor, viewerId, { tab = 'latest', page = 1, limit = 20, author = null } = {}) {
  if (!FEED_TABS.includes(tab)) throw new ValidationError('tab must be latest, following, or discover.');
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_FEED_LIMIT, Number(limit)) : 20;
  const offset = (safePage - 1) * safeLimit;
  let authorFilter = '';
  const extraParams = [];
  if (author !== null && author !== undefined && author !== '') {
    // Profile timelines posts by one username through same gates.
    // Private blocked authors resolve to empty list.
    const [owners] = await executor.execute('SELECT user_id FROM user_profile WHERE username = ?', [String(author).trim().toLowerCase()]);
    const owner = Array.isArray(owners) ? owners[0] : null;
    if (!owner) return { items: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    authorFilter = 'AND p.author_id = ? ';
    extraParams.push(owner.user_id);
  }
  if (tab === 'following') {
    authorFilter += 'AND EXISTS (SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = p.author_id AND p.author_id <> ?) ';
    extraParams.push(viewerId, viewerId);
  }
  const orderBy = tab === 'discover'
    ? 'ORDER BY like_count DESC, p.id_community_post DESC'
    : 'ORDER BY p.id_community_post DESC';
  const [[totalRow]] = await executor.execute(
    'SELECT COUNT(*) AS total FROM community_posts p ' +
    'JOIN user_profile up ON up.user_id = p.author_id ' +
    'WHERE NOT p.is_deleted AND ' + visibilityWhere('p', 'up') + ' ' + authorFilter,
    [...visibilityParams(viewerId), ...extraParams]
  );
  const total = Number(totalRow?.total || 0);
  if (!total) return { items: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
  const [rows] = await executor.execute(
    'SELECT p.id_community_post AS id, p.author_id, p.post_type, p.title, p.body, p.japanese_text, p.translation, ' +
    'p.entity_type, p.entity_id, p.deck_id, p.reading_id, p.snapshot_json, p.created_at, ' +
    'p.updated_at, ' +
    'up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar, ' +
    POST_COUNT_SELECT +
    ' FROM community_posts p ' +
    'JOIN user_profile up ON up.user_id = p.author_id ' +
    POST_COUNT_JOINS +
    ' WHERE NOT p.is_deleted AND ' + visibilityWhere('p', 'up') + ' ' + authorFilter +
    ' ' + POST_GROUP_BY +
    ' ' + orderBy + ' LIMIT ? OFFSET ?',
    [viewerId, ...visibilityParams(viewerId), ...extraParams, safeLimit, offset]
  );
  const items = (Array.isArray(rows) ? rows : []).map((row) => mapPost(row, viewerId));
  return { items, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
}

async function updatePost(executor, authorId, postId, payload) {
  const id = cleanId(postId, 'post');
  const allowed = ['title', 'body', 'translation'];
  const unknown = Object.keys(payload || {}).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ValidationError(`Unexpected field(s): ${unknown.join(', ')}.`);
  if (payload.title === undefined && payload.body === undefined && payload.translation === undefined) {
    throw new ValidationError('Nothing to update.');
  }
  const [rows] = await executor.execute(
    'SELECT post_type FROM community_posts WHERE id_community_post = ? AND author_id = ? AND NOT is_deleted',
    [id, authorId]
  );
  const current = Array.isArray(rows) ? rows[0] : null;
  if (!current) return null;
  const title = payload.title === undefined ? undefined : cleanText(payload.title, 200, 'title');
  const translation = payload.translation === undefined ? undefined : cleanText(payload.translation, 2000, 'translation');
  const body = payload.body === undefined ? undefined : validatePostBody(current.post_type, { body: payload.body });
  const sets = [];
  const params = [];
  if (title !== undefined) { sets.push('title = ?'); params.push(title); }
  if (body !== undefined) { sets.push('body = ?'); params.push(body); }
  if (translation !== undefined) { sets.push('translation = ?'); params.push(translation); }
  if (!sets.length) throw new ValidationError('Nothing to update.');
  await executor.execute(
    `UPDATE community_posts SET ${sets.join(', ')} WHERE id_community_post = ? AND author_id = ?`,
    [...params, id, authorId]
  );
  return getPost(executor, authorId, id);
}

async function deletePost(executor, authorId, postId) {
  const id = cleanId(postId, 'post');
  const [result] = await executor.execute(
    'UPDATE community_posts SET is_deleted = TRUE WHERE id_community_post = ? AND author_id = ? AND NOT is_deleted',
    [id, authorId]
  );
  const affected = Number(result?.affectedRows ?? 0);
  return affected > 0 ? { deletedId: id } : null;
}

async function toggleLike(executor, userId, postId) {
  const id = cleanId(postId, 'post');
  const visible = await getPost(executor, userId, id);
  if (!visible) return null;
  const [existing] = await executor.execute(
    'SELECT 1 FROM post_likes WHERE id_community_post = ? AND user_id = ?',
    [id, userId]
  );
  let liked;
  if (existing[0]) {
    await executor.execute('DELETE FROM post_likes WHERE id_community_post = ? AND user_id = ?', [id, userId]);
    liked = false;
    // Orphan-notif hygiene: the like inbox row no longer describes reality.
    // Best-effort — a cleanup failure must never fail the unlike itself.
    try {
      await executor.execute(
        'DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND kind = \'like\' AND id_community_post = ?',
        [visible.authorId, userId, id]
      );
    } catch {
      // Unlike already succeeded; the stale inbox row is harmless.
    }
  } else {
    await executor.execute(
      'INSERT INTO post_likes (id_community_post, user_id) VALUES (?, ?) ON CONFLICT (id_community_post, user_id) DO NOTHING',
      [id, userId]
    );
    liked = true;
    await notifyUser(executor, { userId: visible.authorId, actorId: userId, kind: 'like', postId: id });
  }
  const post = await getPost(executor, userId, id);
  return post ? { ...post, liked } : null;
}

async function listComments(executor, viewerId, postId, { page = 1, limit = 20 } = {}) {
  const id = cleanId(postId, 'post');
  const post = await getPost(executor, viewerId, id);
  if (!post) return null;
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_FEED_LIMIT, Number(limit)) : 20;
  const offset = (safePage - 1) * safeLimit;
  // Blocked-pair comments stay hidden both ways; private-profile authors are
  // visible to themselves only (mirrors visibilityWhere, three viewer params).
  // V6.1 Phase 3: top-level page is parent_comment_id IS NULL only; replies
  // embed below (max 20 per parent, block-filtered with the same predicate).
  const commentVisibility = `(c.author_id = ? OR up.is_public)`
    + ` AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = c.author_id) OR (b.blocker_id = c.author_id AND b.blocked_id = ?))`;
  const topLevelFilter = 'c.parent_comment_id IS NULL';
  const [[totalRow]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM post_comments c
     JOIN user_profile up ON up.user_id = c.author_id
     WHERE c.id_community_post = ? AND ${topLevelFilter} AND NOT c.is_deleted AND ${commentVisibility}`,
    [id, viewerId, viewerId, viewerId]
  );
  const total = Number(totalRow?.total || 0);
  const [rows] = await executor.execute(
    `SELECT c.id_post_comment AS id, c.author_id, c.body, c.created_at, c.updated_at,
       up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
     FROM post_comments c
     JOIN user_profile up ON up.user_id = c.author_id
     WHERE c.id_community_post = ? AND ${topLevelFilter} AND NOT c.is_deleted AND ${commentVisibility}
     ORDER BY c.id_post_comment ASC LIMIT ? OFFSET ?`,
    [id, viewerId, viewerId, viewerId, safeLimit, offset]
  );
  const topRows = Array.isArray(rows) ? rows : [];
  // Batched reply enrichment (no per-row queries): one COUNT per parent for
  // replyCount plus one ordered fetch capped at 20 per parent in JS.
  let countsByParent = new Map();
  let repliesByParent = new Map();
  const parentIds = topRows.map((row) => Number(row.id)).filter((n) => Number.isSafeInteger(n));
  if (parentIds.length) {
    const inList = parentIds.map(() => '?').join(', ');
    const [countRows] = await executor.execute(
      `SELECT c.parent_comment_id AS parent, COUNT(*) AS total FROM post_comments c
       JOIN user_profile up ON up.user_id = c.author_id
       WHERE c.id_community_post = ? AND c.parent_comment_id IN (${inList}) AND NOT c.is_deleted AND ${commentVisibility}
       GROUP BY c.parent_comment_id`,
      [id, ...parentIds, viewerId, viewerId, viewerId]
    );
    for (const row of Array.isArray(countRows) ? countRows : []) {
      countsByParent.set(Number(row.parent), Number(row.total || 0));
    }
    const [replyRows] = await executor.execute(
      `SELECT c.id_post_comment AS id, c.author_id, c.body, c.created_at, c.updated_at,
         c.parent_comment_id AS parent,
         up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
       FROM post_comments c
       JOIN user_profile up ON up.user_id = c.author_id
       WHERE c.id_community_post = ? AND c.parent_comment_id IN (${inList}) AND NOT c.is_deleted AND ${commentVisibility}
       ORDER BY c.id_post_comment ASC`,
      [id, ...parentIds, viewerId, viewerId, viewerId]
    );
    for (const row of Array.isArray(replyRows) ? replyRows : []) {
      const parent = Number(row.parent);
      if (!repliesByParent.has(parent)) repliesByParent.set(parent, []);
      const bucket = repliesByParent.get(parent);
      // Cap enforced in JS (cheap: at most page-size parents × rows); deeper
      // paging later if needed. replyCount still reflects the full total.
      if (bucket.length >= MAX_REPLIES_PER_COMMENT) continue;
      bucket.push({
        id: Number(row.id),
        authorId: row.author_id,
        mine: String(row.author_id) === String(viewerId),
        body: row.body,
        authorUsername: row.author_username || null,
        authorDisplay: row.author_display || null,
        authorAvatar: row.author_avatar || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at || null,
        edited: isEditedRow(row),
        parentCommentId: parent
      });
    }
  }
  return {
    items: topRows.map((row) => {
      const topId = Number(row.id);
      return {
        id: topId,
        authorId: row.author_id,
        mine: String(row.author_id) === String(viewerId),
        body: row.body,
        authorUsername: row.author_username || null,
        authorDisplay: row.author_display || null,
        authorAvatar: row.author_avatar || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at || null,
        replyCount: countsByParent.get(topId) || 0,
        replies: repliesByParent.get(topId) || []
      };
    }),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: total ? Math.ceil(total / safeLimit) : 0
  };
}

async function createComment(executor, userId, postId, body, parentCommentId = null) {
  const text = cleanText(body, 1000, 'body', { required: true });
  const id = cleanId(postId, 'post');
  // Optional one-level reply parent: validated before the visibility gate so
  // garbage never issues a query; missing/cross-post/nested/deleted → 400.
  let parentId = null;
  let parentAuthorId = null;
  if (parentCommentId !== undefined && parentCommentId !== null && parentCommentId !== '') {
    parentId = cleanId(parentCommentId, 'parentCommentId');
    const [parentRows] = await executor.execute(
      'SELECT id_post_comment AS pid, id_community_post AS post, author_id, parent_comment_id AS parent, is_deleted AS deleted FROM post_comments WHERE id_post_comment = ?',
      [parentId]
    );
    const parent = Array.isArray(parentRows) ? parentRows[0] : null;
    if (!parent || parent.deleted === true || parent.deleted === 1) {
      throw new ValidationError('Parent comment not found.');
    }
    if (Number(parent.post) !== Number(id)) {
      throw new ValidationError('Parent comment must belong to the same post.');
    }
    if (parent.parent !== null && parent.parent !== undefined) {
      throw new ValidationError('Replies are limited to one level.');
    }
    parentAuthorId = parent.author_id;
  }
  // Reply inherits the post visibility gate (deleted/private/blocked → null).
  const post = await getPost(executor, userId, id);
  if (!post) return null;
  let commentId;
  if (parentId === null) {
    const [result] = await executor.execute(
      'INSERT INTO post_comments (id_community_post, author_id, body) VALUES (?, ?, ?) RETURNING id_post_comment AS insertId',
      [id, userId, text]
    );
    commentId = Number(result?.insertId);
  } else {
    const [result] = await executor.execute(
      'INSERT INTO post_comments (id_community_post, author_id, body, parent_comment_id) VALUES (?, ?, ?, ?) RETURNING id_post_comment AS insertId',
      [id, userId, text, parentId]
    );
    commentId = Number(result?.insertId);
  }
  if (!Number.isSafeInteger(commentId) || commentId <= 0) throw new Error('Unable to create the comment.');
  if (parentId === null) {
    if (!post.mine) {
      await notifyUser(executor, { userId: post.authorId, actorId: userId, kind: 'comment', postId: id, commentId });
    }
  } else {
    // Reply rule (avoids double inbox rows): notify the parent comment
    // author only (kind 'reply', no self-notif). The post author is NOT
    // re-notified unless they ARE the parent author — then the single
    // 'reply' row already covers them (never two rows for one reply).
    if (parentAuthorId && String(parentAuthorId) !== String(userId)) {
      await notifyUser(executor, { userId: parentAuthorId, actorId: userId, kind: 'reply', postId: id, commentId });
    }
  }
  const [rows] = await executor.execute(
    `SELECT c.id_post_comment AS id, c.author_id, c.body, c.created_at, c.updated_at, c.parent_comment_id AS parent,
       up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
     FROM post_comments c
     JOIN user_profile up ON up.user_id = c.author_id
     WHERE c.id_post_comment = ?`,
    [commentId]
  );
  const row = (Array.isArray(rows) ? rows : [])[0] || {};
  return {
    id: commentId,
    authorId: userId,
    mine: true,
    body: row.body || text,
    authorUsername: row.author_username || null,
    authorDisplay: row.author_display || null,
    authorAvatar: row.author_avatar || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    parentCommentId: row.parent !== null && row.parent !== undefined ? Number(row.parent) : (parentId !== null ? parentId : null)
  };
}

async function updateComment(executor, userId, commentId, body) {
  const id = cleanId(commentId, 'comment');
  const text = cleanText(body, 1000, 'body', { required: true });
  // The parent post gates the edit: deleted/private/blocked posts resolve to
  // null here (404 upstream), so edits cannot leak through hidden threads.
  const postId = await postIdForComment(executor, id);
  if (!postId) return null;
  const post = await getPost(executor, userId, postId);
  if (!post) return null;
  const [result] = await executor.execute(
    'UPDATE post_comments SET body = ? WHERE id_post_comment = ? AND author_id = ? AND NOT is_deleted',
    [text, id, userId]
  );
  if (Number(result?.affectedRows ?? 0) <= 0) return null;
  return { id, body: text };
}

async function deleteComment(executor, userId, commentId) {
  const id = cleanId(commentId, 'comment');
  // Own comments, plus any comment on the caller's own post (lightweight
  // moderation alongside reporting).
  const [result] = await executor.execute(
    `UPDATE post_comments SET is_deleted = TRUE
     WHERE id_post_comment = ? AND NOT is_deleted
     AND (author_id = ? OR EXISTS (
       SELECT 1 FROM community_posts p
       WHERE p.id_community_post = post_comments.id_community_post AND p.author_id = ?
     ))`,
    [id, userId, userId]
  );
  if (Number(result?.affectedRows ?? 0) <= 0) return null;
  // Orphan-notif hygiene: the comment/reply inbox row no longer describes
  // reality. Replies share the post_comments table, so both kinds clean here.
  // Best-effort — a cleanup failure must never fail the delete itself.
  try {
    await executor.execute(
      'DELETE FROM notifications WHERE kind IN (\'comment\', \'reply\') AND id_post_comment = ?',
      [id]
    );
  } catch {
    // Delete already succeeded; the stale inbox row is harmless.
  }
  return { deletedId: id };
}

async function followUser(executor, followerId, username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new ValidationError('username is required.');
  const [rows] = await executor.execute(
    'SELECT user_id, is_public FROM user_profile WHERE username = ?',
    [name]
  );
  const target = Array.isArray(rows) ? rows[0] : null;
  if (!target || String(target.user_id) === String(followerId)) return null;
  if (target.is_public !== true && target.is_public !== 1) return { notFound: true };
  const [blocked] = await executor.execute(
    `SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    [followerId, target.user_id, target.user_id, followerId]
  );
  if (blocked[0]) return { notFound: true };
  await executor.execute(
    'INSERT INTO user_follows (follower_id, followed_id) VALUES (?, ?) ON CONFLICT (follower_id, followed_id) DO NOTHING',
    [followerId, target.user_id]
  );
  await notifyUser(executor, { userId: target.user_id, actorId: followerId, kind: 'follow' });
  return { followed: String(target.user_id), username: name };
}

async function unfollowUser(executor, followerId, username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new ValidationError('username is required.');
  const [rows] = await executor.execute('SELECT user_id FROM user_profile WHERE username = ?', [name]);
  const target = Array.isArray(rows) ? rows[0] : null;
  if (!target) return null;
  await executor.execute('DELETE FROM user_follows WHERE follower_id = ? AND followed_id = ?', [followerId, target.user_id]);
  return { unfollowed: String(target.user_id), username: name };
}

async function listFollows(executor, userId, username, direction, { page = 1, limit = 20 } = {}) {
  if (direction !== 'followers' && direction !== 'following') throw new ValidationError('direction must be followers or following.');
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new ValidationError('username is required.');
  const [owners] = await executor.execute(
    'SELECT user_id, is_public FROM user_profile WHERE username = ?',
    [name]
  );
  const owner = Array.isArray(owners) ? owners[0] : null;
  if (!owner) return null;
  const isSelf = String(owner.user_id) === String(userId);
  if (!isSelf && owner.is_public !== true && owner.is_public !== 1) return { gated: true };
  const [blocked] = await executor.execute(
    `SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    [userId, owner.user_id, owner.user_id, userId]
  );
  if (!isSelf && blocked[0]) return { gated: true };
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_FEED_LIMIT, Number(limit)) : 20;
  const offset = (safePage - 1) * safeLimit;
  const joinColumn = direction === 'followers' ? 'f.follower_id' : 'f.followed_id';
  const whereColumn = direction === 'followers' ? 'f.followed_id' : 'f.follower_id';
  // Member rows are filtered like any other identity surface: public profiles
  // only (the viewer's own row always passes) and no blocked pair either way
  // versus the viewer.
  const memberVisibility = `(up.user_id = ? OR up.is_public)`
    + ` AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id) OR (b.blocker_id = up.user_id AND b.blocked_id = ?))`;
  const [[totalRow]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM user_follows f
     JOIN user_profile up ON up.user_id = ${joinColumn}
     WHERE ${whereColumn} = ? AND ${memberVisibility}`,
    [owner.user_id, userId, userId, userId]
  );
  const total = Number(totalRow?.total || 0);
  const [rows] = await executor.execute(
    `SELECT up.user_id, up.username, up.display_name, up.avatar_url, up.bio
     FROM user_follows f
     JOIN user_profile up ON up.user_id = ${joinColumn}
     WHERE ${whereColumn} = ? AND ${memberVisibility}
     ORDER BY up.username ASC LIMIT ? OFFSET ?`,
    [owner.user_id, userId, userId, userId, safeLimit, offset]
  );
  const members = Array.isArray(rows) ? rows : [];
  // V6.1 Phase 3: single batched IN-query for viewer-relative flags (no
  // per-row queries). Key: viewerFollowing (viewer follows each member).
  let followingSet = new Set();
  const memberIds = members.map((row) => row.user_id).filter(Boolean);
  if (memberIds.length) {
    const inList = memberIds.map(() => '?').join(', ');
    const [followRows] = await executor.execute(
      `SELECT followed_id FROM user_follows WHERE follower_id = ? AND followed_id IN (${inList})`,
      [userId, ...memberIds]
    );
    for (const row of Array.isArray(followRows) ? followRows : []) {
      if (row && row.followed_id) followingSet.add(String(row.followed_id));
    }
  }
  return {
    items: members.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name || null,
      avatarUrl: row.avatar_url || null,
      bio: row.bio || null,
      viewerFollowing: followingSet.has(String(row.user_id))
    })),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: total ? Math.ceil(total / safeLimit) : 0
  };
}

async function notifyUser(executor, { userId, actorId, kind, postId = null, commentId = null }) {
  if (!userId || String(userId) === String(actorId)) return null;
  // V6.1 Phase 3 adds 'reply' (parent-comment-author inbox row). Migration
  // 042 widens chk_notifications_kind accordingly; older DBs without 042
  // reject the insert (23514/23503 → caller surfaces 400/503, never silent).
  if (!['like', 'comment', 'follow', 'reply'].includes(kind)) return null;
  // Phase 2b (F7): never write an inbox row across a blocking relationship
  // either way. The read-time inbox filters would hide it anyway; skipping
  // the write keeps blocked actors from probing delivery and saves the row.
  const [blocked] = await executor.execute(
    'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
    [actorId, userId, userId, actorId]
  );
  if (Array.isArray(blocked) && blocked[0]) return null;
  const [result] = await executor.execute(
    'INSERT INTO notifications (user_id, actor_id, kind, id_community_post, id_post_comment) VALUES (?, ?, ?, ?, ?) RETURNING id_notification AS insertId',
    [userId, actorId, kind, postId, commentId]
  );
  return result || null;
}

async function listNotifications(executor, userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_FEED_LIMIT, Number(limit)) : 20;
  const offset = (safePage - 1) * safeLimit;
  // Inbox rows that point at a post re-check that post at read time: deleted
  // posts and posts the viewer can no longer see (private/blocked) drop out
  // of the counts and the page alike. Follow notifications carry no post and
  // always pass. (pap = post-author profile; up stays the actor profile.)
  const notifPostJoins = `LEFT JOIN community_posts p ON p.id_community_post = n.id_community_post
    LEFT JOIN user_profile pap ON pap.user_id = p.author_id`;
  const notifPostVisible = `(n.id_community_post IS NULL OR (NOT p.is_deleted AND (p.author_id = ? OR (p.is_public AND pap.is_public))`
    + ` AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = ?))))`;
  const where = unreadOnly ? 'n.user_id = ? AND NOT n.is_read' : 'n.user_id = ?';
  const [[totalRow]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM notifications n ${notifPostJoins} WHERE ${where} AND ${notifPostVisible}`,
    [userId, ...visibilityParams(userId)]
  );
  const [[unreadRow]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM notifications n ${notifPostJoins} WHERE n.user_id = ? AND NOT n.is_read AND ${notifPostVisible}`,
    [userId, ...visibilityParams(userId)]
  );
  const total = Number(totalRow?.total || 0);
  const [rows] = await executor.execute(
    `SELECT n.id_notification AS id, n.actor_id, n.kind, n.id_community_post AS "postId",
       n.id_post_comment AS "commentId", n.is_read AS "isRead", n.created_at AS "createdAt",
       up.username AS actor_username, up.display_name AS actor_display, up.avatar_url AS actor_avatar,
       p.title AS post_title, p.japanese_text AS post_japanese, p.body AS post_body
     FROM notifications n
     LEFT JOIN user_profile up ON up.user_id = n.actor_id
     ${notifPostJoins}
     WHERE ${where} AND ${notifPostVisible}
     ORDER BY n.id_notification DESC LIMIT ? OFFSET ?`,
    [userId, ...visibilityParams(userId), safeLimit, offset]
  );
  return {
    // V6.1 Phase 3 context: excerpt (80-char summary-style truncation from
    // title → japanese_text → body, null for follows/empty) plus
    // actorDisplayName (new canonical key; actorDisplay kept for compat) so
    // clients render "Yuki liked your post: 「…」" without extra fetches.
    items: (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row.id),
      actorId: row.actor_id,
      kind: row.kind,
      postId: row.postId !== null && row.postId !== undefined ? Number(row.postId) : null,
      commentId: row.commentId !== null && row.commentId !== undefined ? Number(row.commentId) : null,
      isRead: row.isRead === true || row.isRead === 1,
      actorUsername: row.actor_username || null,
      actorDisplay: row.actor_display || null,
      actorDisplayName: row.actor_display || null,
      actorAvatar: row.actor_avatar || null,
      excerpt: notificationExcerpt(row.post_title, row.post_japanese, row.post_body),
      createdAt: row.createdAt
    })),
    unread: Number(unreadRow?.total || 0),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: total ? Math.ceil(total / safeLimit) : 0
  };
}

async function markNotificationRead(executor, userId, notificationId) {
  const id = cleanId(notificationId, 'notification');
  const [result] = await executor.execute(
    'UPDATE notifications SET is_read = TRUE WHERE id_notification = ? AND user_id = ? AND NOT is_read',
    [id, userId]
  );
  return Number(result?.affectedRows ?? 0) > 0 ? { id, isRead: true } : null;
}

// V6.0 dashboard widget feed: unread interaction counts grouped by kind
// plus the most recent post titles/actors behind them. Four bounded
// queries, user-scoped; empty inbox → zeroed shape (UI hides, never 0s).
async function getNotificationSummary(executor, userId) {
  // Like/comment inbox rows re-check their post at read time (deleted or
  // no-longer-visible posts drop out of both the counts and the previews);
  // follow rows carry no post and always pass.
  const summaryPostVisible = `(n.id_community_post IS NULL OR (NOT p.is_deleted AND (p.author_id = ? OR (p.is_public AND pap.is_public))`
    + ` AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = ?))))`;
  const [[countRows], [likeRows], [commentRows], [followRows]] = await Promise.all([
    executor.execute(
      `SELECT n.kind, COUNT(*) AS count FROM notifications n
       LEFT JOIN community_posts p ON p.id_community_post = n.id_community_post
       LEFT JOIN user_profile pap ON pap.user_id = p.author_id
       WHERE n.user_id = ? AND NOT n.is_read AND ${summaryPostVisible}
       GROUP BY n.kind`,
      [userId, ...visibilityParams(userId)]
    ),
    executor.execute(
      `SELECT p.id_community_post AS id, p.title, p.japanese_text
       FROM notifications n
       JOIN community_posts p ON p.id_community_post = n.id_community_post
       JOIN user_profile pap ON pap.user_id = p.author_id
       WHERE n.user_id = ? AND NOT n.is_read AND n.kind = 'like'
         AND NOT p.is_deleted AND (p.author_id = ? OR (p.is_public AND pap.is_public))
         AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = ?))
       ORDER BY n.id_notification DESC LIMIT 3`,
      [userId, ...visibilityParams(userId)]
    ),
    executor.execute(
      `SELECT p.id_community_post AS id, p.title, p.japanese_text
       FROM notifications n
       JOIN community_posts p ON p.id_community_post = n.id_community_post
       JOIN user_profile pap ON pap.user_id = p.author_id
       WHERE n.user_id = ? AND NOT n.is_read AND n.kind = 'comment'
         AND NOT p.is_deleted AND (p.author_id = ? OR (p.is_public AND pap.is_public))
         AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = ?))
       ORDER BY n.id_notification DESC LIMIT 3`,
      [userId, ...visibilityParams(userId)]
    ),
    executor.execute(
      `SELECT up.username, up.display_name
       FROM notifications n
       JOIN user_profile up ON up.user_id = n.actor_id
       WHERE n.user_id = ? AND NOT n.is_read AND n.kind = 'follow'
       ORDER BY n.id_notification DESC LIMIT 3`,
      [userId]
    )
  ]);
  const counts = { like: 0, comment: 0, follow: 0 };
  for (const row of Array.isArray(countRows) ? countRows : []) {
    if (counts[row.kind] !== undefined) counts[row.kind] = Number(row.count || 0);
  }
  const postTitle = (row) => {
    const title = String(row.title || row.japanese_text || '').trim();
    return title ? (title.length > 40 ? `${title.slice(0, 40)}…` : title) : 'your post';
  };
  return {
    unread: counts.like + counts.comment + counts.follow,
    likes: {
      count: counts.like,
      posts: (Array.isArray(likeRows) ? likeRows : []).map((row) => ({ id: Number(row.id), title: postTitle(row) }))
    },
    comments: {
      count: counts.comment,
      posts: (Array.isArray(commentRows) ? commentRows : []).map((row) => ({ id: Number(row.id), title: postTitle(row) }))
    },
    follows: {
      count: counts.follow,
      actors: (Array.isArray(followRows) ? followRows : []).map((row) => row.display_name || row.username).filter(Boolean).slice(0, 3)
    }
  };
}

async function markAllNotificationsRead(executor, userId) {
  const [result] = await executor.execute(
    'UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND NOT is_read',
    [userId]
  );
  return { updated: Number(result?.affectedRows ?? 0) };
}

async function createReport(executor, reporterId, { targetType, targetId, reason, details }) {
  if (targetType !== 'post' && targetType !== 'comment') throw new ValidationError('targetType must be post or comment.');
  const id = cleanId(targetId, 'target');
  if (!REPORT_REASONS.includes(reason)) throw new ValidationError(`reason must be one of: ${REPORT_REASONS.join(', ')}.`);
  const note = details === undefined || details === null || details === '' ? null : cleanText(details, 500, 'details');
  if (targetType === 'post') {
    const post = await getPost(executor, reporterId, id);
    if (!post) return null;
    if (post.mine) throw new ValidationError('You cannot report your own post.');
  } else {
    // Comment reports require the parent post to be visible to the
    // reporter; otherwise strangers could probe hidden content by id.
    const parentId = await postIdForComment(executor, id);
    if (!parentId) return null;
    const [commentRows] = await executor.execute(
      'SELECT author_id FROM post_comments WHERE id_post_comment = ? AND NOT is_deleted',
      [id]
    );
    const comment = Array.isArray(commentRows) ? commentRows[0] : null;
    if (!comment) return null;
    if (String(comment.author_id) === String(reporterId)) throw new ValidationError('You cannot report your own comment.');
    const parent = await getPost(executor, reporterId, parentId);
    if (!parent) return null;
  }
  // Phase 2b: one report per reporter per target (application-level dedupe —
  // no unique index, so no migration: the worst case under a race is a
  // second moderation-queue row, harmless). Repeats are a 409, never silent.
  const [existing] = await executor.execute(
    'SELECT 1 FROM content_reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
    [reporterId, targetType, id]
  );
  if (Array.isArray(existing) && existing[0]) {
    throw new ConflictError('You have already reported this content.', 'REPORT_ALREADY_EXISTS');
  }
  const [result] = await executor.execute(
    'INSERT INTO content_reports (reporter_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?) RETURNING id_content_report AS insertId',
    [reporterId, targetType, id, reason, note]
  );
  return { id: Number(result?.insertId) };
}

async function postIdForComment(executor, commentId) {
  const [rows] = await executor.execute('SELECT id_community_post AS id FROM post_comments WHERE id_post_comment = ? AND NOT is_deleted', [commentId]);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? Number(row.id) : null;
}

async function blockUser(executor, blockerId, username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new ValidationError('username is required.');
  const [rows] = await executor.execute('SELECT user_id FROM user_profile WHERE username = ?', [name]);
  const target = Array.isArray(rows) ? rows[0] : null;
  if (!target || String(target.user_id) === String(blockerId)) return null;
  await executor.execute(
    'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT (blocker_id, blocked_id) DO NOTHING',
    [blockerId, target.user_id]
  );
  // Blocking severs follows in both directions so blocked content and
  // interactions disappear immediately from both feeds.
  await executor.execute(
    'DELETE FROM user_follows WHERE (follower_id = ? AND followed_id = ?) OR (follower_id = ? AND followed_id = ?)',
    [blockerId, target.user_id, target.user_id, blockerId]
  );
  return { blocked: String(target.user_id), username: name };
}

async function unblockUser(executor, blockerId, username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new ValidationError('username is required.');
  const [rows] = await executor.execute('SELECT user_id FROM user_profile WHERE username = ?', [name]);
  const target = Array.isArray(rows) ? rows[0] : null;
  if (!target) return null;
  await executor.execute('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, target.user_id]);
  return { unblocked: String(target.user_id), username: name };
}

async function listBlockedUsers(executor, blockerId, { page = 1, limit = 20 } = {}) {
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_BLOCKED_LIMIT, Number(limit)) : 20;
  const offset = (safePage - 1) * safeLimit;
  const [[totalRow]] = await executor.execute(
    'SELECT COUNT(*) AS total FROM user_blocks b WHERE b.blocker_id = ?',
    [blockerId]
  );
  const total = Number(totalRow?.total || 0);
  if (!total) return { items: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
  const [rows] = await executor.execute(
    'SELECT up.user_id, up.username, up.display_name, up.avatar_url ' +
    'FROM user_blocks b ' +
    'JOIN user_profile up ON up.user_id = b.blocked_id ' +
    'WHERE b.blocker_id = ? ' +
    'ORDER BY up.username ASC LIMIT ? OFFSET ?',
    [blockerId, safeLimit, offset]
  );
  return {
    items: (Array.isArray(rows) ? rows : []).map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name || null,
      avatarUrl: row.avatar_url || null
    })),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: total ? Math.ceil(total / safeLimit) : 0
  };
}

async function getUnreadCount(executor, userId) {
  const [[row]] = await executor.execute(
    'SELECT COUNT(*) AS total FROM notifications n WHERE n.user_id = ? AND NOT n.is_read',
    [userId]
  );
  return Number(row?.total || 0);
}

async function getCommunityProfile(executor, viewerId, username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new ValidationError('username is required.');
  const [rows] = await executor.execute(
    'SELECT user_id, username, display_name, bio, avatar_url, is_public, jlpt_level, target_jlpt, interests FROM user_profile WHERE username = ?',
    [name]
  );
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile) return null;
  const isSelf = String(profile.user_id) === String(viewerId);
  if (!isSelf && profile.is_public !== true && profile.is_public !== 1) return { gated: true };
  const [blocked] = await executor.execute(
    `SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    [viewerId, profile.user_id, profile.user_id, viewerId]
  );
  if (!isSelf && blocked[0]) return { gated: true };
  // Phase 2b (F8): study-library sizes (vocabulary/kanji/grammar) are
  // owner-only. The counts object keeps its shape for everyone (same keys),
  // but non-self viewers receive null for the private sizes — null means
  // "undisclosed", never "zero". posts/followers/following stay public.
  let privacyCounts;
  if (isSelf) {
    const [[counts]] = await executor.execute(
      `SELECT
         (SELECT COUNT(*) FROM community_posts WHERE author_id = ? AND NOT is_deleted) AS posts,
         (SELECT COUNT(*) FROM user_follows WHERE followed_id = ?) AS followers,
         (SELECT COUNT(*) FROM user_follows WHERE follower_id = ?) AS following,
         (SELECT COUNT(*) FROM vocabulary WHERE user_id = ?) AS vocabulary,
         (SELECT COUNT(*) FROM kanji WHERE user_id = ?) AS kanji,
         (SELECT COUNT(*) FROM grammar_points WHERE user_id = ?) AS grammar`,
      [profile.user_id, profile.user_id, profile.user_id, profile.user_id, profile.user_id, profile.user_id]
    );
    privacyCounts = {
      posts: Number(counts?.posts || 0),
      followers: Number(counts?.followers || 0),
      following: Number(counts?.following || 0),
      vocabulary: Number(counts?.vocabulary || 0),
      kanji: Number(counts?.kanji || 0),
      grammar: Number(counts?.grammar || 0)
    };
  } else {
    const [[counts]] = await executor.execute(
      `SELECT
         (SELECT COUNT(*) FROM community_posts WHERE author_id = ? AND NOT is_deleted) AS posts,
         (SELECT COUNT(*) FROM user_follows WHERE followed_id = ?) AS followers,
         (SELECT COUNT(*) FROM user_follows WHERE follower_id = ?) AS following`,
      [profile.user_id, profile.user_id, profile.user_id]
    );
    privacyCounts = {
      posts: Number(counts?.posts || 0),
      followers: Number(counts?.followers || 0),
      following: Number(counts?.following || 0),
      vocabulary: null,
      kanji: null,
      grammar: null
    };
  }
  // V6.1 Phase 3 followed-by signals: single batched EXISTS query returns
  // both directions (no per-row queries). following stays for compat;
  // viewerFollowing is the canonical alias; followsYou + mutual are new.
  let viewerFollowing = false;
  let followsYou = false;
  if (!isSelf) {
    const [[followRow]] = await executor.execute(
      'SELECT EXISTS (SELECT 1 FROM user_follows WHERE follower_id = ? AND followed_id = ?) AS following, EXISTS (SELECT 1 FROM user_follows WHERE follower_id = ? AND followed_id = ?) AS followed_by',
      [viewerId, profile.user_id, profile.user_id, viewerId]
    );
    viewerFollowing = Boolean(followRow && (followRow.following === true || followRow.following === 1));
    followsYou = Boolean(followRow && (followRow.followed_by === true || followRow.followed_by === 1));
  }
  return {
    userId: profile.user_id,
    username: profile.username,
    displayName: profile.display_name || null,
    bio: profile.bio || null,
    avatarUrl: profile.avatar_url || null,
    jlptLevel: profile.jlpt_level || null,
    targetJlpt: profile.target_jlpt || null,
    interests: profile.interests || null,
    isSelf,
    following: viewerFollowing,
    viewerFollowing,
    followsYou,
    mutual: Boolean(viewerFollowing && followsYou),
    counts: privacyCounts
  };
}

async function searchCommunity(executor, viewerId, query, { type = 'all', page = 1, limit = 20 } = {}) {
  if (!SEARCH_TYPES.includes(type)) throw new ValidationError('type must be all, posts, people, decks, reading, vocabulary, kanji, or grammar.');
  const text = String(query || '').trim();
  if (text.length > 100) throw new ValidationError('q must not exceed 100 characters.');
  // V6.1 query-less browse: missing/blank q returns recent content per
  // requested type instead of text matches. Ordering EXACT (see header above
  // browseLearningType): posts p.id DESC; decks d.id DESC; reading r.id
  // DESC; people up.updated_at DESC, up.username ASC; learning share-post
  // hits p.id DESC then deck-item hits d.id DESC, position ASC. Gates, caps
  // (MAX_SEARCH_LIMIT), OFFSET paging and hit shapes are identical to text
  // search; only the ILIKE + level predicates are omitted. Non-empty q is
  // byte-identical to the pre-browse behavior below.
  const browse = !text;
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_SEARCH_LIMIT, Number(limit)) : 20;
  // Phase 2b: page was accepted but ignored — every class now pages with a
  // real OFFSET (caps unchanged). The LIKE pattern is wildcard-escaped above.
  const offset = (safePage - 1) * safeLimit;
  const like = browse ? null : `%${escapeLikePattern(text)}%`;
  // Phase 4: bare level queries ("N4") also match level-tagged snapshots.
  const level = browse ? null : parseLevelQuery(text);
  const learningOpts = { like, level, safeLimit, offset };
  const browseLearningOpts = { safeLimit, offset };
  const out = { people: [], posts: [], decks: [], reading: [], vocabulary: [], kanji: [], grammar: [] };
  const jobs = [];
  let rawPeople = [];
  if (type === 'all' || type === 'people') {
    jobs.push((browse
      ? executor.execute(
        `SELECT up.user_id, up.username, up.display_name, up.avatar_url, up.bio
         FROM user_profile up
         WHERE up.username IS NOT NULL AND up.is_public
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id) OR (b.blocker_id = up.user_id AND b.blocked_id = ?))
         ORDER BY up.updated_at DESC, up.username ASC LIMIT ? OFFSET ?`,
        [viewerId, viewerId, safeLimit, offset]
      )
      : executor.execute(
        `SELECT up.user_id, up.username, up.display_name, up.avatar_url, up.bio
         FROM user_profile up
         WHERE up.username IS NOT NULL AND up.is_public
           AND (up.username ILIKE ? ESCAPE '\\' OR COALESCE(up.display_name, '') ILIKE ? ESCAPE '\\')
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id) OR (b.blocker_id = up.user_id AND b.blocked_id = ?))
         ORDER BY up.username ASC LIMIT ? OFFSET ?`,
        [like, like, viewerId, viewerId, safeLimit, offset]
      )).then(([rows]) => {
      rawPeople = Array.isArray(rows) ? rows : [];
    }));
  }
  if (type === 'all' || type === 'posts') {
    jobs.push((browse
      ? executor.execute(
        `SELECT p.id_community_post AS id, p.post_type, p.title, p.body, p.japanese_text, p.created_at,
           up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
          FROM community_posts p
          JOIN user_profile up ON up.user_id = p.author_id
          WHERE NOT p.is_deleted AND ${visibilityWhere('p', 'up')}
          ORDER BY p.id_community_post DESC LIMIT ? OFFSET ?`,
        [...visibilityParams(viewerId), safeLimit, offset]
      )
      : executor.execute(
        `SELECT p.id_community_post AS id, p.post_type, p.title, p.body, p.japanese_text, p.created_at,
           up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
          FROM community_posts p
          JOIN user_profile up ON up.user_id = p.author_id
          WHERE NOT p.is_deleted AND ${visibilityWhere('p', 'up')}
            AND (COALESCE(p.title, '') ILIKE ? ESCAPE '\\' OR COALESCE(p.body, '') ILIKE ? ESCAPE '\\' OR COALESCE(p.japanese_text, '') ILIKE ? ESCAPE '\\')
          ORDER BY p.id_community_post DESC LIMIT ? OFFSET ?`,
        [...visibilityParams(viewerId), like, like, like, safeLimit, offset]
      )).then(([rows]) => {
      out.posts = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id), postType: row.post_type, title: row.title || null, body: row.body || null,
        japaneseText: row.japanese_text || null, authorUsername: row.author_username || null,
        authorDisplay: row.author_display || null, authorAvatar: row.author_avatar || null, createdAt: row.created_at
      }));
    }));
  }
  if (type === 'all' || type === 'decks') {
    // Phase 2b (F9): deck hits require a public deck from a public owner
    // (the viewer's own rows always pass), plus the both-ways block gate.
    jobs.push((browse
      ? executor.execute(
        `SELECT d.id_deck_publication AS id, d.title, d.entity_type, up.username AS owner_username
         FROM deck_publications d
         LEFT JOIN user_profile up ON up.user_id = d.owner_id
         WHERE d.is_public
          AND (d.owner_id = ? OR up.is_public)
          AND NOT EXISTS (
           SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = d.owner_id) OR (b.blocker_id = d.owner_id AND b.blocked_id = ?))
         ORDER BY d.id_deck_publication DESC LIMIT ? OFFSET ?`,
        [viewerId, viewerId, viewerId, safeLimit, offset]
      )
      : executor.execute(
        `SELECT d.id_deck_publication AS id, d.title, d.entity_type, up.username AS owner_username
         FROM deck_publications d
         LEFT JOIN user_profile up ON up.user_id = d.owner_id
         WHERE d.is_public AND d.title ILIKE ? ESCAPE '\\'
          AND (d.owner_id = ? OR up.is_public)
          AND NOT EXISTS (
           SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = d.owner_id) OR (b.blocker_id = d.owner_id AND b.blocked_id = ?))
         ORDER BY d.id_deck_publication DESC LIMIT ? OFFSET ?`,
        [like, viewerId, viewerId, viewerId, safeLimit, offset]
      )).then(([rows]) => {
      out.decks = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id), title: row.title, entityType: row.entity_type, ownerUsername: row.owner_username || null
      }));
    }));
  }
  if (type === 'all' || type === 'reading') {
    // Phase 2b (F9): same owner-publicity gate as deck hits.
    jobs.push((browse
      ? executor.execute(
        `SELECT r.id_reading_publication AS id, r.title, r.level, p.username AS owner_username
         FROM reading_publications r
         LEFT JOIN user_profile p ON p.user_id = r.owner_id
         WHERE r.is_public
          AND (r.owner_id = ? OR p.is_public)
          AND NOT EXISTS (
           SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = r.owner_id) OR (b.blocker_id = r.owner_id AND b.blocked_id = ?))
         ORDER BY r.id_reading_publication DESC LIMIT ? OFFSET ?`,
        [viewerId, viewerId, viewerId, safeLimit, offset]
      )
      : executor.execute(
        `SELECT r.id_reading_publication AS id, r.title, r.level, p.username AS owner_username
         FROM reading_publications r
         LEFT JOIN user_profile p ON p.user_id = r.owner_id
         WHERE r.is_public AND r.title ILIKE ? ESCAPE '\\'
          AND (r.owner_id = ? OR p.is_public)
          AND NOT EXISTS (
           SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = r.owner_id) OR (b.blocker_id = r.owner_id AND b.blocked_id = ?))
         ORDER BY r.id_reading_publication DESC LIMIT ? OFFSET ?`,
        [like, viewerId, viewerId, viewerId, safeLimit, offset]
      )).then(([rows]) => {
      out.reading = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id), title: row.title, level: row.level || null, ownerUsername: row.owner_username || null
      }));
    }));
  }
  await Promise.all(jobs);
  // Phase 4: learning-item types run after the legacy classes (share-post +
  // deck-item hits merged per type, each capped at safeLimit). `all` therefore
  // issues at most 4 legacy + 6 learning queries, all bounded.
  if (type === 'all' || type === 'vocabulary' || type === 'kanji' || type === 'grammar') {
    const wanted = type === 'all' ? ['vocabulary', 'kanji', 'grammar'] : [type];
    await Promise.all(wanted.map(async (learningType) => {
      out[learningType] = browse
        ? await browseLearningType(executor, viewerId, learningType, browseLearningOpts)
        : await searchLearningType(executor, viewerId, learningType, learningOpts);
    }));
  }
  // V6.1 Phase 3: viewer-relative people flags via a single batched edge
  // query (no per-row queries). Keys: following (viewer → person),
  // followsYou (person → viewer).
  if (rawPeople.length) {
    const peopleIds = rawPeople.map((row) => row.user_id).filter(Boolean);
    const inList = peopleIds.map(() => '?').join(', ');
    const [edges] = await executor.execute(
      `SELECT follower_id, followed_id FROM user_follows WHERE (follower_id = ? AND followed_id IN (${inList})) OR (follower_id IN (${inList}) AND followed_id = ?)`,
      [viewerId, ...peopleIds, ...peopleIds, viewerId]
    );
    const followingSet = new Set();
    const followsYouSet = new Set();
    for (const edge of Array.isArray(edges) ? edges : []) {
      if (String(edge.follower_id) === String(viewerId)) followingSet.add(String(edge.followed_id));
      if (String(edge.followed_id) === String(viewerId)) followsYouSet.add(String(edge.follower_id));
    }
    out.people = rawPeople.map((row) => ({
      userId: row.user_id, username: row.username, displayName: row.display_name || null,
      avatarUrl: row.avatar_url || null, bio: row.bio || null,
      following: followingSet.has(String(row.user_id)),
      followsYou: followsYouSet.has(String(row.user_id))
    }));
  } else {
    out.people = [];
  }
  return { ...out, page: safePage, limit: safeLimit };
}

// V6.1 Phase 4: Discover sections. Every section reuses an established gate
// posture (never a new one): posts through visibilityWhere, decks/readings
// through the Phase 2b owner-publicity + both-ways block posture. All
// sections are deterministically ordered with a total-order tiebreak and
// capped small (5 each). No pagination: Discover is a widget, not a feed.
const MAX_DISCOVER_ITEMS = 5;
const DISCOVER_POPULAR_WINDOW_DAYS = 7;
const DISCOVER_POPULAR_POOL_LIMIT = 50;
const DISCOVER_LEARNERS_WINDOW_DAYS = 30;

// Popular-this-week score (EXACT formula — also restated in the Phase 4
// report; change both if this ever changes):
//   score = likeCount + commentCount * 3 + freshnessBonus
//   freshnessBonus = max(0, 24 - floor(ageHours / 12))
//   ageHours = max(0, (nowMs - createdAtMs) / 3600000)
// A brand-new post opens with +24, loses 1 point per 12h, floors at 0 after
// 12 days; inside the 7-day window the bonus ranges 24 → 10, so freshness
// competes with (but never permanently outruns) accumulated engagement.
// Comments weigh 3x likes: conversation signals harder than applause.
// Pure in (likeCount, commentCount, createdAt, nowMs) → pure out, so the
// ranking is deterministic: same input rows always yield the same order.
function popularScore(likeCount, commentCount, createdAt, nowMs = Date.now()) {
  const likes = Math.max(0, Number(likeCount) || 0);
  const comments = Math.max(0, Number(commentCount) || 0);
  const createdMs = new Date(createdAt).getTime();
  const ageHours = Number.isFinite(createdMs) ? Math.max(0, (Number(nowMs) - createdMs) / 3600000) : 0;
  const freshnessBonus = Math.max(0, 24 - Math.floor(ageHours / 12));
  return likes + comments * 3 + freshnessBonus;
}

const DISCOVER_POST_PROJECTION = 'p.id_community_post AS id, p.author_id, p.post_type, p.title, p.body, p.japanese_text, p.translation, ' + 'p.entity_type, p.entity_id, p.deck_id, p.reading_id, p.snapshot_json, p.created_at, ' + 'p.updated_at, ' + 'up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar, ' + POST_COUNT_SELECT;

async function getDiscover(executor, viewerId) {
  // popular candidates: newest 50 visible posts in the 7-day window; ranked
  // in JS by popularScore (keeps the ranking unit-testable without a live DB
  // and deterministic across engines). Bound documented: beyond 50 posts in
  // 7 days, older candidates fall out of the pool before scoring.
  const popularPromise = executor.execute(
    'SELECT ' + DISCOVER_POST_PROJECTION +
    ' FROM community_posts p ' +
    'JOIN user_profile up ON up.user_id = p.author_id ' +
    POST_COUNT_JOINS +
    ' WHERE NOT p.is_deleted AND ' + visibilityWhere('p', 'up') +
    ' AND p.created_at >= NOW() - INTERVAL \'7 days\'' +
    ' ' + POST_GROUP_BY +
    ' ORDER BY p.id_community_post DESC LIMIT ?',
    [viewerId, ...visibilityParams(viewerId), DISCOVER_POPULAR_POOL_LIMIT]
  );
  // learners-you-may-like: authors with recent visible posts the viewer does
  // NOT follow yet. Excludes self, private profiles and blocked pairs (via
  // visibilityWhere), windowed to 30 days, ordered by recent activity
  // (max post id is monotonic → total order, deterministic).
  const learnersPromise = executor.execute(
    `SELECT up.user_id, up.username, up.display_name, up.avatar_url, up.bio,
       MAX(p.id_community_post) AS last_post_id, MAX(p.created_at) AS last_active
      FROM community_posts p
      JOIN user_profile up ON up.user_id = p.author_id
      WHERE NOT p.is_deleted AND ${visibilityWhere('p', 'up')}
        AND p.author_id <> ?
        AND p.created_at >= NOW() - INTERVAL '30 days'
        AND NOT EXISTS (SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = p.author_id)
      GROUP BY up.user_id, up.username, up.display_name, up.avatar_url, up.bio
      ORDER BY last_post_id DESC LIMIT ?`,
    [...visibilityParams(viewerId), viewerId, viewerId, MAX_DISCOVER_ITEMS]
  );
  // useful learning content: newest public decks + readings from public
  // owners (self rows pass), both-ways block gate — Phase 2b posture.
  const decksPromise = executor.execute(
    `SELECT d.id_deck_publication AS id, d.title, d.entity_type, up.username AS owner_username, d.created_at,
       (SELECT COUNT(*) FROM deck_publication_items i WHERE i.id_deck_publication = d.id_deck_publication) AS items
      FROM deck_publications d
      LEFT JOIN user_profile up ON up.user_id = d.owner_id
      WHERE d.is_public
        AND (d.owner_id = ? OR up.is_public)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = d.owner_id) OR (b.blocker_id = d.owner_id AND b.blocked_id = ?))
      ORDER BY d.id_deck_publication DESC LIMIT ?`,
    [viewerId, viewerId, viewerId, MAX_DISCOVER_ITEMS]
  );
  const readingsPromise = executor.execute(
    `SELECT r.id_reading_publication AS id, r.title, r.level, p.username AS owner_username, r.created_at
      FROM reading_publications r
      LEFT JOIN user_profile p ON p.user_id = r.owner_id
      WHERE r.is_public
        AND (r.owner_id = ? OR p.is_public)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = r.owner_id) OR (b.blocker_id = r.owner_id AND b.blocked_id = ?))
      ORDER BY r.id_reading_publication DESC LIMIT ?`,
    [viewerId, viewerId, viewerId, MAX_DISCOVER_ITEMS]
  );
  // open questions: newest visible question posts.
  const questionsPromise = executor.execute(
    'SELECT ' + DISCOVER_POST_PROJECTION +
    ' FROM community_posts p ' +
    'JOIN user_profile up ON up.user_id = p.author_id ' +
    POST_COUNT_JOINS +
    ' WHERE NOT p.is_deleted AND ' + visibilityWhere('p', 'up') +
    ' AND p.post_type = \'question\'' +
    ' ' + POST_GROUP_BY +
    ' ORDER BY p.id_community_post DESC LIMIT ?',
    [viewerId, ...visibilityParams(viewerId), MAX_DISCOVER_ITEMS]
  );
  const [[popularRows], [learnerRows], [deckRows], [readingRows], [questionRows]] = await Promise.all([
    popularPromise, learnersPromise, decksPromise, readingsPromise, questionsPromise
  ]);
  // Phase 3 batched pattern reused: one edge query for viewer-relative flags
  // (no per-row N+1). Learners are unfollowed by construction, so `following`
  // resolves false — still derived from edges, never hardcoded.
  let followingSet = new Set();
  let followsYouSet = new Set();
  const learnerIds = (Array.isArray(learnerRows) ? learnerRows : []).map((row) => row.user_id).filter(Boolean);
  if (learnerIds.length) {
    const inList = learnerIds.map(() => '?').join(', ');
    const [edges] = await executor.execute(
      `SELECT follower_id, followed_id FROM user_follows WHERE (follower_id = ? AND followed_id IN (${inList})) OR (follower_id IN (${inList}) AND followed_id = ?)`,
      [viewerId, ...learnerIds, ...learnerIds, viewerId]
    );
    for (const edge of Array.isArray(edges) ? edges : []) {
      if (String(edge.follower_id) === String(viewerId)) followingSet.add(String(edge.followed_id));
      if (String(edge.followed_id) === String(viewerId)) followsYouSet.add(String(edge.follower_id));
    }
  }
  const learners = (Array.isArray(learnerRows) ? learnerRows : []).map((row) => ({
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name || null,
    avatarUrl: row.avatar_url || null,
    bio: row.bio || null,
    following: followingSet.has(String(row.user_id)),
    followsYou: followsYouSet.has(String(row.user_id)),
    lastActiveAt: row.last_active || null
  }));
  const popular = (Array.isArray(popularRows) ? popularRows : [])
    .map((row) => ({
      post: mapPost(row, viewerId),
      score: popularScore(row.like_count, row.comment_count, row.created_at)
    }))
    .sort((a, b) => (b.score - a.score) || (b.post.id - a.post.id))
    .slice(0, MAX_DISCOVER_ITEMS)
    .map(({ post, score }) => ({ ...post, score }));
  const decks = (Array.isArray(deckRows) ? deckRows : []).map((row) => ({
    id: Number(row.id),
    title: row.title,
    entityType: row.entity_type,
    ownerUsername: row.owner_username || null,
    createdAt: row.created_at,
    itemCount: Number(row.items || 0)
  }));
  const readings = (Array.isArray(readingRows) ? readingRows : []).map((row) => ({
    id: Number(row.id),
    title: row.title,
    level: row.level || null,
    ownerUsername: row.owner_username || null,
    createdAt: row.created_at
  }));
  const questions = (Array.isArray(questionRows) ? questionRows : []).map((row) => mapPost(row, viewerId));
  return { learners, popular, content: { decks, readings }, questions };
}

module.exports = {
  MAX_BLOCKED_LIMIT,
  MAX_FEED_LIMIT,
  MAX_NOTIFICATION_EXCERPT,
  MAX_REPLIES_PER_COMMENT,
  POST_TYPES,
  blockUser,
  createComment,
  createPost,
  createReport,
  deleteComment,
  deletePost,
  followUser,
  getCommunityProfile,
  getDiscover,
  getNotificationSummary,
  getPost,
  getUnreadCount,
  listBlockedUsers,
  listComments,
  listFeed,
  listFollows,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  popularScore,
  searchCommunity,
  toggleLike,
  getShareStats,
  unblockUser,
  unfollowUser,
  updateComment,
  updatePost
};
