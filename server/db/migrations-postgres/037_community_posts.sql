-- V6.0 Social Community (part 1): user follows, posts, likes, comments.
-- Modelled exactly on 030/031/032/036: RLS ENABLE+FORCE, REVOKE
-- PUBLIC/anon/authenticated, GRANT to jlt_runtime, a single
-- jlt_runtime_crud policy USING(true) WITH CHECK(true). Express with
-- jlt_runtime stays the only normal runtime boundary; per-user scoping is
-- the Express layer's responsibility (every read/write carries the
-- owner/viewer predicate, foreign rows 404).
--
-- Design notes:
-- - community_posts.post_type enumerates the V6.0 composer types; shared
--   learning content links by id (deck/reading/entity) instead of
--   duplicating snapshots — the existing publication endpoints stay the
--   source of truth for the content itself.
-- - Soft delete (is_deleted) preserves comment/like history integrity and
--   lets feeds hide removed rows without cascading user content away.
-- - post_likes / user_follows are idempotent by composite PK (toggle =
--   INSERT ... ON CONFLICT DO NOTHING / DELETE), matching deck_follows.
-- - Comments are single-level by design (no parent_id): V6.0 forbids
--   nested reply trees.

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_user_follows_not_self CHECK (follower_id <> followed_id),
  PRIMARY KEY (follower_id, followed_id)
);

CREATE TABLE IF NOT EXISTS community_posts (
  id_community_post bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  post_type varchar NOT NULL,
  title varchar(200),
  body text,
  japanese_text text,
  translation text,
  entity_type varchar,
  entity_id integer,
  deck_id bigint,
  reading_id bigint,
  is_public boolean NOT NULL DEFAULT TRUE,
  is_deleted boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_community_posts_type
    CHECK (post_type IN ('text', 'example', 'question', 'progress', 'share_deck', 'share_reading', 'share_vocab', 'share_kanji', 'share_grammar')),
  CONSTRAINT chk_community_posts_entity_type
    CHECK (entity_type IS NULL OR entity_type IN ('vocabulary', 'kanji', 'grammar')),
  CONSTRAINT chk_community_posts_body
    CHECK (body IS NULL OR char_length(body) <= 2000),
  CONSTRAINT chk_community_posts_japanese
    CHECK (japanese_text IS NULL OR char_length(japanese_text) <= 2000)
);

CREATE TABLE IF NOT EXISTS post_likes (
  id_community_post bigint NOT NULL REFERENCES community_posts (id_community_post) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_community_post, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id_post_comment bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_community_post bigint NOT NULL REFERENCES community_posts (id_community_post) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  body text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_post_comments_body
    CHECK (char_length(body) >= 1 AND char_length(body) <= 1000)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower
  ON user_follows (follower_id, followed_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_followed
  ON user_follows (followed_id, follower_id);
CREATE INDEX IF NOT EXISTS idx_community_posts_author
  ON community_posts (author_id, id_community_post DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_feed
  ON community_posts (is_public, is_deleted, id_community_post DESC);
CREATE INDEX IF NOT EXISTS idx_post_likes_post
  ON post_likes (id_community_post, user_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_post
  ON post_comments (id_community_post, id_post_comment DESC);

ALTER TABLE user_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_follows FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE user_follows FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_follows FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_follows TO jlt_runtime;

ALTER TABLE community_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_posts FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE community_posts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE community_posts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE community_posts TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE community_posts_id_community_post_seq TO jlt_runtime;

ALTER TABLE post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_likes FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE post_likes FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE post_likes FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE post_likes TO jlt_runtime;

ALTER TABLE post_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_comments FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE post_comments FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE post_comments FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE post_comments TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE post_comments_id_post_comment_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON user_follows;
CREATE POLICY jlt_runtime_crud ON user_follows FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS jlt_runtime_crud ON community_posts;
CREATE POLICY jlt_runtime_crud ON community_posts FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS jlt_runtime_crud ON post_likes;
CREATE POLICY jlt_runtime_crud ON post_likes FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS jlt_runtime_crud ON post_comments;
CREATE POLICY jlt_runtime_crud ON post_comments FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_community_posts_updated_at ON community_posts;
CREATE TRIGGER trg_community_posts_updated_at BEFORE UPDATE ON community_posts FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
DROP TRIGGER IF EXISTS trg_post_comments_updated_at ON post_comments;
CREATE TRIGGER trg_post_comments_updated_at BEFORE UPDATE ON post_comments FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
