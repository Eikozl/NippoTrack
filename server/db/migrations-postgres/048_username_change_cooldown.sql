-- V6.2-C username change cooldown: handles are followable identity, so
-- changes are rate-limited to one per 24h (any change — set, rename, clear —
-- stamps the clock uniformly; no gaming the handle by clearing first).
-- NULL = never changed (or changed before this column existed): the next
-- change is always allowed and stamps the clock.
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS username_changed_at timestamptz NULL;
CREATE INDEX IF NOT EXISTS idx_user_profile_username_changed ON user_profile (username_changed_at);
