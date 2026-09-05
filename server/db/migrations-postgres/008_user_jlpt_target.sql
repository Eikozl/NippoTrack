-- Phase 11 — per-user target JLPT study level (study intention only).
-- One nullable target per user; absent row means "no target selected".
-- Never references review evidence, goals, or shared reference tables.
-- Express with jlt_runtime is the only normal runtime database boundary.
CREATE TABLE IF NOT EXISTS user_jlpt_target (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  target_level varchar(2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_user_jlpt_target_level CHECK (target_level IN ('N5', 'N4', 'N3', 'N2', 'N1'))
);

ALTER TABLE user_jlpt_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_jlpt_target FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE user_jlpt_target FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_jlpt_target FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_jlpt_target TO jlt_runtime;

DROP POLICY IF EXISTS user_jlpt_target_runtime_select ON user_jlpt_target;
CREATE POLICY user_jlpt_target_runtime_select
  ON user_jlpt_target
  FOR SELECT
  TO jlt_runtime
  USING (true);

DROP POLICY IF EXISTS user_jlpt_target_runtime_write ON user_jlpt_target;
CREATE POLICY user_jlpt_target_runtime_write
  ON user_jlpt_target
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
