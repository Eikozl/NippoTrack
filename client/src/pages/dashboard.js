import { apiRequest } from '../api';
import { destroyCharts } from '../chartRegistry';
import { iconTile } from '../icons';
import { element, errorState, formatDate, formatDuration, loadingState, openDialog, pageHeader, showToast, withPendingAction } from '../ui';
import { profileStore } from '../accountProfile.js';
import { dashboardWelcomeModel, localDayKey, readVisitRecord, recordDashboardVisit } from '../dashboardWelcome.js';
import { smartGoalsWidget } from '../smartGoals.js';
import { weeklyInsightsWidget } from '../weeklyInsightsWidget.js';
import { CONFIGS } from './v2Pages';
import { applySessionContext } from '../sessionContext.js';

function metric(iconName, label, value, note, page = null, featured = false) {
  const body = [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'metric-icon' }), element('p', { className: 'metric-label text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: label })]),
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

function studyNowSection(studyNow) {
  // V5.6 Study Home: deterministic next action from existing signals.
  // Fail-open: null payload renders nothing, dashboard stays byte-identical.
  // Review actions AUTO-START: one click builds the due queue (oldest first)
  // via the existing /due + /sessions endpoints and hands it to #review —
  // the learner never touches setup. Other kinds link straight to the
  // activity itself.
  const primary = studyNow?.primary;
  if (!primary || typeof primary !== 'object') return null;
  const autoDue = primary.auto === 'due';
  const cta = autoDue
    ? element('button', {
      className: 'button-primary inline-flex min-h-11 items-center justify-center px-5 py-2.5 text-sm font-semibold',
      text: primary.cta || 'Start now',
      attrs: { type: 'button' }
    })
    : element('a', {
      className: 'button-primary inline-flex min-h-11 items-center justify-center px-5 py-2.5 text-sm font-semibold',
      text: primary.cta || 'Start',
      attrs: { href: primary.href || '#review' }
    });
  if (autoDue) cta.addEventListener('click', () => startDueSession(cta));
  return element('section', { className: 'surface study-now p-5 sm:p-6', attrs: { 'aria-label': 'Study now recommendation' } }, [
    element('div', { className: 'flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between' }, [
      element('div', { className: 'min-w-0' }, [
        element('h2', { className: 'mt-1 font-display text-lg font-semibold tracking-tight text-ink', text: primary.title || 'Keep studying' }),
        element('p', { className: 'mt-1 max-w-2xl text-sm leading-6 text-muted', text: primary.reason || '' }),
        ...(primary.estimate ? [element('p', { className: 'mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: primary.estimate })] : [])
      ]),
      element('div', { className: 'flex shrink-0 items-center gap-3' }, [cta])
    ])
  ]);
}

// One-click due session: oldest-first queue from the existing due listing,
// persisted through the existing review-sessions endpoint, handed to #review
// via sessionStorage exactly like the Immersion hand-off (per-tab, once).
// Falls back to plain navigation when anything is missing.
const STUDY_NOW_QUEUE_KEY = 'jlt-study-now-queue';
const STUDY_NOW_SESSION_MAX = 100;

function shiftDaysISO(iso, days) {
  const next = new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000);
  return Number.isNaN(next.getTime()) ? iso : next.toISOString().slice(0, 10);
}

function dueEntityType(row) {
  const raw = String(row?.item_type || row?.entityType || '').toLowerCase();
  if (raw === 'vocabulary') return 'vocabulary';
  if (raw === 'kanji') return 'kanji';
  return 'grammar';
}

async function startDueSession(button) {
  await withPendingAction(button, async () => {
    const today = localDayKey();
    const data = await apiRequest('/api/review/due');
    const seen = new Set();
    const picked = [];
    for (const row of Array.isArray(data?.items) ? data.items : []) {
      const entityType = dueEntityType(row);
      const entityId = Number(row?.entityId);
      if (!Number.isInteger(entityId) || entityId <= 0) continue;
      const key = `${entityType}:${entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({
        entityType,
        entityId,
        display: row.title ?? row.display ?? '',
        reading: row.reading ?? null,
        meaning: row.meaning ?? null,
        ...(row.last_result ? { lastResult: row.last_result } : {}),
        dueOn: String(row.due_on || '').slice(0, 10) || null
      });
      if (picked.length >= STUDY_NOW_SESSION_MAX) break;
    }
    if (!picked.length) {
      window.location.hash = '#review';
      return;
    }
    const oldest = picked.map((item) => item.dueOn).filter(Boolean).sort()[0] || today;
    const earliest = oldest < shiftDaysISO(today, -366) ? shiftDaysISO(today, -366) : oldest;
    const session = await apiRequest('/api/review/sessions', {
      method: 'POST',
      body: {
        sourceFrom: earliest <= today ? earliest : today,
        sourceTo: today,
        items: picked.map(({ entityType, entityId }) => ({ entityType, entityId }))
      }
    });
    const queueItems = applySessionContext(picked.map(({ dueOn, ...rest }) => rest), session);
    try {
      if (window.sessionStorage) {
        window.sessionStorage.setItem(STUDY_NOW_QUEUE_KEY, JSON.stringify({
          reviewSessionId: Number(session?.id),
          items: queueItems
        }));
      }
    } catch { /* storage blocked: review falls back to its banner */ }
    window.location.hash = `#review?reviewSessionId=${encodeURIComponent(session?.id)}&from=study-now`;
  }, { pendingLabel: 'Starting…' }).catch((error) => {
    showToast(error?.message || 'Unable to start the session.', 'error');
  });
}

function todayProgressSection(studyNow) {
  // V5.6 Completion Pass: "What have I actually done today?" — real daily
  // numbers only (graded reviews, logged minutes, new items). Fail-open:
  // without the payload the section renders nothing, never placeholder 0s.
  const progress = studyNow?.todayProgress;
  if (!progress || typeof progress !== 'object') return null;
  const done = Number(progress.reviewsDone || 0);
  const due = Number(progress.reviewsDue || 0);
  const minutes = Number(progress.readingMinutes || 0);
  const fresh = Number(progress.newItems || 0);
  const row = (label, value) => element('div', { className: 'flex items-baseline justify-between gap-3 py-2' }, [
    element('p', { className: 'text-sm text-muted', text: label }),
    element('p', { className: 'text-sm font-semibold tabular-nums text-ink', text: value })
  ]);
  // New-items drill-down: the count row becomes a button opening what was
  // added today, grouped by category (same created_at::date predicate as
  // the server count, so the dialog never disagrees with the row).
  const newItemsRow = fresh > 0
    ? element('button', {
      className: 'flex w-full items-baseline justify-between gap-3 py-2 text-left transition hover:opacity-80',
      attrs: { type: 'button', 'aria-label': `Show ${fresh} new items added today, grouped by category` }
    }, [
      element('p', { className: 'text-sm text-muted', text: 'New items' }),
      element('p', { className: 'text-sm font-semibold tabular-nums text-vermilion underline-offset-4 hover:underline', text: `${fresh} new item${fresh === 1 ? '' : 's'} today` })
    ])
    : null;
  if (newItemsRow) {
    newItemsRow.addEventListener('click', () => {
      const host = element('div', { className: 'grid min-w-0 gap-4 sm:col-span-2' }, [loadingState('Loading today’s additions…')]);
      openDialog({
        title: 'Added today',
        description: 'Everything that entered your collection today, by category.',
        content: [host],
        submitLabel: 'Done',
        onSubmit: async (form, close) => { close(); }
      });
      const loadNewItems = () => {
        host.replaceChildren(loadingState('Loading today’s additions…'));
        apiRequest(`/api/dashboard/study-now/new-items?today=${localDayKey()}`).then((data) => {
        const groups = [
          ['Vocabulary', Array.isArray(data?.vocabulary) ? data.vocabulary : []],
          ['Kanji', Array.isArray(data?.kanji) ? data.kanji : []],
          ['Grammar', Array.isArray(data?.grammar) ? data.grammar : []]
        ];
        const total = groups.reduce((sum, [, items]) => sum + items.length, 0);
        if (!total) {
          host.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Nothing added today yet.' }));
          return;
        }
        host.replaceChildren(...groups.filter(([, items]) => items.length).map(([label, items]) => element('div', { className: 'grid min-w-0 gap-2' }, [
          element('p', { className: 'text-xs font-semibold uppercase tracking-[0.08em] text-muted', text: `${label} (${items.length})` }),
          element('ul', { className: 'grid min-w-0 gap-1.5', attrs: { role: 'list' } }, items.map((item) => element('li', { className: 'min-w-0 rounded-xl border border-stone bg-paper px-3 py-2' }, [
            element('p', { className: 'break-words font-jp text-sm font-semibold text-ink', text: item.display, attrs: { lang: 'ja' } }),
            ...([item.reading, item.meaning].filter(Boolean).length
              ? [element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: [item.reading, item.meaning].filter(Boolean).join(' · ') })]
              : [])
          ])))
        ])));
      }).catch((error) => {
        host.replaceChildren(errorState(error, loadNewItems));
      });
      };
      loadNewItems();
    });
  }
  // Reviews line: with pending reviews show done-of-expected ("7 of 10");
  // with none pending show only what was done ("52 reviews done") — never
  // a self-referential "52 of 52". done/due are disjoint server-side.
  const reviewsLine = due > 0
    ? `${done} of ${done + due} reviews done`
    : (done > 0 ? `${done} review${done === 1 ? '' : 's'} done` : 'No reviews due');
  return element('section', { className: 'surface mt-5 p-5 sm:p-6', attrs: { 'aria-label': "Today's progress" } }, [
    element('div', { className: 'flex items-center gap-3' }, [iconTile('today', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Today’s progress' })]),
    element('div', { className: 'mt-2 divide-y divide-stone' }, [
      row('Reviews', reviewsLine),
      row('Study time', minutes > 0 ? `${formatDuration(minutes)} today` : 'Nothing logged yet'),
      ...(newItemsRow ? [newItemsRow] : [row('New items', 'Nothing added yet')])
    ])
  ]);
}

// V6.0 community pulse: unread interactions only (likes, new followers,
// comments), Study-Now-styled. Zero unread → renders nothing at all, like
// the goals preview (never an empty "0 notifications" card). Fail-open.
async function communityPulseSection() {
  let summary = null;
  try {
    summary = await apiRequest('/api/community/notifications/summary');
  } catch {
    return null;
  }
  if (!summary || Number(summary.unread || 0) <= 0) return null;
  const lines = [];
  const likeTitles = (Array.isArray(summary.likes?.posts) ? summary.likes.posts : []).map((post) => post.title).filter(Boolean);
  if (Number(summary.likes?.count || 0) > 0) {
    lines.push(`You have ${summary.likes.count} like${summary.likes.count === 1 ? '' : 's'}${likeTitles.length ? ` in the post “${likeTitles[0]}”` : ''}`);
  }
  if (Number(summary.follows?.count || 0) > 0) {
    const actors = (Array.isArray(summary.follows?.actors) ? summary.follows.actors : []).filter(Boolean);
    lines.push(`${summary.follows.count} new follower${summary.follows.count === 1 ? '' : 's'}${actors.length ? ` (${actors.join(', ')})` : ''}`);
  }
  const commentTitles = (Array.isArray(summary.comments?.posts) ? summary.comments.posts : []).map((post) => post.title).filter(Boolean);
  if (Number(summary.comments?.count || 0) > 0) {
    lines.push(`${summary.comments.count} new comment${summary.comments.count === 1 ? '' : 's'}${commentTitles.length ? ` in your post “${commentTitles[0]}”` : ''}`);
  }
  if (!lines.length) return null;
  return element('section', { className: 'surface mt-5 p-5 sm:p-6', attrs: { 'aria-label': 'Community activity' } }, [
    element('div', { className: 'flex items-center justify-between gap-3' }, [
      element('div', { className: 'flex items-center gap-3' }, [iconTile('community', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Community' })]),
      element('a', { className: 'text-sm font-semibold text-vermilion hover:underline', text: 'Open community', attrs: { href: '#community' } })
    ]),
    element('div', { className: 'mt-2 divide-y divide-stone' }, lines.map((line) => element('div', { className: 'py-2' }, [
      element('p', { className: 'text-sm leading-6 text-ink', text: line })
    ])))
  ]);
}

function continueSection(studyNow) {
  // V5.6 Completion Pass: "Continue where you left off" — genuinely
  // resumable state only (unfinished reading with position, open review
  // session with remaining cards). Nothing resumable → no section at all;
  // Study Now above already offers the next action, so no dead CTA here.
  const cont = studyNow?.continueStudying;
  if (!cont || typeof cont !== 'object') return null;
  const cards = [];
  if (cont.reading && cont.reading.id !== undefined && cont.reading.id !== null) {
    cards.push(element('a', {
      className: 'surface metric-link flex items-center justify-between gap-4 p-4',
      attrs: { href: `#reading?id=${encodeURIComponent(cont.reading.id)}`, 'aria-label': `Continue reading ${cont.reading.title || 'your text'}` }
    }, [
      element('div', { className: 'min-w-0' }, [
        element('p', { className: 'mt-1 break-words font-semibold text-ink', text: cont.reading.title || 'Untitled text' }),
        element('p', { className: 'mt-1 text-xs text-muted', text: 'Pick up where you left off' })
      ]),
      element('span', { className: 'button-secondary shrink-0 px-3 py-1.5 text-xs', text: 'Continue', attrs: { 'aria-hidden': 'true' } })
    ]));
  }
  if (cont.reviewSession && Number(cont.reviewSession.id) > 0 && Number(cont.reviewSession.remaining) > 0) {
    const remaining = Number(cont.reviewSession.remaining);
    const total = Number(cont.reviewSession.total || remaining);
    cards.push(element('a', {
      className: 'surface metric-link flex items-center justify-between gap-4 p-4',
      attrs: { href: `#review?retake=${encodeURIComponent(cont.reviewSession.id)}`, 'aria-label': `Resume review session with ${remaining} cards left` }
    }, [
      element('div', { className: 'min-w-0' }, [
        element('p', { className: 'mt-1 break-words font-semibold text-ink', text: `Unfinished review — ${remaining} of ${total} left` }),
        element('p', { className: 'mt-1 text-xs text-muted', text: 'Resume where you left off' })
      ]),
      element('span', { className: 'button-secondary shrink-0 px-3 py-1.5 text-xs', text: 'Resume', attrs: { 'aria-hidden': 'true' } })
    ]));
  }
  if (!cards.length) return null;
  return element('section', { className: 'mt-5', attrs: { 'aria-label': 'Continue studying' } }, [
    element('h2', { className: 'font-semibold text-ink', text: 'Continue where you left off' }),
    element('div', { className: 'mt-3 grid gap-4 sm:grid-cols-2' }, cards)
  ]);
}

function activityCalendar(items) {
  const minutesByDate = new Map(items.map((item) => [String(item.date).slice(0, 10), Number(item.minutes)]));
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  // Tapping a day announces its minutes in the live line below — the same
  // data the title/aria-label already carry, now reachable on touch screens.
  const dayDetail = element('p', { className: 'mt-3 text-sm text-muted', attrs: { 'aria-live': 'polite' } }, [
    element('span', { text: 'Tap a day to see its minutes.' })
  ]);
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (34 - index));
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const minutes = minutesByDate.get(value) || 0;
    const isToday = value === todayKey;
    const label = `${formatDate(value)}: ${minutes ? formatDuration(minutes) : 'no study'}${isToday ? ' (today)' : ''}`;
    const day = element('button', { className: `activity-calendar-day grid aspect-square place-items-center rounded-md text-xs font-semibold ${minutes ? 'bg-vermilion' : 'bg-paper'}${isToday ? ' is-today' : ''}`, text: date.getDate(), attrs: { type: 'button', title: `${formatDate(value)} · ${minutes ? formatDuration(minutes) : 'no study'}`, 'aria-label': label } });
    day.addEventListener('click', () => {
      dayDetail.replaceChildren(element('span', { text: label }));
    });
    return day;
  });
  return element('article', { className: 'surface activity-calendar p-5 sm:p-6' }, [element('div', { className: 'flex items-center gap-3' }, [iconTile('sessions', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Activity calendar' })]), element('p', { className: 'mt-1 text-sm text-muted', text: 'The last 35 days. Highlighted days contain at least one study session.' }), element('div', { className: 'mt-5 grid grid-cols-7 gap-2', attrs: { role: 'group', 'aria-label': 'Daily study activity, last 35 days' } }, days), dayDetail]);
}

// Review Reminder: never-reviewed or overdue items (Mastered rests), with a
// one-tap session built from the exact entity queue. Fail-open and hidden
// when empty — same study-home aesthetic as the sibling sections.
function reviewReminderSection() {
  const section = element('section', { className: 'surface mt-5 p-5 sm:p-6', attrs: { 'aria-label': 'Review reminder' } });
  section.hidden = true;
  async function load() {
    let items = [];
    try {
      const data = await apiRequest('/api/review/reminders');
      items = Array.isArray(data?.items) ? data.items : [];
    } catch {
      return;
    }
    if (!items.length) return;
    const queue = items
      .filter((item) => item && item.entityType && Number.isSafeInteger(Number(item.entityId)))
      .slice(0, 500)
      .map((item) => ({ entityType: item.entityType, entityId: Number(item.entityId) }));
    const startButton = element('button', {
      className: 'button-primary mt-4 min-h-10 px-4 py-2 text-sm',
      text: `Review these ${items.length}`,
      attrs: { type: 'button' }
    });
    startButton.addEventListener('click', () => {
      withPendingAction(startButton, async () => {
        const today = localDayKey();
        const session = await apiRequest('/api/review/sessions', {
          method: 'POST',
          body: { sourceFrom: today, sourceTo: today, items: queue }
        });
        if (!session || !session.id) throw new Error('Unable to start that session.');
        window.location.hash = `#review?retake=${Number(session.id)}`;
      }, { pendingLabel: 'Starting…' }).catch((error) => {
        showToast(error?.message || 'Unable to start that session.', 'error');
      });
    });
    const reasonLabel = (item) => (item.reason === 'never'
      ? 'Never reviewed'
      : `Overdue${item.lastResult ? ` · last ${item.lastResult}` : ''}`);
    section.replaceChildren(
      element('div', { className: 'flex items-center gap-3' }, [iconTile('review', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Review reminder' })]),
      element('p', { className: 'mt-1 text-sm text-muted', text: 'Words and patterns waiting too long — never reviewed once, or past their review date.' }),
      element('ul', { className: 'mt-4 grid gap-2', attrs: { role: 'list' } }, items.slice(0, 5).map((item) => element('li', { className: 'flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm' }, [
        element('span', { className: 'min-w-0 break-words font-jp font-semibold text-ink', text: item.display }),
        element('span', { className: 'status-pill', text: reasonLabel(item) })
      ]))),
      ...(items.length > 5 ? [element('p', { className: 'mt-2 text-xs text-muted', text: `+${items.length - 5} more in the session` })] : []),
      startButton
    );
    section.hidden = false;
  }
  void load();
  return section;
}

function recentSessions(items) {  const body = items.length ? element('div', { className: 'divide-y divide-stone' }, items.map((session) => element('div', { className: 'flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0' }, [
    element('div', {}, [element('p', { className: 'text-sm font-semibold text-ink', text: session.category }), element('p', { className: 'mt-1 text-xs text-muted', text: formatDate(session.session_date) })]),
    element('span', { className: 'status-pill', text: formatDuration(session.duration_minutes) })
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
  // Cheap pre-check mirroring shouldShowFirstUseDashboard's durable-data
  // half (see firstUseDashboard.js): true only when zero durable data, so
  // ANY datum skips the extra first-experience fetch below and falls
  // through to the normal dashboard. Malformed payloads fetch anyway; the
  // strict rule then fails open to the normal dashboard.
  if (!data || typeof data !== 'object') return false;
  const counts = ['vocabularyCount', 'kanjiCount', 'grammarCount'].some((key) => Number(data[key]) > 0);
  const sessions = Array.isArray(data.recentSessions) && data.recentSessions.length > 0;
  return !(counts || sessions);
}

function dashboardStudyHomeSkeleton() {
  // Study Home loading skeleton: shaped placeholders mirroring the real
  // render order (Study Now → Today's Progress → Continue → snapshot/goals).
  // Same .skeleton-block shimmer primitive as ui.js skeleton() (still under
  // prefers-reduced-motion via styles.css), visual blocks aria-hidden with a
  // single visually-hidden status line for AT. Matching surface/padding/margin
  // classes keep spacing identical so real content swaps in with no shift.
  const studyNow = element('section', { className: 'surface study-now p-5 sm:p-6', attrs: { 'aria-hidden': 'true' } }, [
    element('div', { className: 'flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between' }, [
      element('div', { className: 'grid min-w-0 flex-1 gap-2' }, [
        element('div', { className: 'skeleton-block h-6 w-1/3' }),
        element('div', { className: 'skeleton-block h-4 w-5/6' }),
        element('div', { className: 'skeleton-block h-4 w-2/3' }),
        element('div', { className: 'skeleton-block mt-1 h-3 w-1/4' })
      ]),
      element('div', { className: 'skeleton-block h-11 w-28 shrink-0 rounded-xl' })
    ])
  ]);
  const todayRow = () => element('div', { className: 'flex items-baseline justify-between gap-3 py-2' }, [
    element('div', { className: 'skeleton-block h-4 w-24' }),
    element('div', { className: 'skeleton-block h-4 w-32' })
  ]);
  const today = element('section', { className: 'surface mt-5 p-5 sm:p-6', attrs: { 'aria-hidden': 'true' } }, [
    element('div', { className: 'flex items-center gap-3' }, [
      element('span', { className: 'skeleton-block size-10 shrink-0 rounded-full' }),
      element('div', { className: 'skeleton-block h-5 w-36' })
    ]),
    element('div', { className: 'mt-2 divide-y divide-stone' }, [todayRow(), todayRow(), todayRow()])
  ]);
  const continueCard = () => element('div', { className: 'surface flex items-center justify-between gap-4 p-4' }, [
    element('div', { className: 'grid min-w-0 flex-1 gap-2' }, [
      element('div', { className: 'skeleton-block h-4 w-3/4' }),
      element('div', { className: 'skeleton-block h-3 w-1/2' })
    ]),
    element('div', { className: 'skeleton-block h-8 w-20 shrink-0 rounded-lg' })
  ]);
  const cont = element('section', { className: 'mt-5', attrs: { 'aria-hidden': 'true' } }, [
    element('div', { className: 'skeleton-block h-5 w-48' }),
    element('div', { className: 'mt-3 grid gap-4 sm:grid-cols-2' }, [continueCard(), continueCard()])
  ]);
  const metricCard = () => element('div', { className: 'surface metric-card p-5' }, [
    element('div', { className: 'skeleton-block h-3 w-1/2' }),
    element('div', { className: 'skeleton-block mt-3 h-8 w-1/3' }),
    element('div', { className: 'skeleton-block mt-2 h-3 w-2/3' })
  ]);
  // Six snapshot tiles fill two full rows of three on desktop
  // (sm 2 cols = three full rows, mobile single column). xl:grid-cols-4 left
  // a 4+2 split with a half-empty void row at 1280-1920px.
  const snapshot = element('div', { className: 'dashboard-metrics mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3', attrs: { 'aria-hidden': 'true' } }, [
    metricCard(), metricCard(), metricCard(), metricCard(), metricCard(), metricCard()
  ]);
  // Goals preview + community pulse share the compact card shape above; one
  // representative row covers that area without reserving full page height.
  const goals = element('section', { className: 'mt-5', attrs: { 'aria-hidden': 'true' } }, [
    element('div', { className: 'skeleton-block h-5 w-32' }),
    element('div', { className: 'mt-3 grid gap-4 sm:grid-cols-2' }, [continueCard(), continueCard()])
  ]);
  const visual = element('div', { className: 'grid', attrs: { 'aria-hidden': 'true' } }, [studyNow, today, cont, snapshot, goals]);
  return element('div', { className: 'grid gap-2', attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': 'Loading your study overview…' } }, [
    visual,
    element('p', { className: 'visually-hidden', text: 'Loading your study overview…' })
  ]);
}

export async function renderDashboard(container) {
  destroyCharts();
  const content = element('div', { className: 'dashboard-frame' });
  container.replaceChildren(element('section', {}, [pageHeader({ title: 'Dashboard', description: 'Your learning home — what to do now, and what you’ve done.' }), content]));
  content.setAttribute('aria-busy', 'true');
  content.replaceChildren(dashboardStudyHomeSkeleton());
  async function load() {
    try {
      // Phase 9 refinement: the study-level estimate lives in the header
      // control now (see levelEstimateControl); the dashboard keeps its
      // calm snapshot of activity without duplicating it.
      // Detailed charts live in Statistics (the canonical analytics page);
      // the dashboard stays a calm snapshot: metrics, recent sessions,
      // activity calendar, and quiet links outward.
      const [data, activity, goalsData, studyNow] = await Promise.all([
        // `today` anchors server windows on the browser's local date: DB
        // CURRENT_DATE is UTC and dropped evening sessions (0 minutes).
        apiRequest(`/api/dashboard?today=${localDayKey()}`),
        apiRequest(`/api/dashboard/activity?today=${localDayKey()}`),
        // One bounded request on the existing Goals endpoint; a failure
        // here skips the preview without failing the dashboard.
        apiRequest('/api/goals?active=1&limit=10').catch(() => null),
        // V5.6 Study Now: deterministic next action. Fail-open — a failure
        // skips the section without failing the dashboard.
        apiRequest(`/api/dashboard/study-now?today=${localDayKey()}`).catch(() => null)
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
            content.setAttribute('aria-busy', 'false');
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
      const pulse = await communityPulseSection();
      content.replaceChildren(
        ...(welcome ? [welcomeHeader(welcome)] : []),
        ...(studyNowSection(studyNow) ? [studyNowSection(studyNow)] : []),
        // V5.6 Completion Pass hierarchy: action → today → continue →
        // snapshot. Progress/continue render nothing when data is absent.
        ...(todayProgressSection(studyNow) ? [todayProgressSection(studyNow)] : []),
        ...(continueSection(studyNow) ? [continueSection(studyNow)] : []),
        reviewReminderSection(),
        ...(pulse ? [pulse] : []),
        // V5.6 Completion Pass: the metrics grid no longer duplicates what
        // Study Now (due reviews → action) and Today's Progress (today's
        // minutes → done) already answer. It keeps week/streaks/collection.
        element('div', { className: 'dashboard-metrics reveal-group grid gap-4 sm:grid-cols-2 xl:grid-cols-3' }, [metric('week', 'This week', formatDuration(data.minutesThisWeek), Number(data.minutesThisWeek) > 60 ? 'hours studied' : 'minutes studied'), metric('streak', 'Current streak', activity.currentStreak, 'consecutive active days'), metric('streak', 'Longest streak', activity.longestStreak, 'best run of active days'), metric('vocabulary', 'Vocabulary', data.vocabularyCount, 'saved words', 'vocabulary'), metric('kanji', 'Kanji', data.kanjiCount, 'tracked characters', 'kanji'), metric('grammar', 'Grammar', data.grammarCount, 'saved patterns', 'grammar')]),
        // Zero eligible goals: this section never renders — no empty card,
        // no placeholder, no reserved space.
        ...(previewGoals.length ? [goalsPreview(previewGoals, eligibleGoals.length > 3)] : []),
        element('div', { className: 'dashboard-panels mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]' }, [recentSessions(data.recentSessions), activityCalendar(activity.calendar)]),
        smartGoalsWidget(),
        weeklyInsightsWidget(),
        element('p', { className: 'dashboard-footnote mt-5 text-center text-sm' }, [element('a', { className: 'font-semibold text-vermilion hover:underline', text: 'View detailed analytics in Statistics', attrs: { href: '#statistics' } })])
      );
      content.setAttribute('aria-busy', 'false');
    } catch (error) { content.setAttribute('aria-busy', 'false'); content.replaceChildren(errorState(error, load)); }
  }
  await load();
}
