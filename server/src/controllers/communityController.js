// V6.0 Social Community endpoints. Identity always derives from
// req.user.id; no endpoint accepts a userId/ownerId from the caller.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const { parsePagination, paginationPayload } = require('../pagination');
const community = require('../services/community');

function postBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be an object.');
  }
  return body;
}

function rejectUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ValidationError(`Unexpected field(s): ${unknown.join(', ')}.`);
}

async function createPost(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['postType', 'title', 'body', 'japaneseText', 'translation', 'entityType', 'entityId', 'deckId', 'readingId']);
    const post = await community.createPost(pool, req.user.id, body);
    return res.status(201).json(post);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to create the post.' });
  }
}

async function getPost(req, res) {
  try {
    const post = await community.getPost(pool, req.user.id, parseIdParam(req, 'post'));
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    return res.json(post);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the post.' });
  }
}

async function listFeed(req, res) {
  try {
    const query = req.query || {};
    const { page, limit } = parsePagination(query);
    const result = await community.listFeed(pool, req.user.id, {
      tab: query.tab || 'latest',
      author: query.author || null,
      page,
      limit
    });
    return res.json({ items: result.items, pagination: paginationPayload(result.items, result.total, result.page, result.limit) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the feed.' });
  }
}

async function updatePost(req, res) {
  try {
    const body = postBody(req.body);
    const post = await community.updatePost(pool, req.user.id, parseIdParam(req, 'post'), body);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    return res.json(post);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to update the post.' });
  }
}

async function deletePost(req, res) {
  try {
    const result = await community.deletePost(pool, req.user.id, parseIdParam(req, 'post'));
    if (!result) return res.status(404).json({ error: 'Post not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to delete the post.' });
  }
}

async function toggleLike(req, res) {
  try {
    const post = await community.toggleLike(pool, req.user.id, parseIdParam(req, 'post'));
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    return res.json(post);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to like the post.' });
  }
}

async function listComments(req, res) {
  try {
    const query = req.query || {};
    const { page, limit } = parsePagination(query);
    const result = await community.listComments(pool, req.user.id, parseIdParam(req, 'post'), { page, limit });
    if (!result) return res.status(404).json({ error: 'Post not found.' });
    return res.json({ items: result.items, pagination: paginationPayload(result.items, result.total, result.page, result.limit) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load comments.' });
  }
}

async function createComment(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['body', 'parentCommentId']);
    const comment = await community.createComment(pool, req.user.id, parseIdParam(req, 'post'), body.body, body.parentCommentId ?? null);
    if (!comment) return res.status(404).json({ error: 'Post not found.' });
    return res.status(201).json(comment);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to create the comment.' });
  }
}

async function updateComment(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['body']);
    const comment = await community.updateComment(pool, req.user.id, parseIdParam(req, 'comment'), body.body);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    return res.json(comment);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to update the comment.' });
  }
}

async function deleteComment(req, res) {
  try {
    const result = await community.deleteComment(pool, req.user.id, parseIdParam(req, 'comment'));
    if (!result) return res.status(404).json({ error: 'Comment not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to delete the comment.' });
  }
}

async function followUser(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['username']);
    const result = await community.followUser(pool, req.user.id, body.username);
    if (!result || result.notFound) return res.status(404).json({ error: 'User not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to follow the user.' });
  }
}

async function unfollowUser(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['username']);
    const result = await community.unfollowUser(pool, req.user.id, body.username);
    if (!result) return res.status(404).json({ error: 'User not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to unfollow the user.' });
  }
}

async function listFollows(req, res) {
  try {
    const query = req.query || {};
    const { page, limit } = parsePagination(query);
    const result = await community.listFollows(pool, req.user.id, req.params.username, req.params.direction, { page, limit });
    if (!result) return res.status(404).json({ error: 'User not found.' });
    if (result.gated) return res.status(404).json({ error: 'User not found.' });
    return res.json({ items: result.items, pagination: paginationPayload(result.items, result.total, result.page, result.limit) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load follows.' });
  }
}

async function listNotifications(req, res) {
  try {
    const query = req.query || {};
    const { page, limit } = parsePagination(query);
    const result = await community.listNotifications(pool, req.user.id, {
      page,
      limit,
      unreadOnly: query.unread === '1' || query.unread === 'true'
    });
    return res.json({ items: result.items, unread: result.unread, pagination: paginationPayload(result.items, result.total, result.page, result.limit) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load notifications.' });
  }
}

async function markNotificationRead(req, res) {
  try {
    const result = await community.markNotificationRead(pool, req.user.id, parseIdParam(req, 'notification'));
    if (!result) return res.status(404).json({ error: 'Notification not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to update the notification.' });
  }
}

async function notificationSummary(req, res) {
  try {
    return res.json(await community.getNotificationSummary(pool, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load notification summary.' });
  }
}

async function markAllNotificationsRead(req, res) {
  try {
    return res.json({ success: true, ...(await community.markAllNotificationsRead(pool, req.user.id)) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to update notifications.' });
  }
}

async function createReport(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['targetType', 'targetId', 'reason', 'details']);
    const result = await community.createReport(pool, req.user.id, body);
    if (!result) return res.status(404).json({ error: 'Reported content not found.' });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to create the report.' });
  }
}

async function blockUser(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['username']);
    const result = await community.blockUser(pool, req.user.id, body.username);
    if (!result) return res.status(404).json({ error: 'User not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to block the user.' });
  }
}

async function unblockUser(req, res) {
  try {
    const body = postBody(req.body);
    rejectUnknownFields(body, ['username']);
    const result = await community.unblockUser(pool, req.user.id, body.username);
    if (!result) return res.status(404).json({ error: 'User not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to unblock the user.' });
  }
}

async function listBlockedUsers(req, res) {
  try {
    return res.json({ items: await community.listBlockedUsers(pool, req.user.id) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load blocked users.' });
  }
}

async function getProfile(req, res) {
  try {
    const profile = await community.getCommunityProfile(pool, req.user.id, req.params.username);
    if (!profile) return res.status(404).json({ error: 'User not found.' });
    if (profile.gated) return res.status(404).json({ error: 'User not found.' });
    return res.json(profile);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the profile.' });
  }
}

async function searchCommunity(req, res) {
  try {
    const query = req.query || {};
    const { page, limit } = parsePagination(query);
    const result = await community.searchCommunity(pool, req.user.id, query.q || '', {
      type: query.type || 'all',
      page,
      limit
    });
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to search the community.' });
  }
}

async function getDiscover(req, res) {
  try {
    return res.json(await community.getDiscover(pool, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load Discover.' });
  }
}

module.exports = {
  blockUser,
  createComment,
  createPost,
  createReport,
  deleteComment,
  deletePost,
  followUser,
  getDiscover,
  getPost,
  getProfile,
  listBlockedUsers,
  listComments,
  listFeed,
  listFollows,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationSummary,
  searchCommunity,
  unblockUser,
  unfollowUser,
  updateComment,
  updatePost,
  toggleLike
};
