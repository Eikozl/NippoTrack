-- Profile avatar storage: public `avatars` bucket for per-user JPEG avatars.
-- Each user owns exactly one object, `<userId>/avatar.jpg`, upserted by
-- POST /api/users/me/avatar and removed by DELETE /api/users/me/avatar.
-- The object path is built server-side from req.user.id only; client
-- filenames are never trusted, so no orphan or traversal paths can exist.
--
-- WRITE POSTURE (deliberate, tightest): NO anon/authenticated INSERT, UPDATE
-- or DELETE policies are created on storage.objects. Every write is mediated
-- by the Express avatar endpoints through the server-held service key, so the
-- magic-byte (JPEG-only), 2MB, path-confinement and per-user throttle checks
-- cannot be bypassed from the browser. Reads stay public so <img> tags and
-- profile fetches need no credentials. Per-user scoping remains the Express
-- layer's responsibility, matching the 030-042 runtime model (jlt_runtime is
-- the only application DB boundary; storage writes use the service key kept
-- server-side only, never issued to the client).
INSERT INTO storage.buckets (id, name, public)
SELECT 'avatars', 'avatars', TRUE
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'avatars');

-- Public read-only: exactly one SELECT policy, no write policies at all.
DROP POLICY IF EXISTS avatars_public_read ON storage.objects;
CREATE POLICY avatars_public_read
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'avatars');
