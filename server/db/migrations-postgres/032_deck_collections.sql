-- Deck collections (playlists): named groups of publications with an order,
-- shareable as a self-contained signed code. Importing a collection imports
-- every member deck's items (dedupe per deck). 026-style RLS, no triggers.
CREATE TABLE IF NOT EXISTS deck_collections (
  id_deck_collection bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title varchar(120) NOT NULL,
  description varchar(500) NOT NULL DEFAULT '',
  is_public boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_deck_collections_title
    CHECK (char_length(title) >= 1)
);

CREATE TABLE IF NOT EXISTS deck_collection_decks (
  id_deck_collection bigint NOT NULL REFERENCES deck_collections (id_deck_collection) ON DELETE CASCADE,
  id_deck_publication bigint NOT NULL REFERENCES deck_publications (id_deck_publication) ON DELETE CASCADE,
  position integer NOT NULL,
  CONSTRAINT chk_deck_collection_decks_position
    CHECK (position >= 0),
  CONSTRAINT deck_collection_decks_unique
    UNIQUE (id_deck_collection, id_deck_publication)
);

CREATE INDEX IF NOT EXISTS idx_deck_collections_owner
  ON deck_collections (owner_id, id_deck_collection DESC);
CREATE INDEX IF NOT EXISTS idx_deck_collections_public
  ON deck_collections (is_public, id_deck_collection DESC);
CREATE INDEX IF NOT EXISTS idx_deck_collection_decks_collection
  ON deck_collection_decks (id_deck_collection, position);

ALTER TABLE deck_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE deck_collections FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE deck_collections FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE deck_collections FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deck_collections TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE deck_collections_id_deck_collection_seq TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON deck_collections;
CREATE POLICY jlt_runtime_crud
  ON deck_collections
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

ALTER TABLE deck_collection_decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE deck_collection_decks FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE deck_collection_decks FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE deck_collection_decks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deck_collection_decks TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON deck_collection_decks;
CREATE POLICY jlt_runtime_crud
  ON deck_collection_decks
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
