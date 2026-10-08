-- V6.2-B: reconcile speech_rate range with the product truth.
-- normalizeSpeechRate (server/src/services/reviewEngine.js) and the API
-- contract (PUT /api/review/preferences) accept 0.25–1.5, and a 0.25 row
-- exists in the wild; but 046 installed a 0.5–1.5 CHECK that would reject
-- legitimate writes. Widen to the product range and VALIDATE (existing rows
-- conform by construction). Forward-only; never edit 046.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_review_preferences_speech_rate'
  ) THEN
    ALTER TABLE user_review_preferences DROP CONSTRAINT chk_user_review_preferences_speech_rate;
  END IF;
END $$;

ALTER TABLE user_review_preferences ADD CONSTRAINT chk_user_review_preferences_speech_rate
  CHECK (speech_rate IS NULL OR (speech_rate >= 0.25 AND speech_rate <= 1.5));

ALTER TABLE user_review_preferences VALIDATE CONSTRAINT chk_user_review_preferences_speech_rate;
