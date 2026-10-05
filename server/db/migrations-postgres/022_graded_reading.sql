-- V5.3a — Graded reading: shared/user reading texts, external source records
-- and per-user reading progress. Express with jlt_runtime is the only normal
-- runtime database boundary. Modelled exactly on 021_immersion_pipeline.sql
-- (RLS ENABLE+FORCE, REVOKE PUBLIC/anon/authenticated, GRANT to jlt_runtime
-- incl. identity sequences, a single jlt_runtime_crud policy USING(true)
-- WITH CHECK(true), jlt_set_updated_at triggers, idempotent guards).
--
-- Shared-library note: reading_texts rows with user_id NULL are SYSTEM
-- (library) texts shared by all users. The jlt_runtime_crud policy stays
-- intentionally broad (USING(true) WITH CHECK(true)), exactly as in
-- 019/020/021: RLS here isolates the Supabase API roles (anon/authenticated
-- hold zero grants), while per-user scoping is the Express layer's
-- responsibility — every read/write carries an
--   (user_id = req.user.id OR user_id IS NULL)
-- predicate and foreign rows are reported as 404, never leaked.
--
-- reading_texts.text size is enforced APP-SIDE (<= 100,000 characters) by
-- server/src/services/gradedReader.js, per contract.

CREATE TABLE IF NOT EXISTS reading_sources (
  id_reading_source bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type varchar NOT NULL,
  url text,
  title text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_reading_sources_type
    CHECK (type IN ('aozora', 'nhk', 'user'))
);

CREATE TABLE IF NOT EXISTS reading_texts (
  id_reading_text bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint REFERENCES reading_sources (id_reading_source) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  text text NOT NULL,
  title text NOT NULL,
  level varchar,
  annotations_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_reading_texts_level
    CHECK (level IN ('N5', 'N4', 'N3', 'N2', 'N1') OR level IS NULL)
);

CREATE TABLE IF NOT EXISTS user_reading_progress (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  text_id bigint NOT NULL REFERENCES reading_texts (id_reading_text) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  time_spent_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_reading_progress_user_text_unique UNIQUE (user_id, text_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_texts_user
  ON reading_texts (user_id);

CREATE INDEX IF NOT EXISTS idx_reading_texts_level
  ON reading_texts (level);

CREATE INDEX IF NOT EXISTS idx_user_reading_progress_user_text
  ON user_reading_progress (user_id, text_id);

ALTER TABLE reading_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_sources FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE reading_sources FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE reading_sources FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reading_sources TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE reading_sources_id_reading_source_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON reading_sources;
CREATE POLICY jlt_runtime_crud
  ON reading_sources
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_reading_sources_updated_at ON reading_sources;
CREATE TRIGGER trg_reading_sources_updated_at BEFORE UPDATE ON reading_sources FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();

ALTER TABLE reading_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_texts FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE reading_texts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE reading_texts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reading_texts TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE reading_texts_id_reading_text_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON reading_texts;
CREATE POLICY jlt_runtime_crud
  ON reading_texts
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_reading_texts_updated_at ON reading_texts;
CREATE TRIGGER trg_reading_texts_updated_at BEFORE UPDATE ON reading_texts FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();

ALTER TABLE user_reading_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_reading_progress FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE user_reading_progress FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_reading_progress FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_reading_progress TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE user_reading_progress_id_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON user_reading_progress;
CREATE POLICY jlt_runtime_crud
  ON user_reading_progress
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_user_reading_progress_updated_at ON user_reading_progress;
CREATE TRIGGER trg_user_reading_progress_updated_at BEFORE UPDATE ON user_reading_progress FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
