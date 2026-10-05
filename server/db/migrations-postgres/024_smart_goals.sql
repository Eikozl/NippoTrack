-- V5.3a — Smart goals: per-user weekly goal + JLPT target + auto-adjust and
-- grace-day preferences backing the /api/goals/smart endpoints. One row per
-- user (CASCADE like 008/018/023). Express with jlt_runtime is the only
-- normal runtime database boundary; modelled exactly on 021-023 (RLS
-- ENABLE+FORCE, REVOKE PUBLIC/anon/authenticated, GRANT to jlt_runtime,
-- jlt_runtime_crud policy, jlt_set_updated_at trigger, idempotent guards).

CREATE TABLE IF NOT EXISTS user_smart_goals (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  weekly_goal integer NOT NULL DEFAULT 20,
  target_jlpt varchar,
  auto_adjust boolean NOT NULL DEFAULT true,
  grace_days smallint NOT NULL DEFAULT 1,
  preferences_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_user_smart_goals_weekly_goal CHECK (weekly_goal >= 1 AND weekly_goal <= 1000),
  CONSTRAINT chk_user_smart_goals_target_jlpt
    CHECK (target_jlpt IN ('N5', 'N4', 'N3', 'N2', 'N1') OR target_jlpt IS NULL),
  CONSTRAINT chk_user_smart_goals_grace_days CHECK (grace_days >= 0 AND grace_days <= 2)
);

ALTER TABLE user_smart_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_smart_goals FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE user_smart_goals FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_smart_goals FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_smart_goals TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON user_smart_goals;
CREATE POLICY jlt_runtime_crud
  ON user_smart_goals
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_user_smart_goals_updated_at ON user_smart_goals;
CREATE TRIGGER trg_user_smart_goals_updated_at BEFORE UPDATE ON user_smart_goals FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
