-- JMdict Q1 hot-lookup index (Context-Aware Vocabulary Intelligence, CA-B1.1).
--
-- Proof (measured on the pinned snapshot: 218,672 entries / 498,846 forms,
-- local PG18, after ANALYZE): the frozen Q1 shape
--   WHERE source_id = ? AND normalized = ? AND kind = ?
--   ORDER BY is_common DESC, entry_id LIMIT 6
-- ran Limit > Sort > Index Scan on idx_jmdict_forms_lookup for every probe
-- (sort present; 43 buffer hits on the 52-row pathological cohort こう/reb),
-- versus Limit > Index Scan with NO sort on
-- (source_id, normalized, kind, is_common DESC, entry_id) for the same probes
-- (9 buffer hits on こう/reb; identical results on 1-row, 5-row, 14-row and
-- 52-row cohorts). The (source_id, kind, ...) column order measured
-- identically; (source_id, normalized, ...) is kept because it preserves the
-- established leading columns. Storage: ~28 MB vs ~27 MB for the old index
-- (+3%); the old index is redundant (same leading columns) and is dropped in
-- the same transaction, so net index storage is unchanged and refresh write
-- overhead does not grow. No query, table, policy, or grant changes.
CREATE INDEX IF NOT EXISTS idx_jmdict_forms_q1_lookup
  ON jmdict_forms (source_id, normalized, kind, is_common DESC, entry_id);
DROP INDEX IF EXISTS idx_jmdict_forms_lookup;
