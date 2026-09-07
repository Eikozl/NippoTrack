-- JSO-B index trim (Context-Aware + frozen VAF-A/VAF-A.1).
--
-- Drops idx_jmdict_forms_entry + idx_jmdict_senses_entry (~18 MB combined).
-- EXPLAIN evidence on the full snapshot (local jlt_smoke, JSO-B):
--   Q2-forms 50-entry cohort: 0.94 ms via entry index vs ~1.0-1.2 ms via
--     jmdict_forms_pkey prefix — negligible delta, same index-access shape.
--   Q2-forms single entry: already used the pkey (0.18 ms warm).
--   Q2-senses cohorts: already used jmdict_entries_pkey + jmdict_senses_pkey
--     lateral (~1.0 ms warm) — the senses entry index was never chosen.
--   Q1: unchanged Limit -> Index Scan using idx_jmdict_forms_q1_lookup.
-- Both dropped indexes are strict prefixes of their table PKs, so the PKs
-- cover the same (source_id, entry_id) access paths.
--
-- KEPT deliberately: idx_jmdict_senses_pos (1.4 MB GIN — the C1 audit's
-- pos @>/&& probes use Bitmap Index Scans on it; dropping would slow the
-- monthly audit for no meaningful saving), all PKs, the Q1 index, the
-- snapshot unique, and the active-pointer PK.

DROP INDEX IF EXISTS idx_jmdict_forms_entry;
DROP INDEX IF EXISTS idx_jmdict_senses_entry;
