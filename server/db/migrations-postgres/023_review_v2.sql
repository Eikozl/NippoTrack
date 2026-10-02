-- V5.3a — Review 2.0: per-user card-type preferences, detected error
-- patterns, and forward-compatible review_sessions columns.
-- Express with jlt_runtime is the only normal runtime database boundary.
-- Modelled exactly on 021/022 (RLS ENABLE+FORCE, REVOKE PUBLIC/anon/
-- authenticated, GRANT to jlt_runtime incl. identity sequences, a single
-- jlt_runtime_crud policy USING(true) WITH CHECK(true), jlt_set_updated_at
-- triggers, idempotent guards).
--
-- user_review_preferences: one row per user (PK user_id, CASCADE like the
-- other per-user preference tables 008/018). card_types/weights are JSONB so
-- the Review 2.0 contract can evolve without migrations.
--
-- review_patterns: rows are REPLACE-per-detection (the engine deletes a
-- user's previous rows before inserting a fresh run), kept for audit and for
-- the UI panel; detected_at preserves when the current set was computed.
--
-- review_sessions gains nullable card_type + difficulty_score columns
-- (ADD COLUMN IF NOT EXISTS) so existing rows and the frozen V5.2 API
-- contract stay untouched; new Review 2.0 flows may populate them later.

CREATE TABLE IF NOT EXISTS user_review_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  card_types jsonb NOT NULL DEFAULT '["recognition"]'::jsonb,
  weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  engine_mode varchar NOT NULL DEFAULT 'fixed',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_user_review_preferences_engine_mode
    CHECK (engine_mode IN ('fixed', 'dynamic'))
);

CREATE TABLE IF NOT EXISTS review_patterns (
  id_review_pattern bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  pattern_type varchar NOT NULL,
  affected_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_action text NOT NULL,
  priority smallint NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_review_patterns_priority CHECK (priority >= 1 AND priority <= 3)
);

CREATE INDEX IF NOT EXISTS idx_review_patterns_user_detected
  ON review_patterns (user_id, detected_at DESC);

ALTER TABLE review_sessions ADD COLUMN IF NOT EXISTS card_type varchar;
ALTER TABLE review_sessions ADD COLUMN IF NOT EXISTS difficulty_score real;

ALTER TABLE user_review_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_review_preferences FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE user_review_preferences FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_review_preferences FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_review_preferences TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON user_review_preferences;
CREATE POLICY jlt_runtime_crud
  ON user_review_preferences
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_user_review_preferences_updated_at ON user_review_preferences;
CREATE TRIGGER trg_user_review_preferences_updated_at BEFORE UPDATE ON user_review_preferences FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();

ALTER TABLE review_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_patterns FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE review_patterns FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE review_patterns FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_patterns TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE review_patterns_id_review_pattern_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON review_patterns;
CREATE POLICY jlt_runtime_crud
  ON review_patterns
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_review_patterns_updated_at ON review_patterns;
CREATE TRIGGER trg_review_patterns_updated_at BEFORE UPDATE ON review_patterns FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
