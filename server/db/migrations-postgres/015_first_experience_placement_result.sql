-- NippoTrack Quick Placement — per-band result persistence (follows v5.1-A.3 scoring).
-- Stores the server-graded breakdown alongside the estimate so GET
-- /api/first-experience can return result:{totalCorrect,byBand} without any
-- client-side calculation. Raw answers are still never stored.
-- PRE-BREAKDOWN NULL DECISION: A.3-era completed rows keep NULL in all six
-- columns (raw answers were never stored, so backfill is IMPOSSIBLE). The API
-- treats completed-with-NULL-counts as "completed before breakdowns" and
-- returns result:null while still surfacing status/estimate/completedAt.
-- No RLS/policy changes: migration 014 already grants jlt_runtime
-- SELECT/INSERT/UPDATE/DELETE on user_first_experience via table-level
-- policies, which cover new columns automatically.
ALTER TABLE user_first_experience ADD COLUMN IF NOT EXISTS placement_total_correct SMALLINT CHECK (placement_total_correct BETWEEN 0 AND 10);
ALTER TABLE user_first_experience ADD COLUMN IF NOT EXISTS placement_correct_n5 SMALLINT CHECK (placement_correct_n5 BETWEEN 0 AND 2);
ALTER TABLE user_first_experience ADD COLUMN IF NOT EXISTS placement_correct_n4 SMALLINT CHECK (placement_correct_n4 BETWEEN 0 AND 2);
ALTER TABLE user_first_experience ADD COLUMN IF NOT EXISTS placement_correct_n3 SMALLINT CHECK (placement_correct_n3 BETWEEN 0 AND 2);
ALTER TABLE user_first_experience ADD COLUMN IF NOT EXISTS placement_correct_n2 SMALLINT CHECK (placement_correct_n2 BETWEEN 0 AND 2);
ALTER TABLE user_first_experience ADD COLUMN IF NOT EXISTS placement_correct_n1 SMALLINT CHECK (placement_correct_n1 BETWEEN 0 AND 2);
