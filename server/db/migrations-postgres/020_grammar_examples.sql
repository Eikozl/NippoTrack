-- Grammar usage examples (mirrors usage_examples for vocabulary).
-- The legacy grammar_points.example column is kept untouched for API
-- compatibility; existing non-empty values are preserved as the first
-- managed example row so no user data is lost.
CREATE TABLE IF NOT EXISTS grammar_examples (
  id_grammar_example bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_grammar integer NOT NULL REFERENCES grammar_points (id_grammar) ON DELETE CASCADE,
  sentence text NOT NULL,
  translation text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_grammar_examples_grammar
  ON grammar_examples (id_grammar, id_grammar_example);

INSERT INTO grammar_examples (id_grammar, sentence)
  SELECT g.id_grammar, g.example FROM grammar_points g
  WHERE g.example IS NOT NULL AND btrim(g.example) <> ''
  AND NOT EXISTS (SELECT 1 FROM grammar_examples e WHERE e.id_grammar = g.id_grammar AND e.sentence = g.example);

ALTER TABLE grammar_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE grammar_examples FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE grammar_examples FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE grammar_examples FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE grammar_examples TO jlt_runtime;
GRANT USAGE, SELECT ON SEQUENCE grammar_examples_id_grammar_example_seq TO jlt_runtime;

DROP POLICY IF EXISTS jlt_runtime_crud ON grammar_examples;
CREATE POLICY jlt_runtime_crud
  ON grammar_examples
  FOR ALL
  TO jlt_runtime
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_grammar_examples_updated_at ON grammar_examples;
CREATE TRIGGER trg_grammar_examples_updated_at BEFORE UPDATE ON grammar_examples FOR EACH ROW EXECUTE FUNCTION jlt_set_updated_at();
