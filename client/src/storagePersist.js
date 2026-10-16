// Persistent storage request (WebKit eviction hardening).
// Home-screen web apps (iOS) and browsers may evict best-effort website
// data (localStorage, where the Supabase session lives) under storage
// pressure or inactivity windows. Requesting persistent mode excludes the
// origin from automatic eviction. Fail-open and idempotent: unsupported
// platforms, denials, and private-mode throwables all resolve false with
// zero effect on boot. Pure/DOM-free except for the injected navigator.
export async function requestPersistentStorage(navigatorRef) {
  try {
    const storage = navigatorRef?.storage;
    if (!storage || typeof storage.persisted !== 'function' || typeof storage.persist !== 'function') return false;
    if (await storage.persisted()) return true;
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}
