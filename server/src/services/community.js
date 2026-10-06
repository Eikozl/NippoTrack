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
const { ValidationError } = require('../errors/http');

const POST_TYPES = ['text', 'example', 'question', 'progress', 'share_deck', 'share_reading', 'share_vocab', 'share_kanji', 'share_grammar'];
const ENTITY_TYPES = ['vocabulary', 'kanji', 'grammar'];
const FEED_TABS = ['latest', 'following', 'discover'];
const REPORT_REASONS = ['spam', 'harassment', 'inappropriate', 'misleading', 'other'];
const MAX_FEED_LIMIT = 30;
const MAX_SEARCH_LIMIT = 20;

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
function visibilityWhere(alias, viewerParam, profileAlias) {
  return `(${alias}.author_id = ${viewerParam} OR (${alias}.is_public AND ${profileAlias}.is_public))`
    + ` AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ${viewerParam} AND b.blocked_id = ${alias}.author_id) OR (b.blocker_id = ${alias}.author_id AND b.blocked_id = ${viewerParam}))`;
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
  return {
    id: Number(row.id),
    authorId: row.author_id,
    mine: String(row.author_id) === String(viewerId),
    postType: row.post_type,
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
    const [rows] = await executor.execute(`SELECT ${columns} FROM ${table} WHERE ${pk} = ? AND user_id = ?`, [entityId, authorId]);
    const entry = Array.isArray(rows) ? rows[0] : null;
    if (!entry) throw new ValidationError('Linked learning item not found.');
    snapshot = { display: entry.display, reading: entry.reading || null, meaning: entry.meaning || null };
  }
  const deckId = payload.deckId ?? null;
  if (deckId !== null) {
    const [rows] = await executor.execute(
      `SELECT d.title, d.entity_type, (SELECT COUNT(*) FROM deck_publication_items i WHERE i.id_deck_publication = d.id_deck_publication) AS items
       FROM deck_publications d WHERE d.id_deck_publication = ? AND (d.owner_id = ? OR d.is_public = TRUE)`,
      [deckId, authorId]
    );
    const deck = Array.isArray(rows) ? rows[0] : null;
    if (!deck) throw new ValidationError('Linked deck not found.');
    snapshot = { ...snapshot, title: deck.title, entityType: deck.entity_type, itemCount: Number(deck.items || 0) };
  }
  const readingId = payload.readingId ?? null;
  if (readingId !== null) {
    const [rows] = await executor.execute(
      `SELECT title, level, char_length(text) AS chars FROM reading_publications
       WHERE id_reading_publication = ? AND (owner_id = ? OR is_public = TRUE)`,
      [readingId, authorId]
    );
    const text = Array.isArray(rows) ? rows[0] : null;
    if (!text) throw new ValidationError('Linked reading text not found.');
    snapshot = { ...snapshot, title: text.title, level: text.level || null, chars: Number(text.chars || 0) };
  }
  return { entityType, entityId, deckId, readingId, snapshot };
}

function validatePostBody(postType, body) {
  if (postType === 'text' || postType === 'question' || postType === 'progress') {
    return cleanText(body.body, 2000, 'body', { required: true });
  }
  return cleanText(body.body, 2000, 'body');
}

async function createPost(executor, authorId, payload) {
  const postType = assertPostType(payload.postType);
  const title = cleanText(payload.title, 200, 'title');
  const body = validatePostBody(postType, payload);
  const japaneseText = postType === 'example'
    ? cleanText(payload.japaneseText, 2000, 'japaneseText', { required: true })
    : cleanText(payload.japaneseText, 2000, 'japaneseText');
  const translation = cleanText(payload.translation, 2000, 'translation');
  const links = await validateLinkedContent(executor, authorId, payload);
  const [result] = await executor.execute(
    `INSERT INTO community_posts (author_id, post_type, title, body, japanese_text, translation, entity_type, entity_id, deck_id, reading_id, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) RETURNING id_community_post AS insertId`,
    [authorId, postType, title, body, japaneseText, translation, links.entityType, links.entityId, links.deckId, links.readingId, JSON.stringify(links.snapshot || {})]
  );
  const id = Number(result?.insertId ?? (Array.isArray(result) ? result[0]?.insertId : undefined));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Unable to create the post.');
  return getPost(executor, authorId, id);
}

