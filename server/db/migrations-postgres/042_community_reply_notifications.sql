-- V6.1 Community replies (part 2): inbox kind for one-level replies.
-- Additive-only widening of the notifications kind check to include
-- 'reply' (parent-comment-author inbox row for POST .../comments with
-- parentCommentId). No new table, no data backfill: existing
-- like/comment/follow rows are untouched. Same RLS/grant/policy model as
-- 030-041: jlt_runtime stays the only runtime boundary; per-user scoping
-- remains the Express layer's responsibility.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_notifications_kind') THEN
    ALTER TABLE notifications DROP CONSTRAINT chk_notifications_kind;
  END IF;
  ALTER TABLE notifications ADD CONSTRAINT chk_notifications_kind
    CHECK (kind IN ('like', 'comment', 'follow', 'reply'));
END
$$;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE notifications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE notifications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notifications TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON notifications;
CREATE POLICY jlt_runtime_crud ON notifications FOR ALL TO jlt_runtime USING (true) WITH CHECK (true);
