// Phase 11 — Target JLPT level (user goal / study intention).
//
// SEMANTICS (kept distinct from everything else):
// - Estimated study level (Phase 9) = evidence-derived, never written here.
// - Reference progress (Phase 10) = evidence-derived, never written here.
// - Target JLPT level (this module) = explicitly selected by the user.
//   It is NOT a claim about current ability, exam registration, readiness,
//   certification, or a recommendation. Changing it mutates nothing except
//   which progress context the UI highlights.
//
// PERSISTENCE: one row per user in user_jlpt_target (see migration 008).
// Absent row (or cleared) = valid "no target" state, returned as null.
// Only exact 'N5'..'N1' strings are accepted; null clears. The CHECK
// constraint mirrors this whitelist at the database boundary. Goals'
// target_jlpt_level is a separate per-goal filter and is intentionally NOT
// reused here (its semantics genuinely differ; see Phase 11 report).

const { JLPT_LEVELS } = require('../constants');
const { ValidationError } = require('../errors/http');

function normalizeTargetLevel(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !JLPT_LEVELS.includes(value)) {
    throw new ValidationError(`target_level must be one of: ${JLPT_LEVELS.join(', ')}, or null to clear.`);
  }
  return value;
}

async function getJlptTarget(database, userId) {
  const [rows] = await database.execute(
    'SELECT target_level FROM user_jlpt_target WHERE user_id = ?',
    [userId]
  );
  if (!rows || rows.length === 0) return null;
  return JLPT_LEVELS.includes(rows[0].target_level) ? rows[0].target_level : null;
}

// Persists the target (level string) or clears it (null). Touches only
// user_jlpt_target — never review state, kanji, goals, sessions, or
// encounters. Returns the stored value (level or null).
async function setJlptTarget(database, userId, value) {
  const level = normalizeTargetLevel(value);
  if (level === null) {
    await database.execute('DELETE FROM user_jlpt_target WHERE user_id = ?', [userId]);
    return null;
  }
  await database.execute(
    'INSERT INTO user_jlpt_target (user_id, target_level, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
    'ON CONFLICT (user_id) DO UPDATE SET target_level = EXCLUDED.target_level, updated_at = CURRENT_TIMESTAMP',
    [userId, level]
  );
  return level;
}

module.exports = { getJlptTarget, normalizeTargetLevel, setJlptTarget };
