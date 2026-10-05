import { apiRequest } from '../api';
import { icon } from '../icons';
import { profileStore, MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName } from '../accountProfile.js';
import { element, loadingState, pageHeader, showToast, withPendingAction } from '../ui';
import { applyAppThemeAttributes, isAllowedAppTheme, persistAppTheme } from '../appTheme';
import { smartGoalsSettingsSection } from '../smartGoals.js';
import { enterPlacement, placementResultFromState, placementResultNode, selfReportResultNode } from '../firstExperience.js';
import { targetLevelOptions } from '../jlptTarget.js';

const SETTINGS_SECTIONS = [
  { key: 'profile', label: 'Profile' },
  { key: 'learning', label: 'Learning' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'account', label: 'Account' }
];

function rawText(tag, className, value) {
  const node = element(tag, { className });
  node.textContent = value == null ? '' : String(value);
  return node;
}

function sectionSurface(title, description, children = []) {
  const id = `settings-${title.toLowerCase().replace(/\s+/g, '-')}-title`;
  return element('section', { className: 'settings-section surface max-w-5xl p-5 sm:p-6', attrs: { 'aria-labelledby': id } }, [
    element('h2', { className: 'font-display text-xl font-semibold tracking-tight text-ink', text: title, attrs: { id } }),
    ...(description ? [element('p', { className: 'mt-2 max-w-2xl text-sm leading-6 text-muted', text: description })] : []),
    ...children
  ]);
}

function identityPreview(profile) {
  const initials = profile?.initials || '';
  const mark = element('span', { className: 'account-initials account-initials--large', attrs: { 'aria-hidden': 'true' } });
  if (initials) mark.textContent = initials;
  else mark.appendChild(icon('user', { size: 21 }));
  const copy = element('div', { className: 'min-w-0' }, [
    rawText('p', 'truncate text-sm font-semibold text-ink', profile?.displayName || 'Account'),
    rawText('p', 'truncate text-sm text-muted', profile?.email || 'Email unavailable')
  ]);
  return element('div', { className: 'flex min-w-0 items-center gap-3' }, [mark, copy]);
}

function startingPointBlock(firstExperiencePromise = null) {
  const block = sectionSurface('Japanese starting point', null, [
    element('div', { className: 'starting-point-body mt-4' }, [
      element('p', { className: 'text-sm leading-6 text-muted', text: 'Loading your starting point…' })
    ])
  ]);
  const body = block.querySelector('.starting-point-body');
  const state = firstExperiencePromise || apiRequest('/api/first-experience', { notifyAuth: false });
  Promise.resolve(state).then((firstExperience) => {
    if (!body.isConnected) return;
    const stored = placementResultFromState(firstExperience);
    if (!stored) {
      body.replaceChildren(
        element('p', { className: 'text-sm leading-6 text-muted', text: 'Answer 10 short Japanese questions to establish a starting reference.' }),
        element('p', { className: 'mt-2 text-xs leading-5 text-muted', text: 'This is a starting estimate, not an official JLPT assessment.' }),
        (() => {
          const take = element('button', { className: 'button-secondary mt-4', text: 'Take quick placement', attrs: { type: 'button' } });
          take.addEventListener('click', () => enterPlacement({ navigate: (page) => { window.location.hash = `#${page}`; } }));
          return take;
        })()
      );
      return;
    }
    if (stored.source === 'self_reported') {
      body.replaceChildren(selfReportResultNode(element, {
        estimate: stored.estimate,
        completedAt: stored.completedAt,
        titleTag: 'h3',
        titleClassName: 'font-display mt-2 text-xl font-semibold tracking-tight text-ink'
      }));
      return;
    }
    body.replaceChildren(placementResultNode(element, {
      estimate: stored.estimate,
      result: stored.result,
      completedAt: stored.completedAt,
      titleTag: 'h3',
      titleClassName: 'font-display mt-2 text-xl font-semibold tracking-tight text-ink'
    }));
  }).catch(() => {
    if (body.isConnected) body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Starting point is unavailable right now.' }));
  });
  return block;
}

