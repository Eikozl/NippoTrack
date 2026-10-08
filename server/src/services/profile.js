const { ValidationError } = require('../errors/http');

const MAX_DISPLAY_NAME_LENGTH = 50;

function normalizeDisplayName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ValidationError('display_name must be text or null.');
  const trimmed = value.trim();
  if (Array.from(trimmed).length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ValidationError(`display_name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
  }
  return trimmed || null;
}

function profileShape(row, email) {
  return {
    displayName: row?.display_name ?? null,
    avatarUrl: row?.avatar_url || null,
    updatedAt: row?.updated_at ?? null,
    email: email || null
  };
}

async function getProfile(database, userId, email) {
  const [rows] = await database.execute(
    'SELECT display_name, avatar_url, updated_at FROM user_profile WHERE user_id = ?',
    [userId]
  );
  return profileShape(rows?.[0], email);
}

async function setProfile(database, userId, email, value) {
  const displayName = normalizeDisplayName(value);
  await database.execute(
    'INSERT INTO user_profile (user_id, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
    'ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = CURRENT_TIMESTAMP',
    [userId, displayName]
  );
  return getProfile(database, userId, email);
}

module.exports = { MAX_DISPLAY_NAME_LENGTH, getProfile, normalizeDisplayName, profileShape, setProfile };
