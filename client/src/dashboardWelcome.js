// v5.1-E.2 Dashboard welcome personalization — pure, DOM-free helpers.
// Presentation only: derives a restrained welcome line from the owned
// display_name plus a minimal local visit-state (local calendar days).
// No Auth changes, no streak/review/activity inference, no email parsing.

export function firstNameForDisplayName(displayName) {
  if (typeof displayName !== 'string') return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  // Split on whitespace incl. full-width space U+3000 (e.g. "山田 太郎").
  const first = trimmed.split(/[\s\u3000]+/u).filter(Boolean)[0];
  return first || null;
}

export function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function visitKeyForUser(userKey) {
  return `jlt-dashboard-visit:${userKey || 'anonymous'}`;
}

// Reads the stored visit record. Returns { firstSeenDay, lastSeenDay }
// with YYYY-MM-DD strings or nulls. Never throws (fail-open to first-visit).
export function readVisitRecord(storage, userKey) {
  try {
    const raw = storage?.getItem?.(visitKeyForUser(userKey));
    if (!raw) return { firstSeenDay: null, lastSeenDay: null };
    const parsed = JSON.parse(raw);
    const firstSeenDay = typeof parsed?.firstSeenDay === 'string' ? parsed.firstSeenDay : null;
    const lastSeenDay = typeof parsed?.lastSeenDay === 'string' ? parsed.lastSeenDay : null;
    return { firstSeenDay, lastSeenDay };
  } catch {
    return { firstSeenDay: null, lastSeenDay: null };
  }
}

// Computes the welcome model WITHOUT writing. isFirstExperience: true when
// this is the first Dashboard seen after setup (no stored firstSeenDay).
// isReturningDay: true when the last stored day differs from today
// (local-calendar-day semantics — not 24h, not streaks, not activity).
export function dashboardWelcomeModel({ displayName = null, firstSeenDay = null, lastSeenDay = null, today = null } = {}) {
  const day = today || localDayKey();
  const firstName = firstNameForDisplayName(displayName);
  const isFirstExperience = !firstSeenDay;
  const isReturningDay = !isFirstExperience && lastSeenDay !== day;
  if (isFirstExperience) {
    return {
      kind: 'welcome',
      title: firstName ? `Welcome, ${firstName}!` : 'Welcome, new user!',
      subtitle: 'Your workspace is ready.',
      isFirstExperience: true,
      isReturningDay: false
    };
  }
  if (isReturningDay) {
    return {
      kind: 'welcome-back',
      title: firstName ? `Welcome back, ${firstName}!` : 'Welcome back!',
      subtitle: "Here's where your Japanese stands today.",
      isFirstExperience: false,
      isReturningDay: true
    };
  }
  if (firstSeenDay === day) {
    return {
      kind: 'welcome',
      title: firstName ? `Welcome, ${firstName}!` : 'Welcome, new user!',
      subtitle: 'Your workspace is ready.',
      isFirstExperience: false,
      isReturningDay: false
    };
  }
  return {
    kind: 'welcome',
    title: firstName ? `Welcome, ${firstName}!` : 'Welcome back!',
    subtitle: "Here's where your Japanese stands today.",
    isFirstExperience: false,
    isReturningDay: false
  };
}

// Records today's visit (local calendar day). Returns the updated record.
// First visit stamps both days; later days advance lastSeenDay only.
export function recordDashboardVisit(storage, userKey, today = localDayKey()) {
  const current = readVisitRecord(storage, userKey);
  const next = {
    firstSeenDay: current.firstSeenDay || today,
    lastSeenDay: today
  };
  try {
    storage?.setItem?.(visitKeyForUser(userKey), JSON.stringify(next));
  } catch {
    // Storage failures never block the dashboard.
  }
  return next;
}
