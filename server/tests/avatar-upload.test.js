// Profile avatar upload (server side): route wiring, JPEG-only magic-byte
// validation, 2MB cap, fixed-path construction, service-key-mediated storage
// semantics and null-clearing delete. Hermetic throughout: mocked storage
// client + stub executor/controller seams per repo test style (no live DB,
// no network). Preview/test project only; production is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const PUBLIC_BASE = 'https://mufxygohcjikhlktvrcy.supabase.co';

const pool = require('../src/config/db');
const { ValidationError } = require('../src/errors/http');
const profileAvatar = require('../src/services/profileAvatar');
const controller = require('../src/controllers/deckPublicationsController');

test.after(async () => {
  await pool.end();
});

const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function mockRes() {
  let statusCode = 200;
  let body;
  const headers = {};
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; },
    setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); }
  };
  return { res, status: () => statusCode, body: () => body, headers };
}

function multipartBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'ascii'));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`${disposition}\r\n`, 'ascii'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'ascii'));
    chunks.push(Buffer.from('\r\n', 'ascii'));
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n', 'ascii'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'ascii'));
  return Buffer.concat(chunks);
}

function mockMultipartReq(body, boundary, userId = USER_ID) {
  const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return {
    user: { id: userId },
    headers,
    body,
    get(name) { return headers[String(name).toLowerCase()]; }
  };
}

function mockStorage({ uploads = [], removals = [], uploadError = null, removeError = null } = {}) {
  return {
    storage: {
      from(bucket) {
        return {
          async upload(objectPath, buffer, options) {
            uploads.push({ bucket, objectPath, buffer, options });
            return { error: uploadError };
          },
          async remove(objectPaths) {
            removals.push({ bucket, objectPaths });
            return { error: removeError };
          }
        };
      }
    }
  };
}

test('route wiring: POST + DELETE /me/avatar exist with a multipart parser on POST', () => {
  const usersRouter = require('../src/routes/users');
  const routes = usersRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]),
      handlers: layer.route.stack.length
    }));
  const post = routes.find((r) => r.path === '/me/avatar' && r.methods.includes('post'));
  const del = routes.find((r) => r.path === '/me/avatar' && r.methods.includes('delete'));
  assert.ok(post, 'POST /me/avatar is wired');
  assert.ok(del, 'DELETE /me/avatar is wired');
  assert.ok(post.handlers >= 2, 'POST carries the raw multipart parser plus the controller');
});

test('AVATAR_MAX_BYTES is the 2MB hard ceiling', () => {
  assert.equal(profileAvatar.AVATAR_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(profileAvatar.AVATAR_URL_MAX_CHARS, 500);
});

test('magic bytes: canvas JPEG accepted, everything else rejected', () => {
  assert.equal(profileAvatar.validateAvatarBuffer(JPEG_MIN), JPEG_MIN);
  const rejected = [
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])],
    ['GIF87a', Buffer.from('GIF87aFakeImageData', 'ascii')],
    ['GIF89a', Buffer.from('GIF89aFakeImageData', 'ascii')],
    ['WebP', Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 fake', 'ascii')],
    ['BMP', Buffer.from([0x42, 0x4d, 0x46, 0x00, 0x00, 0x00, 0x00, 0x00])],
    ['EXE (MZ)', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'ascii')],
    ['plain text', Buffer.from('hello, not an image', 'ascii')],
    ['empty', Buffer.alloc(0)],
    ['single 0xFF (truncated SOI)', Buffer.from([0xff])]
  ];
  for (const [label, bytes] of rejected) {
    assert.throws(() => profileAvatar.validateAvatarBuffer(bytes), ValidationError, `${label} must be rejected`);
  }
});

test('2MB cap: exactly MAX passes, MAX+1 rejected, empty rejected', () => {
  const atMax = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(profileAvatar.AVATAR_MAX_BYTES - 2)]);
  assert.equal(atMax.length, profileAvatar.AVATAR_MAX_BYTES);
  assert.doesNotThrow(() => profileAvatar.validateAvatarBuffer(atMax));
  const overMax = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(profileAvatar.AVATAR_MAX_BYTES - 1)]);
  assert.throws(() => profileAvatar.validateAvatarBuffer(overMax), ValidationError, 'over-cap upload rejected');
  assert.throws(() => profileAvatar.validateAvatarBuffer(Buffer.alloc(0)), ValidationError, 'empty file rejected');
});

