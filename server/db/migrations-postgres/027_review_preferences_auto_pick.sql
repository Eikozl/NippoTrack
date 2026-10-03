-- Review 3.0 — per-user auto-pick toggle for review cards.
-- Express with jlt_runtime is the only normal runtime database boundary.
--
-- Additive column only: user_review_preferences already carries RLS
-- ENABLE+FORCE, REVOKE PUBLIC/anon/authenticated, GRANTs to jlt_runtime, the
-- single jlt_runtime_crud policy, and the jlt_set_updated_at trigger from
-- 023_review_v2.sql. A column inherits all of those, so this migration
-- creates no new table, policy, or trigger and the runtime-security pins
-- (47 tables / 51 policies / 23 triggers) stay green.
--
-- auto_pick is nullable with DEFAULT TRUE: pre-027 rows backfill to TRUE,
-- legacy reads without the column still resolve to true via the engine's
-- default-true read path, and the engineMode/cardTypes/weights contract is
-- untouched. The JSONB columns were NOT reused: card_types is an array and
-- weights is a numeric (0-100) map, so stuffing a boolean there would break
-- their validation contracts.

ALTER TABLE user_review_preferences ADD COLUMN IF NOT EXISTS auto_pick boolean DEFAULT TRUE;