async function renderProfileSection(slot) {
  slot.replaceChildren(loadingState('Loading profile…'));
  let profile;
  let loadError = null;
  try { profile = await profileStore.load(); } catch (error) { loadError = error; profile = profileStore.get() || { displayName: null, initials: '', email: null }; }

  const input = element('input', {
    className: 'field-control',
    attrs: { id: 'profile-display-name', name: 'display_name', type: 'text', maxlength: String(MAX_DISPLAY_NAME_LENGTH), autocomplete: 'name', 'aria-describedby': 'profile-display-name-error', value: profile.displayName || '' }
  });
  const saveButton = element('button', { className: 'button-primary', text: 'Save changes', attrs: { type: 'submit', disabled: '' } });
  const status = element('p', { className: 'min-h-5 text-sm text-muted', attrs: { 'aria-live': 'polite' } });
  const errorText = element('p', { className: 'min-h-5 text-sm text-red-700', attrs: { id: 'profile-display-name-error', role: 'alert' } });
  const form = element('form', { className: 'mt-6 grid max-w-2xl gap-4', attrs: { 'aria-labelledby': 'profile-form-title' } }, [
    element('h3', { className: 'sr-only', text: 'Edit profile', attrs: { id: 'profile-form-title' } }),
    element('label', { className: 'field', attrs: { for: 'profile-display-name' } }, [element('span', { text: 'Display name' }), input]),
    status,
    errorText,
    element('div', { className: 'flex justify-end' }, [saveButton])
  ]);
  let initialValue = input.value;
  function setDirty(dirty) {
    saveButton.disabled = !dirty;
    if (dirty) { status.textContent = 'Unsaved changes'; errorText.textContent = ''; input.removeAttribute('aria-invalid'); }
    else status.textContent = '';
  }
  input.addEventListener('input', () => setDirty(input.value !== initialValue));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    withPendingAction(saveButton, async () => {
      let value;
      try { value = normalizeDisplayName(input.value); } catch (error) {
        input.setAttribute('aria-invalid', 'true');
        errorText.textContent = error.message;
        status.textContent = '';
        throw error;
      }
      status.textContent = 'Saving…';
      errorText.textContent = '';
      input.removeAttribute('aria-invalid');
      try {
        const saved = await profileStore.save(value);
        input.value = saved.displayName || '';
        initialValue = input.value;
        saveButton.disabled = true;
        status.textContent = '✓ Saved';
        const preview = form.parentElement?.querySelector('.account-identity-preview');
        if (preview) preview.replaceChildren(identityPreview(saved));
      } catch (error) {
        status.textContent = '';
        errorText.textContent = error?.status === 400 ? error.message : 'Could not save your display name. Please try again.';
        input.setAttribute('aria-invalid', 'true');
        throw error;
      }
    }, { pendingLabel: 'Saving…' }).catch(() => undefined);
  });
  slot.replaceChildren(sectionSurface('Profile', 'How you appear inside NippoTrack.', [
    element('div', { className: 'account-identity-preview mt-6' }, [identityPreview(profile)]),
    form,
    publicProfileBlock(),
    ...(loadError ? [element('p', { className: 'mt-4 text-sm text-muted', text: 'Profile could not be loaded. You can still try saving a display name.' })] : [])
  ]));
}

