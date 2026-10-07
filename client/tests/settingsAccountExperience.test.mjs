import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('Settings is organized into exactly Profile, Learning, Account', () => {
  const source = readSource('src/pages/settings.js');
  for (const section of ['Profile', 'Learning', 'Account']) assert.ok(source.includes(`label: '${section}'`), `${section} section is registered`);
  assert.ok(!source.includes(`label: 'Appearance'`), 'appearance section removed');
  assert.match(source, /SETTINGS_SECTIONS = \[/);
  assert.ok(source.includes('settings-section-nav') && source.includes('aria-current'), 'section navigation is semantic and current state is exposed');
  assert.ok(source.includes("'aria-controls': 'settings-panel'"), 'section tabs target one panel');
});

test('Profile is explicit, optional, text-only, and email remains read-only', () => {
  const source = readSource('src/pages/settings.js');
  assert.ok(source.includes("id: 'profile-display-name'"), 'display name field present');
  assert.ok(source.includes(`maxlength: String(MAX_DISPLAY_NAME_LENGTH)`), 'field is bounded');
  assert.ok(source.includes("method: 'PUT'"), 'save uses explicit PUT');
  const profileModel = readSource('src/accountProfile.js');
  assert.ok(profileModel.includes("body: { display_name: normalized }"), 'only display_name is submitted');
  assert.ok(source.includes("status.textContent = 'Unsaved changes'"), 'dirty state is visible');
  assert.ok(source.includes("status.textContent = 'Saving…'"), 'saving state is visible');
  assert.ok(source.includes("status.textContent = '✓ Saved'"), 'restrained saved state is visible');
  assert.ok(source.includes('settings-account-email'), 'email is presented as read-only text');
  assert.doesNotMatch(source, /<input[^>]+email|type:\s*'email'/i, 'email is not an editable profile field');
});

test('Learning reuses target and first-experience semantics; appearance UI is gone', () => {
  const source = readSource('src/pages/settings.js');
  assert.ok(source.includes("/api/level/target"), 'existing target endpoint reused');
  assert.ok(source.includes('target_level: next'), 'target contract remains unchanged');
  assert.ok(source.includes("/api/first-experience"), 'existing starting-point state reused');
  assert.ok(source.includes('placementResultFromState') && source.includes('placementResultNode') && source.includes('selfReportResultNode'), 'starting-point renderers remain shared');
  // Appearance removed from Settings: no nav entry, no section, no theme
  // writes here. Persisted theme (localStorage via main.js/theme-init)
  // stays as-is; no replacement switcher is invented.
  assert.ok(!source.includes("key: 'appearance'"), 'appearance nav entry removed');
  assert.ok(!source.includes('renderAppearanceSection'), 'appearance section renderer removed');
  assert.ok(!source.includes('persistAppTheme') && !source.includes('applyAppThemeAttributes') && !source.includes('isAllowedAppTheme'), 'no theme writes from settings');
  assert.ok(!source.includes('jlt-theme-change'), 'no theme event from settings');
  assert.ok(!source.includes('appearance'), 'header description drops appearance');
  assert.doesNotMatch(source, /accent picker|font selector|density|animation toggle/i);
});

test('No avatar/upload surface; public-profile editing lives only in Community', () => {
  const settings = readSource('src/pages/settings.js');
  const account = readSource('src/accountProfile.js');
  for (const source of [settings, account]) {
    assert.doesNotMatch(source, /avatar|upload|supabase storage|remote avatar/i);
    assert.doesNotMatch(source, /innerHTML/);
  }
  // The user-approved public identity (username/bio/visibility for Community)
  // moved out of settings: no block, fields, or save remain here.
  assert.equal(settings.split('Public profile').length - 1, 0, 'no public-profile block in settings');
  assert.ok(!settings.includes('publicProfileBlock'), 'block builder removed from settings');
  for (const marker of ['profile-username', 'profile-bio', 'profile-level', 'profile-target', 'profile-interests', 'profile-public', 'jlpt_level', 'target_jlpt', 'Save public profile']) {
    assert.ok(!settings.includes(marker), `settings no longer edits ${marker}`);
  }
  // The single editor now lives on the own Community profile dialog.
  const feed = readSource('src/pages/communityFeed.js');
  for (const marker of ['profile-username', 'profile-bio', 'profile-level', 'profile-target', 'profile-interests', 'profile-public', 'jlpt_level', 'target_jlpt', 'is_public']) {
    assert.ok(feed.includes(marker), `community dialog edits ${marker}`);
  }
  assert.ok(feed.includes('Edit profile'), 'own-profile entry point present');
});