test('fixed path: server-built <userId>/avatar.jpg, traversal impossible', () => {
  assert.equal(profileAvatar.avatarObjectPath(USER_ID), `${USER_ID}/avatar.jpg`);
  // Client filenames are never an input: the builder takes only the authed id.
  assert.equal(profileAvatar.avatarObjectPath.length, 1);
  for (const evil of ['../evil', '..\\evil', 'a/b/avatar.jpg', '/etc/passwd', '', null, undefined, 42, 'not-a-uuid', `${USER_ID}/../x`, `${USER_ID}\n/evil`]) {
    assert.throws(() => profileAvatar.avatarObjectPath(evil), ValidationError, `traversal input rejected: ${String(evil)}`);
  }
  // No user enumeration surface: one fixed path per caller, generic errors.
  assert.throws(() => profileAvatar.avatarObjectPath(OTHER_ID.slice(0, 8)), ValidationError);
});

test('path construction takes no client filename influence (no originalname/path inputs)', () => {
  // Source-level pin (read as text, client-test style): the object path is
  // built from req.user.id only — multer-style originalname and body path
  // segments must appear nowhere in the avatar write path.
  for (const sourcePath of ['../src/services/profileAvatar.js', '../src/routes/users.js', '../src/controllers/deckPublicationsController.js']) {
    const source = fs.readFileSync(path.join(__dirname, sourcePath), 'utf8');
    assert.ok(!source.includes('originalname'), `no client filename in ${sourcePath}`);
    assert.ok(!source.includes('req.body.path'), `no client path segment in ${sourcePath}`);
    assert.ok(!source.includes('req.file'), `no multer file passthrough in ${sourcePath}`);
  }
  // Behavioral pin: distinct callers resolve to distinct fixed paths, so one
  // user can never address another user's object.
  assert.notEqual(profileAvatar.avatarObjectPath(USER_ID), profileAvatar.avatarObjectPath(OTHER_ID));
});

test('multipart extractor: returns exact avatar bytes, ignores filenames', () => {
  const boundary = '----TestBoundary123';
  const body = multipartBody(boundary, [
    { name: 'avatar', filename: '../../../evil.png', contentType: 'image/png', data: JPEG_MIN }
  ]);
  const out = profileAvatar.extractAvatarFromMultipart(mockMultipartReq(body, boundary));
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, JPEG_MIN);
});

test('multipart extractor: missing/empty avatar field is a 400-class error', () => {
  const boundary = '----TestBoundary456';
  const wrongField = multipartBody(boundary, [
    { name: 'file', filename: 'a.jpg', contentType: 'image/jpeg', data: JPEG_MIN }
  ]);
  assert.throws(
    () => profileAvatar.extractAvatarFromMultipart(mockMultipartReq(wrongField, boundary)),
    ValidationError
  );
  const emptyFile = multipartBody(boundary, [
    { name: 'avatar', filename: 'a.jpg', contentType: 'image/jpeg', data: Buffer.alloc(0) }
  ]);
  assert.throws(
    () => profileAvatar.extractAvatarFromMultipart(mockMultipartReq(emptyFile, boundary)),
    ValidationError
  );
  const notMultipart = { user: { id: USER_ID }, headers: {}, body: undefined, get: () => undefined };
  assert.throws(() => profileAvatar.extractAvatarFromMultipart(notMultipart), ValidationError);
});

