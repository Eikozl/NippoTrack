// Post-release feature block: grading sounds, difficult one-tap sessions,
// Review Reminder, calendar day minutes, fullscreen placement, owned-meaning
// badges, deck tap-to-define. Source assertions — no DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('grading sounds fire on practice success only, never on grade buttons', () => {
  const sounds = readSource('src/reviewSounds.js');
  assert.ok(sounds.includes('AudioContext'), 'Web Audio synth, zero assets');
  assert.ok(sounds.includes('jlt-review-sound'), 'persisted toggle');
  assert.ok(sounds.includes('isReviewSoundOn') && sounds.includes('setReviewSoundOn'), 'toggle API');
  assert.ok(sounds.includes("result === 'Good'") && sounds.includes("result === 'Again'"), 'success + fail voices');
  const review = readSource('src/pages/review.js');
  assert.ok(review.includes('../reviewSounds.js'), 'review page imports the synth');
  assert.ok(!review.includes('playReviewSound(result)'), 'grade buttons stay silent');
  assert.ok(!review.includes('Sounds on'), 'no sound toggle inside review');
  assert.ok(review.includes("playReviewSound('Good')"), 'success chime on correct answers');
  assert.ok(review.includes("playReviewSound('Again')"), 'low tone on misses');
});

test('sound toggle lives in Settings Accessibility, away from review', () => {
  const settings = readSource('src/pages/settings.js');
  assert.ok(settings.includes("'accessibility'"), 'accessibility section registered');
  assert.ok(settings.includes('renderAccessibilitySection'), 'section renderer');
  assert.ok(settings.includes('settings-review-sounds'), 'review sounds checkbox');
  assert.ok(settings.includes('../reviewSounds.js'), 'settings owns the toggle');
});

test('difficult section starts a real session in one tap', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('Practice these'), 'one-tap session button');
  assert.ok(source.includes('/api/review/sessions'), 'exact entity queue via the sessions endpoint');
  assert.ok(source.includes('#review?retake='), 'hands off to the review runner');
});

test('dashboard owns a fail-open Review Reminder with the same aesthetic', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('reviewReminderSection'), 'reminder section builder');
  assert.ok(source.includes('/api/review/reminders'), 'reminder feed endpoint');
  assert.ok(source.includes('Review reminder'), 'section title');
  assert.ok(source.includes('Never reviewed') && source.includes('Overdue'), 'both reason labels');
  assert.ok(source.includes('#review?retake='), 'session handoff like everywhere else');
});

test('calendar days are buttons announcing their minutes', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('Tap a day to see its minutes'), 'discovery copy');
  assert.ok(source.includes('aria-live'), 'live region announces the tapped day');
});

test('placement owns the whole screen until complete, skip or leave', () => {
  const placement = readSource('src/firstExperience.js');
  assert.ok(placement.includes('placement-fullscreen'), 'body-level fullscreen class');
  assert.ok(placement.includes('teardownFullscreen'), 'single teardown path');
  assert.ok(placement.includes("hashchange', onPlacementAway") || placement.includes('hashchange'), 'leaving via history/shortcuts releases the chrome');
  const main = readSource('src/main.js');
  assert.ok(main.includes('placement-fullscreen'), 'navigation cleans orphaned chrome');
  const css = readSource('src/styles.css');
  assert.ok(css.includes('body.placement-fullscreen #sidebar'), 'sidebar hidden');
  assert.ok(css.includes('body.placement-fullscreen #app-shell header'), 'top bars hidden');
});

test('owned meanings are badged as your definition', () => {
  const reading = readSource('src/pages/reading.js');
  assert.ok(reading.includes('Your definition'), 'owned-meaning badge in word sheets');
});

test('nameless learners meet the claim editor, not a dead end', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('openEditProfileDialog(null)'), 'My profile opens the claim editor without a username');
  assert.ok(source.includes('Claim a username to open your public profile.'), 'still-nameless saves stay instead of a broken page');
  assert.ok(source.includes('Only you will see your posts until you claim a username'), 'composer warns private-by-default authors');
});

test('placement abstention advances immediately', () => {
  const source = readSource('src/firstExperience.js');
  const block = source.slice(source.indexOf('abstainButton.addEventListener'), source.indexOf('abstainButton.addEventListener') + 600);
  assert.ok(block.includes('state.answers[question.id] = null'), 'abstention still recorded');
  assert.ok(block.includes('state.index += 1'), 'moves to the next question at once');
  assert.ok(block.includes("state.phase = 'review'"), 'last question jumps to review');
});

test('deck examples define words like reading does', () => {  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/lookup/define-sentence'), 'bounded sentence lookup');
  assert.ok(source.includes('openDefineDialog'), 'chips dialog');
  assert.ok(source.includes('openDefinitionDialog'), 'per-word definition dialog');
  assert.ok(source.includes('Sentence context'), 'the example sentence travels as context');
  assert.ok(source.includes('Practice strokes'), 'single kanji opens handwriting');
  assert.ok(source.includes('../kanjiWriting.js'), 'handwriting overlay reused');
  assert.ok(source.includes('exampleDefineRow'), 'deck items show examples with a Define entry');
  assert.ok(source.includes('Your definition'), 'owned meanings badged');
});
