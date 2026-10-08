-- V6.1 Community replies (part 1): one-level reply model on post_comments.
-- Additive-only: a nullable self-referencing parent_comment_id plus a
-- BEFORE INSERT OR UPDATE trigger that rejects second-level nesting (a
-- reply whose parent is itself a reply), so thread depth can never exceed
-- one even if a future writer bypasses the Express single-level guard.
-- NOTE: the self-FK targets post_comments (id_post_comment) — that is the
-- table's identity PK (see 037); there is no post_comments (id) column.
-- Same RLS/grant/policy model as 030-040: jlt_runtime stays the only
-- runtime boundary; per-user scoping remains the Express layer's
-- responsibility (every read/write carries the owner/viewer predicate).
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_comment_id BIGINT REFERENCES post_comments (id_post_comment) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_post_comments_parent
  ON post_comments (parent_comment_id) WHERE parent_comment_id IS NOT NULL;

-- Cheap partial index for comment lists (non-deleted rows per post).
CREATE INDEX IF NOT EXISTS idx_post_comments_post_visible
  ON post_comments (id_community_post) WHERE NOT is_deleted;

CREATE OR REPLACE FUNCTION jlt_post_comments_one_level()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_comment_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM post_comments p
      WHERE p.id_post_comment = NEW.parent_comment_id
        AND p.parent_comment_id IS NULL
    ) THEN
      RAISE EXCEPTION 'post_comments: replies are limited to one level (parent % is itself a reply or missing)', NEW.parent_comment_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_comments_one_level ON post_comments;
CREATE TRIGGER trg_post_comments_one_level
  BEFORE INSERT OR UPDATE ON post_comments
  FOR EACH ROW EXECUTE FUNCTION jlt_post_comments_one_level();

ALTER TABLE post_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_comments FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE post_comments FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE post_comments FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE post_comments TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON post_comments;
CREATE POLICY jlt_runtime_crud ON post_comments FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