async function getPost(executor, viewerId, postId) {
  const id = cleanId(postId, 'post');
  const [rows] = await executor.execute(
    `SELECT p.id_community_post AS id, p.author_id, p.post_type, p.title, p.body, p.japanese_text, p.translation,
       p.entity_type, p.entity_id, p.deck_id, p.reading_id, p.snapshot_json, p.created_at,
       p.updated_at,
       up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar,
       (SELECT COUNT(*) FROM post_likes l WHERE l.id_community_post = p.id_community_post) AS like_count,
       (SELECT COUNT(*) FROM post_comments c WHERE c.id_community_post = p.id_community_post AND NOT c.is_deleted) AS comment_count,
       EXISTS (SELECT 1 FROM post_likes l WHERE l.id_community_post = p.id_community_post AND l.user_id = ?) AS liked
     FROM community_posts p
     JOIN user_profile up ON up.user_id = p.author_id
     WHERE p.id_community_post = ? AND NOT p.is_deleted AND ${visibilityWhere('p', '?', 'up')}`,
    [viewerId, id, viewerId]
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? mapPost(row, viewerId) : null;
}

async function listFeed(executor, viewerId, { tab = 'latest', page = 1, limit = 20 } = {}) {
  if (!FEED_TABS.includes(tab)) throw new ValidationError('tab must be latest, following, or discover.');
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_FEED_LIMIT, Number(limit)) : 20;
  const offset = (safePage - 1) * safeLimit;
  let authorFilter = '';
  const params = [viewerId];
  if (tab === 'following') {
    authorFilter = 'AND EXISTS (SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = p.author_id AND p.author_id <> ?) ';
    params.push(viewerId, viewerId);
  }
  const orderBy = tab === 'discover'
    ? 'ORDER BY like_count DESC, p.id_community_post DESC'
    : 'ORDER BY p.id_community_post DESC';
  const [[totalRow]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM community_posts p
     JOIN user_profile up ON up.user_id = p.author_id
     WHERE NOT p.is_deleted AND ${visibilityWhere('p', '?', 'up')} ${authorFilter}`,
    params
  );
  const total = Number(totalRow?.total || 0);
  if (!total) return { items: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
  const [rows] = await executor.execute(
    `SELECT p.id_community_post AS id, p.author_id, p.post_type, p.title, p.body, p.japanese_text, p.translation,
       p.entity_type, p.entity_id, p.deck_id, p.reading_id, p.snapshot_json, p.created_at,
       p.updated_at,
       up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar,
       (SELECT COUNT(*) FROM post_likes l WHERE l.id_community_post = p.id_community_post) AS like_count,
       (SELECT COUNT(*) FROM post_comments c WHERE c.id_community_post = p.id_community_post AND NOT c.is_deleted) AS comment_count,
       EXISTS (SELECT 1 FROM post_likes l WHERE l.id_community_post = p.id_community_post AND l.user_id = ?) AS liked
     FROM community_posts p
     JOIN user_profile up ON up.user_id = p.author_id
     WHERE NOT p.is_deleted AND ${visibilityWhere('p', '?', 'up')} ${authorFilter}
     ${orderBy} LIMIT ? OFFSET ?`,
    [viewerId, ...params, safeLimit, offset]
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
  // Authors cannot inflate their own posts.
  if (visible.mine) return visible;
  const [existing] = await executor.execute(
    'SELECT 1 FROM post_likes WHERE id_community_post = ? AND user_id = ?',
    [id, userId]
  );
  let liked;
  if (existing[0]) {
    await executor.execute('DELETE FROM post_likes WHERE id_community_post = ? AND user_id = ?', [id, userId]);
    liked = false;
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
  const [[totalRow]] = await executor.execute(
    'SELECT COUNT(*) AS total FROM post_comments WHERE id_community_post = ? AND NOT is_deleted',
    [id]
  );
  const total = Number(totalRow?.total || 0);
  const [rows] = await executor.execute(
    `SELECT c.id_post_comment AS id, c.author_id, c.body, c.created_at, c.updated_at,
       up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
     FROM post_comments c
     JOIN user_profile up ON up.user_id = c.author_id
     WHERE c.id_community_post = ? AND NOT c.is_deleted
     ORDER BY c.id_post_comment ASC LIMIT ? OFFSET ?`,
    [id, safeLimit, offset]
  );
  return {
    items: (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row.id),
      authorId: row.author_id,
      mine: String(row.author_id) === String(viewerId),
      body: row.body,
      authorUsername: row.author_username || null,
      authorDisplay: row.author_display || null,
      authorAvatar: row.author_avatar || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || null
    })),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: total ? Math.ceil(total / safeLimit) : 0
  };
}

async function createComment(executor, userId, postId, body) {
  const text = cleanText(body, 1000, 'body', { required: true });
  const id = cleanId(postId, 'post');
  const post = await getPost(executor, userId, id);
  if (!post) return null;
  const [result] = await executor.execute(
    'INSERT INTO post_comments (id_community_post, author_id, body) VALUES (?, ?, ?) RETURNING id_post_comment AS insertId',
    [id, userId, text]
  );
  const commentId = Number(result?.insertId);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) throw new Error('Unable to create the comment.');
  if (!post.mine) {
    await notifyUser(executor, { userId: post.authorId, actorId: userId, kind: 'comment', postId: id, commentId });
  }
  const [rows] = await executor.execute(
    `SELECT c.id_post_comment AS id, c.author_id, c.body, c.created_at, c.updated_at,
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
    updatedAt: row.updated_at || null
  };
}

