-- V6.2-A link hygiene: community share-posts may reference decks/readings
-- that no longer exist (no FKs on community_posts.deck_id/reading_id).
-- Verified zero orphans on staging before writing this file, so the
-- constraints are added NOT VALID (no table scan, no write block); a later
-- VALIDATE CONSTRAINT pass can promote them once prod is triaged the same
-- way. entity_id stays polymorphic by design (no FK possible) — documented,
-- not changed. Never edit history: this is a forward-only addition.
ALTER TABLE community_posts DROP CONSTRAINT IF EXISTS fk_community_posts_deck;
ALTER TABLE community_posts ADD CONSTRAINT fk_community_posts_deck
  FOREIGN KEY (deck_id) REFERENCES deck_publications (id_deck_publication)
  ON DELETE SET NULL NOT VALID;

ALTER TABLE community_posts DROP CONSTRAINT IF EXISTS fk_community_posts_reading;
ALTER TABLE community_posts ADD CONSTRAINT fk_community_posts_reading
  FOREIGN KEY (reading_id) REFERENCES reading_publications (id_reading_publication)
  ON DELETE SET NULL NOT VALID;
