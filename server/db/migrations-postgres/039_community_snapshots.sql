-- V6.0 Community (part 3): server-built content snapshots on posts.
-- Share posts (deck/reading/entity) snapshot the linked content's display
-- values at publish time so other learners can preview and save them
-- WITHOUT ever reading another learner's private rows: the snapshot is
-- part of the public post payload. Snapshots are frozen (never follow
-- later edits), mirroring the deck/item snapshot philosophy of 030.
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS snapshot_json jsonb NOT NULL DEFAULT '{}';
