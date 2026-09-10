import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('auth architecture frozen: same endpoints, same Supabase calls, same guards', () => {
  for (const endpoint of ['/api/auth/sign-in', '/api/auth/sign-up', '/api/auth/forgot-password', '/api/auth/logout', '/api/auth/session']) {
    assert.ok(main.includes(`'${endpoint}'`), `contract kept: ${endpoint}`);
  }
  assert.ok(main.includes('supabase.auth.setSession(data.session)'), 'sign-in session establishment kept');
  assert.ok(main.includes('supabase.auth.updateUser({ password: password.value })'), 'reset semantics kept');
  assert.ok(main.includes('supabase.auth.signOut()'), 'sign-out invalidation kept');
  assert.ok(main.includes("password.value !== confirm.value) throw new Error('Passwords do not match.')"), 'validation semantics kept');
  assert.ok(main.includes('renderAuthGate') && main.includes('jlt-auth-required'), 'auth gate wiring kept');
  assert.ok(main.includes("'sign-in'"), 'sign-in identifiers kept');
  assert.ok(!/continue with google/i.test(main), 'no Google OAuth control');
  assert.ok(!/passkey|magic link|remember me/i.test(main), 'no feature expansion in auth shell');
});

test('sign-out completes logout then lands on the public Landing', () => {
  const signOut = main.slice(main.indexOf('async function signOut()'), main.indexOf('async function signOut()') + 600);
  assert.ok(signOut.includes('supabase.auth.signOut()'), 'existing sign-out runs first');
  assert.ok(signOut.includes("'/api/auth/logout'"), 'API logout runs');
  assert.ok(signOut.includes("window.location.assign('/')"), 'canonical destination is Landing /');
  assert.ok(!signOut.includes('renderAuthGate'), 'never lands back on the Auth screen');
});

test('auth always offers a path back to the Landing', () => {
  assert.ok(main.includes("attrs: { href: '/' }"), 'wordmark/home links resolve to /');
  assert.ok(main.includes('Back to NippoTrack'), 'textual back affordance present');
  assert.ok(main.includes("aria-label': 'NippoTrack home'") || main.includes("'NippoTrack home'"), 'wordmark link is labelled');
});

test('one shared shell hosts every auth state with a stable mode transition', () => {
  assert.ok(main.includes('auth-card auth-mode'), 'card carries the mode-transition hook');
  assert.ok(css.includes('.auth-mode'), 'mode transition styled once for all views');
  assert.ok(css.includes('@keyframes auth-mode-enter'), 'restrained content transition exists');
  const authCss = css.slice(css.indexOf('.auth-screen'), css.indexOf('#global-search-results'));
  assert.ok(authCss.length > 0, 'auth styles grouped in one block');
  assert.ok(!/carousel|page-flip|slide.*viewport/i.test(authCss), 'no dramatic page effects');
});

test('labels, autocomplete, and password semantics preserved', () => {
  assert.ok(main.includes("autocomplete: 'email'"), 'email autocomplete kept');
  assert.ok(main.includes("autocomplete: view === 'sign-up' ? 'new-password' : 'current-password'"), 'password autocomplete kept');
  assert.ok(main.includes("for: 'profile-display-name'") || main.includes("attrs: { for: 'analyzer-text' }") || main.includes("text: 'Email'"), 'visible labels kept');
  assert.ok(main.includes("aria-pressed"), 'show-password exposes pressed state');
  assert.ok(main.includes("aria-label': 'Show password'") || main.includes("'Show password'"), 'show-password is labelled');
  assert.ok(main.includes("type: 'submit'"), 'real submit button kept');
  assert.ok(main.includes("'aria-live': 'polite'") || main.includes("aria-live': 'polite'"), 'error announcement kept');
});

test('pending and error states are truthful, stable, and calm', () => {
  assert.ok(main.includes('Signing in…'), 'pending label communicates work');
  assert.ok(main.includes('aria-busy'), 'pending state announced');
  assert.ok(main.includes('spinner-inline'), 'spinner treatment without geometry shift');
  assert.ok(css.includes('@keyframes auth-feedback-enter'), 'error entrance restrained');
  assert.ok(!/shake/i.test(main) && !/shake/i.test(css), 'no form shake');
});

test('visual system: editorial zones, surface, motion, mobile, dark, reduced motion', () => {
  assert.ok(css.includes('.auth-shell') && css.includes('.auth-brand-panel') && css.includes('.auth-card'), 'two-zone composition exists');
  assert.ok(css.includes('minmax(0,1.3fr) minmax(22rem,1fr)'), 'desktop ~56/44 split with a comfortable form minimum');
  assert.ok(css.includes('width:min(100%,28.75rem)'), 'form width capped at ~460px');
  assert.ok(css.includes('@keyframes auth-editorial-enter') && css.includes('@keyframes auth-card-enter'), 'perceptible restrained entrances');
  assert.ok(css.includes('.auth-brand-panel { display:none; }') || css.includes('.auth-brand-panel{display:none'), 'mobile removes the marketing column');
  assert.ok(css.includes('@media (max-width: 900px)'), 'split collapses before it cramps');
  assert.ok(css.includes(':root[data-theme="dark"] .auth-card') || css.includes(':root[data-theme="dark"] .auth-screen'), 'dark auth intentionally styled');
  assert.ok(css.includes('.auth-editorial, .auth-card, .auth-mode'), 'reduced-motion covers auth entrances');
  assert.ok(!/glassmorphism|neon/i.test(css), 'no showcase background language');
});
