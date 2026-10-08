// Profile avatar uploads: one fixed public JPEG object per user.
//
// Contract (frozen with the client team):
// - Bucket `avatars`, PUBLIC read. Object path `<userId>/avatar.jpg` built
//   server-side from req.user.id only (never from client filenames).
// - POST /api/users/me/avatar stores multipart field `avatar` with
//   upsert:true, contentType 'image/jpeg', cacheControl 'public, max-age=3600'
//   and responds { avatarUrl } (public URL + ?v=<Date.now()> cache-buster).
//   The client then persists the URL itself via PUT /api/users/me.
// - DELETE /api/users/me/avatar removes the object (not-found ignored) and
//   NULLs avatar_url through the same upsert path as putOwnProfile.
//
// Security posture (by construction):
// - Magic bytes over extension/MIME: JPEG SOI (FF D8) required, nothing else
//   accepted (PNG/WebP/GIF/BMP/SVG rejected; SVG is script-capable).
// - Hard 2MB ceiling (AVATAR_MAX_BYTES); empty files rejected.
// - Path confinement: userId must be a UUID, so no client-controlled segment
//   can escape `<uuid>/avatar.jpg` (single fixed path => zero orphans, and no
//   user enumeration: other users' paths are unreachable, 404/403 identical).
// - Service-key mediation: all storage writes use a server-side client built
//   from SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY); the key
//   never leaves the server and no client storage credentials exist.
// - Dependency-free multipart parsing and in-memory per-user throttle
//   (lexicalRateLimit.js style: per-process bound, honestly documented).
const { createClient } = require('@supabase/supabase-js');
const { ValidationError } = require('../errors/http');
const pool = require('../config/db');

const AVATAR_BUCKET = 'avatars';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_CONTENT_TYPE = 'image/jpeg';
const AVATAR_CACHE_CONTROL = 'public, max-age=3600';
const AVATAR_URL_MAX_CHARS = 500;
const AVATAR_UPLOAD_LIMIT_MAX = 20;
const AVATAR_UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const AVATAR_BUCKET_CAP = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const buckets = new Map();

function tryConsumeAvatarUpload({ userId, now = Date.now() } = {}) {
  const key = `user:${userId}`;
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + AVATAR_UPLOAD_WINDOW_MS }
    : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > AVATAR_BUCKET_CAP) {
    for (const [storedKey, stored] of buckets) {
      if (stored.resetAt <= now) buckets.delete(storedKey);
    }
  }
  if (bucket.count <= AVATAR_UPLOAD_LIMIT_MAX) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

// Test-only hook: clears in-memory buckets. Not reachable from any route.
function resetAvatarLimitsForTests() {
  buckets.clear();
}

// Single fixed object path per user. The UUID gate is the path-confinement
// enforcement: req.user.id is authed, but nothing client-controlled ever
// becomes a path segment, so traversal (`../`, `/`, absolute paths) cannot
// be expressed. Generic message: no user enumeration via error text.
function avatarObjectPath(userId) {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new ValidationError('Invalid user.');
  }
  return `${userId}/avatar.jpg`;
}

// JPEG SOI marker (FF D8). Only the leading magic bytes are enforced: the
// client always uploads canvas-produced image/jpeg, and every other format
// (PNG 89 50 4E 47, GIF 47 49 46 38, WebP RIFF, BMP 42 4D, SVG 3C text) is
// rejected regardless of extension or declared MIME type.
function isJpegBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function validateAvatarBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError('Avatar file is empty.');
  }
  if (buffer.length > AVATAR_MAX_BYTES) {
    throw new ValidationError('Avatar file must be 2MB or smaller.');
  }
  if (!isJpegBuffer(buffer)) {
    throw new ValidationError('Avatar must be a JPEG image.');
  }
  return buffer;
}