// Community handle + visibility for Decks. Separate save from the
// display-name form; fail-open with toasts.
function publicProfileBlock() {
  const usernameInput = element('input', {
    className: 'field-control', attrs: { id: 'profile-username', name: 'username', type: 'text', maxlength: '30', autocomplete: 'username', placeholder: 'username', 'aria-describedby': 'profile-username-hint' }
  });
  const bioInput = element('textarea', {
    className: 'field-control', attrs: { id: 'profile-bio', name: 'bio', maxlength: '500', placeholder: 'A short bio (optional)' }
  });
  const publicBox = element('input', { attrs: { id: 'profile-public', name: 'is_public', type: 'checkbox' } });
  const saveButton = element('button', { className: 'button-secondary', text: 'Save public profile', attrs: { type: 'button' } });
  const status = element('p', { className: 'min-h-5 text-sm text-muted', attrs: { 'aria-live': 'polite' } });
  const block = element('div', { className: 'mt-8 grid max-w-2xl gap-4 border-t border-stone pt-6' }, [
    element('h3', { className: 'text-base font-semibold text-ink', text: 'Public profile' }),
    element('p', { className: 'text-sm text-muted', attrs: { id: 'profile-username-hint' }, text: 'Claim a username to be followable in Decks. Only what you publish is public.' }),
    element('label', { className: 'field', attrs: { for: 'profile-username' } }, [element('span', { text: 'Username (2–30, lowercase, hyphens)' }), usernameInput]),
    element('label', { className: 'field', attrs: { for: 'profile-bio' } }, [element('span', { text: 'Bio' }), bioInput]),
    element('label', { className: 'flex items-center gap-2 text-sm text-ink', attrs: { for: 'profile-public' } }, [publicBox, element('span', { text: 'Public profile' })]),
    status,
    element('div', { className: 'flex justify-end' }, [saveButton])
  ]);
  apiRequest('/api/users/me').then((saved) => {
    usernameInput.value = saved.username || '';
    bioInput.value = saved.bio || '';
    publicBox.checked = Boolean(saved.isPublic);
  }).catch(() => {});
  saveButton.addEventListener('click', () => {
    withPendingAction(saveButton, async () => {
      status.textContent = 'Saving…';
      const saved = await apiRequest('/api/users/me', {
        method: 'PUT',
        body: {
          username: String(usernameInput.value || '').trim(),
          bio: bioInput.value,
          is_public: publicBox.checked
        }
      });
      usernameInput.value = saved.username || '';
      bioInput.value = saved.bio || '';
      publicBox.checked = Boolean(saved.isPublic);
      status.textContent = saved.username ? `Public profile: ${saved.username}.` : 'Profile saved (private).';
    }, { pendingLabel: 'Saving…' }).catch((error) => {
      status.textContent = '';
      showToast(error?.message || 'Unable to save the public profile.', 'error');
    });
  });
  return block;
}

async function renderLearningSection(slot) {
  slot.replaceChildren(loadingState('Loading learning preferences…'));
  const firstExperiencePromise = apiRequest('/api/first-experience', { notifyAuth: false });
  let target = null;
  let targetError = null;
  try {
    const payload = await apiRequest('/api/level/target');
    target = typeof payload?.targetLevel === 'string' ? payload.targetLevel : null;
  } catch (error) { targetError = error; }

  const select = element('select', { className: 'field-control mt-2 max-w-56', attrs: { id: 'settings-target-jlpt-level', 'aria-label': 'Target JLPT level' } }, targetLevelOptions().map((option) => element('option', { attrs: { value: option.value, ...(option.value === (target || '') ? { selected: 'selected' } : {}) }, text: option.label })));
  const targetStatus = element('p', { className: 'mt-2 min-h-5 text-sm text-muted', attrs: { 'aria-live': 'polite' } });
  select.addEventListener('change', async () => {
    const previous = target;
    const next = select.value || null;
    select.disabled = true;
    targetStatus.textContent = 'Saving…';
    try {
      const saved = await apiRequest('/api/level/target', { method: 'PUT', body: { target_level: next } });
      target = typeof saved?.targetLevel === 'string' ? saved.targetLevel : null;
      targetStatus.textContent = '✓ Saved';
    } catch {
      select.value = previous || '';
      targetStatus.textContent = 'Could not save the target level. Please try again.';
    } finally { select.disabled = false; }
  });
  const targetChildren = [
    element('label', { className: 'field mt-5 max-w-md', attrs: { for: 'settings-target-jlpt-level' } }, [element('span', { text: 'Target JLPT level' }), element('span', { className: 'text-xs font-normal leading-5 text-muted', text: 'Your study goal — not your current level.' }), select]),
    targetStatus
  ];
  if (targetError) targetChildren.push(element('p', { className: 'text-sm text-muted', text: 'Target level is unavailable right now.' }));
  const targetSection = sectionSurface('Learning', 'Keep your study target and historical Japanese starting point together.', targetChildren);
  const placement = startingPointBlock(firstExperiencePromise.catch(() => null));
  slot.replaceChildren(element('div', { className: 'grid gap-5' }, [targetSection, smartGoalsSettingsSection(), placement]));
}

