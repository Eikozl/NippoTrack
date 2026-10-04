-- Weekly insights cache: one generated insights document per user per ISO
-- week, so the dashboard can render instantly and history stays stable.
-- Express with jlt_runtime is the only normal runtime database boundary;
-- modelled exactly on 026_review_session_items.sql (RLS ENABLE+FORCE,
-- REVOKE PUBLIC/anon/authenticated, GRANT to jlt_runtime,
-- jlt_runtime_crud policy, idempotent guards). No updated_at column, so no
-- trigger (trigger count unchanged). Regeneration overwrites the week's row.
CREATE TABLE IF NOT EXISTS weekly_insights (
  id_weekly_insight bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  week_start date NOT NULL,
  insights_json jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT weekly_insights_user_week_unique
    UNIQUE (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_insights_user_week
  ON weekly_insights (user_id, week_start DESC);

ALTER TABLE weekly_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_insights FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE weekly_insights FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE weekly_insights FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE weekly_insights TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE weekly_insights_id_weekly_insight_seq TO jlt_runtime;
DROP POLICY IF EXISTS jlt_runtime_crud ON weekly_insights;
CREATE POLICY jlt_runtime_crud
  ON weekly_insights
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);
