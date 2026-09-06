-- Review session grouping for SRS review evidence.
-- Express with jlt_runtime is the only normal runtime database boundary.
CREATE TABLE IF NOT EXISTS review_sessions (
  id_review_session bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  source_from date NOT NULL,
  source_to date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_review_sessions_source_range CHECK (source_to >= source_from)
);

CREATE INDEX IF NOT EXISTS idx_review_sessions_user_started
  ON review_sessions (user_id, started_at DESC);

ALTER TABLE review_events ADD COLUMN IF NOT EXISTS id_review_session bigint NULL REFERENCES review_sessions (id_review_session) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_review_events_session
  ON review_events (id_review_session, reviewed_at);

ALTER TABLE review_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_sessions FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE review_sessions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE review_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_sessions TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE review_sessions_id_review_session_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON review_sessions;
CREATE POLICY jlt_runtime_crud
  ON review_sessions
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_review_sessions_updated_at ON review_sessions;
CREATE TRIGGER trg_review_sessions_updated_at BEFORE UPDATE ON review_sessions FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
