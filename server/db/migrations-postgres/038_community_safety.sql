-- V6.0 Social Community (part 2): notifications, reports, blocks, and the
-- public-profile columns needed for identity (level/target/interests).
-- Same RLS/grant/policy model as 030-037. Notifications are an internal
-- inbox only (no push/email): like/comment/follow events on the user's own
-- content. Reports are triage rows (no auto-takedown in V6.0); blocks hide
-- bidirectionally in feeds, profiles, and interactions (enforced in the
-- service layer, never frontend-only).

CREATE TABLE IF NOT EXISTS notifications (
  id_notification bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  kind varchar NOT NULL,
  id_community_post bigint REFERENCES community_posts (id_community_post) ON DELETE CASCADE,
  id_post_comment bigint REFERENCES post_comments (id_post_comment) ON DELETE CASCADE,
  is_read boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_notifications_kind
    CHECK (kind IN ('like', 'comment', 'follow'))
);

CREATE TABLE IF NOT EXISTS content_reports (
  id_content_report bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  target_type varchar NOT NULL,
  target_id bigint NOT NULL,
  reason varchar NOT NULL,
  details varchar(500),
  status varchar NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_content_reports_target
    CHECK (target_type IN ('post', 'comment')),
  CONSTRAINT chk_content_reports_reason
    CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misleading', 'other')),
  CONSTRAINT chk_content_reports_status
    CHECK (status IN ('open', 'reviewed', 'dismissed'))
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_user_blocks_not_self CHECK (blocker_id <> blocked_id),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Public identity additions (additive, nullable, safe defaults).
-- display_name/username/bio/avatar_url/is_public already exist (018+030).
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS jlpt_level varchar(2);
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS target_jlpt varchar(2);
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS interests varchar(500);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_profile_levels') THEN
    ALTER TABLE user_profile ADD CONSTRAINT chk_user_profile_levels
      CHECK (
        (jlpt_level IS NULL OR jlpt_level IN ('N5', 'N4', 'N3', 'N2', 'N1'))
        AND (target_jlpt IS NULL OR target_jlpt IN ('N5', 'N4', 'N3', 'N2', 'N1'))
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications (user_id, is_read, id_notification DESC);
CREATE INDEX IF NOT EXISTS idx_content_reports_target
  ON content_reports (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_reporter
  ON content_reports (reporter_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker
  ON user_blocks (blocker_id, blocked_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks (blocked_id, blocker_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE notifications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE notifications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notifications TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE notifications_id_notification_seq TO jlt_runtime;

ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_reports FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE content_reports FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE content_reports FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE content_reports TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE content_reports_id_content_report_seq TO jlt_runtime;

ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_blocks FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE user_blocks FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE user_blocks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_blocks TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON notifications;
CREATE POLICY jlt_runtime_crud ON notifications FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS jlt_runtime_crud ON content_reports;
CREATE POLICY jlt_runtime_crud ON content_reports FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS jlt_runtime_crud ON user_blocks;
CREATE POLICY jlt_runtime_crud ON user_blocks FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
