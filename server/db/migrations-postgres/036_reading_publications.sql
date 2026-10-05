-- Reading publications (Reading <-> Community): first-class snapshot rows so
-- a published text — with its editorial translations — survives edits to the
-- author's library. Import copies the snapshot into the importer's own
-- library as a user text. Only owners can publish their own texts.
-- Modelled on 030 deck_publications (026-style RLS posture).
CREATE TABLE IF NOT EXISTS reading_publications (
  id_reading_publication bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL,
  description varchar(500) NOT NULL DEFAULT '',
  level varchar,
  text text NOT NULL,
  translations_json jsonb,
  is_public boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_reading_publications_title
    CHECK (char_length(title) >= 1),
  CONSTRAINT chk_reading_publications_level
    CHECK (level IN ('N5', 'N4', 'N3', 'N2', 'N1') OR level IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_reading_publications_owner
  ON reading_publications (owner_id, id_reading_publication DESC);
CREATE INDEX IF NOT EXISTS idx_reading_publications_public
  ON reading_publications (is_public, id_reading_publication DESC);

ALTER TABLE reading_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_publications FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE reading_publications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE reading_publications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reading_publications TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE reading_publications_id_reading_publication_seq TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON reading_publications;
CREATE POLICY jlt_runtime_crud
  ON reading_publications
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
