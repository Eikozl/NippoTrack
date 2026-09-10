// Canonical authentication modal — the single Auth UI for NippoTrack.
//
// Hosts: (1) the public Landing (/), opened over the page from Sign in/up
// CTAs; (2) the legacy /app fallback, opened by the auth gate when no
// session exists (protected routes, recovery links, deep links).
//
// ARCHITECTURE FREEZE: every field, endpoint, validation rule, message,
// session call, and focus rule below matches the frozen authentication
// semantics. This module only recomposes presentation around them:
// - sign-in / sign-up / forgot / reset submit flows (identical bodies)
// - confirmation + error messages (identical strings)
// - per-view autofocus rule (identical)
// - locale switching via setLocale (identical behavior)
// What changed vs the retired split screen: centered modal shell, neutral
// title, in-modal view transitions, post-success check + authorized hold.

// The modal markup reuses app components/tokens/utilities (.field-control,
// .button-primary, .auth-*, Tailwind utilities) that live in styles.css —
// which the /app bundle loads statically but the Landing never does. This
// import makes the stylesheet a dependency of this async chunk, so Vite
// loads it on demand when the modal opens over the Landing. No class
// collisions: the Landing uses only landing-*/demo-* class names.
import './styles.css';

import { element } from './ui.js';
import { icon } from './icons.js';
import { apiRequest } from './api.js';
import { authConfigured, supabase } from './authClient.js';
import { getLocale, setLocale } from './i18n.js';

// Briefly visible success hold after CONFIRMED sign-in (owner-authorized,
// 400–550ms). The Auth request itself is never delayed.
export const AUTH_SUCCESS_HOLD_MS = 475;

