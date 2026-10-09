import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const modal = readFileSync(new URL('../src/authModal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const landing = readFileSync(new URL('../src/landing/landing.js', import.meta.url), 'utf8');
const hiw = readFileSync(new URL('../src/landing/howItWorks.js', import.meta.url), 'utf8');
const sections = readFileSync(new URL('../src/landing/sections.js', import.meta.url), 'utf8');

test('auth architecture frozen: same endpoints, same Supabase calls, same guards', () => {
  for (const endpoint of ['/api/auth/sign-in', '/api/auth/sign-up', '/api/auth/forgot-password', '/api/auth/logout', '/api/auth/session']) {
    assert.ok(modal.includes(`'${endpoint}'`) || main.includes(`'${endpoint}'`), `contract kept: ${endpoint}`);
  }
  assert.ok(modal.includes('supabase.auth.setSession(data.session)'), 'sign-in session establishment kept');
  assert.ok(modal.includes('supabase.auth.updateUser({ password: password.value })'), 'reset semantics kept');
  assert.ok(modal.includes('supabase.auth.signOut()'), 'sign-out invalidation kept');
  assert.ok(modal.includes("password.value !== confirm.value) throw new Error('Passwords do not match.')"), 'validation semantics kept');
  assert.ok(main.includes('renderAuthGate') && main.includes('jlt-auth-required'), 'auth gate wiring kept');
  assert.ok(modal.includes("'sign-in'"), 'sign-in identifiers kept');
  assert.ok(!/continue with google/i.test(modal), 'no Google OAuth control');
  assert.ok(!/passkey|magic link|remember me/i.test(modal), 'no feature expansion in auth shell');
});

test('landing sign-in opens the modal instead of navigating away', () => {
  assert.ok(sections.includes('data-auth-open="sign-in"'), 'sign-in triggers marked');
  assert.ok(sections.includes('data-auth-open="sign-up"'), 'sign-up triggers marked');
  for (const entry of [landing, hiw]) {
    assert.ok(entry.includes('data-auth-open'), 'public entry intercepts auth triggers');
    assert.ok(entry.includes("import('../authModal.js')"), 'modal loads on demand, never in the initial bundle');
    assert.ok(entry.includes("window.location.assign('/app')"), 'authenticated users land in the Core App');
  }
  // No-JS / import-failure fallback still reaches Auth through the legacy route.
  assert.ok(landing.includes("trigger.getAttribute('href') || '/app'"), 'fallback navigation preserved');
});

test('modal title is neutral and the legacy eyebrow is gone', () => {
  assert.ok(modal.includes("'Welcome to NippoTrack'"), 'frozen neutral title renders');
  assert.ok(!modal.includes('Welcome back'), 'no returning-user inference');
  assert.ok(!modal.includes('Welcome, new user'), 'no new-user inference');
  assert.ok(!modal.includes('JAPANESE LEARNING TRACKER'), 'legacy product label removed');
  assert.ok(modal.includes("'Sign in to continue to your Japanese workspace.'"), 'supporting copy kept');
});

test('rejected split screen is fully removed', () => {
  for (const source of [modal, main]) {
    assert.ok(!source.includes('Learn your way'), 'no editorial headline panel');
    assert.ok(!source.includes('auth-brand-panel'), 'no split canvas hooks');
    assert.ok(!source.includes('auth-shell'), 'no split shell hooks');
  }
  const authCss = css.slice(css.indexOf('.auth-modal-overlay'), css.indexOf('#global-search-results'));
  assert.ok(!authCss.includes('auth-brand-panel'), 'no split canvas styles');
});

test('create account and recovery stay inside the same modal shell', () => {
  assert.ok(modal.includes('openAuthModal'), 'single modal entry');
  assert.ok(modal.includes('showView'), 'in-modal view machine');
  const switchBlock = modal.slice(modal.indexOf('function showView'));
  assert.ok(!switchBlock.includes('location.assign') && !switchBlock.includes('location.href'), 'view switches never navigate');
  assert.ok(modal.includes("'Create your account'"), 'sign-up stays in-modal');
  assert.ok(modal.includes("'Back to sign in'"), 'return path stays in-modal');
  assert.ok(css.includes('@keyframes auth-swap-in'), 'directional content transition exists');
});

test('success check renders only after confirmed sign-in, then holds briefly', () => {
  const handler = modal.slice(modal.indexOf("view === 'sign-in'"));
  const setSessionAt = handler.indexOf('supabase.auth.setSession');
  const successAt = handler.indexOf("setSubmitState(submit, labelNode, 'success')");
  assert.ok(setSessionAt !== -1 && successAt !== -1 && setSessionAt < successAt, 'check follows confirmed success');
  assert.ok(modal.includes('AUTH_SUCCESS_HOLD_MS = 475'), 'authorized ~475ms hold');
  const failure = modal.slice(modal.indexOf('} catch (error) {'));
  assert.ok(!failure.includes('is-success'), 'failed sign-in never shows the check');
  assert.ok(failure.includes("setSubmitState(submit, labelNode, 'idle'"), 'button returns to normal on failure');
});

test('modal closes via X, Escape, and backdrop with focus return', () => {
  assert.ok(modal.includes("aria-label': 'Close authentication'") || modal.includes("'Close authentication'"), 'visible close control');
  assert.ok(modal.includes("event.key === 'Escape'"), 'Escape closes');
  assert.ok(modal.includes('event.target === overlay'), 'backdrop click closes');
  assert.ok(modal.includes('previouslyFocused?.isConnected'), 'focus returns to the Landing trigger');
  assert.ok(modal.includes("role': 'dialog'") || modal.includes("'dialog'"), 'dialog role present');
  assert.ok(modal.includes('aria-modal'), 'modal semantics present');
  assert.ok(modal.includes('inert'), 'background leaves the tab order while open');
});

test('sign-out completes logout then lands on the public Landing', () => {
  const signOut = main.slice(main.indexOf('async function signOut()'), main.indexOf('async function signOut()') + 600);
  assert.ok(signOut.includes('supabase.auth.signOut()'), 'existing sign-out runs first');
  assert.ok(signOut.includes("'/api/auth/logout'"), 'API logout runs');
  assert.ok(signOut.includes("window.location.assign('/')"), 'canonical destination is Landing /');
  assert.ok(!signOut.includes('renderAuthGate'), 'never lands back on the Auth screen');
});

test('legacy /app route reuses the same modal without diverging', () => {
  assert.ok(main.includes('openAuthModal({'), '/app gate delegates to the shared modal');
  assert.ok(main.includes('initialAuthView'), '?auth= deep links keep working');
  assert.ok(main.includes('PASSWORD_RECOVERY'), 'recovery-link entry kept');
  assert.ok(main.includes("onClose: () => window.location.assign('/')"), 'dismissed legacy gate lands on /');
});

test('session restore never flashes the login form (neutral splash first)', () => {
  const boot = main.slice(main.indexOf('async function bootstrapApp()'));
  assert.ok(boot.includes('Checking your session'), 'splash copy while verifying');
  assert.ok(boot.indexOf('Checking your session') < boot.indexOf('renderAuthGate'), 'splash renders before any gate');
  assert.ok(!boot.includes('const closeGate = renderAuthGate('), 'no instant modal on cold boot');
  assert.ok(boot.includes('openGate()'), 'gate opens only when the session check fails');
});

test('frozen focus and copy rules survive the move', () => {
  assert.ok(modal.includes("(view === 'forgot' || view === 'sign-up' ? email : password).focus()"), 'initial autofocus rule kept');
  assert.ok(modal.includes("(view === 'forgot' ? email : password).focus()"), 'error-path focus rule kept');
  assert.ok(modal.includes("'Enter the email connected to your account. We will send you a recovery link.'"), 'forgot directive copy kept');
});

test('visual system: centered modal, mobile behavior, reduced motion', () => {
  assert.ok(modal.includes("import './styles.css'"), 'modal ships its own stylesheet dependency (Landing never loads app CSS)');
  assert.ok(css.includes('.auth-modal-overlay') && css.includes('.auth-modal-card'), 'modal foundation exists');
  assert.ok(css.includes('width:min(100%,32rem)'), 'desktop card widened so register fits without inner scroll');
  assert.ok(css.includes('@media (max-width: 640px)'), 'narrow-viewport rules exist');
  assert.ok(css.includes('.auth-check') && css.includes('@keyframes auth-check-pop'), 'restrained check animation exists');
  assert.ok(css.includes('.auth-swap-out, .auth-swap-in, .auth-check'), 'reduced-motion covers modal motion');
  assert.ok(!/glassmorphism|neon/i.test(css), 'no showcase background language');
});
