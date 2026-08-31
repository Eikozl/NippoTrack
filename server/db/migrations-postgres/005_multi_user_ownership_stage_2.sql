-- Stage 2 runs only after the parameterized owner backfill has verified that
-- every existing root row has exactly the one approved owner.
ALTER TABLE vocabulary ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE kanji ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE grammar_points ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE study_sessions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE goals ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE content_entries ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE tags ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE kanji DROP CONSTRAINT kanji_character_kanji_key;
ALTER TABLE grammar_points DROP CONSTRAINT grammar_points_grammar_point_key;
ALTER TABLE tags DROP CONSTRAINT tags_normalized_name_key;

ALTER TABLE kanji ADD CONSTRAINT kanji_user_character_kanji_key UNIQUE (user_id, character_kanji);
ALTER TABLE grammar_points ADD CONSTRAINT grammar_points_user_grammar_point_key UNIQUE (user_id, grammar_point);
ALTER TABLE tags ADD CONSTRAINT tags_user_normalized_name_key UNIQUE (user_id, normalized_name);

CREATE INDEX idx_vocabulary_user_id ON vocabulary (user_id, id_vocabulary DESC);
CREATE INDEX idx_kanji_user_id ON kanji (user_id, id_kanji DESC);
CREATE INDEX idx_grammar_points_user_id ON grammar_points (user_id, id_grammar DESC);
CREATE INDEX idx_study_sessions_user_date ON study_sessions (user_id, session_date DESC, id_session DESC);
CREATE INDEX idx_goals_user_active_due ON goals (user_id, is_active, due_date);
CREATE INDEX idx_content_entries_user_date ON content_entries (user_id, content_date DESC, id_content_entry DESC);
CREATE INDEX idx_notes_user_updated_at ON notes (user_id, updated_at DESC, id_note DESC);