const VIEWS = ['sign-in', 'sign-up', 'forgot', 'reset'];
const SUBMIT_LABELS = { 'sign-in': 'Sign in', 'sign-up': 'Create your account', forgot: 'Send recovery link', reset: 'Update password' };
const PENDING_LABELS = { 'sign-in': 'Signing in…', 'sign-up': 'Creating account…', forgot: 'Sending…', reset: 'Updating…' };
const HEADINGS = { 'sign-in': 'Welcome to NippoTrack', 'sign-up': 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' };
const DESCRIPTIONS = {
  'sign-in': 'Sign in to continue to your Japanese workspace.',
  'sign-up': 'Start building a Japanese workspace around the way you already learn.',
  forgot: 'Enter the email connected to your account. We will send you a recovery link.',
  reset: 'Choose a new password to regain access to your workspace.'
};

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function linkButton(text, action) {
  const button = element('button', { className: 'underline underline-offset-4', text, attrs: { type: 'button' } });
  button.addEventListener('click', action);
  return button;
}

let currentModal = null;

export function isAuthModalOpen() {
  return currentModal !== null;
}

export function closeAuthModal() {
  currentModal?.close('dismiss');
}

export function openAuthModal({
  host = document.body,
  background = null,
  initialView = 'sign-in',
  message = '',
  messageKind = 'error',
  dismissible = true,
  trigger = null,
  onAuthenticated = null,
  onClose = null
} = {}) {
  if (!VIEWS.includes(initialView)) initialView = 'sign-in';
  // Singleton: a second open replaces the first (same-host re-renders, e.g.
  // locale change, keep exactly one modal, trap, and scroll lock).
  if (currentModal) currentModal.close('silent');
  if (!authConfigured) {
    host.textContent = 'Supabase Auth configuration is required.';
    return () => {};
  }

  let view = initialView;
  let closed = false;
  let switching = false;
  let swapTimer = 0;
  const previouslyFocused = trigger instanceof HTMLElement ? trigger
    : (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const overlay = element('div', { className: 'auth-modal-overlay', attrs: { role: 'presentation' } });
  const panel = element('section', {
    className: 'auth-card auth-modal-card',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'auth-modal-title' }
  });
  const closeButton = element('button', { className: 'icon-button auth-modal-close', attrs: { type: 'button', 'aria-label': 'Close authentication' } }, [icon('close', { size: 20 })]);
  const body = element('div', { className: 'auth-modal-body', attrs: { 'data-lenis-prevent': '' } });

  const focusable = () => [...panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];

  function teardown() {
    window.clearTimeout(swapTimer);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    if (document.body.style.overflow === 'hidden') document.body.style.overflow = '';
    try { window.__jltLenis?.start?.(); } catch { /* lenis handle is best-effort */ }
    if (background && 'inert' in background) {
      try { background.inert = false; } catch { /* inert restore is best-effort */ }
    }
    if (currentModal?.close === close) currentModal = null;
  }

  function close(reason = 'dismiss') {
    if (closed) return;
    closed = true;
    const wasDismiss = reason === 'dismiss';
    teardown();
    if (wasDismiss) {
      try { onClose?.(); } catch { /* close hooks are best-effort */ }
      if (previouslyFocused?.isConnected) requestAnimationFrame(() => previouslyFocused.focus({ preventScroll: true }));
    }
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      if (!dismissible) return;
      event.preventDefault();
      event.stopPropagation();
      close('dismiss');
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = focusable();
    if (!controls.length) return event.preventDefault();
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  if (dismissible) {
    closeButton.addEventListener('click', () => close('dismiss'));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close('dismiss');
    });
  }

  function localeControl() {
    const menu = element('div', { className: 'auth-locale-menu', attrs: { role: 'menu', hidden: '' } }, [
      ['en', 'English'], ['es', 'Spanish']
    ].map(([value, label]) => {
      const option = element('button', { className: 'auth-locale-option', text: label, attrs: { type: 'button', role: 'menuitemradio', 'aria-checked': String(getLocale() === value) } });
      option.addEventListener('click', () => setLocale(value));
      return option;
    }));
    const toggle = element('button', {
      className: 'auth-locale-toggle auth-locale-toggle--compact',
      text: getLocale() === 'es' ? 'ES' : 'EN',
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Language', title: 'Language' }
    });
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = menu.hasAttribute('hidden');
      if (open) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', String(open));
    });
    return element('div', { className: 'auth-locale-control auth-locale-control--modal' }, [toggle, menu]);
  }

  function buildFields() {
    const email = element('input', { className: 'field-control auth-input', attrs: { type: 'email', required: '', autocomplete: 'email', placeholder: 'you@example.com' } });
    const password = element('input', {
      className: 'field-control auth-input',
      attrs: { id: 'auth-modal-password', type: 'password', required: '', autocomplete: view === 'sign-up' ? 'new-password' : 'current-password', placeholder: 'Password' }
    });
    const confirm = element('input', { className: 'field-control auth-input', attrs: { type: 'password', required: '', autocomplete: 'new-password', placeholder: 'Confirm password' } });
    // Show/hide is presentation-only around the same password field: the
    // submitted payload and validation never change.
    const showToggle = element('button', { className: 'auth-show', text: 'Show', attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Show password' } });
    showToggle.addEventListener('click', () => {
      const showing = password.getAttribute('type') === 'password';
      password.setAttribute('type', showing ? 'text' : 'password');
      showToggle.textContent = showing ? 'Hide' : 'Show';
      showToggle.setAttribute('aria-pressed', String(showing));
      showToggle.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
      password.focus();
    });
    // The toggle must not live inside the <label> (interactive content would
    // corrupt the password accessible name), so label and control are
    // siblings joined by for/id.
    const passwordField = element('div', { className: 'field' }, [
      element('label', { attrs: { for: 'auth-modal-password' } }, [element('span', { text: 'Password' })]),
      element('span', { className: 'auth-password-wrap' }, [password, showToggle])
    ]);
    const fields = [];
    if (view !== 'reset') fields.push(element('label', { className: 'field' }, [element('span', { text: 'Email' }), email]));
    if (view !== 'forgot') fields.push(passwordField);
    if (view === 'sign-up' || view === 'reset') fields.push(element('label', { className: 'field' }, [element('span', { text: 'Confirm password' }), confirm]));
    return { email, password, confirm, fields };
  }

  function buildSwitcher() {
    const switcher = element('p', { className: 'auth-switcher' });
    const gap = () => document.createTextNode(' ');
    if (view === 'sign-in') {
      switcher.append(
        element('span', { text: 'New to NippoTrack?' }),
        gap(),
        linkButton('Create account', () => showView('sign-up', { direction: 'forward' }))
      );
      switcher.append(element('span', { className: 'auth-forgot-row' }, [
        linkButton('Forgot password?', () => showView('forgot', { direction: 'forward' }))
      ]));
    } else if (view === 'sign-up') {
      switcher.append(
        element('span', { text: 'Already have an account?' }),
        gap(),
        linkButton('Sign in', () => showView('sign-in', { direction: 'back' }))
      );
    } else {
      switcher.append(linkButton('Back to sign in', () => showView('sign-in', { direction: 'back' })));
    }
    return switcher;
  }

  function setSubmitState(submit, labelNode, state, labelText) {
    submit.classList.toggle('is-pending', state === 'pending');
    submit.classList.toggle('is-success', state === 'success');
    submit.disabled = state !== 'idle';
    submit.setAttribute('aria-busy', String(state === 'pending'));
    submit.querySelector('.spinner-inline, .auth-check')?.remove();
    if (state === 'pending') {
      submit.prepend(element('span', { className: 'spinner spinner-inline', attrs: { 'aria-hidden': 'true' } }));
      labelNode.textContent = labelText;
    } else if (state === 'success') {
      submit.setAttribute('aria-label', 'Signed in');
      submit.append(element('span', { className: 'auth-check', attrs: { 'aria-hidden': 'true' } }, [icon('check', { size: 22 })]));
      labelNode.textContent = '';
    } else {
      submit.removeAttribute('aria-label');
      labelNode.textContent = labelText;
    }
  }

  function renderBody(notice = null, noticeKind = 'error') {
    const { email, password, confirm, fields } = buildFields();
    const feedback = element('p', {
      className: `auth-feedback min-h-5 text-sm ${notice ? (noticeKind === 'error' ? 'text-red-700 auth-feedback--error' : 'text-ink') : 'text-muted'}`,
      text: notice || '',
      attrs: { 'aria-live': 'polite' }
    });
    const labelNode = element('span', { text: SUBMIT_LABELS[view] });
    const submit = element('button', { className: 'button-primary auth-submit', attrs: { type: 'submit' } }, [labelNode]);
    const form = element('form', { className: 'auth-form', attrs: { 'aria-label': HEADINGS[view] } }, [
      ...fields, feedback, submit
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setSubmitState(submit, labelNode, 'pending', PENDING_LABELS[view]);
      feedback.textContent = '';
      feedback.classList.remove('text-red-700', 'auth-feedback--error', 'text-ink');
      feedback.classList.add('text-muted');
      try {
        if ((view === 'sign-up' || view === 'reset') && password.value !== confirm.value) throw new Error('Passwords do not match.');
        if (view === 'sign-in') {
          const data = await apiRequest('/api/auth/sign-in', { method: 'POST', body: { email: email.value, password: password.value }, notifyAuth: false });
          const { error } = await supabase.auth.setSession(data.session);
          if (error) throw error;
          // SUCCESS CHECK RULE: the check renders ONLY here — after the
          // existing implementation confirmed sign-in. Never before.
          setSubmitState(submit, labelNode, 'success');
          await new Promise((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 60 : AUTH_SUCCESS_HOLD_MS));
          if (closed) return;
          close('success');
          try { await onAuthenticated?.(); } catch { /* post-auth handoff is best-effort */ }
          return;
        }
        if (view === 'sign-up') {
          await apiRequest('/api/auth/sign-up', { method: 'POST', body: { email: email.value, password: password.value }, notifyAuth: false });
          showView('sign-in', { notice: 'Check your email to confirm your account before signing in.', noticeKind: 'notice' });
          return;
        }
        if (view === 'forgot') {
          await apiRequest('/api/auth/forgot-password', { method: 'POST', body: { email: email.value }, notifyAuth: false });
          showView('sign-in', { notice: 'If an account exists, recovery instructions have been sent.', noticeKind: 'notice' });
          return;
        }
        const { error } = await supabase.auth.updateUser({ password: password.value });
        if (error) throw error;
        await supabase.auth.signOut();
        showView('sign-in', { notice: 'Password updated. Sign in with your new password.', noticeKind: 'notice' });
      } catch (error) {
        // Failure path: pending cleared, button restored, existing error
        // shown. The success check is never rendered here.
        feedback.textContent = error?.status === 429 ? 'Too many attempts. Please wait before trying again.' : error?.message || 'Unable to complete that request.';
        feedback.classList.remove('text-muted', 'text-ink');
        feedback.classList.add('text-red-700', 'auth-feedback--error');
        setSubmitState(submit, labelNode, 'idle', SUBMIT_LABELS[view]);
        (view === 'forgot' ? email : password).focus();
      }
    });
    body.replaceChildren(
      element('h1', { className: 'auth-title', text: HEADINGS[view], attrs: { id: 'auth-modal-title' } }),
      element('p', { className: 'auth-description', text: DESCRIPTIONS[view] }),
      form,
      buildSwitcher()
    );
    (view === 'forgot' || view === 'sign-up' ? email : password).focus();
  }

  // In-modal view transition: the shell (overlay/panel/close) stays stable;
  // only the body content swaps with a small directional slide. Forward
  // (deeper into Auth) exits left and enters from the right; back reverses.
  function showView(next, { direction = 'forward', notice = null, noticeKind = 'error' } = {}) {
    if (!VIEWS.includes(next) || switching || closed) return;
    if (next === view && !notice) return;
    view = next;
    if (prefersReducedMotion()) {
      renderBody(notice, noticeKind);
      return;
    }
    switching = true;
    body.classList.add('auth-swap-out', direction === 'back' ? 'auth-swap-out--back' : 'auth-swap-out--forward');
    window.clearTimeout(swapTimer);
    swapTimer = window.setTimeout(() => {
      if (closed) return;
      renderBody(notice, noticeKind);
      body.classList.remove('auth-swap-out', 'auth-swap-out--forward', 'auth-swap-out--back');
      body.classList.add('auth-swap-in', direction === 'back' ? 'auth-swap-in--back' : 'auth-swap-in--forward');
      window.setTimeout(() => {
        body.classList.remove('auth-swap-in', 'auth-swap-in--forward', 'auth-swap-in--back');
        switching = false;
      }, 240);
    }, 110);
  }

  panel.append(
    element('div', { className: 'auth-modal-toprow' }, [
      localeControl(),
      ...(dismissible ? [closeButton] : [])
    ]),
    body
  );
  overlay.appendChild(panel);
  host.appendChild(overlay);
  if (background && 'inert' in background) {
    try { background.inert = true; } catch { /* inert is best-effort */ }
  }
  document.body.style.overflow = 'hidden';
  try { window.__jltLenis?.stop?.(); } catch { /* lenis handle is best-effort */ }
  document.addEventListener('keydown', onKeyDown, true);
  renderBody(message || null, message ? messageKind : 'error');

  currentModal = { close, showView };
  return close;
}