function renderAppearanceSection(slot) {
  const current = document.documentElement.dataset.theme || 'light';
  const light = element('button', { className: `theme-option ${current === 'light' ? 'button-primary' : 'button-secondary'}`, text: 'Light mode', attrs: { type: 'button', 'aria-pressed': String(current === 'light') } });
  const dark = element('button', { className: `theme-option ${current === 'dark' ? 'button-primary' : 'button-secondary'}`, text: 'Dark mode', attrs: { type: 'button', 'aria-pressed': String(current === 'dark') } });
  const setTheme = (theme) => { if (!isAllowedAppTheme(theme)) return; persistAppTheme(theme, localStorage); applyAppThemeAttributes(theme); window.dispatchEvent(new CustomEvent('jlt-theme-change', { detail: theme })); showToast(`${theme === 'dark' ? 'Dark' : 'Light'} theme selected.`); renderAppearanceSection(slot); };
  light.addEventListener('click', () => setTheme('light'));
  dark.addEventListener('click', () => setTheme('dark'));
  slot.replaceChildren(sectionSurface('Appearance', 'Choose the existing light or dark surface for NippoTrack.', [element('div', { className: 'mt-5 flex flex-wrap gap-3' }, [light, dark])]));
}

function renderAccountSection(slot) {
  const profile = profileStore.get() || { email: null };
  const exportButton = element('button', { className: 'button-secondary mt-5', text: 'Export backup', attrs: { type: 'button' } });
  exportButton.addEventListener('click', () => {
    withPendingAction(exportButton, async () => {
      const backup = await apiRequest('/api/export');
      const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `nippotrack-backup-${backup.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
      showToast('Backup exported.');
    }, { pendingLabel: 'Preparing…' }).catch((error) => showToast(error.message || 'Unable to export backup.', 'error'));
  });
  const email = rawText('p', 'mt-5 break-all text-sm text-muted', profile.email || 'Email unavailable');
  email.id = 'settings-account-email';
  slot.replaceChildren(sectionSurface('Account', 'Account identity and existing data actions.', [
    element('div', { className: 'mt-5 grid gap-1.5' }, [element('span', { className: 'text-sm font-semibold text-ink', text: 'Email' }), email]),
    exportButton
  ]));
}

export async function renderSettings(container) {
  let active = 'profile';
  const panel = element('div', { className: 'settings-panel min-w-0', attrs: { id: 'settings-panel', tabindex: '-1' } });
  const buttons = new Map();
  const sectionNav = element('nav', { className: 'settings-section-nav', attrs: { 'aria-label': 'Settings sections' } }, SETTINGS_SECTIONS.map(({ key, label }) => {
    const button = element('button', { className: `settings-section-tab ${key === active ? 'is-active' : ''}`, text: label, attrs: { type: 'button', 'aria-controls': 'settings-panel', ...(key === active ? { 'aria-current': 'page' } : {}) } });
    button.addEventListener('click', () => {
      if (active === key) return;
      active = key;
      buttons.forEach((candidate, candidateKey) => {
        candidate.classList.toggle('is-active', candidateKey === active);
        if (candidateKey === active) candidate.setAttribute('aria-current', 'page');
        else candidate.removeAttribute('aria-current');
      });
      renderActive();
      panel.focus({ preventScroll: true });
    });
    buttons.set(key, button);
    return button;
  }));
  container.replaceChildren(element('section', {}, [
    pageHeader({ eyebrow: 'Preferences', title: 'Settings', description: 'Your profile, learning preferences, appearance, and account actions.' }),
    element('div', { className: 'settings-layout max-w-6xl' }, [sectionNav, panel])
  ]));

  async function renderActive() {
    if (active === 'profile') return renderProfileSection(panel);
    if (active === 'learning') return renderLearningSection(panel);
    if (active === 'appearance') return renderAppearanceSection(panel);
    return renderAccountSection(panel);
  }
  await renderActive();
}
