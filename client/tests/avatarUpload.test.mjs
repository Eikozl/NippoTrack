// Profile-avatar upload — source assertions for the frozen avatar contract.
// Uses source code assertions (reading files as text) to avoid DOM
// dependencies, per the client test convention (see kanjiWritingUX.test.mjs).
// Contract pins (both sides implement to these protocol strings):
// - module client/src/avatarImage.js exporting compressAvatarImage +
//   AVATAR_LIMITS { MAX_RAW_BYTES: 10*1024*1024, MAX_DIMENSION: 512,
//   TARGET_BYTES: 512*1024, QUALITY: 0.82, FALLBACK_QUALITY: 0.6 }
// - POST /api/users/me/avatar (multipart field `avatar`), persist via
//   PUT /api/users/me { avatar_url }, DELETE /api/users/me/avatar
// - file input accept="image/jpeg,image/png,image/webp"
// - fallback class account-initials retained; community renders via the
//   existing avatarFace() (untouched, no upload wiring there)
// - object URLs revoked; no raw-string children in touched UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const AVATAR_MODULE_PATH = join('client', 'src', 'avatarImage.js');
const SETTINGS_PATH = join('client', 'src', 'pages', 'settings.js');
const ACCOUNT_PROFILE_PATH = join('client', 'src', 'accountProfile.js');
const COMMUNITY_FEED_PATH = join('client', 'src', 'pages', 'communityFeed.js');

