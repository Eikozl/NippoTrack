-- JSO-B lean runtime projection (Context-Aware + frozen VAF-A/VAF-A.1).
--
-- jmdict_entries drops `doc JSONB` + per-entry `checksum`: JSO-A proved zero
-- runtime, verification, rollback, and recovery consumers (importer + tests
-- updated alongside; SOURCE artifact sha256 in jmdict_sources is untouched).
--
-- Physical rebuild via table swap so populated installations actually reclaim
-- storage: a bare DROP COLUMN would leave the old heap allocated. Rows and
-- semantics are preserved (works on empty databases too). Forms, senses,
-- indexes, ledger, pointer, RLS posture, and grants are untouched here;
-- index drops (if justified by EXPLAIN evidence) arrive in 013.
--
-- FKs are dropped and re-added under their ORIGINAL names so posture checks
-- and tooling observe no difference. The entries PK keeps its original name.

ALTER TABLE jmdict_forms DROP CONSTRAINT IF EXISTS fk_jmdict_forms_entry;
ALTER TABLE jmdict_senses DROP CONSTRAINT IF EXISTS fk_jmdict_senses_entry;

CREATE TABLE jmdict_entries_new (
  source_id bigint NOT NULL,
  ent_seq bigint NOT NULL,
  pos_summary text[] NOT NULL DEFAULT ARRAY[]::text[],
  is_common boolean NOT NULL DEFAULT false,
  PRIMARY KEY (source_id, ent_seq),
  CONSTRAINT chk_jmdict_entries_new_ent_seq CHECK (ent_seq > 0),
  CONSTRAINT fk_jmdict_entries_source FOREIGN KEY (source_id)
    REFERENCES jmdict_sources (source_id) ON DELETE RESTRICT
);

INSERT INTO jmdict_entries_new (source_id, ent_seq, pos_summary, is_common)
  SELECT source_id, ent_seq, pos_summary, is_common FROM jmdict_entries;

DROP TABLE jmdict_entries;

ALTER TABLE jmdict_entries_new RENAME TO jmdict_entries;
ALTER TABLE jmdict_entries RENAME CONSTRAINT jmdict_entries_new_pkey TO jmdict_entries_pkey;
ALTER TABLE jmdict_entries RENAME CONSTRAINT chk_jmdict_entries_new_ent_seq TO chk_jmdict_entries_ent_seq;

ALTER TABLE jmdict_forms ADD CONSTRAINT fk_jmdict_forms_entry FOREIGN KEY (source_id, entry_id)
  REFERENCES jmdict_entries (source_id, ent_seq) ON DELETE CASCADE;
ALTER TABLE jmdict_senses ADD CONSTRAINT fk_jmdict_senses_entry FOREIGN KEY (source_id, entry_id)
  REFERENCES jmdict_entries (source_id, ent_seq) ON DELETE CASCADE;

-- RLS posture identical to 010 (forced, runtime SELECT-only). The old policy
-- died with the old table; recreate it under the same frozen name.
ALTER TABLE jmdict_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE jmdict_entries FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE jmdict_entries FROM PUBLIC;
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.jmdict_entries FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
GRANT SELECT ON TABLE jmdict_entries TO jlt_runtime;
DROP POLICY IF EXISTS jmdict_entries_runtime_select ON jmdict_entries;
CREATE POLICY jmdict_entries_runtime_select ON jmdict_entries FOR SELECT TO jlt_runtime USING (true);
