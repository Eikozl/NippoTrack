import { apiRequest } from '../api';
import { destroyCharts } from '../chartRegistry';
import { iconTile } from '../icons';
import { element, errorState, formatDate, loadingState, pageHeader } from '../ui';
import { profileStore } from '../accountProfile.js';
import { dashboardWelcomeModel, localDayKey, readVisitRecord, recordDashboardVisit } from '../dashboardWelcome.js';
import { CONFIGS } from './v2Pages';

function metric(iconName, label, value, note, page = null, featured = false) {
  const body = [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'metric-icon' }), element('p', { className: 'text-xs font-semibold uppercase tracking-[0.13em] text-muted', text: label })]),
    element('p', { className: 'mt-3 font-display text-3xl font-semibold tracking-tight text-ink', text: value }),
    element('p', { className: 'mt-2 text-xs text-muted', text: note })
  ];
  const cardClass = `surface metric-card p-5${featured ? ' metric-card--featured' : ''}`;
  // Linked metrics act as quiet deep links into their pages; unlinked
  // metrics stay plain text so the snapshot keeps its visual calm.
  if (!page) return element('article', { className: cardClass }, body);
  return element('a', { className: `${cardClass} metric-link block`, attrs: { href: `#${page}`, 'aria-label': `${label}: ${value} ${note} — open page` } }, body);
}

function welcomeHeader(model) {
  return element('div', { className: 'dashboard-welcome' }, [
    element('h2', { className: 'font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl', text: model.title }),
    element('p', { className: 'mt-1 text-sm leading-6 text-muted', text: model.subtitle })
  ]);
}

