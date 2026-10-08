import { apiRequest } from '../api';
import { accessToken } from '../authClient.js';
import { compressAvatarImage } from '../avatarImage.js';
import { icon } from '../icons';
import { profileStore, MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName } from '../accountProfile.js';
import { element, loadingState, pageHeader, showToast, withPendingAction } from '../ui';
import { isSafeAvatarUrl } from '../avatarPolicy.js';
import { smartGoalsSettingsSection } from '../smartGoals.js';
import { enterPlacement, placementResultFromState, placementResultNode, selfReportResultNode } from '../firstExperience.js';
import { targetLevelOptions } from '../jlptTarget.js';

const SETTINGS_SECTIONS = [
  { key: 'profile', label: 'Profile' },
  { key: 'learning', label: 'Learning' },
  { key: 'account', label: 'Account' }
];

// Single live locale subscription for the mounted settings page (aborted on
// remount). Section labels render via t() at mount; without this, switching
// language while settings is open would leave the whole page stale.
let settingsLocaleController = null;

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
  const safe = isSafeAvatarUrl(profile?.avatarUrl) ? String(profile.avatarUrl).trim() : null;
  if (safe) {
    // Photo overlays the initials mark (same 2.75rem box, round, cover);
    // the initials stay underneath so a broken URL falls back gracefully.
    const img = element('img', {
      className: 'absolute inset-0 h-full w-full object-cover',
      attrs: { src: safe, alt: '', loading: 'lazy', decoding: 'async', width: '44', height: '44', 'aria-hidden': 'true' }
    });
    img.addEventListener('error', () => { try { img.remove(); } catch { /* initials remain */ } });
    mark.appendChild(img);
  }
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

// Multipart avatar upload (apiRequest only speaks JSON, so this thin fetch
// mirrors its auth behavior: bearer token when available, same-origin
// credentials, and the shared jlt-auth-required dispatch on 401/403).
async function uploadAvatarBlob(blob) {
  const base = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || '';
  let token = null;
  try { token = await accessToken(); } catch { token = null; }
  const form = new FormData();
  form.append('avatar', blob, 'avatar.jpg');
  let response;
  try {
    response = await fetch(`${base}/api/users/me/avatar`, {
      method: 'POST',
      credentials: 'include',
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      body: form
    });
  } catch {
    throw new Error('Could not upload your photo. Please try again.');
  }
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent('jlt-auth-required', { detail: { status: response.status } }));
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || 'Could not upload your photo. Please try again.');
  const avatarUrl = typeof data?.avatarUrl === 'string' && data.avatarUrl.trim() ? data.avatarUrl : null;
  if (!avatarUrl) throw new Error('Could not upload your photo. Please try again.');
  return avatarUrl;
}

