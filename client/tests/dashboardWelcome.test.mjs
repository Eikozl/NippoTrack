import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dashboardWelcomeModel,
  firstNameForDisplayName,
  localDayKey,
  readVisitRecord,
  recordDashboardVisit
} from '../src/dashboardWelcome.js';

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    _map: map
  };
}

test('first-name extraction uses display_name only, never email', () => {
  assert.equal(firstNameForDisplayName('Andres Peña'), 'Andres');
  assert.equal(firstNameForDisplayName('John Michael Doe'), 'John');
  assert.equal(firstNameForDisplayName('山田 太郎'), '山田');
  assert.equal(firstNameForDisplayName('  Yuki  '), 'Yuki');
  assert.equal(firstNameForDisplayName(null), null);
  assert.equal(firstNameForDisplayName(''), null);
  assert.equal(firstNameForDisplayName(42), null);
});

test('first dashboard experience welcomes (named and unnamed)', () => {
  assert.equal(dashboardWelcomeModel({ displayName: null, today: '2026-09-09' }).title, 'Welcome, new user!');
  const named = dashboardWelcomeModel({ displayName: 'Andres Peña', today: '2026-09-09' });
  assert.equal(named.title, 'Welcome, Andres!');
  assert.equal(named.isFirstExperience, true);
  assert.equal(named.isReturningDay, false);
});

test('same-day revisit stays Welcome; next local calendar day is Welcome back', () => {
  const sameDay = dashboardWelcomeModel({
    displayName: 'Andres Peña',
    firstSeenDay: '2026-09-09',
    lastSeenDay: '2026-09-09',
    today: '2026-09-09'
  });
  assert.equal(sameDay.title, 'Welcome, Andres!');
  assert.equal(sameDay.isReturningDay, false);

  // 23:50 -> next morning 08:00 crosses the local calendar day boundary
  // even though fewer than 24 hours passed.
  const nextDay = dashboardWelcomeModel({
    displayName: 'Andres Peña',
    firstSeenDay: '2026-09-09',
    lastSeenDay: '2026-09-09',
    today: '2026-09-10'
  });
  assert.equal(nextDay.title, 'Welcome back, Andres!');
  assert.equal(nextDay.isReturningDay, true);

  const unnamed = dashboardWelcomeModel({
    displayName: null,
    firstSeenDay: '2026-09-09',
    lastSeenDay: '2026-09-09',
    today: '2026-09-10'
  });
  assert.equal(unnamed.title, 'Welcome back!');
});

test('visit recording stamps first day once, then advances last day only', () => {
  const store = storage();
  const first = recordDashboardVisit(store, 'a@example.com', '2026-09-09');
  assert.deepEqual(first, { firstSeenDay: '2026-09-09', lastSeenDay: '2026-09-09' });
  const same = recordDashboardVisit(store, 'a@example.com', '2026-09-09');
  assert.deepEqual(same, { firstSeenDay: '2026-09-09', lastSeenDay: '2026-09-09' });
  const next = recordDashboardVisit(store, 'a@example.com', '2026-09-10');
  assert.deepEqual(next, { firstSeenDay: '2026-09-09', lastSeenDay: '2026-09-10' });
  assert.deepEqual(readVisitRecord(store, 'a@example.com'), next);
});

test('storage failures fail open without throwing', () => {
  const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
  assert.deepEqual(readVisitRecord(broken, 'x'), { firstSeenDay: null, lastSeenDay: null });
  assert.deepEqual(recordDashboardVisit(broken, 'x', '2026-09-09'), { firstSeenDay: '2026-09-09', lastSeenDay: '2026-09-09' });
  assert.match(localDayKey(new Date(2026, 8, 9, 23, 50)), /2026-09-09/);
});
