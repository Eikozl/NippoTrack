// Post-onboarding checklist: per-action completeness derived from the FIXED
// dashboard contract (no visit/click tracking). Guards the regression where
// completing ONE action dismissed the whole checklist.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

function onboarded() {
  return { onboarding: { completed: true } };
}

function dashboard(overrides = {}) {
  return {
    vocabularyCount: 0,
    kanjiCount: 0,
    grammarCount: 0,
    recentSessions: [],
    ...overrides
  };
}

test('zero durable data shows the checklist with all actions pending', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({ firstExperience: onboarded(), dashboard: dashboard() }),
    true
  );
  const states = firstUse.getFirstUseActionStates(dashboard());
  assert.deepEqual(states.map((action) => action.route), ['analyzer', 'vocabulary', 'sessions']);
  assert.ok(states.every((action) => action.completed === false));
});

test('one vocabulary entry completes vocabulary+analyzer but keeps the checklist', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  const data = dashboard({ vocabularyCount: 1 });
  const states = new Map(firstUse.getFirstUseActionStates(data).map((action) => [action.route, action.completed]));
  assert.equal(states.get('vocabulary'), true);
  assert.equal(states.get('analyzer'), true);
  assert.equal(states.get('sessions'), false);
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({ firstExperience: onboarded(), dashboard: data }),
    true,
    'a single action must not dismiss the checklist'
  );
});

test('one session alone keeps vocabulary and analyzer pending', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  const data = dashboard({ recentSessions: [{ id_session: 1 }] });
  const states = new Map(firstUse.getFirstUseActionStates(data).map((action) => [action.route, action.completed]));
  assert.equal(states.get('sessions'), true);
  assert.equal(states.get('vocabulary'), false);
  assert.equal(states.get('analyzer'), false);
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({ firstExperience: onboarded(), dashboard: data }),
    true
  );
});

test('checklist hides only when vocabulary, collection, and session are all done', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({
      firstExperience: onboarded(),
      dashboard: dashboard({ vocabularyCount: 2, recentSessions: [{ id_session: 1 }] })
    }),
    false
  );
  // Kanji/session without vocabulary still leaves vocabulary pending.
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({
      firstExperience: onboarded(),
      dashboard: dashboard({ kanjiCount: 3, recentSessions: [{ id_session: 1 }] })
    }),
    true
  );
});

test('incomplete onboarding or unknown shapes fail open to the normal dashboard', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({
      firstExperience: { onboarding: { completed: false } },
      dashboard: dashboard()
    }),
    false
  );
  assert.equal(firstUse.shouldShowFirstUseDashboard({ firstExperience: onboarded(), dashboard: null }), false);
  assert.equal(firstUse.shouldShowFirstUseDashboard({ firstExperience: null, dashboard: dashboard() }), false);
  assert.deepEqual(firstUse.getFirstUseActionStates(null).filter((action) => action.completed), []);
});
