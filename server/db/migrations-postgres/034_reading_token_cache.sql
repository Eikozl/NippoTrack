-- Token-layer cache (P0 perf): the per-occurrence sentences/tokens artifact
-- computed by analyzeReading is stored here so GET serves it with a cheap
-- per-request ownership overlay instead of recomputing the full lexical
-- analysis (kuromoji + gloss + ownership) on every request.
-- Additive only: both columns nullable (imports stay lazy-filled on first
-- GET); known flags are NEVER trusted from cache (overlay refreshes them).
ALTER TABLE reading_texts ADD COLUMN IF NOT EXISTS sentences_json jsonb;
ALTER TABLE reading_texts ADD COLUMN IF NOT EXISTS tokens_json jsonb;
