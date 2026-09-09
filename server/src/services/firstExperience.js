// NippoTrack v5.1-A.2 — first-experience state (onboarding + placement + target).
//
// SEMANTICS:
// - user_first_experience (migration 014) holds the first-run state: whether
//   onboarding completed, which study sources the user picked, and the
//   placement flow status. Absent row = "never onboarded" (valid state).
// - The persistent study target lives in user_jlpt_target (migration 008) and
//   is REUSED here via services/jlptTarget — target logic is never duplicated.
// - placement_estimate is a transient self-placement hint only (scoring lands
//   in A.3) — never an official level, confidence, or mastery claim.
// - Ownership always derives from the caller-supplied userId (req.user.id at
//   the controller boundary). Body-supplied user ids are never read.
//
// CONCURRENCY: completeOnboarding performs setJlptTarget + the 014 upsert in
// ONE transaction (pool.getConnection + BEGIN/COMMIT/ROLLBACK, following the
// sessions/vocabulary controller convention). All validation runs BEFORE the
// transaction opens, so invalid input never touches the database.

const { ValidationError } = require('../errors/http');
const { getJlptTarget, normalizeTargetLevel, setJlptTarget } = require('./jlptTarget');

// Fixed contract (migration 014 CHECK constraint mirrors this allowlist).
const STUDY_SOURCES = [
  'textbooks',
  'anime-drama',
  'manga',
  'youtube',
  'classes',
  'flashcards',
  'conversations',
  'apps',
  'notes',
  'other'
];

const PLACEMENT_STATUSES = ['not_started', 'skipped', 'completed'];
const PLACEMENT_ESTIMATES = ['N5', 'N4', 'N3', 'N2', 'N1'];

// Only 'skipped' may be written through the A.2 onboarding PUT (screen-4
// "Skip for now" marks placement skipped at onboarding-completion time).
// Placement scoring/completion is an A.3 concern with its own endpoint.
const ONBOARDING_PLACEMENT_STATUS = 'skipped';

function normalizeStudySources(value) {
  if (!Array.isArray(value)) {
    throw new ValidationError(`studySources must be an array of: ${STUDY_SOURCES.join(', ')} (empty array allowed).`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !STUDY_SOURCES.includes(entry)) {
      throw new ValidationError(`studySources must be an array of: ${STUDY_SOURCES.join(', ')} (empty array allowed).`);
    }
  }
  if (new Set(value).size !== value.length) {
    throw new ValidationError('studySources must not contain duplicates.');
  }
  return [...value];
}

function normalizeOnboardingPlacementStatus(value) {
  if (value === undefined) return undefined;
  if (value !== ONBOARDING_PLACEMENT_STATUS) {
    throw new ValidationError("placementStatus, when provided, must be 'skipped'.");
  }
  return value;
}

function toFirstExperienceShape(row, targetLevel) {
  if (!row) {
    return {
      onboarding: { completed: false, studySources: [] },
      placement: { status: 'not_started', estimate: null },
      targetLevel
    };
  }
  return {
    onboarding: {
      completed: row.onboarding_completed_at !== null && row.onboarding_completed_at !== undefined,
      studySources: Array.isArray(row.study_sources) ? [...row.study_sources] : []
    },
    placement: {
      status: PLACEMENT_STATUSES.includes(row.placement_status) ? row.placement_status : 'not_started',
      estimate: PLACEMENT_ESTIMATES.includes(row.placement_estimate) ? row.placement_estimate : null
    },
    targetLevel
  };
}

// Read-only: one bounded SELECT on user_first_experience + the target lookup.
// Never invents sources/estimates — absent row yields the never-onboarded shape.
async function getFirstExperience(database, userId) {
  const [rows] = await database.execute(
    'SELECT onboarding_completed_at, study_sources, placement_status, placement_estimate FROM user_first_experience WHERE user_id = ?',
    [userId]
  );
  const targetLevel = await getJlptTarget(database, userId);
  return toFirstExperienceShape(rows && rows[0], targetLevel);
}

// Marks onboarding complete: validates everything first (target via the
// shared normalizeTargetLevel — null clears; sources strictly against the
// allowlist; placementStatus only 'skipped'), then atomically persists the
// target plus the 014 upsert. Returns the GET shape.
async function completeOnboarding(pool, userId, body) {
  const source = body && typeof body === 'object' ? body : {};
  if (!Object.prototype.hasOwnProperty.call(source, 'targetLevel')) {
    throw new ValidationError('targetLevel is required (N5..N1, or null to clear).');
  }
  if (!Object.prototype.hasOwnProperty.call(source, 'studySources')) {
    throw new ValidationError('studySources is required (array of study source keys; empty array allowed).');
  }
  // Validation precedes any write so partial input can never partially persist.
  const targetLevel = normalizeTargetLevel(source.targetLevel);
  const studySources = normalizeStudySources(source.studySources);
  const placementStatus = normalizeOnboardingPlacementStatus(source.placementStatus);

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await setJlptTarget(connection, userId, targetLevel);
    if (placementStatus === ONBOARDING_PLACEMENT_STATUS) {
      await connection.execute(
        'INSERT INTO user_first_experience (user_id, study_sources, onboarding_completed_at, placement_status, updated_at) ' +
        "VALUES (?, ?, CURRENT_TIMESTAMP, 'skipped', CURRENT_TIMESTAMP) " +
        'ON CONFLICT (user_id) DO UPDATE SET study_sources = EXCLUDED.study_sources, ' +
        "onboarding_completed_at = CURRENT_TIMESTAMP, placement_status = 'skipped', updated_at = CURRENT_TIMESTAMP",
        [userId, studySources]
      );
    } else {
      // No placementStatus supplied: preserve any existing placement_status
      // (skip/completion is owned by A.3); new rows take the DB default.
      await connection.execute(
        'INSERT INTO user_first_experience (user_id, study_sources, onboarding_completed_at, updated_at) ' +
        'VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT (user_id) DO UPDATE SET study_sources = EXCLUDED.study_sources, ' +
        'onboarding_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP',
        [userId, studySources]
      );
    }
    await connection.commit();
    connection.release();
    connection = null;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Transaction rollback failed:', rollbackError);
      } finally {
        connection.release();
      }
    }
    throw error;
  }
  return getFirstExperience(pool, userId);
}

module.exports = {
  STUDY_SOURCES,
  PLACEMENT_STATUSES,
  completeOnboarding,
  getFirstExperience,
  normalizeOnboardingPlacementStatus,
  normalizeStudySources
};