function activityCalendar(items) {
  const minutesByDate = new Map(items.map((item) => [String(item.date).slice(0, 10), Number(item.minutes)]));
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (34 - index));
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const minutes = minutesByDate.get(value) || 0;
    const isToday = value === todayKey;
    return element('div', { className: `activity-calendar-day grid aspect-square place-items-center rounded-md text-xs font-semibold ${minutes ? 'bg-vermilion' : 'bg-paper'}${isToday ? ' is-today' : ''}`, text: date.getDate(), attrs: { role: 'img', title: `${formatDate(value)} · ${minutes} minutes`, 'aria-label': `${formatDate(value)}: ${minutes ? `${minutes} minutes` : 'no study'}${isToday ? ' (today)' : ''}` } });
  });
  return element('article', { className: 'surface activity-calendar p-5 sm:p-6' }, [element('div', { className: 'flex items-center gap-3' }, [iconTile('sessions', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Activity calendar' })]), element('p', { className: 'mt-1 text-sm text-muted', text: 'The last 35 days. Highlighted days contain at least one study session.' }), element('div', { className: 'mt-5 grid grid-cols-7 gap-2', attrs: { role: 'group', 'aria-label': 'Daily study activity, last 35 days' } }, days)]);
}

function recentSessions(items) {
  const body = items.length ? element('div', { className: 'divide-y divide-stone' }, items.map((session) => element('div', { className: 'flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0' }, [
    element('div', {}, [element('p', { className: 'text-sm font-semibold text-ink', text: session.category }), element('p', { className: 'mt-1 text-xs text-muted', text: formatDate(session.session_date) })]),
    element('span', { className: 'status-pill', text: `${session.duration_minutes} min` })
  ]))) : element('p', { className: 'py-10 text-center text-sm text-muted', text: 'No study sessions recorded yet.' });
  return element('article', { className: 'surface p-5 sm:p-6' }, [element('div', { className: 'flex items-center gap-3' }, [iconTile('recent', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Recent sessions' })]), element('p', { className: 'mt-1 text-sm text-muted', text: 'Your latest recorded study activity.' }), element('div', { className: 'mt-6' }, [body])]);
}

function goalsPreview(items, showAll) {
  // Preview only: title + canonical progress lines, no forms or edit
  // controls. Each card navigates to the Goals page via existing routing.
  // Count-aware grid: the rendered card count selects the column layout so
  // one goal uses the full section width instead of a narrow left column.
  // Mobile is always one column; tablet adds a second column by width;
  // desktop matches the column count to the rendered cards.
  const gridClass = items.length > 2
    ? 'mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3'
    : items.length > 1
      ? 'mt-3 grid gap-4 sm:grid-cols-2'
      : 'mt-3 grid gap-4';
  return element('section', { className: 'mt-5' }, [
    element('div', { className: 'flex items-baseline justify-between gap-3' }, [
      element('h2', { className: 'font-semibold text-ink', text: 'Active goals' }),
      ...(showAll ? [element('a', { className: 'text-sm font-semibold text-vermilion hover:underline', text: 'View all goals', attrs: { href: '#goals' } })] : [])
    ]),
    element('div', { className: gridClass }, items.map((item) => {
      const [, progressLine, detailLine] = CONFIGS.goals.card(item);
      return element('a', { className: 'surface metric-link block min-w-0 p-4', attrs: { href: '#goals', 'aria-label': `${item.title}: ${progressLine} — open goals` } }, [
        element('p', { className: 'break-words font-semibold text-ink', text: item.title }),
        element('p', { className: 'mt-1 break-words text-sm tabular-nums text-muted', text: progressLine }),
        ...(detailLine ? [element('p', { className: 'mt-1 break-words text-xs text-muted', text: detailLine })] : [])
      ]);
    }))
  ]);
}

function isEmptyDashboardSnapshot(data) {
  // v5.1-A.4 first-use pre-check (mirrors getFirstUseActionStates' durable-
  // data half): one cheap decision so a learner with a FULLY completed
  // checklist never pays for the extra first-experience fetch below.
  // Partial progress (any action incomplete) still fetches so the checklist
  // can render with per-action states.
  if (!data || typeof data !== 'object') return false;
  const hasVocabulary = Number(data.vocabularyCount) > 0;
  const hasCollection = hasVocabulary || Number(data.kanjiCount) > 0 || Number(data.grammarCount) > 0;
  const hasSession = Array.isArray(data.recentSessions) && data.recentSessions.length > 0;
  if (hasVocabulary && hasCollection && hasSession) return false;
  return true;
}

export async function renderDashboard(container) {
  destroyCharts();
  const content = element('div', { className: 'dashboard-frame' });
  container.replaceChildren(element('section', {}, [pageHeader({ eyebrow: 'Overview', title: 'Dashboard', description: 'A calm snapshot of your current Japanese study activity.' }), content]));
  content.replaceChildren(loadingState('Loading your study overview…'));
  async function load() {
    try {
      // Phase 9 refinement: the study-level estimate lives in the header
      // control now (see levelEstimateControl); the dashboard keeps its
      // calm snapshot of activity without duplicating it.
      // Detailed charts live in Statistics (the canonical analytics page);
      // the dashboard stays a calm snapshot: metrics, recent sessions,
      // activity calendar, and quiet links outward.
      const [data, activity, review, goalsData] = await Promise.all([
        apiRequest('/api/dashboard'),
        apiRequest('/api/dashboard/activity'),
        apiRequest('/api/review'),
        // One bounded request on the existing Goals endpoint; a failure
        // here skips the preview without failing the dashboard.
        apiRequest('/api/goals?active=1&limit=10').catch(() => null)
      ]);
      // v5.1-E welcome personalization (presentation only): display_name
      // first-name + local-calendar-day visit state. The cached profile
      // store is reused — no new endpoint, no migration. Fail-open: any
      // profile/storage trouble falls back to the unnamed welcome.
      let welcome = null;
      try {
        const profile = profileStore.get() || await profileStore.load().catch(() => null);
        const userKey = profile?.email || 'anonymous';
        const today = localDayKey();
        const record = readVisitRecord(window.localStorage, userKey);
        welcome = dashboardWelcomeModel({
          displayName: profile?.displayName || null,
          firstSeenDay: record.firstSeenDay,
          lastSeenDay: record.lastSeenDay,
          today
        });
        recordDashboardVisit(window.localStorage, userKey, today);
      } catch {
        welcome = dashboardWelcomeModel({ today: localDayKey() });
      }
      // v5.1-A.4 first-use state (DERIVED, no new flag): an onboarded
      // learner with zero durable data sees a calm starting state instead
      // of the normal snapshot. ANY durable data — or any fetch trouble —
      // falls through to the normal dashboard below, byte-identical.
      if (isEmptyDashboardSnapshot(data)) {
        try {
          const firstExperience = await apiRequest('/api/first-experience', { notifyAuth: false });
          const firstUse = await import('../firstUseDashboard.js');
          if (firstUse.shouldShowFirstUseDashboard({ firstExperience, dashboard: data })) {
            destroyCharts();
            window.dispatchEvent(new CustomEvent('jlt-sidebar-activity', { detail: activity }));
            firstUse.renderFirstUseDashboard(content, {
              el: element,
              navigate: (page) => { window.location.hash = `#${page}`; },
              firstExperience,
              dashboard: data
            });
            return;
          }
        } catch {
          // Fail open to the normal dashboard.
        }
      }
      destroyCharts();
      window.dispatchEvent(new CustomEvent('jlt-sidebar-activity', { detail: activity }));
      const goalItems = Array.isArray(goalsData?.items) ? goalsData.items : [];
      // Canonical active-work semantics (active and not complete) in the
      // existing Goals ordering: earliest deadline first, then newest.
      const eligibleGoals = goalItems.filter((item) => item.is_active && !item.isComplete);
      const previewGoals = eligibleGoals.slice(0, 3);
      content.replaceChildren(
        ...(welcome ? [welcomeHeader(welcome)] : []),
        element('div', { className: 'dashboard-metrics reveal-group grid gap-4 sm:grid-cols-2 xl:grid-cols-4' }, [metric('today', 'Today', data.minutesToday, 'minutes studied'), metric('week', 'This week', data.minutesThisWeek, 'minutes studied'), metric('streak', 'Current streak', activity.currentStreak, 'consecutive active days'), metric('streak', 'Longest streak', activity.longestStreak, 'best run of active days'), metric('review', 'Due reviews', review.items.length, 'items ready to recall', 'review', true), metric('vocabulary', 'Vocabulary', data.vocabularyCount, 'saved words', 'vocabulary'), metric('kanji', 'Kanji', data.kanjiCount, 'tracked characters', 'kanji'), metric('grammar', 'Grammar', data.grammarCount, 'saved patterns', 'grammar')]),
        // Zero eligible goals: this section never renders — no empty card,
        // no placeholder, no reserved space.
        ...(previewGoals.length ? [goalsPreview(previewGoals, eligibleGoals.length > 3)] : []),
        element('div', { className: 'dashboard-panels mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]' }, [recentSessions(data.recentSessions), activityCalendar(activity.calendar)]),
        element('p', { className: 'dashboard-footnote mt-5 text-center text-sm' }, [element('a', { className: 'font-semibold text-vermilion hover:underline', text: 'View detailed analytics in Statistics', attrs: { href: '#statistics' } })])
      );
    } catch (error) { content.replaceChildren(errorState(error, load)); }
  }
  await load();
}
