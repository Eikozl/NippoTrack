-- Review session queues: the exact ordered items a session was started with,
-- so an unfinished ("In progress") session can be retaken where the user
-- left off. Express with jlt_runtime is the only normal runtime database
-- boundary; modelled exactly on 021_immersion_pipeline.sql (RLS
-- ENABLE+FORCE, REVOKE PUBLIC/anon/authenticated, GRANT to jlt_runtime,
-- jlt_runtime_crud policy, idempotent guards). No updated_at column, so no
-- trigger (trigger count unchanged). Ownership flows through review_sessions;
-- rows vanish with their session via ON DELETE CASCADE.
CREATE TABLE IF NOT EXISTS review_session_items (
  id_review_session_item bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_review_session bigint NOT NULL REFERENCES review_sessions (id_review_session) ON DELETE CASCADE,
  entity_type varchar NOT NULL,
  entity_id integer NOT NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_review_session_items_entity_type
    CHECK (entity_type IN ('vocabulary', 'kanji', 'grammar')),
  CONSTRAINT chk_review_session_items_position
    CHECK (position >= 0),
  CONSTRAINT review_session_items_session_entity_unique
    UNIQUE (id_review_session, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_review_session_items_session_position
  ON review_session_items (id_review_session, position);

ALTER TABLE review_session_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_session_items FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE review_session_items FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE review_session_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_session_items TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE review_session_items_id_review_session_item_seq TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON review_session_items;
CREATE POLICY jlt_runtime_crud
  ON review_session_items
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