async function readRequired(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    assert.fail(`Missing avatar-contract file ${path} (feature not yet implemented): ${error.message}`);
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

// Protocol strings may live in the compression module or the settings UI
// (implementer places wiring, never the strings); assert on the union so
// only the frozen contract is pinned, never file-internal naming.
async function avatarUiSources() {
  const module = await readRequired(AVATAR_MODULE_PATH);
  const settings = await readRequired(SETTINGS_PATH);
  const account = await readOptional(ACCOUNT_PROFILE_PATH);
  return { module, settings, account, union: `${module}\n${settings}\n${account}` };
}

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `avatar section start marker present: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end !== -1, `avatar section end marker present: ${endMarker}`);
  return source.substring(start, end);
}

test('avatar module exports compressAvatarImage and AVATAR_LIMITS with the exact frozen budgets', async () => {
  const { module } = await avatarUiSources();
  assert.ok(module.includes('compressAvatarImage'), 'compressAvatarImage is defined');
  assert.ok(
    module.includes('export async function compressAvatarImage')
      || module.includes('export function compressAvatarImage')
      || (module.includes('export') && module.includes('compressAvatarImage')),
    'compressAvatarImage is exported'
  );
  assert.ok(module.includes('AVATAR_LIMITS'), 'AVATAR_LIMITS is defined');
  assert.ok(
    /export\s+(const|let|var)\s+AVATAR_LIMITS/.test(module) || /AVATAR_LIMITS\s*=\s*\{/.test(module),
    'AVATAR_LIMITS is exported as an object'
  );
  // Exact frozen values (whitespace-tolerant; any formatting holds).
  for (const key of ['MAX_RAW_BYTES', 'MAX_DIMENSION', 'TARGET_BYTES', 'QUALITY', 'FALLBACK_QUALITY']) {
    assert.ok(module.includes(key), `budget key present: ${key}`);
  }
  assert.ok(/10\s*\*\s*1024\s*\*\s*1024/.test(module), 'MAX_RAW_BYTES is exactly 10*1024*1024');
  assert.ok(/MAX_DIMENSION\s*:\s*512\b/.test(module), 'MAX_DIMENSION is exactly 512');
  assert.ok(/512\s*\*\s*1024/.test(module), 'TARGET_BYTES is exactly 512*1024');
  assert.ok(/QUALITY\s*:\s*0\.82\b/.test(module), 'QUALITY is exactly 0.82');
  assert.ok(/FALLBACK_QUALITY\s*:\s*0\.6\b/.test(module), 'FALLBACK_QUALITY is exactly 0.6');
});

test('AVATAR_LIMITS numeric values match the frozen budgets exactly', async () => {
  const { AVATAR_LIMITS } = await import('../src/avatarImage.js');
  assert.equal(AVATAR_LIMITS.MAX_RAW_BYTES, 10 * 1024 * 1024);
  assert.equal(AVATAR_LIMITS.MAX_DIMENSION, 512);
  assert.equal(AVATAR_LIMITS.TARGET_BYTES, 512 * 1024);
  assert.equal(AVATAR_LIMITS.QUALITY, 0.82);
  assert.equal(AVATAR_LIMITS.FALLBACK_QUALITY, 0.6);
});

test('upload posts multipart field `avatar` to POST /api/users/me/avatar and persists via PUT avatar_url', async () => {
  const { union } = await avatarUiSources();
  assert.ok(union.includes('/api/users/me/avatar'), 'avatar endpoint path present');
  assert.ok(/method:\s*['"]POST['"]/.test(union), 'upload uses explicit POST');
  assert.ok(union.includes('FormData'), 'upload builds a multipart FormData body');
  assert.ok(
    /append\(\s*['"]avatar['"]/.test(union) || /name="avatar"/.test(union),
    'multipart field name is exactly `avatar`'
  );
  assert.ok(union.includes('/api/users/me'), 'persist reuses the existing profile endpoint');
  assert.ok(/method:\s*['"]PUT['"]/.test(union), 'persist uses explicit PUT');
  assert.ok(union.includes('avatar_url'), 'persist payload key is exactly avatar_url');
  assert.ok(
    union.includes('/api/users/me/avatar') && /method:\s*['"]DELETE['"]/.test(union),
    'remove uses DELETE /api/users/me/avatar'
  );
});

test('file picker allowlists jpeg/png/webp only (no svg/gif)', async () => {
  const { union } = await avatarUiSources();
  assert.ok(/type:\s*['"]file['"]/.test(union), 'a file input exists');
  assert.ok(union.includes('accept'), 'picker carries an accept allowlist');
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    assert.ok(union.includes(mime), `picker allowlists ${mime}`);
  }
  const acceptValues = [...union.matchAll(/accept['"]?\s*[:=]\s*['"]([^'"]+)['"]/gi)].map((m) => m[1]);
  assert.ok(acceptValues.length > 0, 'at least one accept attribute value found');
  for (const value of acceptValues) {
    assert.ok(!/svg/i.test(value), `accept value excludes svg: ${value}`);
    assert.ok(!/gif/i.test(value), `accept value excludes gif: ${value}`);
  }
});

test('compressor rejects animated GIF (and non still-image types) before decode', async () => {
  const { module } = await avatarUiSources();
  assert.ok(module.includes('ALLOWED_AVATAR_INPUT_TYPES'), 'compressor has an explicit input allowlist');
  for (const mime of ["'image/jpeg'", "'image/png'", "'image/webp'"]) {
    assert.ok(module.includes(mime), `compressor allows ${mime}`);
  }
  assert.ok(module.includes('image/gif'), 'compressor names gif to reject it explicitly');
  assert.ok(/Animated[^.]*not supported/i.test(module), 'gif rejection carries a still-image message');
});

test('nav trigger photo is clipped to the icon box (never exceeds it)', async () => {
  const main = await readFile(join('client', 'src', 'main.js'), 'utf-8');
  const css = await readFile(join('client', 'src', 'styles.css'), 'utf-8');
  assert.ok(main.includes('account-trigger--photo'), 'trigger toggles the photo clipping class');
  assert.ok(main.includes('absolute inset-0 h-full w-full'), 'trigger photo fills (never exceeds) the icon box');
  assert.ok(css.includes('.icon-button.account-trigger--photo'), 'clipping rule exists for the trigger');
  assert.ok(/\.icon-button\.account-trigger--photo\s*\{[^}]*overflow:\s*hidden/.test(css), 'clipping rule hides overflow');
  assert.ok(/\.icon-button\.account-trigger--photo\s*\{[^}]*position:\s*relative/.test(css), 'clipping rule positions the box');
});

test('account-initials fallback retained; community still renders via the untouched avatarFace()', async () => {
  const { union, settings } = await avatarUiSources();
  const feed = await readRequired(COMMUNITY_FEED_PATH);
  assert.ok(union.includes('account-initials'), 'initials fallback class retained on the account surface');
  assert.ok(settings.includes('account-initials'), 'settings identity mark keeps the fallback class');
  assert.ok(feed.includes('avatarFace('), 'community renders identity via the existing avatarFace()');
  assert.ok(feed.includes('avatarUrlFor'), 'community keeps the single safe avatar-URL resolver');
  assert.ok(
    !feed.includes('/api/users/me/avatar'),
    'community carries no upload wiring (renderer untouched)'
  );
});

test('object URLs are revoked wherever avatar previews are created', async () => {
  const { union, module } = await avatarUiSources();
  assert.ok(union.includes('revokeObjectURL'), 'avatar flow revokes object URLs (no blob leak)');
  assert.ok(module.includes('revokeObjectURL'), 'compression fallback path revokes its decode URL');
  assert.ok(union.includes('createObjectURL'), 'previews are object URLs (hence revoked)');
});

test('avatar failures toast (never silent) with error kind', async () => {
  const { settings } = await avatarUiSources();
  const avatarSection = sectionBetween(settings, 'Avatar upload controls', "const input = element('input'");
  assert.ok(avatarSection.includes('showToast('), 'avatar flow surfaces toasts');
  assert.ok(avatarSection.includes("'error'"), 'avatar failures toast with the error kind');
});

test('touched avatar UI passes no raw-string children to element() and uses no innerHTML', async () => {
  const { module, settings } = await avatarUiSources();
  assert.ok(!module.includes('innerHTML'), 'no innerHTML in the compression module');
  const avatarSection = sectionBetween(settings, 'Avatar upload controls', "const input = element('input'");
  assert.ok(!avatarSection.includes('innerHTML'), 'no innerHTML in the avatar upload section');
  // Regression guards in the communityFeed.test.mjs style: element()
  // appends children verbatim via appendChild, so labels must travel via
  // the `text` option, never as bare string children.
  for (const label of ['Choose photo', 'Upload photo', 'Remove photo']) {
    assert.ok(!avatarSection.includes(`}, '${label}')`), `${label} must use text: option, never a string child`);
    assert.ok(avatarSection.includes(`text: '${label}'`), `${label} present via text option`);
  }
  assert.ok(!avatarSection.includes("}, ['"), 'no string-array children in the avatar section');
});
