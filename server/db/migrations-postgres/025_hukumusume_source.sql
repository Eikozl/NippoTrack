-- V5.3b — Hukumusume source: widen the reading_sources type allowlist so the
-- fairy-tale importer can persist its rows. The 022 CHECK enumerated only
-- ('aozora', 'nhk', 'user'); inserts with type 'hukumusume' fail with 23514
-- without this change. Idempotent: drops the old constraint only if present,
-- then (re)creates it with the widened set.

ALTER TABLE reading_sources DROP CONSTRAINT IF EXISTS chk_reading_sources_type;
ALTER TABLE reading_sources
  ADD CONSTRAINT chk_reading_sources_type
  CHECK (type IN ('aozora', 'hukumusume', 'nhk', 'user'));
