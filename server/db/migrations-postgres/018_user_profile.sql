-- NippoTrack v5.1-C — application presentation profile.
-- Display name is optional, non-unique, and never an authentication identity.
-- Runtime routes always bind user_id from the verified request user; no body
-- field can select another account. Empty names are stored as NULL by the API.
CREATE TABLE IF NOT EXISTS user_profile (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name varchar(50) NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profile FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE user_profile FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_profile FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_profile TO jlt_runtime;

DROP POLICY IF EXISTS user_profile_runtime_select ON user_profile;
CREATE POLICY user_profile_runtime_select
  ON user_profile
  FOR SELECT
  TO jlt_runtime
  USING (true);

DROP POLICY IF EXISTS user_profile_runtime_write ON user_profile;
CREATE POLICY user_profile_runtime_write
  ON user_profile
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