test('storeAvatar: fixed path, upsert jpeg options, cache-busted public URL', async () => {
  const uploads = [];
  const storage = mockStorage({ uploads });
  const result = await profileAvatar.storeAvatar({
    userId: USER_ID,
    buffer: JPEG_MIN,
    storage,
    now: 1700000000000,
    publicBase: PUBLIC_BASE
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bucket, 'avatars');
  assert.equal(uploads[0].objectPath, `${USER_ID}/avatar.jpg`);
  assert.deepEqual(uploads[0].buffer, JPEG_MIN);
  assert.deepEqual(uploads[0].options, {
    upsert: true,
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=3600'
  });
  assert.equal(
    result.avatarUrl,
    `${PUBLIC_BASE}/storage/v1/object/public/avatars/${USER_ID}/avatar.jpg?v=1700000000000`
  );
  assert.equal(result.objectPath, `${USER_ID}/avatar.jpg`);
});

test('storeAvatar: storage failure surfaces (no silent success), overlong URL rejected pre-write', async () => {
  await assert.rejects(
    profileAvatar.storeAvatar({
      userId: USER_ID,
      buffer: JPEG_MIN,
      storage: mockStorage({ uploadError: { message: 'boom' } }),
      now: 1,
      publicBase: PUBLIC_BASE
    }),
    /Avatar storage upload failed/
  );
  await assert.rejects(
    profileAvatar.storeAvatar({
      userId: USER_ID,
      buffer: JPEG_MIN,
      storage: mockStorage(),
      now: 1,
      publicBase: `https://example.supabase.co/${'y'.repeat(500)}`
    }),
    ValidationError,
    'avatar_url longer than varchar(500) is refused before any DB write'
  );
});

test('clearAvatar: removes fixed path, NULLs avatar_url via the putOwnProfile upsert path', async () => {
  const removals = [];
  const seen = [];
  const db = { execute: async (sql, params = []) => { seen.push({ sql, params }); return [[]]; } };
  const result = await profileAvatar.clearAvatar({
    userId: USER_ID,
    db,
    storage: mockStorage({ removals })
  });
  assert.deepEqual(result, { avatarUrl: null });
  assert.equal(removals.length, 1);
  assert.equal(removals[0].bucket, 'avatars');
  assert.deepEqual(removals[0].objectPaths, [`${USER_ID}/avatar.jpg`]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /avatar_url/i);
  assert.match(seen[0].sql, /ON CONFLICT \(user_id\) DO UPDATE SET avatar_url/i);
  assert.deepEqual(seen[0].params, [USER_ID, null]);
});

test('clearAvatar: not-found storage object is ignored, real failures abort pre-write', async () => {
  const seen = [];
  const db = { execute: async (sql, params = []) => { seen.push({ sql, params }); return [[]]; } };
  const ok = await profileAvatar.clearAvatar({
    userId: USER_ID,
    db,
    storage: mockStorage({ removeError: { message: 'NotFound: Object not found' } })
  });
  assert.deepEqual(ok, { avatarUrl: null });
  assert.equal(seen.length, 1, 'column is still cleared when the object was already gone');
  const seen2 = [];
  await assert.rejects(
    profileAvatar.clearAvatar({
      userId: USER_ID,
      db: { execute: async (sql, params = []) => { seen2.push({ sql, params }); return [[]]; } },
      storage: mockStorage({ removeError: { message: 'connection reset' } })
    }),
    /Avatar storage removal failed/
  );
  assert.equal(seen2.length, 0, 'column untouched when the removal genuinely failed');
});

test('throttle: 20 uploads/hour per user, then 429-class block with Retry-After', () => {
  profileAvatar.resetAvatarLimitsForTests();
  try {
    for (let i = 0; i < profileAvatar.AVATAR_UPLOAD_LIMIT_MAX; i += 1) {
      assert.deepEqual(
        profileAvatar.tryConsumeAvatarUpload({ userId: USER_ID, now: 1000 + i }),
        { allowed: true, retryAfterSec: 0 }
      );
    }
    const blocked = profileAvatar.tryConsumeAvatarUpload({ userId: USER_ID, now: 2000 });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1);
    assert.equal(profileAvatar.tryConsumeAvatarUpload({ userId: OTHER_ID, now: 2000 }).allowed, true);
  } finally {
    profileAvatar.resetAvatarLimitsForTests();
  }
});

test('POST controller: stores via the service and responds { avatarUrl }', async () => {
  profileAvatar.resetAvatarLimitsForTests();
  const boundary = '----CtrlBoundary1';
  const body = multipartBody(boundary, [
    { name: 'avatar', filename: 'canvas.jpg', contentType: 'image/jpeg', data: JPEG_MIN }
  ]);
  const original = profileAvatar.storeAvatar;
  let captured;
  profileAvatar.storeAvatar = async (args) => {
    captured = args;
    return { avatarUrl: `${PUBLIC_BASE}/storage/v1/object/public/avatars/${USER_ID}/avatar.jpg?v=9` };
  };
  try {
    const { res, status, body: payload } = mockRes();
    await controller.postOwnAvatar(mockMultipartReq(body, boundary), res);
    assert.equal(status(), 200);
    assert.match(payload().avatarUrl, new RegExp(`^${PUBLIC_BASE.replace(/\./g, '\\.')}/storage/v1/object/public/avatars/`));
    assert.equal(captured.userId, USER_ID);
    assert.deepEqual(captured.buffer, JPEG_MIN);
  } finally {
    profileAvatar.storeAvatar = original;
    profileAvatar.resetAvatarLimitsForTests();
  }
});

