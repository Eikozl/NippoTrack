-- Editorial sentence translations (reader "Tap to reveal English"): manual
-- translations keyed by sentence id ({sentenceId: translation}). Nullable so
-- texts without translations simply show no reveal affordance. Reset on
-- re-import (text may change, stale translations would misalign). Additive
-- only; translations are shared content, never user-scoped.
ALTER TABLE reading_texts ADD COLUMN IF NOT EXISTS sentence_translations_json jsonb;
