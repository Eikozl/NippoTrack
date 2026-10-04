-- Deck suggestions (light PRs): proposed title/description edits on a
-- publication, decided by the deck owner. Only title/description are
-- auto-applied on accept (items/tags stay out of scope by design).
-- 026-style RLS posture, no triggers.
CREATE TABLE IF NOT EXISTS deck_suggestions (
  id_deck_suggestion bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_deck_publication bigint NOT NULL REFERENCES deck_publications (id_deck_publication) ON DELETE CASCADE,
  proposer_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  changes_json jsonb NOT NULL,
  status varchar NOT NULL DEFAULT 'pending',
  comment text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at timestamptz,
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_deck_suggestions_status
    CHECK (status IN ('pending', 'accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_deck_suggestions_deck_status
  ON deck_suggestions (id_deck_publication, status, id_deck_suggestion DESC);

ALTER TABLE deck_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deck_suggestions FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE deck_suggestions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE deck_suggestions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deck_suggestions TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE deck_suggestions_id_deck_suggestion_seq TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON deck_suggestions;
CREATE POLICY jlt_runtime_crud
  ON deck_suggestions
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