test('POST controller: non-JPEG content is a 400 and never reaches storage', async () => {
  profileAvatar.resetAvatarLimitsForTests();
  const boundary = '----CtrlBoundary2';
  const body = multipartBody(boundary, [
    { name: 'avatar', filename: 'evil.svg', contentType: 'image/svg+xml', data: Buffer.from('<svg></svg>', 'ascii') }
  ]);
  const original = profileAvatar.storeAvatar;
  let called = false;
  profileAvatar.storeAvatar = async () => { called = true; throw new Error('must not be called'); };
  try {
    const { res, status, body: payload } = mockRes();
    await controller.postOwnAvatar(mockMultipartReq(body, boundary), res);
    assert.equal(status(), 400);
    assert.equal(called, false);
    assert.ok(payload().error);
  } finally {
    profileAvatar.storeAvatar = original;
    profileAvatar.resetAvatarLimitsForTests();
  }
});

test('POST controller: exhausted budget is a 429 with Retry-After, storage untouched', async () => {
  profileAvatar.resetAvatarLimitsForTests();
  const user = '00000000-0000-4000-8000-000000000099';
  for (let i = 0; i < profileAvatar.AVATAR_UPLOAD_LIMIT_MAX; i += 1) {
    profileAvatar.tryConsumeAvatarUpload({ userId: user });
  }
  const boundary = '----CtrlBoundary3';
  const body = multipartBody(boundary, [
    { name: 'avatar', filename: 'a.jpg', contentType: 'image/jpeg', data: JPEG_MIN }
  ]);
  const original = profileAvatar.storeAvatar;
  let called = false;
  profileAvatar.storeAvatar = async () => { called = true; throw new Error('must not be called'); };
  try {
    const { res, status, headers } = mockRes();
    await controller.postOwnAvatar(mockMultipartReq(body, boundary, user), res);
    assert.equal(status(), 429);
    assert.ok(Number(headers['retry-after']) >= 1);
    assert.equal(called, false);
  } finally {
    profileAvatar.storeAvatar = original;
    profileAvatar.resetAvatarLimitsForTests();
  }
});

