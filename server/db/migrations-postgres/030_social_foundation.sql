-- Social foundation: public identity columns plus persisted public decks.
-- user_profile gains an opt-in public handle (username is unique and
-- URL-safe; display_name stays non-unique per 018). deck_publications are
-- first-class rows (unlike stateless share codes): owned, listable,
-- followable. Items are snapshots (display/reading/meaning/...) so a deck
-- survives edits to the author's collection. Express with jlt_runtime is
-- the only normal runtime boundary; modelled on 026 (RLS ENABLE+FORCE,
-- REVOKE PUBLIC/anon/authenticated, GRANT to jlt_runtime,
-- jlt_runtime_crud policy, idempotent guards). No updated_at columns, so no
-- new triggers.
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS username varchar(30);
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS bio varchar(500);
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS avatar_url varchar(500);
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT FALSE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_profile_username') THEN
    ALTER TABLE user_profile ADD CONSTRAINT chk_user_profile_username
      CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9-]{1,29}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_profile_username_key') THEN
    ALTER TABLE user_profile ADD CONSTRAINT user_profile_username_key UNIQUE (username);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS deck_publications (
  id_deck_publication bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title varchar(120) NOT NULL,
  description varchar(500) NOT NULL DEFAULT '',
  entity_type varchar NOT NULL,
  is_public boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_deck_publications_entity_type
    CHECK (entity_type IN ('vocabulary', 'kanji', 'grammar')),
  CONSTRAINT chk_deck_publications_title
    CHECK (char_length(title) >= 1)
);

CREATE TABLE IF NOT EXISTS deck_publication_items (
  id_deck_publication_item bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_deck_publication bigint NOT NULL REFERENCES deck_publications (id_deck_publication) ON DELETE CASCADE,
  position integer NOT NULL,
  item_json jsonb NOT NULL,
  CONSTRAINT chk_deck_publication_items_position
    CHECK (position >= 0),
  CONSTRAINT deck_publication_items_deck_position_unique
    UNIQUE (id_deck_publication, position)
);

CREATE TABLE IF NOT EXISTS deck_follows (
  id_deck_publication bigint NOT NULL REFERENCES deck_publications (id_deck_publication) ON DELETE CASCADE,
  follower_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_deck_publication, follower_id)
);

CREATE INDEX IF NOT EXISTS idx_deck_publications_owner
  ON deck_publications (owner_id, id_deck_publication DESC);
CREATE INDEX IF NOT EXISTS idx_deck_publications_public
  ON deck_publications (is_public, id_deck_publication DESC);
CREATE INDEX IF NOT EXISTS idx_deck_publication_items_deck
  ON deck_publication_items (id_deck_publication, position);
CREATE INDEX IF NOT EXISTS idx_deck_follows_deck
  ON deck_follows (id_deck_publication);

ALTER TABLE deck_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE deck_publications FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE deck_publications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE deck_publications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deck_publications TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE deck_publications_id_deck_publication_seq TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON deck_publications;
CREATE POLICY jlt_runtime_crud
  ON deck_publications
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

ALTER TABLE deck_publication_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE deck_publication_items FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE deck_publication_items FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE deck_publication_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deck_publication_items TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE deck_publication_items_id_deck_publication_item_seq TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON deck_publication_items;
CREATE POLICY jlt_runtime_crud
  ON deck_publication_items
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

ALTER TABLE deck_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE deck_follows FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE deck_follows FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE deck_follows FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deck_follows TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON deck_follows;
CREATE POLICY jlt_runtime_crud
  ON deck_follows
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