// Dependency-free multipart extractor for the single `avatar` field.
// The route mounts express.raw({ type: 'multipart/form-data' }) so req.body
// is the raw Buffer here; headers are ASCII-parsed and only the byte offsets
// are used, so binary content is never corrupted by string decoding.
// Filenames are ignored entirely (never trusted, never echoed).
function extractAvatarFromMultipart(req) {
  const getHeader = typeof req.get === 'function'
    ? (name) => req.get(name)
    : (name) => req.headers?.[name.toLowerCase()];
  const contentType = getHeader('content-type') || '';
  const match = /boundary=([^;]+)/i.exec(contentType);
  const boundary = match ? match[1].trim().replace(/^"|"$/g, '') : '';
  const body = req.body;
  if (!boundary || !Buffer.isBuffer(body) || body.length === 0) {
    throw new ValidationError('Avatar file is required. Send multipart form-data with field "avatar".');
  }
  const delimiter = Buffer.from(`--${boundary}`, 'ascii');
  const positions = [];
  let cursor = 0;
  while (positions.length <= 32) {
    const index = body.indexOf(delimiter, cursor);
    if (index === -1) break;
    positions.push(index);
    cursor = index + delimiter.length;
  }
  const headerSeparator = Buffer.from('\r\n\r\n');
  for (let i = 0; i + 1 < positions.length; i += 1) {
    let segStart = positions[i] + delimiter.length;
    if (body[segStart] === 0x0d && body[segStart + 1] === 0x0a) segStart += 2;
    let segEnd = positions[i + 1];
    if (body[segEnd - 2] === 0x0d && body[segEnd - 1] === 0x0a) segEnd -= 2;
    if (segEnd <= segStart) continue;
    const segment = body.slice(segStart, segEnd);
    const headerEnd = segment.indexOf(headerSeparator);
    if (headerEnd === -1) continue;
    const headers = segment.slice(0, headerEnd).toString('latin1');
    if (!/name="avatar"/.test(headers)) continue;
    const content = Buffer.from(segment.slice(headerEnd + headerSeparator.length));
    if (content.length === 0) throw new ValidationError('Avatar file is empty.');
    return content;
  }
  throw new ValidationError('Avatar file is required. Send multipart form-data with field "avatar".');
}

function avatarServiceConfig() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const serviceKey = (
    process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_INTEGRATION_SECRET_KEY
    || ''
  ).trim();
  if (!url || !serviceKey) throw new Error('Avatar storage is not configured.');
  return { url: url.replace(/\/+$/, ''), serviceKey };
}

// Service-role client for Storage writes only. Keys stay server-side: this
// module never serializes them and no endpoint ever returns them.
function defaultStorageClient() {
  const { url, serviceKey } = avatarServiceConfig();
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
}

function publicAvatarUrl(base, objectPath, now) {
  return `${base.replace(/\/+$/, '')}/storage/v1/object/public/${AVATAR_BUCKET}/${objectPath}?v=${now}`;
}

// Storage write only (no DB write here by contract: the client persists the
// returned URL itself via PUT /api/users/me { avatar_url }). The 500-char
// guard runs before returning so the follow-up PUT can never overflow
// user_profile.avatar_url varchar(500).
async function storeAvatar({ userId, buffer, storage, now = Date.now(), publicBase } = {}) {
  validateAvatarBuffer(buffer);
  const objectPath = avatarObjectPath(userId);
  const client = storage || defaultStorageClient();
  const { error } = await client.storage.from(AVATAR_BUCKET).upload(objectPath, buffer, {
    upsert: true,
    contentType: AVATAR_CONTENT_TYPE,
    cacheControl: AVATAR_CACHE_CONTROL
  });
  if (error) throw new Error('Avatar storage upload failed.', { cause: error });
  const base = publicBase !== undefined ? publicBase : avatarServiceConfig().url;
  const avatarUrl = publicAvatarUrl(base, objectPath, now);
  if (avatarUrl.length > AVATAR_URL_MAX_CHARS) {
    throw new ValidationError('Avatar URL exceeds the 500 character limit.');
  }
  return { objectPath, avatarUrl };
}

// Delete the storage object (not-found is ignored: deleting twice, or
// deleting without ever uploading, is still a successful clear), then NULL
// the column through the same INSERT ... ON CONFLICT upsert path that
// putOwnProfile uses. Real storage failures abort before the DB write so a
// failed removal never reports success; the fixed single path means a retry
// (or the next upload's upsert) can never leave orphans behind.
async function clearAvatar({ userId, db = pool, storage } = {}) {
  const objectPath = avatarObjectPath(userId);
  const client = storage || defaultStorageClient();
  const { error } = await client.storage.from(AVATAR_BUCKET).remove([objectPath]);
  if (error && !/not[ -]?found|nosuchkey|does not exist/i.test(String(error.message || ''))) {
    throw new Error('Avatar storage removal failed.', { cause: error });
  }
  await db.execute(
    'INSERT INTO user_profile (user_id, avatar_url) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url',
    [userId, null]
  );
  return { avatarUrl: null };
}

module.exports = {
  AVATAR_BUCKET,
  AVATAR_BUCKET_CAP,
  AVATAR_CACHE_CONTROL,
  AVATAR_CONTENT_TYPE,
  AVATAR_MAX_BYTES,
  AVATAR_UPLOAD_LIMIT_MAX,
  AVATAR_UPLOAD_WINDOW_MS,
  AVATAR_URL_MAX_CHARS,
  avatarObjectPath,
  avatarServiceConfig,
  clearAvatar,
  defaultStorageClient,
  extractAvatarFromMultipart,
  isJpegBuffer,
  publicAvatarUrl,
  resetAvatarLimitsForTests,
  storeAvatar,
  tryConsumeAvatarUpload,
  validateAvatarBuffer
};
