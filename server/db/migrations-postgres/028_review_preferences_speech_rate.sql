-- Review 3.0 voice speed: per-user TTS rate persisted with the card-type
-- preferences. Additive column only: the table already carries RLS
-- ENABLE+FORCE, jlt_runtime grants and the jlt_runtime_crud policy from 023,
-- and no new table/policy/trigger is created, so verifier counts are
-- untouched. Validation (0.5–1.5) lives in reviewEngine.normalizeSpeechRate.
ALTER TABLE user_review_preferences ADD COLUMN IF NOT EXISTS speech_rate real DEFAULT 0.9;
