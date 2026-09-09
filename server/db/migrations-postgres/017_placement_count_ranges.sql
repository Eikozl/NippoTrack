-- NippoTrack placement count ranges — widen 015 per-band CHECKs for the N5x3/N4x3/N3x4 bank.
-- 015 capped every band at 0..2, which wrongly rejects valid N5=3 / N3=3 / N3=4
-- breakdowns from server-side grading (gradePlacement). New bank maxima: N5 0..3,
-- N4 0..3, N3 0..4. Total 0..10 unchanged; vestigial N2/N1 0..2 unchanged (always 0).
-- Constraint names below are the 015 auto-generated names (verified via pg_constraint).
-- No data changes, no RLS/policy changes (014 table policies cover these columns).
ALTER TABLE user_first_experience DROP CONSTRAINT IF EXISTS user_first_experience_placement_correct_n5_check;
ALTER TABLE user_first_experience DROP CONSTRAINT IF EXISTS user_first_experience_placement_correct_n4_check;
ALTER TABLE user_first_experience DROP CONSTRAINT IF EXISTS user_first_experience_placement_correct_n3_check;
ALTER TABLE user_first_experience ADD CONSTRAINT user_first_experience_placement_correct_n5_check CHECK (placement_correct_n5 BETWEEN 0 AND 3);
ALTER TABLE user_first_experience ADD CONSTRAINT user_first_experience_placement_correct_n4_check CHECK (placement_correct_n4 BETWEEN 0 AND 3);
ALTER TABLE user_first_experience ADD CONSTRAINT user_first_experience_placement_correct_n3_check CHECK (placement_correct_n3 BETWEEN 0 AND 4);
