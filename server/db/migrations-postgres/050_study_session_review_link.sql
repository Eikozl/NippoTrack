-- 050 links a manually logged study session to the review session it was
-- created from (Log study session flow). Lets dashboards exclude the
-- review's auto-counted minutes when the learner logged them manually, so
-- the same activity is never counted twice. Nullable: pre-existing rows
-- and manual sessions keep NULL and behave exactly as before. Deleting the
-- review session unlinks instead of deleting the learner's manual record.
ALTER TABLE study_sessions
  ADD COLUMN IF NOT EXISTS id_review_session integer NULL REFERENCES review_sessions (id_review_session) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_study_sessions_review_session
  ON study_sessions (id_review_session) WHERE id_review_session IS NOT NULL;
