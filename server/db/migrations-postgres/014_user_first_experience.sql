-- NippoTrack v5.1-A.2 — per-user first-run experience state (onboarding + placement).
-- One row per user; absent row means "never onboarded". Never references review
-- evidence, goals, or shared reference tables. The persistent study target lives
-- in user_jlpt_target (reused, untouched here); placement_estimate is a transient
-- self-placement hint only — never an official level, confidence, or mastery.
-- Express with jlt_runtime is the only normal runtime database boundary.
CREATE TABLE IF NOT EXISTS user_first_experience (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  onboarding_completed_at timestamptz NULL,
  study_sources TEXT[] NOT NULL DEFAULT '{}',
  placement_status varchar(12) NOT NULL DEFAULT 'not_started' CHECK (placement_status IN ('not_started', 'skipped', 'completed')),
  placement_estimate varchar(2) NULL CHECK (placement_estimate IN ('N5', 'N4', 'N3', 'N2', 'N1')),
  placement_completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_user_first_experience_sources CHECK (study_sources <@ ARRAY['textbooks', 'anime-drama', 'manga', 'youtube', 'classes', 'flashcards', 'conversations', 'apps', 'notes', 'other']::text[])
);
-- NOTE on chk_user_first_experience_sources: defense-in-depth only. The server
-- allowlist is authoritative (it also rejects NULL/blank elements and dedupes;
-- a NULL array element evaluates the <@ check to UNKNOWN, which CHECK accepts).
-- No updated_at trigger (mirrors 008_user_jlpt_target); the server sets updated_at.

ALTER TABLE user_first_experience ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_first_experience FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE user_first_experience FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_first_experience FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_first_experience TO jlt_runtime;

DROP POLICY IF EXISTS user_first_experience_runtime_select ON user_first_experience;
CREATE POLICY user_first_experience_runtime_select
  ON user_first_experience
  FOR SELECT
  TO jlt_runtime
  USING (true);

DROP POLICY IF EXISTS user_first_experience_runtime_write ON user_first_experience;
CREATE POLICY user_first_experience_runtime_write
  ON user_first_experience
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

-- BACKFILL (admin role, same migration): pre-migration accounts count as
-- onboarded, so stamp onboarding_completed_at now. Placement stays not_started
-- and no estimates/sources are invented. auth.users is readable from the
-- migration role (cf. scripts/backfill-multi-user-ownership.js SELECT on
-- auth.users via the same admin pool). ON CONFLICT keeps this idempotent.
INSERT INTO user_first_experience (user_id, onboarding_completed_at)
SELECT id, CURRENT_TIMESTAMP FROM auth.users
ON CONFLICT (user_id) DO NOTHING;
