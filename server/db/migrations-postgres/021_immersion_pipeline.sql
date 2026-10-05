-- Immersion reading pipeline: persisted analyze -> select -> learn sessions.
-- Express with jlt_runtime is the only normal runtime database boundary.
-- Modelled exactly on 020_grammar_examples.sql (RLS, grants, policy,
-- updated_at trigger). Additionally widens the shared kanji_encounters
-- source_type CHECK so immersion sessions can be recorded as encounter
-- provenance via the existing recordKanjiEncounters service.
CREATE TABLE IF NOT EXISTS immersion_sessions (
  id_immersion_session bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  source_text text NOT NULL,
  estimated_level varchar,
  confidence real,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_immersion_sessions_estimated_level
    CHECK (estimated_level IN ('N5', 'N4', 'N3', 'N2', 'N1') OR estimated_level IS NULL),
  CONSTRAINT chk_immersion_sessions_confidence
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE IF NOT EXISTS immersion_session_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_immersion_session bigint NOT NULL REFERENCES immersion_sessions (id_immersion_session) ON DELETE CASCADE,
  entity_type varchar NOT NULL,
  entity_id integer NOT NULL,
  review_status varchar NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_immersion_session_items_entity_type
    CHECK (entity_type IN ('vocabulary', 'kanji', 'grammar')),
  CONSTRAINT immersion_session_items_session_entity_unique
    UNIQUE (id_immersion_session, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_immersion_sessions_user_created
  ON immersion_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_immersion_session_items_session
  ON immersion_session_items (id_immersion_session);

-- Immersion sessions record kanji encounters through the existing
-- recordKanjiEncounters service (migration 007 semantics), so the shared
-- provenance CHECK must accept the new source type. DROP + ADD keeps this
-- migration idempotent.
ALTER TABLE kanji_encounters DROP CONSTRAINT IF EXISTS chk_kanji_encounters_source_type;
ALTER TABLE kanji_encounters ADD CONSTRAINT chk_kanji_encounters_source_type
  CHECK (source_type IN ('vocabulary', 'session_writing', 'immersion_session'));

ALTER TABLE immersion_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE immersion_sessions FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE immersion_sessions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE immersion_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE immersion_sessions TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE immersion_sessions_id_immersion_session_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON immersion_sessions;
CREATE POLICY jlt_runtime_crud
  ON immersion_sessions
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_immersion_sessions_updated_at ON immersion_sessions;
CREATE TRIGGER trg_immersion_sessions_updated_at BEFORE UPDATE ON immersion_sessions FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();

ALTER TABLE immersion_session_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE immersion_session_items FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE immersion_session_items FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE immersion_session_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE immersion_session_items TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE immersion_session_items_id_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON immersion_session_items;
CREATE POLICY jlt_runtime_crud
  ON immersion_session_items
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_immersion_session_items_updated_at ON immersion_session_items;
CREATE TRIGGER trg_immersion_session_items_updated_at BEFORE UPDATE ON immersion_session_items FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
