-- V6.0 reading study time: daily reading seconds per learner so reading
-- contributes to dashboard minutes and streaks. Accumulated from the
-- deltas of user_reading_progress saves (PUT-replaces totals), never
-- written directly by clients. Same RLS/grant model as all runtimetables.
CREATE TABLE IF NOT EXISTS reading_study_days (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  day date NOT NULL,
  seconds integer NOT NULL DEFAULT 0,
  CONSTRAINT chk_reading_study_days_seconds CHECK (seconds >= 0),
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_reading_study_days_user_day
  ON reading_study_days (user_id, day DESC);

ALTER TABLE reading_study_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_study_days FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE reading_study_days FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE reading_study_days FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reading_study_days TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON reading_study_days;
CREATE POLICY jlt_runtime_crud ON reading_study_days FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