test('DELETE controller: responds { avatarUrl: null } and scopes to req.user.id', async () => {
  const original = profileAvatar.clearAvatar;
  let captured;
  profileAvatar.clearAvatar = async (args) => {
    captured = args;
    return { avatarUrl: null };
  };
  try {
    const { res, status, body: payload } = mockRes();
    await controller.deleteOwnAvatar({ user: { id: OTHER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(payload(), { avatarUrl: null });
    assert.equal(captured.userId, OTHER_ID);
  } finally {
    profileAvatar.clearAvatar = original;
  }
});

test('DELETE controller: storage failure is a 503 with a neutral message', async () => {
  const original = profileAvatar.clearAvatar;
  profileAvatar.clearAvatar = async () => { throw new Error('Avatar storage removal failed.'); };
  try {
    const { res, status, body: payload } = mockRes();
    await controller.deleteOwnAvatar({ user: { id: USER_ID } }, res);
    assert.equal(status(), 503);
    assert.equal(payload().error, 'Unable to remove the avatar.');
  } finally {
    profileAvatar.clearAvatar = original;
  }
});

test('PUT /api/users/me avatar_url allowlist: own storage URL passes, anything else is 400 pre-write', async () => {
  const poolModule = require('../src/config/db');
  // Pin check reads the configured storage base: stub it to the fixture host.
  const originalConfig = profileAvatar.avatarServiceConfig;
  profileAvatar.avatarServiceConfig = () => ({ url: PUBLIC_BASE });
  const goodUrl = `${PUBLIC_BASE}/storage/v1/object/public/avatars/${USER_ID}/avatar.jpg?v=1234567890123`;
  const runPut = async (avatarUrl, stub) => {
    const original = poolModule.execute;
    poolModule.execute = stub;
    try {
      const { res, status, body: payload } = mockRes();
      await controller.putOwnProfile({ body: { avatar_url: avatarUrl }, user: { id: USER_ID } }, res);
      return { status: status(), body: payload() };
    } finally {
      poolModule.execute = original;
    }
  };
  // Accept: own avatars-bucket object URL (+?v= cache-buster), echoed back.
  {
    let written = null;
    const row = { username: null, display_name: null, bio: null, avatar_url: goodUrl, is_public: false, jlpt_level: null, target_jlpt: null, interests: null };
    const out = await runPut(goodUrl, async (sql, params = []) => {
      if (/INSERT INTO user_profile/i.test(sql)) { written = params[params.length - 1]; return [{ affectedRows: 1 }]; }
      if (/FROM user_profile WHERE user_id/i.test(sql)) return [[row]];
      throw new Error(`Unexpected SQL: ${String(sql).slice(0, 60)}`);
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.avatarUrl, goodUrl);
    assert.equal(written, goodUrl);
  }
  try {
    // Reject: foreign host, data: URL, over-long value, and — the P1 case —
    // ANOTHER user's valid storage URL (cross-user reference). All 400
    // with zero DB writes.
    const evil = [
      'https://evil.test/tracker.png',
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      `${PUBLIC_BASE}/storage/v1/object/public/avatars/${USER_ID}/avatar.jpg?v=${'9'.repeat(600)}`,
      `${PUBLIC_BASE}/storage/v1/object/public/avatars/${OTHER_ID}/avatar.jpg?v=7`
    ];
    for (const value of evil) {
      const out = await runPut(value, async () => { throw new Error('must not query on invalid avatar_url'); });
      assert.equal(out.status, 400, `rejected: ${String(value).slice(0, 60)}`);
    }
    // Clear: null/empty clears the column.
    for (const value of [null, '']) {
      const row = { username: null, display_name: null, bio: null, avatar_url: null, is_public: false, jlpt_level: null, target_jlpt: null, interests: null };
      const out = await runPut(value, async (sql) => {
        if (/INSERT INTO user_profile/i.test(sql)) return [{ affectedRows: 1 }];
        if (/FROM user_profile WHERE user_id/i.test(sql)) return [[row]];
        throw new Error(`Unexpected SQL: ${String(sql).slice(0, 60)}`);
      });
      assert.equal(out.status, 200);
      assert.equal(out.body.avatarUrl, null);
    }
  } finally {
    profileAvatar.avatarServiceConfig = originalConfig;
  }
});

test('GET /api/profile serves avatarUrl: nav/settings/community-outside-feed read it from here', async () => {
  const { getProfile } = require('../src/services/profile');
  const url = `${PUBLIC_BASE}/storage/v1/object/public/avatars/${USER_ID}/avatar.jpg?v=7`;
  const db = { execute: async (sql) => {
    assert.match(sql, /avatar_url/, 'profile query selects the avatar column');
    return [[{ display_name: 'Yuki', avatar_url: url, updated_at: '2026-10-01' }]];
  } };
  assert.deepEqual(await getProfile(db, USER_ID, 'yuki@example.com'), {
    displayName: 'Yuki',
    avatarUrl: url,
    updatedAt: '2026-10-01',
    email: 'yuki@example.com'
  });
  const empty = await getProfile({ execute: async () => [[]] }, USER_ID, null);
  assert.equal(empty.avatarUrl, null, 'no photo degrades to null (initials fallback)');
});

test('migration 043: public bucket, SELECT-only policy, writes stay service-mediated', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../db/migrations-postgres/043_avatar_storage.sql'), 'utf8'
  );
  assert.match(sql, /INSERT INTO storage\.buckets/i);
  assert.match(sql, /'avatars'/);
  assert.match(sql, /public/i);
  assert.match(sql, /WHERE NOT EXISTS/i);
  assert.match(sql, /CREATE POLICY avatars_public_read/i);
  assert.match(sql, /FOR SELECT/i);
  assert.match(sql, /bucket_id = 'avatars'/);
  assert.doesNotMatch(sql, /FOR (INSERT|UPDATE|DELETE)/i);
  assert.match(sql, /service key/i);
});
