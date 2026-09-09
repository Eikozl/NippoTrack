-- NippoTrack placement source — distinguishes quiz-derived vs self-reported starting level.
-- NULL means "not completed OR completed-before-source-tracking" (pre-change rows
-- cannot have their source inferred, so no backfill; leave NULL). Quiz breakdown
-- columns (015) stay NULL for self_reported rows — no invented counts.
-- No RLS/policy changes: migration 014 already grants jlt_runtime
-- SELECT/INSERT/UPDATE/DELETE on user_first_experience via table-level
-- policies, which cover new columns automatically. No other tables.
ALTER TABLE user_first_experience ADD COLUMN IF NOT EXISTS placement_source varchar(16) NULL CHECK (placement_source IN ('quiz', 'self_reported'));
