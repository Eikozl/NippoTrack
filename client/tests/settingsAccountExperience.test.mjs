import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('Settings is organized into exactly Profile, Learning, Appearance, Account', () => {
  const source = readSource('src/pages/settings.js');
  for (const section of ['Profile', 'Learning', 'Appearance', 'Account']) assert.ok(source.includes(`label: '${section}'`), `${section} section is registered`);
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

test('Learning reuses target and first-experience semantics; Appearance keeps theme behavior', () => {
  const source = readSource('src/pages/settings.js');
  assert.ok(source.includes("/api/level/target"), 'existing target endpoint reused');
  assert.ok(source.includes('target_level: next'), 'target contract remains unchanged');
  assert.ok(source.includes("/api/first-experience"), 'existing starting-point state reused');
  assert.ok(source.includes('placementResultFromState') && source.includes('placementResultNode') && source.includes('selfReportResultNode'), 'starting-point renderers remain shared');
  assert.ok(source.includes('persistAppTheme') && source.includes('jlt-theme-change'), 'theme persistence/event semantics preserved');
  assert.doesNotMatch(source, /accent picker|font selector|density|animation toggle/i);
});

test('No avatar/upload or social profile surface was introduced', () => {
  const settings = readSource('src/pages/settings.js');
  const account = readSource('src/accountProfile.js');
  for (const source of [settings, account]) {
    assert.doesNotMatch(source, /avatar|upload|supabase storage|remote avatar|username|public profile|bio/i);
    assert.doesNotMatch(source, /innerHTML/);
  }
});