async function updateComment(executor, userId, commentId, body) {
  const id = cleanId(commentId, 'comment');
  const text = cleanText(body, 1000, 'body', { required: true });
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
  return Number(result?.affectedRows ?? 0) > 0 ? { deletedId: id } : null;
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
  const [[totalRow]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM user_follows f WHERE ${whereColumn} = ?`,
    [owner.user_id]
  );
  const total = Number(totalRow?.total || 0);
  const [rows] = await executor.execute(
    `SELECT up.user_id, up.username, up.display_name, up.avatar_url, up.bio
     FROM user_follows f
     JOIN user_profile up ON up.user_id = ${joinColumn}
     WHERE ${whereColumn} = ?
     ORDER BY up.username ASC LIMIT ? OFFSET ?`,
    [owner.user_id, safeLimit, offset]
  );
  return {
    items: (Array.isArray(rows) ? rows : []).map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name || null,
      avatarUrl: row.avatar_url || null,
      bio: row.bio || null
    })),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: total ? Math.ceil(total / safeLimit) : 0
  };
}

async function notifyUser(executor, { userId, actorId, kind, postId = null, commentId = null }) {
  if (!userId || String(userId) === String(actorId)) return null;
  if (!['like', 'comment', 'follow'].includes(kind)) return null;
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
  const where = unreadOnly ? 'n.user_id = ? AND NOT n.is_read' : 'n.user_id = ?';
  const [[totalRow]] = await executor.execute(`SELECT COUNT(*) AS total FROM notifications n WHERE ${where}`, [userId]);
  const [[unreadRow]] = await executor.execute('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND NOT is_read', [userId]);
  const total = Number(totalRow?.total || 0);
  const [rows] = await executor.execute(
    `SELECT n.id_notification AS id, n.actor_id, n.kind, n.id_community_post AS "postId",
       n.id_post_comment AS "commentId", n.is_read AS "isRead", n.created_at AS "createdAt",
       up.username AS actor_username, up.display_name AS actor_display, up.avatar_url AS actor_avatar
     FROM notifications n
     LEFT JOIN user_profile up ON up.user_id = n.actor_id
     WHERE ${where}
     ORDER BY n.id_notification DESC LIMIT ? OFFSET ?`,
    [userId, safeLimit, offset]
  );
  return {
    items: (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row.id),
      actorId: row.actor_id,
      kind: row.kind,
      postId: row.postId !== null && row.postId !== undefined ? Number(row.postId) : null,
      commentId: row.commentId !== null && row.commentId !== undefined ? Number(row.commentId) : null,
      isRead: row.isRead === true || row.isRead === 1,
      actorUsername: row.actor_username || null,
      actorDisplay: row.actor_display || null,
      actorAvatar: row.actor_avatar || null,
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
    const parent = await getPost(executor, reporterId, parentId);
    if (!parent) return null;
  }
  const [result] = await executor.execute(
    'INSERT INTO content_reports (reporter_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?) RETURNING id_content_report AS insertId',
    [reporterId, targetType, id, reason, note]
  );
  return { id: Number(result?.insertId) };
}

async function postIdForComment(executor, commentId) {
  const [rows] = await executor.execute('SELECT id_community_post AS id FROM post_comments WHERE id_post_comment = ?', [commentId]);
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

async function listBlockedUsers(executor, blockerId) {
  const [rows] = await executor.execute(
    `SELECT up.user_id, up.username, up.display_name, up.avatar_url
     FROM user_blocks b
     JOIN user_profile up ON up.user_id = b.blocked_id
     WHERE b.blocker_id = ?
     ORDER BY up.username ASC`,
    [blockerId]
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name || null,
    avatarUrl: row.avatar_url || null
  }));
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
  const [[followRow]] = isSelf ? [[null]] : await executor.execute(
    'SELECT 1 AS following FROM user_follows WHERE follower_id = ? AND followed_id = ?',
    [viewerId, profile.user_id]
  );
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
    following: Boolean(followRow && followRow.following),
    counts: {
      posts: Number(counts?.posts || 0),
      followers: Number(counts?.followers || 0),
      following: Number(counts?.following || 0),
      vocabulary: Number(counts?.vocabulary || 0),
      kanji: Number(counts?.kanji || 0),
      grammar: Number(counts?.grammar || 0)
    }
  };
}

async function searchCommunity(executor, viewerId, query, { type = 'all', page = 1, limit = 20 } = {}) {
  const allowed = ['all', 'posts', 'people', 'decks', 'reading'];
  if (!allowed.includes(type)) throw new ValidationError('type must be all, posts, people, decks, or reading.');
  const text = String(query || '').trim();
  if (!text) throw new ValidationError('q is required.');
  if (text.length > 100) throw new ValidationError('q must not exceed 100 characters.');
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(MAX_SEARCH_LIMIT, Number(limit)) : 20;
  const like = `%${text}%`;
  const out = { people: [], posts: [], decks: [], reading: [] };
  const jobs = [];
  if (type === 'all' || type === 'people') {
    jobs.push(executor.execute(
      `SELECT up.user_id, up.username, up.display_name, up.avatar_url, up.bio
       FROM user_profile up
       WHERE up.username IS NOT NULL AND up.is_public
         AND (up.username ILIKE ? OR COALESCE(up.display_name, '') ILIKE ?)
         AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id) OR (b.blocker_id = up.user_id AND b.blocked_id = ?))
       ORDER BY up.username ASC LIMIT ?`,
      [like, like, viewerId, viewerId, safeLimit]
    ).then(([rows]) => {
      out.people = (Array.isArray(rows) ? rows : []).map((row) => ({
        userId: row.user_id, username: row.username, displayName: row.display_name || null,
        avatarUrl: row.avatar_url || null, bio: row.bio || null
      }));
    }));
  }
  if (type === 'all' || type === 'posts') {
    jobs.push(executor.execute(
      `SELECT p.id_community_post AS id, p.post_type, p.title, p.body, p.japanese_text, p.created_at,
         up.username AS author_username, up.display_name AS author_display, up.avatar_url AS author_avatar
       FROM community_posts p
       JOIN user_profile up ON up.user_id = p.author_id
       WHERE NOT p.is_deleted AND ${visibilityWhere('p', '?', 'up')}
         AND (COALESCE(p.title, '') ILIKE ? OR COALESCE(p.body, '') ILIKE ? OR COALESCE(p.japanese_text, '') ILIKE ?)
       ORDER BY p.id_community_post DESC LIMIT ?`,
      [viewerId, like, like, like, safeLimit]
    ).then(([rows]) => {
      out.posts = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id), postType: row.post_type, title: row.title || null, body: row.body || null,
        japaneseText: row.japanese_text || null, authorUsername: row.author_username || null,
        authorDisplay: row.author_display || null, authorAvatar: row.author_avatar || null, createdAt: row.created_at
      }));
    }));
  }
  if (type === 'all' || type === 'decks') {
    jobs.push(executor.execute(
      `SELECT d.id_deck_publication AS id, d.title, d.entity_type, up.username AS owner_username
       FROM deck_publications d
       LEFT JOIN user_profile up ON up.user_id = d.owner_id
       WHERE d.is_public AND d.title ILIKE ? AND NOT EXISTS (
         SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = d.owner_id) OR (b.blocker_id = d.owner_id AND b.blocked_id = ?))
       ORDER BY d.id_deck_publication DESC LIMIT ?`,
      [like, viewerId, viewerId, safeLimit]
    ).then(([rows]) => {
      out.decks = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id), title: row.title, entityType: row.entity_type, ownerUsername: row.owner_username || null
      }));
    }));
  }
  if (type === 'all' || type === 'reading') {
    jobs.push(executor.execute(
      `SELECT r.id_reading_publication AS id, r.title, r.level, p.username AS owner_username
       FROM reading_publications r
       LEFT JOIN user_profile p ON p.user_id = r.owner_id
       WHERE r.is_public AND r.title ILIKE ? AND NOT EXISTS (
         SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = r.owner_id) OR (b.blocker_id = r.owner_id AND b.blocked_id = ?))
       ORDER BY r.id_reading_publication DESC LIMIT ?`,
      [like, viewerId, viewerId, safeLimit]
    ).then(([rows]) => {
      out.reading = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id), title: row.title, level: row.level || null, ownerUsername: row.owner_username || null
      }));
    }));
  }
  await Promise.all(jobs);
  return { ...out, page: safePage, limit: safeLimit };
}

module.exports = {
  MAX_FEED_LIMIT,
  POST_TYPES,
  blockUser,
  createComment,
  createPost,
  createReport,
  deleteComment,
  deletePost,
  followUser,
  getCommunityProfile,
  getPost,
  listBlockedUsers,
  listComments,
  listFeed,
  listFollows,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  searchCommunity,
  toggleLike,
  unblockUser,
  unfollowUser,
  updateComment,
  updatePost
};