async function renderProfileSection(slot) {
  slot.replaceChildren(loadingState('Loading profile…'));
  let profile;
  let loadError = null;
  try { profile = await profileStore.load(); } catch (error) { loadError = error; profile = profileStore.get() || { displayName: null, initials: '', email: null }; }

  function refreshIdentity(nextProfile) {
    const host = slot.querySelector('.account-identity-preview');
    if (host) host.replaceChildren(identityPreview(nextProfile));
  }

  // Avatar upload controls: pick (keyboard-operable button driving a
  // visually-hidden file input) → live preview in the identity mark →
  // Upload (compress → POST → persist → refresh) / Remove (DELETE → persist
  // null → refresh). Failures toast, never silent.
  const fileInput = element('input', {
    className: 'visually-hidden',
    attrs: { id: 'profile-avatar-file', type: 'file', accept: 'image/jpeg,image/png,image/webp', tabindex: '-1', 'aria-hidden': 'true' }
  });
  const chooseButton = element('button', { className: 'button-secondary', text: 'Choose photo', attrs: { type: 'button' } });
  const uploadButton = element('button', { className: 'button-primary', text: 'Upload photo', attrs: { type: 'button', disabled: '' } });
  const removeButton = element('button', { className: 'button-secondary', text: 'Remove photo', attrs: { type: 'button' } });
  if (!isSafeAvatarUrl(profile?.avatarUrl)) removeButton.hidden = true;
  const selectionNote = element('p', { className: 'min-h-5 text-sm text-muted', attrs: { 'aria-live': 'polite' } });
  const avatarControls = element('div', { className: 'mt-4 grid max-w-2xl gap-3' }, [
    fileInput,
    element('div', { className: 'flex flex-wrap gap-2' }, [chooseButton, uploadButton, removeButton]),
    selectionNote,
    element('p', { className: 'text-xs leading-5 text-muted', text: 'JPEG, PNG, or WebP up to 10 MB. Compressed to a small photo before upload.' })
  ]);
  let pendingFile = null;
  let pendingPreviewUrl = null;
  function revokePendingPreview() {
    if (!pendingPreviewUrl) return;
    try { URL.revokeObjectURL(pendingPreviewUrl); } catch { /* revoke is best-effort */ }
    pendingPreviewUrl = null;
  }
  function clearSelection() {
    revokePendingPreview();
    pendingFile = null;
    try { fileInput.value = ''; } catch { /* reset is best-effort */ }
    uploadButton.disabled = true;
    selectionNote.textContent = '';
  }
  function paintLivePreview(url) {
    const mark = slot.querySelector('.account-identity-preview .account-initials');
    if (!mark) return;
    mark.querySelector('[data-avatar-preview]')?.remove();
    const img = element('img', {
      className: 'absolute inset-0 h-full w-full object-cover',
      attrs: { src: url, alt: '', decoding: 'async', width: '44', height: '44', 'aria-hidden': 'true', 'data-avatar-preview': 'true' }
    });
    mark.appendChild(img);
  }
  chooseButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!String(file.type || '').startsWith('image/')) {
      fileInput.value = '';
      showToast('Please choose an image file (JPEG, PNG, or WebP).', 'error');
      return;
    }
    revokePendingPreview();
    pendingFile = file;
    pendingPreviewUrl = URL.createObjectURL(file);
    paintLivePreview(pendingPreviewUrl);
    uploadButton.disabled = false;
    selectionNote.textContent = 'Photo selected — Upload to save it.';
  });
  uploadButton.addEventListener('click', () => {
    if (!pendingFile) return;
    withPendingAction(uploadButton, async () => {
      const compressed = await compressAvatarImage(pendingFile);
      try {
        const avatarUrl = await uploadAvatarBlob(compressed.blob);
        await apiRequest('/api/users/me', { method: 'PUT', body: { avatar_url: avatarUrl } });
        const refreshed = await profileStore.load({ force: true });
        clearSelection();
        fileInput.value = '';
        refreshIdentity(refreshed);
        removeButton.hidden = !isSafeAvatarUrl(refreshed?.avatarUrl);
        window.dispatchEvent(new CustomEvent('jlt-profile-change'));
        showToast('Profile photo updated.');
      } finally {
        try { URL.revokeObjectURL(compressed.previewUrl); } catch { /* revoke is best-effort */ }
      }
    }, { pendingLabel: 'Uploading…' }).catch((error) => {
      showToast(error?.message || 'Could not upload your photo. Please try again.', 'error');
      if (pendingFile) uploadButton.disabled = false;
    });
  });
  removeButton.addEventListener('click', () => {
    withPendingAction(removeButton, async () => {
      await apiRequest('/api/users/me/avatar', { method: 'DELETE' });
      await apiRequest('/api/users/me', { method: 'PUT', body: { avatar_url: null } });
      const refreshed = await profileStore.load({ force: true });
      clearSelection();
      fileInput.value = '';
      refreshIdentity(refreshed);
      removeButton.hidden = !isSafeAvatarUrl(refreshed?.avatarUrl);
      window.dispatchEvent(new CustomEvent('jlt-profile-change'));
      showToast('Profile photo removed.');
    }, { pendingLabel: 'Removing…' }).catch((error) => {
      showToast(error?.message || 'Could not remove your photo. Please try again.', 'error');
    });
  });

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
        // A picked-but-not-yet-uploaded photo survives the display-name
        // refresh so the pending Upload state is never silently discarded.
        if (pendingPreviewUrl) paintLivePreview(pendingPreviewUrl);
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
    avatarControls,
    form,
    ...(loadError ? [element('p', { className: 'mt-4 text-sm text-muted', text: 'Profile could not be loaded. You can still try saving a display name.' })] : [])
  ]));
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
    pageHeader({ title: 'Settings', description: 'Your profile, learning preferences, and account actions.' }),
    element('div', { className: 'settings-layout max-w-6xl' }, [sectionNav, panel])
  ]));

  async function renderActive() {
    if (active === 'profile') return renderProfileSection(panel);
    if (active === 'learning') return renderLearningSection(panel);
    return renderAccountSection(panel);
  }
  settingsLocaleController?.abort();
  settingsLocaleController = new AbortController();
  window.addEventListener('jlt-locale-change', () => {
    if (!container.isConnected) return;
    // Never drop a picked-but-not-uploaded avatar photo for a re-render.
    if (container.querySelector('#profile-avatar-file')?.files?.length) return;
    renderActive().catch(() => undefined);
  }, { signal: settingsLocaleController.signal });
  await renderActive();
}
