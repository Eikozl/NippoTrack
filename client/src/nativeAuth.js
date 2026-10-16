// Native deep-link auth return (sideloaded APK only).
// Email confirm/recovery links minted with { nativeApp: true } point at
// nippotrack://auth/callback. Android delivers them to the app via the
// Capacitor App plugin; this module turns the incoming URL into a Supabase
// session. Pure and DOM-free except for the optional navigation callback,
// so it is unit-testable with a fake supabase client.
export const NATIVE_AUTH_SCHEME = 'nippotrack://auth/callback';

export function isNativeAuthUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase().startsWith('nippotrack://auth/callback');
  } catch {
    return false;
  }
}

function allParams(url) {
  const parsed = new URL(String(url));
  const out = {};
  for (const [key, value] of parsed.searchParams) {
    if (!(key in out)) out[key] = value;
  }
  const hash = String(parsed.hash || '').replace(/^#/, '');
  for (const part of hash.split('&')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = decodeURIComponent(part.slice(0, separator));
    if (!(key in out)) out[key] = decodeURIComponent(part.slice(separator + 1));
  }
  return out;
}

// Returns { handled: true } when a session was established, or
// { handled: false, reason } otherwise. Never throws.
export async function handleNativeAuthUrl(url, supabase) {
  try {
    if (!isNativeAuthUrl(url) || !supabase?.auth) return { handled: false, reason: 'not-an-auth-callback' };
    const params = allParams(url);
    if (params.code) {
      const { error } = await supabase.auth.exchangeCodeForSession(params.code);
      if (error) throw error;
      return { handled: true };
    }
    if (params.access_token) {
      const { error } = await supabase.auth.setSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token || ''
      });
      if (error) throw error;
      return { handled: true };
    }
    if (params.token_hash && params.type) {
      const { error } = await supabase.auth.verifyOtp({ type: params.type, token_hash: params.token_hash });
      if (error) throw error;
      return { handled: true };
    }
    if (params.error) return { handled: false, reason: String(params.error_description || params.error) };
    return { handled: false, reason: 'no-auth-payload' };
  } catch (error) {
    return { handled: false, reason: error?.message || 'unknown' };
  }
}

// Wires the Capacitor App plugin once. onAuthenticated runs after a session
// is established (host navigates to the app, same as the web handoff).
export function initNativeAuth({ supabase, onAuthenticated } = {}) {
  try {
    const plugin = window?.Capacitor?.Plugins?.App;
    if (!plugin || typeof plugin.addListener !== 'function') return false;
    plugin.addListener('appUrlOpen', async ({ url }) => {
      const result = await handleNativeAuthUrl(url, supabase);
      if (!result.handled) return;
      try { await onAuthenticated?.(); } catch { /* host handoff is best-effort */ }
    });
    return true;
  } catch {
    return false;
  }
}
