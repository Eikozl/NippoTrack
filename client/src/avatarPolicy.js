// Avatar URL safety gate (single source of truth).
// Avatars are Supabase Storage public URLs for the avatars bucket (with
// ?v= cache-buster) or same-origin relative paths. data:/blob:/script
// schemes are rejected outright (SVG polyglots execute outside <img>);
// plain http: and foreign https: hosts are rejected (mixed content +
// tracker-host risk) since avatar_url is allowlisted at write time.
export function isSafeAvatarUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  return /^https:\/\/[A-Za-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/avatars\//i.test(trimmed)
    || /^\/(?!\/)/.test(trimmed);
}

export function avatarUrlFor(source) {
  if (!source || typeof source !== 'object') return null;
  const candidate = source.authorAvatar || source.avatarUrl || source.actorAvatar || null;
  if (!candidate) return null;
  const trimmed = String(candidate).trim();
  return isSafeAvatarUrl(trimmed) ? trimmed : null;
}
