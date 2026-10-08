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

test('one vocabulary entry completes vocabulary+analyzer; any datum shows the normal dashboard', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  const data = dashboard({ vocabularyCount: 1 });
  const states = new Map(firstUse.getFirstUseActionStates(data).map((action) => [action.route, action.completed]));
  assert.equal(states.get('vocabulary'), true);
  assert.equal(states.get('analyzer'), true);
  assert.equal(states.get('sessions'), false);
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({ firstExperience: onboarded(), dashboard: data }),
    false,
    'any durable datum shows the normal dashboard (checklist persists inside it)'
  );
});

test('one session alone keeps vocabulary and analyzer pending, on the normal dashboard', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  const data = dashboard({ recentSessions: [{ id_session: 1 }] });
  const states = new Map(firstUse.getFirstUseActionStates(data).map((action) => [action.route, action.completed]));
  assert.equal(states.get('sessions'), true);
  assert.equal(states.get('vocabulary'), false);
  assert.equal(states.get('analyzer'), false);
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({ firstExperience: onboarded(), dashboard: data }),
    false
  );
});

test('normal dashboard on any durable data; first-use only at zero data', async () => {
  const firstUse = await import('../../client/src/firstUseDashboard.js');
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({
      firstExperience: onboarded(),
      dashboard: dashboard({ vocabularyCount: 2, recentSessions: [{ id_session: 1 }] })
    }),
    false
  );
  // Kanji/session without vocabulary is still durable data → normal dashboard.
  assert.equal(
    firstUse.shouldShowFirstUseDashboard({
      firstExperience: onboarded(),
      dashboard: dashboard({ kanjiCount: 3, recentSessions: [{ id_session: 1 }] })
    }),
    false
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
