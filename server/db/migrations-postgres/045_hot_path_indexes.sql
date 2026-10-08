-- V6.2-A Phase 2 (hot-path indexes): read-optimised composite indexes for
-- the four hottest query shapes identified in the Phase-1 audit. All
-- target tables/columns were verified to exist (022 graded reading, 030
-- social foundation, 018 user_profile) against the testing project via
-- information_schema before writing this file. No existing index covers
-- these orderings (verified via pg_indexes on testing).
--
-- Query-shape -> index match:
-- (a) library feed: gradedReader listLibraryTexts
--       WHERE (rt.user_id IS NULL OR rt.user_id = ?) [...]
--       ORDER BY rt.created_at DESC, rt.id_reading_text DESC LIMIT ? OFFSET ?
--     -> idx_reading_texts_library_feed (created_at DESC, id_reading_text DESC)
-- (b) progress feed: gradedReader listReadingProgress
--       WHERE p.user_id = ?
--       ORDER BY p.updated_at DESC, p.text_id DESC LIMIT ? OFFSET ?
--     -> idx_user_reading_progress_recent (user_id, updated_at DESC, text_id DESC)
--     (existing idx_user_reading_progress_user_text covers (user_id, text_id)
--     point lookups; the new index serves the ORDER BY feed scan.)
-- (c) deck-follow reverse lookup ("my follows" / toggle EXISTS +
--     follower-side joins; forward direction is already covered by the PK
--     (id_deck_publication, follower_id) + idx_deck_follows_deck)
--     -> idx_deck_follows_follower (follower_id, id_deck_publication)
-- (d) people directory browse: community searchService browse-people
--       WHERE up.username IS NOT NULL AND up.is_public [...]
--       ORDER BY up.updated_at DESC, up.username ASC LIMIT ? OFFSET ?
--     -> idx_user_profile_directory (updated_at DESC, username ASC)
--
-- EXPLAIN deliberately skipped per task: no staging load exists to make a
-- plan meaningful, and planning-only EXPLAIN on shared testing infra adds
-- no signal beyond the exact index-column/ORDER BY match above. Never
-- EXPLAIN ANALYZE on shared infra.
--
-- Forward-only, re-runnable (IF NOT EXISTS). No RLS/grant/policy change:
-- indexes inherit their table's posture; jlt_runtime stays the only
-- runtime boundary. Plain CREATE INDEX (never CONCURRENTLY: the migrate
-- script runs all files in one transaction block).

CREATE INDEX IF NOT EXISTS idx_reading_texts_library_feed
  ON reading_texts (created_at DESC, id_reading_text DESC);

CREATE INDEX IF NOT EXISTS idx_user_reading_progress_recent
  ON user_reading_progress (user_id, updated_at DESC, text_id DESC);

CREATE INDEX IF NOT EXISTS idx_deck_follows_follower
  ON deck_follows (follower_id, id_deck_publication);

CREATE INDEX IF NOT EXISTS idx_user_profile_directory
  ON user_profile (updated_at DESC, username ASC);
