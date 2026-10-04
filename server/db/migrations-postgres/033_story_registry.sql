-- Story Registry (phase 1): content_entries gains the story columns; links
-- from stories to enrolled review items live in story_review_links.
-- Additive only: no existing column is touched, no new triggers (no new
-- updated_at column). 026-style RLS posture for the new table.
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS source_url varchar(2000);
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS embed_html text;
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS thumbnail_url varchar(2000);
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS duration_seconds integer;
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS source_domain varchar(255);
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS source_text text;
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS extracted_json jsonb NOT NULL DEFAULT '{}';
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS processing_status varchar NOT NULL DEFAULT 'none';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_content_entries_story_status') THEN
    ALTER TABLE content_entries ADD CONSTRAINT chk_content_entries_story_status
      CHECK (processing_status IN ('none', 'pending', 'processing', 'completed', 'failed'));
  END IF;
END
$$;
ALTER TABLE content_entries ADD COLUMN IF NOT EXISTS extraction_error text;

CREATE TABLE IF NOT EXISTS story_review_links (
  id_content_entry integer NOT NULL REFERENCES content_entries (id_content_entry) ON DELETE CASCADE,
  id_review_item integer NOT NULL REFERENCES review_items (id_review_item) ON DELETE CASCADE,
  PRIMARY KEY (id_content_entry, id_review_item)
);

ALTER TABLE story_review_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_review_links FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE story_review_links FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE story_review_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE story_review_links TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON story_review_links;
CREATE POLICY jlt_runtime_crud
  ON story_review_links
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
