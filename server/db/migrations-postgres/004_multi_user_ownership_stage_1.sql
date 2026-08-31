-- Stage 1 of the multi-user migration: ownership columns remain nullable until
-- the verified existing owner is assigned by the parameterized backfill script.
-- The owner UUID must never be committed to this repository.
ALTER TABLE vocabulary ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
ALTER TABLE kanji ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
ALTER TABLE grammar_points ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
ALTER TABLE study_sessions ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
ALTER TABLE goals ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
ALTER TABLE content_entries ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
ALTER TABLE notes ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
ALTER TABLE tags ADD COLUMN user_id uuid REFERENCES auth.users (id) ON DELETE RESTRICT;
