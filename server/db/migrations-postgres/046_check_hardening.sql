-- V6.2-A Phase 2 (CHECK hardening + reserved-column documentation).
-- Forward-only, re-runnable (pg_constraint IF NOT EXISTS guards; COMMENTs
-- are unconditionally safe). No RLS/grant/policy change; no new tables.
--
-- 1) user_review_preferences.speech_rate range 0.5-1.5, NULL allowed.
--    Nullability verified on testing: YES (real, DEFAULT 0.9).
--    Added NOT VALID on purpose: testing currently holds one row with
--    speech_rate = 0.25, which the Express validator
--    (reviewEngine.normalizeSpeechRate, 0.25-1.5) accepts. A validating
--    ADD would fail the whole migrate transaction, so the constraint is
--    staged NOT VALID and VALIDATE is deferred until product reconciles
--    the app range (0.25-1.5) with this DB range (0.5-1.5) and triages
--    the 0.25 row. New writes outside 0.5-1.5 are rejected immediately.
-- 2) immersion_session_items.review_status allowlist. Verified on testing
--    FIRST: SELECT DISTINCT shows ONLY 'pending' (44 rows), so the
--    allowlist below validates cleanly and is added validating (no NOT
--    VALID). The set beyond 'pending' is a minimal learn-flow lifecycle
--    proposal (no writer besides the 'pending' default exists yet in
--    server/src) and needs product sign-off; widen on backend need, never
--    silently.
-- 3) COMMENT ON COLUMN lines: documentation only, always safe.
-- 4) Account-deletion semantics: NO DDL here by design. Decision matrix
--    delivered in the Phase-2 handoff message (RESTRICT-vs-CASCADE per
--    table family + orphan-report query) for product sign-off.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_review_preferences_speech_rate') THEN
    ALTER TABLE user_review_preferences ADD CONSTRAINT chk_user_review_preferences_speech_rate
      CHECK (speech_rate IS NULL OR (speech_rate >= 0.5 AND speech_rate <= 1.5)) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_immersion_session_items_review_status') THEN
    ALTER TABLE immersion_session_items ADD CONSTRAINT chk_immersion_session_items_review_status
      CHECK (review_status IN ('pending', 'seen', 'learned', 'skipped'));
  END IF;
END
$$;

COMMENT ON COLUMN user_profile.interests IS
  'Reserved-nullable: free-form interest tags (V6.0 identity). NULL means unset; kept nullable by design for future structured interests — do not backfill or default.';

COMMENT ON COLUMN review_sessions.card_type IS
  'Reserved-nullable: Review 2.0 card-type classifier (forward-compatible column from 023). NULL means not yet classified; writers may populate later without a migration.';

COMMENT ON COLUMN review_sessions.difficulty_score IS
  'Reserved-nullable: Review 2.0 difficulty estimate (forward-compatible column from 023). NULL means not yet scored; writers may populate later without a migration.';

COMMENT ON COLUMN content_entries.duration_seconds IS
  'Reserved-nullable: story media length in seconds (033 registry). NULL means unknown or not applicable (non-media entries); never default to 0.';

COMMENT ON COLUMN immersion_session_items.entity_id IS
  'Polymorphic key by design: pairs with entity_type (vocabulary|kanji|grammar). Intentionally no FK — joins must always include entity_type; see UNIQUE (id_immersion_session, entity_type, entity_id).';

COMMENT ON COLUMN review_session_items.entity_id IS
  'Polymorphic key by design: pairs with entity_type (vocabulary|kanji|grammar). Intentionally no FK — joins must always include entity_type; see UNIQUE (id_review_session, entity_type, entity_id).';

COMMENT ON COLUMN community_posts.entity_id IS
  'Polymorphic key by design: pairs with entity_type (vocabulary|kanji|grammar). Intentionally no FK (unlike deck_id/reading_id, which gained FKs in 044) — snapshot_json carries the display payload so posts survive source edits.';
