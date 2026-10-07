// V6.0 Social Community feed: tabs, composer, post cards, profiles,
// notifications, search, and learning actions. The legacy decks hub stays
// untouched (mounted as the Decks tab). All bodies render via textContent;
// all identity comes from the server payloads (req.user.id server-side).
import { apiRequest } from '../api';
import { icon } from '../icons';
import { speakJapanese } from '../speech.js';
import {
  element, emptyState, errorState, loadingState, openDialog, confirmDialog,
  showToast, withPendingAction, skeleton
} from '../ui';

const POST_TYPE_LABEL = {
  text: 'Post', example: 'Example', question: 'Question', progress: 'Milestone',
  share_deck: 'Deck', share_reading: 'Reading',
  share_vocab: 'Vocabulary', share_kanji: 'Kanji', share_grammar: 'Grammar'
};

const COMPOSER_TYPES = [
  { value: 'text', label: 'Text post' },
  { value: 'example', label: 'Japanese Example' },
  { value: 'question', label: 'Question' },
  { value: 'progress', label: 'Study Progress' },
  { value: 'share_deck', label: 'Share a Deck' },
  { value: 'share_reading', label: 'Share a Reading' },
  { value: 'share_vocab', label: 'Share Vocabulary' },
  { value: 'share_kanji', label: 'Share Kanji' },
  { value: 'share_grammar', label: 'Share Grammar' }
];

// Grouped discovery for the same 9 values above (payloads byte-identical —
// only the picker UX is grouped). Compact select-based (no card grid) so
// 360px layouts never overflow. Values are never renamed here.
const COMPOSER_GROUPS = [
  {
    label: 'Discuss',
    hint: 'Text posts and questions for the community.',
    types: [
      { value: 'text', label: 'Text post' },
      { value: 'question', label: 'Question' }
    ]
  },
  {
    label: 'Japanese',
    hint: 'Share a sentence you found or wrote.',
    types: [
      { value: 'example', label: 'Japanese Example' }
    ]
  },
  {
    label: 'Progress',
    hint: 'Milestones with an optional verified snapshot.',
    types: [
      { value: 'progress', label: 'Study Progress' }
    ]
  },
  {
    label: 'Learning material',
    hint: 'Share decks, readings, and saved items.',
    types: [
      { value: 'share_deck', label: 'Share a Deck' },
      { value: 'share_reading', label: 'Share a Reading' },
      { value: 'share_vocab', label: 'Share Vocabulary' },
      { value: 'share_kanji', label: 'Share Kanji' },
      { value: 'share_grammar', label: 'Share Grammar' }
    ]
  }
];

function composerGroupFor(value) {
  return COMPOSER_GROUPS.find((group) => group.types.some((type) => type.value === value)) || null;
}

function timeAgo(iso) {
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return 'now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function initialsFor(display, username) {
  const source = String(display || username || '?').trim();
  const letters = source.replace(/^@/, '').split(/[\s_-]+/).map((part) => part[0]).filter(Boolean);
  return (letters.slice(0, 2).join('') || '?').toUpperCase();
}

function isSafeAvatarUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  // Backend avatar_url values are https storage URLs (or relative paths).
  // Never render javascript:/data-non-image schemes into <img src>.
  return /^(https?:\/\/|\/|data:image\/)/i.test(trimmed);
}

function avatarUrlFor(source) {
  if (!source || typeof source !== 'object') return null;
  const candidate = source.authorAvatar || source.avatarUrl || source.actorAvatar || null;
  if (!candidate) return null;
  const trimmed = String(candidate).trim();
  return isSafeAvatarUrl(trimmed) ? trimmed : null;
}

function avatarFace(display, username, avatarUrl, sizeClass = 'size-10 text-sm') {
  const name = String(display || username || 'Someone').trim() || 'Someone';
  const initials = element('span', {
    className: 'grid place-items-center',
    text: initialsFor(display, username),
    attrs: { 'aria-hidden': 'true' }
  });
  const face = element('span', {
    className: `relative grid ${sizeClass} shrink-0 place-items-center overflow-hidden rounded-full bg-ink font-display font-semibold text-paper`
  });
  const safe = isSafeAvatarUrl(avatarUrl) ? String(avatarUrl).trim() : null;
  if (!safe) {
    face.setAttribute('aria-hidden', 'true');
    face.textContent = initialsFor(display, username);
    return face;
  }
  face.appendChild(initials);
  const img = element('img', {
    className: 'absolute inset-0 h-full w-full object-cover',
    attrs: { src: safe, alt: name, loading: 'lazy' }
  });
  // Fallback: hiding the img reveals the initials node underneath.
  img.addEventListener('error', () => { try { img.remove(); } catch { /* noop */ } });
  face.appendChild(img);
  return face;
}

function avatarNode(post, onProfile) {
  const display = post?.authorDisplay ?? post?.displayName ?? null;
  const username = post?.authorUsername ?? post?.username ?? null;
  const avatarUrl = avatarUrlFor(post);
  const face = avatarFace(display, username, avatarUrl, 'size-10 text-sm');
  // Usernames AND avatars open profiles — discoverability must not depend
  // on hitting the small handle text.
  if (username && typeof onProfile === 'function') {
    const button = element('button', {
      className: 'shrink-0 rounded-full',
      attrs: { type: 'button', 'aria-label': `Open profile of ${username}` }
    });
    button.addEventListener('click', (event) => { event.stopPropagation(); onProfile(username); });
    button.appendChild(face);
    return button;
  }
  return face;
}

function authorLine(post, onProfile) {
  const name = element('button', {
    className: 'truncate text-left text-sm font-semibold text-ink hover:underline',
    text: post.authorDisplay || post.authorUsername || 'Someone',
    attrs: { type: 'button', 'aria-label': `Open profile of ${post.authorUsername || 'user'}` }
  });
  name.addEventListener('click', (event) => { event.stopPropagation(); onProfile(post.authorUsername); });
  const meta = element('p', {
    className: 'truncate text-xs text-muted',
    text: `@${post.authorUsername || 'user'}${timeAgo(post.createdAt) ? ` · ${timeAgo(post.createdAt)}` : ''}`
  });
  return element('div', { className: 'min-w-0' }, [name, meta]);
}

function typePill(postType) {
  return element('span', { className: 'status-pill text-xs', text: POST_TYPE_LABEL[postType] || postType });
}

// Phase 5-frontend honesty gates (same tight rule as review.js
// isUsableMeaning): fragments, links, or symbol-only strings are never
// quizzable, so they must never be saved from shared posts either.
function isUsableMeaning(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/[-–—―]$/.test(text) || /^[-–—―]/.test(text)) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  if (/[\r\n]/.test(text)) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  return true;
}

// Same single-Han check as the Decks hub (community.js:91): kanji saves
// require exactly one Han character, never a word or multi-char string.
const SINGLE_HAN = /^\p{Script=Han}$/u;

function speechPieces() {
  const hasWindow = typeof window !== 'undefined';
  return {
    synthesis: hasWindow ? window.speechSynthesis : null,
    Utterance: hasWindow ? window.SpeechSynthesisUtterance : null
  };
}

// Single-utterance TTS reusing the shared speakJapanese infrastructure
// (same pattern as the Decks hub playQueue single-item path). No furigana
// or analysis is fabricated — the given text plays as-is.
// Rapid-press cooldown: overlapping presses still speak (last wins via the
// shared cancel inside speakJapanese); only duplicate error toasts are
// suppressed silently. Genuine no-voice verdicts still surface once.
let lastCommunityPlayAt = 0;
const COMMUNITY_PLAY_COOLDOWN_MS = 600;
function playJapaneseText(text) {
  const say = String(text || '').trim();
  if (!say) { showToast('Nothing to play.', 'error'); return; }
  let isRapid = false;
  try {
    const now = Date.now();
    isRapid = Boolean(lastCommunityPlayAt) && (now - lastCommunityPlayAt < COMMUNITY_PLAY_COOLDOWN_MS);
    lastCommunityPlayAt = now;
  } catch { /* cooldown tracking is best-effort */ }
  const verdict = speakJapanese(say, { ...speechPieces() });
  if (!verdict.ok) {
    if (isRapid) return;
    showToast(verdict.message || 'Audio playback is unavailable.', 'error');
  }
}

// Verified progress snapshot block (additive `stats`, null when absent).
// Presents backend numbers only — never claims live data.
function statsBlock(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const rows = [
    (stats.streakDays !== undefined && stats.streakDays !== null) ? `🔥 ${Number(stats.streakDays)}-day streak` : null,
    (stats.vocabCount !== undefined && stats.vocabCount !== null) ? `📚 ${Number(stats.vocabCount)} vocab` : null,
    (stats.kanjiCount !== undefined && stats.kanjiCount !== null) ? `字 ${Number(stats.kanjiCount)} kanji` : null,
    (stats.grammarCount !== undefined && stats.grammarCount !== null) ? `📝 ${Number(stats.grammarCount)} grammar` : null,
    (stats.studiedMinutesMonth !== undefined && stats.studiedMinutesMonth !== null) ? `⏱ ${Number(stats.studiedMinutesMonth)} min (last 30 days)` : null,
    (stats.reviewsDue !== undefined && stats.reviewsDue !== null) ? `📥 ${Number(stats.reviewsDue)} reviews due` : null,
    (stats.readingsFinished !== undefined && stats.readingsFinished !== null) ? `📖 ${Number(stats.readingsFinished)} readings finished` : null
  ].filter(Boolean);
  if (!rows.length) return null;
  const asOf = stats.asOf ? `verified snapshot · ${stats.asOf}` : 'verified snapshot';
  return element('div', { className: 'mt-3 rounded-xl border border-stone bg-paper p-3', attrs: { 'aria-label': 'Verified study snapshot' } }, [
    element('p', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: 'Study snapshot' }),
    element('ul', { className: 'mt-2 grid gap-1 text-sm text-ink/90', attrs: { role: 'list' } }, rows.map((line) => element('li', { className: 'tabular-nums', text: line }))),
    element('p', { className: 'mt-2 text-xs text-muted', text: asOf })
  ]);
}

function entityCreateEndpoint(entityType) {
  return entityType === 'vocabulary' ? '/api/vocabulary' : entityType === 'kanji' ? '/api/kanji' : '/api/grammar';
}

// Deck snapshots store raw columns (word / character_kanji /
// grammar_point), never a generic display field — mirror the server's
// displayOf() so shared decks show han characters, not "Item N".
function deckItemDisplay(kind, entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (kind === 'kanji') return entry.character_kanji || entry.display || null;
  if (kind === 'grammar') return entry.grammar_point || entry.display || null;
  return entry.word || entry.display || entry.title || null;
}

function entityCreateBody(entityType, snapshot) {
  // Honesty gate: no usable dictionary meaning → null (callers render a
  // disabled Save with "No dictionary meaning available"). Never invents a
  // gloss — fake meanings must not enter the library/review queue.
  const meaning = String(snapshot?.meaning || '').trim();
  if (!isUsableMeaning(meaning)) return null;
  if (!snapshot?.display) return null;
  if (entityType === 'vocabulary') {
    return { word: snapshot.display, ...(snapshot.reading ? { reading: snapshot.reading } : {}), meaning };
  }
  if (entityType === 'kanji') {
    return { character_kanji: snapshot.display, meaning };
  }
  return { grammar_point: snapshot.display, meaning };
}

export async function mountSocialFeed({ tabs, body, renderDecksHub }) {
  const state = {
    tab: 'feed',
    pages: { feed: 1, following: 1, discover: 1 },
    profile: null,
    searchQuery: '',
    searchType: 'all'
  };

  // BATCH 1 (v6.1) — Instagram-style bookmark saves: every Save affordance on
  // shared Community content is an icon-only button using the lucide bookmark
  // glyph (icons.js `bookmark`, saved state `bookmarkSaved` = BookMarked).
  // Confirm-then-save, honesty gates, and aria-labels are unchanged — only
  // presentation moved from text buttons to icons. Icon-only targets keep
  // min-h-11/min-w-11 (44px), real <button> keyboard reachability, and the
  // global + .icon-button focus-visible ring. Saved = filled-feel BookMarked
  // (fill-current) + disabled + "Already saved" tooltip.
  const BOOKMARK_BUTTON_CLASS = 'icon-button min-h-11 min-w-11 shrink-0';
  const BOOKMARK_ICON_SIZE = 20;
  function bookmarkSaveButton({ ariaLabel, title, disabled = false, saved = false }) {
    const glyph = saved ? 'bookmarkSaved' : 'bookmark';
    const button = element('button', {
      className: `${BOOKMARK_BUTTON_CLASS}${disabled || saved ? ' opacity-60' : ''}`,
      attrs: {
        type: 'button',
        ...((disabled || saved) ? { disabled: '', ...(title ? { title } : {}), 'aria-label': ariaLabel } : { 'aria-label': ariaLabel, ...(title ? { title } : {}) })
      }
    }, [icon(glyph, { size: BOOKMARK_ICON_SIZE, ...(saved ? { className: 'fill-current' } : {}) })]);
    // Stop card/dialog click-through on every save affordance (enabled presses
    // add their own confirm listener second — same-element listeners both run).
    button.addEventListener('click', (event) => event.stopPropagation());
    return button;
  }

  // BATCH 2(a) (v6.1) — Minimal text actions: Reply/Report are borderless,
  // background-less plain text (muted, hover underline/semibold). Edit/Delete
  // share the old bordered style but stay untouched per spec (reported below).
  // Real <button>s keep aria-labels, keyboard reachability, and the pending
  // flows of their composers/dialogs.
  const COMMENT_TEXT_ACTION_CLASS = 'min-h-9 rounded px-1 text-xs font-medium text-muted transition hover:text-ink hover:underline focus-visible:underline';
  function commentTextAction({ text, ariaLabel, onPress }) {
    const button = element('button', { className: COMMENT_TEXT_ACTION_CLASS, text, attrs: { type: 'button', 'aria-label': ariaLabel } });
    if (typeof onPress === 'function') button.addEventListener('click', onPress);
    return button;
  }

  // Bottom floating glass nav: the EXISTING `tabs` node is restyled in place —
  // the old top tab-buttons row (Feed/Following/Discover/Decks plus the
  // trailing bell) is gone, never duplicated. Tab logic (showTab / state.tab /
  // profile interplay / setTabPressed) is unchanged; only presentation +
  // placement moved. The three section entries keep role=tab + aria-selected;
  // Share (+) is an action button co-located in the same pill for thumb reach
  // (same toolbar pattern as the app header actions). The bell lives ONLY in
  // the … overflow menu — no standalone bell in the pill, no duplicate.
  // Desktop centering: the pill is viewport-fixed, but on lg+ the app shell
  // shows a 17rem sticky sidebar (index.html lg:grid-cols-[17rem_1fr]), so
  // viewport centering would sit half-a-sidebar left of the content column.
  // lg:left shifts the anchor by half the sidebar (8.5rem) so -translate-x-1/2
  // centers the pill within the MAIN CONTENT column. Below lg there is no
  // sidebar (off-canvas drawer), so the base left-1/2 viewport centering stays.
  tabs.className = 'community-bottom-nav fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center justify-between gap-1 rounded-full border border-stone/60 bg-paper/80 px-2 py-2 shadow-lg backdrop-blur-md lg:left-[calc(50%+8.5rem)]';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Community sections');
  // Safe-area: the pill floats above the home indicator, never under it.
  tabs.style.paddingBottom = 'max(0.5rem, env(safe-area-inset-bottom))';
  // Reserve room so the floating pill never covers the last posts or pager.
  body.style.paddingBottom = '6.5rem';

  const tabDefs = [
    { key: 'feed', label: 'Feed', iconName: 'home' },
    { key: 'following', label: 'Following', iconName: 'users' },
    { key: 'discover', label: 'Discover', iconName: 'search' }
  ];
  const tabButtons = new Map();
  // Icon-only buttons: compact 44px touch targets (5 × 44px + gaps fits
  // 360px with no page h-scroll). Monochrome like the rest of the set —
  // active state comes from .is-active (see styles.css), never color alone
  // without the pill highlight.
  const navButtonClass = 'relative grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-muted transition hover:text-ink';
  for (const def of tabDefs) {
    const button = element('button', {
      className: navButtonClass,
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false', 'aria-label': def.label }
    }, [icon(def.iconName, { size: 22 })]);
    button.addEventListener('click', () => showTab(def.key));
    tabButtons.set(def.key, button);
    tabs.appendChild(button);
  }

  // Share (+) is the SOLE composer entry: it opens the full composer inside
  // an openDialog (same 9 types, grouped picker, conditional fields,
  // byte-identical payloads). Escape cancels and discards the draft
  // (documented in the dialog description). No inline composer remains in
  // the feed body.
  const share = element('button', {
    className: navButtonClass,
    attrs: { type: 'button', 'aria-label': 'Share something — open the composer' }
  }, [icon('plus', { size: 22 })]);
  share.addEventListener('click', () => {
    openComposerDialog(async () => {
      if (state.profile || state.tab !== 'feed') await showTab('feed');
      else renderFeedRoot();
    });
  });
  tabs.appendChild(share);

  // Overflow menu (three-dots): profiles were reachable only from
  // publications, so the "…" entry is now a small popup menu instead of a
  // straight jump to the Decks hub. Same menu pattern as the post actions
  // above (role=menu/menuitem, Esc/outside-click close, focus return, real
  // buttons). The bell lives ONLY here — no standalone bell in the pill, so
  // the pill holds 5 targets (Home/Users/Search/+/…). The legacy decks hub
  // still mounts untouched via renderDecksHub; only its entry point moved
  // behind the Decks item.
  const decksDef = { key: 'decks', label: 'Decks', iconName: 'dots' };
  const overflowWrap = element('div', { className: 'relative shrink-0' });
  const overflowButton = element('button', {
    className: navButtonClass,
    attrs: { type: 'button', 'aria-label': 'More options', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }
  }, [icon(decksDef.iconName, { size: 22 })]);
  // Unread signal lives ONLY on this toggle (no standalone bell): the small
  // vermilion count badge it carries preserves the signal (information, kept).
  const overflowBadge = element('span', {
    className: 'absolute -right-0.5 -top-0.5 hidden min-w-5 place-items-center rounded-full bg-vermilion px-1 text-[10px] font-bold text-paper',
    text: '0',
    attrs: { 'aria-hidden': 'true' }
  });
  overflowBadge.style.display = 'none';
  overflowButton.appendChild(overflowBadge);
  // Opens upward from the floating pill (never under the home indicator);
  // right-aligned to the toggle with a viewport-width cap so the menu never
  // overflows at 360px.
  const overflowMenu = element('div', {
    className: 'absolute bottom-full right-0 z-50 mb-2 hidden w-52 max-w-[calc(100vw-2rem)] rounded-2xl border border-stone/60 bg-paper p-1.5 shadow-lg',
    attrs: { role: 'menu', 'aria-label': 'More community options' }
  });
  const closeOverflow = (refocus = false) => {
    if (overflowMenu.classList.contains('hidden')) return;
    overflowMenu.classList.add('hidden');
    overflowButton.setAttribute('aria-expanded', 'false');
    if (refocus) { try { overflowButton.focus(); } catch { /* focus is best-effort */ } }
  };
  const openOverflow = () => {
    overflowMenu.classList.remove('hidden');
    overflowButton.setAttribute('aria-expanded', 'true');
    try {
      overflowMenu.querySelector('button')?.focus({ preventScroll: true });
    } catch { /* focus is best-effort */ }
  };
  overflowButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (overflowMenu.classList.contains('hidden')) openOverflow();
    else closeOverflow(false);
  });
  overflowButton.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeOverflow(true); }
  });
  overflowMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeOverflow(true); }
  });
  document.addEventListener('click', (event) => {
    if (overflowWrap.contains(event.target)) return;
    closeOverflow(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overflowMenu.classList.contains('hidden')) closeOverflow(true);
  });
  const addOverflowItem = (label, itemIconName, handler) => {
    const item = element('button', {
      className: 'flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-ink transition hover:bg-paper',
      attrs: { type: 'button', role: 'menuitem' }
    }, [icon(itemIconName, { size: 18 }), element('span', { text: label })]);
    item.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeOverflow(true);
      await handler();
    });
    overflowMenu.appendChild(item);
    return item;
  };
  addOverflowItem(decksDef.label, 'book', async () => { await showTab(decksDef.key); });
  addOverflowItem('My profile', 'user', async () => {
    // Own profile: the viewer username comes from the existing own-profile
    // endpoint (GET /api/users/me, same one Settings + the composer use),
    // then reuses the standard openProfile/renderProfile path — so the
    // followers/following lists on the own profile lead onward to any other
    // profile. Unclaimed usernames stay in Community with guidance instead
    // of a dead navigation.
    try {
      const me = await apiRequest('/api/users/me');
      const ownUsername = me?.username || me?.user?.username || null;
      if (!ownUsername) {
        showToast('Claim a username to open your profile.', 'error');
        return;
      }
      openProfile(ownUsername);
    } catch (error) {
      showToast(error?.message || 'Unable to open your profile.', 'error');
    }
  });
  addOverflowItem('Notifications', 'bell', async () => { await openNotifications(); });
  overflowWrap.append(overflowButton, overflowMenu);
  tabs.appendChild(overflowWrap);
  // Phase 7-frontend trimming: cheap badge — GET unread-count (single indexed
  // COUNT) for mount + after-inbox-close, never list?limit=1. Inbox
  // open/mark-read/mark-all flows below are unchanged. The badge lives on the
  // … toggle (bell is menu-only), so the label reads "More options, N unread
  // notifications" when unread > 0, plain "More options" otherwise.
  async function refreshOverflowBadge() {
    try {
      const data = await apiRequest('/api/community/notifications/unread-count');
      const unread = Number(data?.unread || 0);
      overflowBadge.textContent = unread > 99 ? '99+' : String(unread);
      overflowBadge.style.display = unread > 0 ? 'grid' : 'none';
      overflowButton.setAttribute('aria-label', unread > 0 ? `More options, ${unread} unread notifications` : 'More options');
    } catch {
      overflowBadge.style.display = 'none';
      overflowButton.setAttribute('aria-label', 'More options');
    }
  }

  function setTabPressed() {
    for (const [key, button] of tabButtons) {
      const active = key === state.tab && !state.profile;
      button.setAttribute('aria-selected', String(active));
      button.classList.toggle('is-active', active);
    }
    // The overflow toggle is an action button (not a tab), so it carries no
    // aria-selected — but it keeps the same .is-active pill highlight while
    // the Decks destination it opens is current.
    overflowButton.classList.toggle('is-active', state.tab === 'decks' && !state.profile);
  }

  async function showTab(tab) {
    state.tab = tab;
    state.profile = null;
    setTabPressed();
    if (tab === 'decks') {
      body.replaceChildren(loadingState('Loading decks…'));
      try {
        await renderDecksHub(body);
      } catch (error) {
        body.replaceChildren(errorState(error, () => showTab('decks')));
      }
      return;
    }
    renderFeedRoot();
  }

  function openProfile(username) {
    if (!username) return;
    state.profile = username;
    setTabPressed();
    renderProfile(username);
  }

  function backToFeed() {
    state.profile = null;
    setTabPressed();
    renderFeedRoot();
  }

  // ---- shared post card
  // Phase 7-frontend trimming: optimistic like costs 1 request (the mutation).
  // Local count delta + painted state are the source of truth until the next
  // natural feed/discover/search load — no onRefresh → load(true) full page-1
  // refetch after like success. Paint runs AFTER withPendingAction settles so
  // it survives the pending-state snapshot restore; on failure revert + toast.
  // Menu edit/delete/block still use onRefresh (load-bearing); like never does.
  function likeButton(post) {
    const button = element('button', {
      className: 'inline-flex min-h-9 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-sm text-muted transition hover:text-ink',
      attrs: { type: 'button', 'aria-pressed': String(post.liked === true), 'aria-label': `Like post (${post.likeCount || 0} likes)` }
    });
    const paint = (liked, count) => {
      button.replaceChildren(
        element('span', { text: liked ? '❤️' : '🤍', attrs: { 'aria-hidden': 'true' } }),
        element('span', { className: 'tabular-nums', text: String(count) })
      );
      button.setAttribute('aria-pressed', String(liked));
    };
    paint(post.liked === true, Number(post.likeCount || 0));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const prevLiked = post.liked === true;
      const prevCount = Number(post.likeCount || 0);
      withPendingAction(button, async () => {
        const updated = await apiRequest(`/api/community/posts/${post.id}/like`, { method: 'POST' });
        post.liked = updated.liked === true;
        post.likeCount = Number(updated.likeCount ?? 0);
      }).then(() => {
        paint(post.liked, post.likeCount);
      }).catch((error) => {
        post.liked = prevLiked;
        post.likeCount = prevCount;
        paint(prevLiked, prevCount);
        showToast(error?.message || 'Unable to like.', 'error');
      });
    });
    return button;
  }

  function commentButton(post, onOpen) {
    const button = element('button', {
      className: 'inline-flex min-h-9 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-sm text-muted transition hover:text-ink',
      text: `💬 ${Number(post.commentCount || 0)}`,
      attrs: { type: 'button', 'aria-label': `Comments (${post.commentCount || 0})` }
    });
    button.addEventListener('click', (event) => { event.stopPropagation(); onOpen(post); });
    return button;
  }

  function postMenuButton(post, onDone) {
    const wrap = element('div', { className: 'relative' });
    const toggle = element('button', {
      className: 'icon-button', text: '···',
      attrs: { type: 'button', 'aria-label': 'Post actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }
    });
    const menu = element('div', {
      className: 'absolute right-0 z-20 hidden min-w-36 rounded-lg border border-stone bg-paper p-1 shadow-lg',
      attrs: { role: 'menu' }
    });
    const close = (refocus = false) => {
      if (menu.classList.contains('hidden')) return;
      menu.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
      if (refocus) { try { toggle.focus(); } catch { /* noop */ } }
    };
    const openMenu = () => {
      menu.classList.remove('hidden');
      toggle.setAttribute('aria-expanded', 'true');
    };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      if (willOpen) openMenu();
      else close(false);
    });
    // Keyboard-dismissable: Escape closes and returns focus to the toggle.
    toggle.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(true); }
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(true); }
    });
    document.addEventListener('click', (event) => {
      if (wrap.contains(event.target)) return;
      close(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !menu.classList.contains('hidden')) close(true);
    });
    const addItem = (label, handler) => {
      const itemButton = element('button', {
        className: 'flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-paper',
        text: label, attrs: { type: 'button', role: 'menuitem' }
      });
      // Stop bubbling: without this the click reaches the post card
      // underneath and opens the detail dialog on top of the confirm.
      itemButton.addEventListener('click', (event) => { event.stopPropagation(); close(false); handler(); });
      menu.appendChild(itemButton);
    };
    if (post.mine) {
      addItem('Edit post', () => {
        const titleInput = element('input', { className: 'field-control', attrs: { type: 'text', maxlength: '200', 'aria-label': 'Post title' } });
        titleInput.value = post.title || '';
        const bodyInput = element('textarea', { className: 'field-control min-h-24 w-full', attrs: { rows: '3', maxlength: '2000', 'aria-label': 'Post text' } });
        bodyInput.value = post.body || '';
        const translationInput = element('textarea', { className: 'field-control min-h-16 w-full', attrs: { rows: '2', maxlength: '2000', 'aria-label': 'Translation' } });
        translationInput.value = post.translation || '';
        openDialog({
          title: 'Edit post',
          description: 'Only text fields change — the linked content stays as published.',
          content: [element('div', { className: 'grid gap-3' }, [titleInput, bodyInput, translationInput])],
          submitLabel: 'Save changes',
          onSubmit: async (form, close) => {
            try {
              await apiRequest(`/api/community/posts/${post.id}`, {
                method: 'PUT',
                body: { title: titleInput.value, body: bodyInput.value, translation: translationInput.value }
              });
              showToast('Post updated.');
              close();
              if (typeof onDone === 'function') onDone();
            } catch (error) {
              showToast(error?.message || 'Unable to update.', 'error');
            }
          }
        });
      });
      addItem('Delete post', () => {
        confirmDialog({
          title: 'Delete this post?',
          description: 'It disappears from every feed. Likes and comments go with it. This cannot be undone.',
          confirmLabel: 'Delete',
          onConfirm: async () => {
            try {
              await apiRequest(`/api/community/posts/${post.id}`, { method: 'DELETE' });
              showToast('Post deleted.');
              if (typeof onDone === 'function') onDone();
            } catch (error) {
              showToast(error?.message || 'Unable to delete.', 'error');
            }
          }
        });
      });
    } else {
      addItem('Report post', () => openReportDialog('post', post.id));
      addItem(`Block @${post.authorUsername || 'user'}`, () => {
        confirmDialog({
          title: `Block @${post.authorUsername || 'user'}?`,
          description: 'You will no longer see each other anywhere in Community.',
          confirmLabel: 'Block',
          onConfirm: async () => {
            try {
              await apiRequest('/api/community/blocks', { method: 'POST', body: { username: post.authorUsername } });
              showToast('User blocked.');
              if (typeof onDone === 'function') onDone();
            } catch (error) {
              showToast(error?.message || 'Unable to block.', 'error');
            }
          }
        });
      });
    }
    wrap.append(toggle, menu);
    return wrap;
  }

  function readingPreviewButton(readingId, title) {
    const button = element('button', {
      className: 'mt-1 break-words text-left font-semibold text-ink hover:underline',
      text: title,
      attrs: { type: 'button', 'aria-label': `Preview ${title}` }
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openReadingPreview(readingId, title);
    });
    return button;
  }

  async function openReadingPreview(readingId, fallbackTitle) {
    // Loading-first: the dialog opens with a skeleton immediately, then the
    // excerpt (or an in-dialog errorState) replaces it. No fetch-then-open.
    const bodyHost = element('div', { className: 'grid min-w-0 gap-3' }, [skeleton({ rows: 2, variant: 'cards', label: 'Loading preview…' })]);
    bodyHost.setAttribute('aria-busy', 'true');
    openDialog({
      title: fallbackTitle || 'Reading preview',
      description: 'Loading…',
      content: [bodyHost],
      submitLabel: 'Close',
      onSubmit: async (form, close) => close()
    });
    const loadPreview = async () => {
      bodyHost.setAttribute('aria-busy', 'true');
      bodyHost.replaceChildren(skeleton({ rows: 2, variant: 'cards', label: 'Loading preview…' }));
      try {
        const detail = await apiRequest(`/api/reading/publications/${encodeURIComponent(readingId)}`);
        const points = Array.from(String(detail?.text || ''));
        const excerpt = points.length > 1500 ? `${points.slice(0, 1500).join('')}…` : points.join('');
        const meta = `${detail?.level ? `Level ${detail.level} (reference)` : 'No level'}${detail?.text ? ` · ${points.length.toLocaleString()} characters` : ''}`;
        bodyHost.setAttribute('aria-busy', 'false');
        bodyHost.replaceChildren(element('div', { className: 'grid min-w-0 gap-3' }, [
          element('p', { className: 'break-words text-xs text-muted', text: meta }),
          excerpt
            ? element('p', { className: 'whitespace-pre-wrap break-words font-jp text-sm leading-7 text-ink', text: excerpt, attrs: { lang: 'ja' } })
            : element('p', { className: 'text-sm text-muted', text: 'Excerpt unavailable.' }),
          importReadingButton(readingId)
        ]));
      } catch (error) {
        bodyHost.setAttribute('aria-busy', 'false');
        bodyHost.replaceChildren(errorState(error, () => loadPreview()));
      }
    };
    await loadPreview();
  }

  function practiceLink() {
    // KEPT hub link (single shared vocab/kanji/grammar): no per-entity deep
    // link exists (review has no entity query param), and a 1-item session
    // cannot be built without an implicit save of a foreign snapshot — the
    // hub link honestly says "save first to include this item" instead of
    // auto-saving + navigating. Deck viewer Start Review below DOES build a
    // real session (save-then-queue), so this is the only kept '#review' hub
    // link in Community.
    const link = element('a', { className: 'button-secondary inline-flex min-h-9 items-center px-3 py-1.5 text-xs', text: 'Practice in Review', attrs: { href: '#review', title: 'Opens Review — save first to include this item', 'aria-label': 'Open Review to practice your due items' } });
    link.addEventListener('click', (event) => event.stopPropagation());
    return link;
  }

  function detailsLink(post) {
    // Only kanji has an existing detail route for arbitrary text
    // (#kanji-reference/<char>). Vocab/grammar details require an owned
    // library id (foreign snapshots carry none) — those buttons are omitted.
    const kind = post.entityType || (post.postType === 'share_kanji' ? 'kanji' : null);
    if (kind !== 'kanji') return null;
    const display = String(post.snapshot?.display || '');
    if (!SINGLE_HAN.test(display)) return null;
    const link = element('a', { className: 'button-secondary inline-flex min-h-9 items-center px-3 py-1.5 text-xs', text: 'Details', attrs: { href: `#kanji-reference/${encodeURIComponent(display)}`, 'aria-label': `Open reference details for ${display}` } });
    link.addEventListener('click', (event) => event.stopPropagation());
    return link;
  }

  // Deck items reuse the same honesty gates as single saves (no invented
  // gloss, single-Han kanji). Used to disable per-item Save honestly.
  function deckItemSaveable(kind, entry) {
    const display = deckItemDisplay(kind, entry);
    if (!display) return false;
    if (!isUsableMeaning(entry?.meaning)) return false;
    if (kind === 'kanji' && !SINGLE_HAN.test(String(display))) return false;
    return true;
  }

  // Owned-id helpers for the deck review session flow (POST
  // /api/review/sessions requires OWNED library ids: {entityType, entityId}).
  // Deck snapshots are foreign, so unsaved items are saved first via the
  // existing POST /api/vocabulary|kanji|grammar endpoints. Never fakes an id.
  function ownedIdFromSaveResponse(kind, data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = kind === 'kanji'
      ? [data.id_kanji, data.idKanji, data.id, data.insertId]
      : kind === 'grammar'
        ? [data.id_grammar, data.idGrammar, data.id, data.insertId]
        : [data.id_vocabulary, data.idVocabulary, data.id, data.insertId];
    for (const candidate of candidates) {
      const id = Number(candidate);
      if (Number.isInteger(id) && id > 0) return id;
    }
    return null;
  }

  async function findOwnedEntityId(kind, display) {
    const text = String(display || '').trim();
    if (!text) return null;
    const endpoint = kind === 'kanji' ? '/api/kanji/options' : kind === 'grammar' ? '/api/grammar/options' : '/api/vocabulary/options';
    try {
      const data = await apiRequest(`${endpoint}?search=${encodeURIComponent(text)}&limit=20`);
      const rows = Array.isArray(data?.items) ? data.items : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        if (kind === 'kanji' && String(row.character_kanji || '') === text) {
          const id = Number(row.id_kanji);
          if (Number.isInteger(id) && id > 0) return id;
        } else if (kind === 'grammar' && String(row.grammar_point || '') === text) {
          const id = Number(row.id_grammar);
          if (Number.isInteger(id) && id > 0) return id;
        } else if (kind !== 'kanji' && kind !== 'grammar' && String(row.word || '') === text) {
          const id = Number(row.id_vocabulary);
          if (Number.isInteger(id) && id > 0) return id;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  async function saveDeckItemReturningId(kind, entry) {
    const display = deckItemDisplay(kind, entry);
    const meaning = String(entry?.meaning || '').trim();
    if (!display || !isUsableMeaning(meaning)) return null;
    if (kind === 'kanji' && !SINGLE_HAN.test(String(display))) return null;
    try {
      let created = null;
      if (kind === 'kanji') {
        created = await apiRequest('/api/kanji', { method: 'POST', body: { character_kanji: display, meaning } });
      } else if (kind === 'grammar') {
        created = await apiRequest('/api/grammar', { method: 'POST', body: { grammar_point: display, meaning } });
      } else {
        created = await apiRequest('/api/vocabulary', { method: 'POST', body: { word: display, ...(entry.reading ? { reading: entry.reading } : {}), meaning } });
      }
      const entityId = ownedIdFromSaveResponse(kind, created);
      return entityId ? { entityId, saved: true } : null;
    } catch (error) {
      if (error?.status === 409) {
        const existing = error?.data?.existingKanji;
        const existingId = Number(existing?.idKanji ?? existing?.id_kanji ?? existing?.id);
        if (Number.isInteger(existingId) && existingId > 0) return { entityId: existingId, already: true };
      }
      return null;
    }
  }

  // Search-first to avoid creating duplicates for vocabulary/grammar (which
  // allow duplicate words): reuse the owned row when the exact display
  // already exists, otherwise save. Returns {entityId, saved} or
  // {entityId, already} or null (unsaveable/unqueueable — honestly skipped).
  async function ensureDeckOwnedId(kind, entry) {
    const display = deckItemDisplay(kind, entry);
    if (!display || !deckItemSaveable(kind, entry)) return null;
    const existing = await findOwnedEntityId(kind, display);
    if (existing) return { entityId: existing, already: true };
    const saved = await saveDeckItemReturningId(kind, entry);
    if (saved) return saved;
    const retry = await findOwnedEntityId(kind, display);
    if (retry) return { entityId: retry, already: true };
    return null;
  }

  function todayISODate() {
    try {
      return new Date().toISOString().slice(0, 10);
    } catch {
      return '2026-01-01';
    }
  }

  function exampleActions(post) {
    // Japanese Example posts (#6): Save-as-vocab (gated on a real usable
    // translation) + TTS via shared speakJapanese. Analyze is OMITTED:
    // #analyzer has no text-prefill/query support and #immersion only reads
    // returnUrl — linking would drop the text. Never fabricate furigana.
    if (post.postType !== 'example' || !String(post.japaneseText || '').trim()) return null;
    const text = String(post.japaneseText || '').trim();
    const meaning = String(post.translation || '').trim();
    const saveable = isUsableMeaning(meaning);
    const rowChildren = [];
    if (saveable) {
      const save = bookmarkSaveButton({ ariaLabel: 'Save example as vocabulary', title: 'Save example to library' });
      save.addEventListener('click', (event) => {
        event.stopPropagation();
        // Save-from-Community confirmation (same display + meaning pattern as
        // saveEntityButton and the deck viewer per-item saves): old example
        // posts hit this path, so it must confirm like every other save.
        confirmDialog({
          title: `Save "${text}" to your library?`,
          description: `${text} — ${meaning}. This adds it to your library and review queue.`,
          confirmLabel: 'Save',
          confirmClassName: 'button-primary',
          pendingLabel: 'Saving…',
          onConfirm: async () => {
            try {
              await withPendingAction(save, async () => {
                await apiRequest('/api/vocabulary', { method: 'POST', body: { word: text, meaning } });
                showToast('Saved to your library.');
              }, { pendingLabel: 'Saving…' });
            } catch (error) {
              showToast(error?.message || 'Unable to save (it may already be saved).', 'error');
            }
          }
        });
      });
      rowChildren.push(save);
    } else {
      const disabled = bookmarkSaveButton({ ariaLabel: 'Save unavailable — no dictionary meaning available', title: 'No dictionary meaning available', disabled: true });
      disabled.addEventListener('click', (event) => event.stopPropagation());
      rowChildren.push(disabled);
    }
    // Speaker/bocina glyph from icons.js (volume), no emoji: matches the Decks
    // hub play affordances (icon('volume')) with a text label for this row.
    // Stop behavior is N/A here (single utterance, no queue).
    const play = element('button', { className: 'button-secondary inline-flex min-h-9 items-center gap-1.5 px-3 py-1.5 text-xs', attrs: { type: 'button', 'aria-label': 'Play example aloud' } }, [icon('volume', { size: 16 }), element('span', { text: 'Play' })]);
    play.addEventListener('click', (event) => { event.stopPropagation(); playJapaneseText(text); });
    rowChildren.push(play);
    return element('div', { className: 'mt-2 flex flex-wrap gap-2' }, rowChildren);
  }

  function linkedBox(post) {
    const snapshot = post.snapshot && typeof post.snapshot === 'object' ? post.snapshot : null;
    if (post.postType === 'share_deck' && post.deckId) {
      const title = snapshot?.title || 'Shared deck';
      return element('div', { className: 'mt-3 rounded-xl border border-stone bg-paper p-3' }, [
        element('p', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: '📚 Deck' }),
        element('p', { className: 'mt-1 break-words font-semibold text-ink', text: title }),
        ...(snapshot?.itemCount !== undefined ? [element('p', { className: 'mt-1 text-xs text-muted', text: `${snapshot.itemCount} items${snapshot.entityType ? ` · ${snapshot.entityType}` : ''}` })] : []),
        element('div', { className: 'mt-2 flex flex-wrap gap-2' }, [openDeckButton(post.deckId, title)])
      ]);
    }
    if (post.postType === 'share_reading' && post.readingId) {
      const title = snapshot?.title || 'Shared reading';
      // Analyze OMITTED: POST /api/immersion/analyze exists but the
      // immersion page takes no text-prefill param (only returnUrl) and the
      // analyzer page has no query prefill — a link would drop the text.
      // Import + preview-as-Read reuse existing flows read-only.
      const levelText = snapshot?.level ? `Level ${snapshot.level} (reference)` : 'No level';
      return element('div', { className: 'mt-3 rounded-xl border border-stone bg-paper p-3' }, [
        element('p', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: '📖 Reading — tap the title for a preview' }),
        readingPreviewButton(post.readingId, title),
        ...(snapshot ? [element('p', { className: 'mt-1 text-xs text-muted', text: `${levelText}${snapshot.chars ? ` · ${Number(snapshot.chars).toLocaleString()} characters` : ''}`, attrs: { title: 'Reference level — not official JLPT data' } })] : []),
        element('div', { className: 'mt-2 flex flex-wrap gap-2' }, [importReadingButton(post.readingId)])
      ]);
    }
    if ((post.postType === 'share_vocab' || post.postType === 'share_kanji' || post.postType === 'share_grammar') && snapshot?.display) {
      return element('div', { className: 'mt-3 rounded-xl border border-stone bg-paper p-3' }, [
        element('p', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: 'Shared learning item' }),
        element('p', { className: 'mt-1 break-words font-jp text-lg font-semibold text-ink', text: snapshot.display, attrs: { lang: 'ja' } }),
        ...(snapshot.reading ? [element('p', { className: 'break-words font-jp text-sm text-muted', text: snapshot.reading, attrs: { lang: 'ja' } })] : []),
        ...(snapshot.meaning ? [element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: snapshot.meaning })] : []),
        element('div', { className: 'mt-2 flex flex-wrap gap-2' }, [saveEntityButton(post), practiceLink(), detailsLink(post)].filter(Boolean))
      ]);
    }
    return null;
  }

  function openDeckButton(deckId, title) {
    const button = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Open deck', attrs: { type: 'button' } });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openDeckViewer(deckId, title);
    });
    return button;
  }

  async function openDeckViewer(deckId, title) {
    // Loading-first: the dialog opens with a skeleton immediately, then the
    // deck content (or an in-dialog errorState) replaces it. No fetch-then-open.
    const bodyHost = element('div', { className: 'grid min-w-0 gap-3' }, [skeleton({ rows: 4, variant: 'grid', label: 'Loading deck…' })]);
    bodyHost.setAttribute('aria-busy', 'true');
    const closeViewer = openDialog({
      title: title || 'Shared deck',
      description: 'Loading…',
      content: [bodyHost],
      submitLabel: 'Close',
      onSubmit: async (form, close) => close()
    });
    const loadDeck = async () => {
      bodyHost.setAttribute('aria-busy', 'true');
      bodyHost.replaceChildren(skeleton({ rows: 4, variant: 'grid', label: 'Loading deck…' }));
      let detail = null;
      try {
        detail = await apiRequest(`/api/decks/${encodeURIComponent(deckId)}`);
      } catch (error) {
        bodyHost.setAttribute('aria-busy', 'false');
        bodyHost.replaceChildren(errorState(error, () => loadDeck()));
        return;
      }
      const items = Array.isArray(detail?.items) ? detail.items : [];
      bodyHost.setAttribute('aria-busy', 'false');
      const rows = element('div', { className: 'grid min-w-0 grid-cols-2 gap-2 xl:grid-cols-3' });
      rows.setAttribute('aria-busy', 'false');
      const saveAll = bookmarkSaveButton({ ariaLabel: `Save all ${items.length} items to your library`, title: `Save all ${items.length} items to your library` });
      // Deck review builds a REAL session (save-then-queue): foreign snapshot
      // items are saved first via the existing POST endpoints, then POST
      // /api/review/sessions queues the OWNED ids and hands off like the
      // immersion flow (sessionStorage queue → #review?reviewSessionId=…).
      // Never fakes a queue; unqueueable items are reported, never included.
      const startReview = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Start Review', attrs: { type: 'button', 'aria-label': 'Save deck items and start a review session' } });
      const topRow = element('div', { className: 'flex flex-wrap gap-2' }, [saveAll, startReview]);
      const savedIds = new Set();
      const paintRows = () => {
        rows.replaceChildren(...items.map((entry, index) => {
          const kind = entry.entityType || detail.entityType || 'vocabulary';
          const label = deckItemDisplay(kind, entry) || `Item ${index + 1}`;
          const saved = savedIds.has(`${kind}:${label}`);
          const saveable = deckItemSaveable(kind, entry);
          const saveDisabledReason = !isUsableMeaning(entry?.meaning)
            ? 'No dictionary meaning available'
            : (kind === 'kanji' ? 'Single kanji character required' : 'Cannot save this item');
          const save = saved
            ? bookmarkSaveButton({ saved: true, ariaLabel: `Saved ${label}`, title: 'Already saved' })
            : !saveable
              ? bookmarkSaveButton({ disabled: true, ariaLabel: `Save unavailable for ${label} — ${saveDisabledReason.toLowerCase()}`, title: saveDisabledReason })
              : bookmarkSaveButton({ ariaLabel: `Save ${label} to library`, title: `Save ${label} to library` });
          if (!saved && saveable) {
            save.addEventListener('click', () => {
              const meaningNote = String(entry?.meaning || '').trim();
              confirmDialog({
                title: `Save "${label}" to your library?`,
                description: meaningNote ? `${label} — ${meaningNote}. This adds it to your library and review queue.` : `${label} will be added to your library and review queue.`,
                confirmLabel: 'Save',
                confirmClassName: 'button-primary',
                pendingLabel: 'Saving…',
                onConfirm: async () => {
                  const ok = await saveDeckItem(kind, entry);
                  if (ok) {
                    savedIds.add(`${kind}:${label}`);
                    paintRows();
                    showToast('Saved to your library.');
                  } else {
                    showToast('Unable to save (it may already be saved).', 'error');
                  }
                }
              });
            });
          }
          return element('div', { className: 'flex min-w-0 items-center justify-between gap-3 rounded-xl border border-stone bg-paper px-3 py-2' }, [
            element('div', { className: 'min-w-0' }, [
              element('p', { className: 'truncate font-jp text-sm font-semibold text-ink', text: label, attrs: { lang: 'ja' } }),
              ...(entry.meaning ? [element('p', { className: 'truncate text-xs text-muted', text: entry.meaning })] : [])
            ]),
            save
          ]);
        }));
      };
      paintRows();
      saveAll.addEventListener('click', () => {
        confirmDialog({
          title: `Save ${items.length} items to your library?`,
          description: `Save ${items.length} items from this deck to your library? Items already saved or without a dictionary meaning will be skipped.`,
          confirmLabel: 'Save all',
          confirmClassName: 'button-primary',
          pendingLabel: 'Saving…',
          onConfirm: async () => {
            await withPendingAction(saveAll, async () => {
              let saved = 0;
              let skipped = 0;
              for (const entry of items) {
                const kind = entry.entityType || detail.entityType || 'vocabulary';
                // eslint-disable-next-line no-await-in-loop
                if (await saveDeckItem(kind, entry)) {
                  saved += 1;
                  savedIds.add(`${kind}:${deckItemDisplay(kind, entry)}`);
                } else skipped += 1;
              }
              paintRows();
              showToast(saved ? `Saved ${saved} item${saved === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped (already saved or unavailable)` : ''}.` : 'Nothing new to save (already saved or no dictionary meaning).', saved ? 'success' : 'info');
            });
          }
        });
      });
      startReview.addEventListener('click', () => withPendingAction(startReview, async () => {
        // Save-then-queue: resolve OWNED ids first (search-first reuse to
        // avoid duplicates, then POST the missing ones). Honesty gates
        // (deckItemSaveable) decide saveability; failures are skipped, never
        // faked. Only owned ids reach POST /api/review/sessions.
        let savedCount = 0;
        let alreadyCount = 0;
        let skippedCount = 0;
        const owned = [];
        const seen = new Set();
        for (const entry of items) {
          const kind = entry.entityType || detail.entityType || 'vocabulary';
          const display = deckItemDisplay(kind, entry);
          if (!display || !deckItemSaveable(kind, entry)) {
            skippedCount += 1;
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const resolved = await ensureDeckOwnedId(kind, entry);
          if (!resolved) {
            skippedCount += 1;
            continue;
          }
          if (resolved.already) alreadyCount += 1;
          else savedCount += 1;
          const key = `${kind}:${resolved.entityId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          savedIds.add(`${kind}:${display}`);
          owned.push({
            entityType: kind,
            entityId: resolved.entityId,
            display,
            ...(entry.reading ? { reading: entry.reading } : {}),
            ...(entry.meaning ? { meaning: entry.meaning } : {})
          });
        }
        paintRows();
        if (!owned.length) {
          showToast('Nothing reviewable — items need a dictionary meaning first.', 'error');
          return;
        }
        const capped = owned.slice(0, 500);
        const cappedSkipped = owned.length - capped.length;
        if (cappedSkipped > 0) skippedCount += cappedSkipped;
        const today = todayISODate();
        let session = null;
        try {
          session = await apiRequest('/api/review/sessions', {
            method: 'POST',
            body: {
              sourceFrom: today,
              sourceTo: today,
              items: capped.map(({ entityType, entityId }) => ({ entityType, entityId }))
            }
          });
        } catch (error) {
          showToast(error?.message || 'Unable to start the review.', 'error');
          return;
        }
        const sessionId = Number(session?.id);
        if (!Number.isInteger(sessionId) || sessionId <= 0) {
          showToast('Unable to start the review.', 'error');
          return;
        }
        // Immersion hand-off pattern (stories.js): stash the queue for the
        // freshly created OPEN session, then navigate. Grading still validates
        // ownership server-side.
        const contextByKey = new Map((Array.isArray(session?.items) ? session.items : []).map((entry) => [`${entry.entityType}:${entry.entityId}`, entry.context]));
        const queueItems = capped.map((item) => {
          const context = contextByKey.get(`${item.entityType}:${item.entityId}`);
          return context ? { ...item, context } : item;
        });
        try {
          if (window.sessionStorage) {
            window.sessionStorage.setItem('jlt-immersion-review-queue', JSON.stringify({
              reviewSessionId: sessionId,
              items: queueItems
            }));
          }
        } catch { /* storage blocked: review falls back to its banner */ }
        const parts = [];
        if (savedCount) parts.push(`Saved ${savedCount}`);
        if (alreadyCount) parts.push(`${alreadyCount} already in library`);
        const prefix = parts.length ? `${parts.join(', ')} — ` : '';
        const skippedNote = skippedCount ? ` (${skippedCount} skipped)` : '';
        showToast(`${prefix}starting review with ${capped.length}${skippedNote}.`);
        try { closeViewer({ silent: true }); } catch { /* close is best-effort */ }
        window.location.hash = `#review?reviewSessionId=${sessionId}`;
      }, { pendingLabel: 'Starting…' }).catch((error) => showToast(error?.message || 'Unable to start the review.', 'error')));
      bodyHost.replaceChildren(
        element('p', { className: 'break-words text-xs text-muted', text: `${items.length} items` }),
        topRow,
        rows
      );
    };
    await loadDeck();
  }

  function openDeckViewerRefresh() {}

  async function saveDeckItem(kind, entry) {
    const display = deckItemDisplay(kind, entry);
    const meaning = String(entry?.meaning || '').trim();
    if (!display) return false;
    // Honesty gates: no invented gloss, single-Han kanji. No request fires
    // when the gate fails — the caller counts it as skipped.
    if (!isUsableMeaning(meaning)) return false;
    if (kind === 'kanji' && !SINGLE_HAN.test(String(display))) return false;
    try {
      if (kind === 'kanji') {
        await apiRequest('/api/kanji', { method: 'POST', body: { character_kanji: display, meaning } });
      } else if (kind === 'grammar') {
        await apiRequest('/api/grammar', { method: 'POST', body: { grammar_point: display, meaning } });
      } else {
        await apiRequest('/api/vocabulary', { method: 'POST', body: { word: display, ...(entry.reading ? { reading: entry.reading } : {}), meaning } });
      }
      return true;
    } catch {
      return false;
    }
  }

  function importReadingButton(readingId) {
    const button = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Import to library', attrs: { type: 'button' } });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      withPendingAction(button, async () => {
        const result = await apiRequest(`/api/reading/publications/${encodeURIComponent(readingId)}/import`, { method: 'POST' });
        if (result?.duplicate) showToast('Already in your library.');
        else showToast('Imported to your library.');
        if (result?.id) window.location.hash = `#reading?id=${encodeURIComponent(result.id)}`;
      }, { pendingLabel: 'Importing…' }).catch((error) => showToast(error?.message || 'Unable to import.', 'error'));
    });
    return button;
  }

  function saveEntityButton(post) {
    const snapshot = post.snapshot || {};
    const body = entityCreateBody(post.entityType, snapshot);
    if (!body) {
      const disabled = bookmarkSaveButton({ disabled: true, ariaLabel: 'Save unavailable — no dictionary meaning available', title: 'No dictionary meaning available' });
      disabled.addEventListener('click', (event) => event.stopPropagation());
      return disabled;
    }
    const button = bookmarkSaveButton({ ariaLabel: `Save ${snapshot.display} to library`, title: `Save ${snapshot.display} to library` });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (post.entityType === 'kanji' && !SINGLE_HAN.test(String(snapshot.display || ''))) {
        showToast('This kanji cannot be saved — a single kanji character is required.', 'error');
        return;
      }
      const display = String(snapshot.display || '');
      const meaningNote = String(snapshot.meaning || '').trim();
      const readingNote = String(snapshot.reading || '').trim();
      confirmDialog({
        title: `Save "${display}" to your library?`,
        description: `${display}${readingNote ? ` · ${readingNote}` : ''}${meaningNote ? ` — ${meaningNote}` : ''}. This adds it to your library and review queue.`,
        confirmLabel: 'Save',
        confirmClassName: 'button-primary',
        pendingLabel: 'Saving…',
        onConfirm: async () => {
          try {
            await withPendingAction(button, async () => {
              await apiRequest(entityCreateEndpoint(post.entityType), { method: 'POST', body });
              showToast('Saved to your library.');
            }, { pendingLabel: 'Saving…' });
          } catch (error) {
            showToast(error?.message || 'Unable to save (it may already be saved).', 'error');
          }
        }
      });
    });
    return button;
  }

  function postCard(post, { onProfile, onRefresh } = {}) {
    const card = element('article', { className: 'surface cursor-pointer p-4 sm:p-5', attrs: { tabindex: '0', role: 'button', 'aria-label': `Open post by ${post.authorUsername || 'user'}` } });
    const open = () => openPostDialog(post.id, { onProfile, onRefresh });
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (event.target && event.target !== card && typeof event.target.closest === 'function' && event.target.closest('button')) return;
        event.preventDefault();
        open();
      }
    });
    const head = element('div', { className: 'flex items-start justify-between gap-3' }, [
      element('div', { className: 'flex min-w-0 items-center gap-3' }, [avatarNode(post, onProfile), authorLine(post, onProfile)]),
      postMenuButton(post, onRefresh)
    ]);
    card.append(head, element('div', { className: 'mt-2' }, [typePill(post.postType)]));
    if (post.title) card.appendChild(element('p', { className: 'mt-2 break-words font-semibold text-ink', text: post.title }));
    if (post.japaneseText) card.appendChild(element('p', { className: 'mt-2 break-words font-jp text-lg leading-8 text-ink', text: post.japaneseText, attrs: { lang: 'ja' } }));
    if (post.body) card.appendChild(element('p', { className: 'mt-2 break-words text-sm leading-6 text-ink/90', text: post.body }));
    if (post.translation) card.appendChild(element('p', { className: 'mt-2 break-words text-sm leading-6 text-muted', text: post.translation }));
    // Progress cards present the backend-verified snapshot when present
    // (additive `stats`, null for manual-only progress → body only).
    if (post.postType === 'progress' && post.stats) {
      const stats = statsBlock(post.stats);
      if (stats) card.appendChild(stats);
    }
    // Japanese Example posts carry per-example study actions (Save gated on
    // a real translation + TTS; Analyze omitted — no prefill support).
    if (post.postType === 'example') {
      const examples = exampleActions(post);
      if (examples) {
        examples.addEventListener('click', (event) => event.stopPropagation());
        card.appendChild(examples);
      }
    }
    const box = linkedBox(post);
    if (box) {
      box.addEventListener('click', (event) => event.stopPropagation());
      card.appendChild(box);
    }
    const foot = element('div', { className: 'mt-3 flex items-center gap-1 border-t border-stone pt-3' }, [
      // Phase 7: like costs 1 mutation only — no onRefresh full reload.
      // postMenuButton above keeps onRefresh (edit/delete/block load-bearing).
      likeButton(post),
      commentButton(post, () => openPostDialog(post.id, { onProfile, onRefresh, focusComments: true }))
    ]);
    foot.addEventListener('click', (event) => event.stopPropagation());
    card.appendChild(foot);
    return card;
  }

  // onRefresh is legacy for like/comment (now local-only, no feed reload) and
  // stays only so menu edit/delete/block callers keep working; dialog
  // like/comment paths intentionally never invoke it.
  function openPostDialog(postId, { onProfile, onRefresh, focusComments = false } = {}) {
    apiRequest(`/api/community/posts/${encodeURIComponent(postId)}`).then((post) => {
      const like = likeButton(post);
      // Desktop dead-space fix: the comments region scrolls internally once it
      // passes ~38vh on sm+ (sm: prefix, so mobile keeps its natural height).
      // Long threads no longer push the footer an ocean away; short threads
      // (1-2 comments) leave no blank to scroll. Reply styling untouched.
      const commentsWrap = element('div', { className: 'grid min-w-0 gap-2 sm:max-h-[38vh] sm:overflow-y-auto sm:overscroll-contain sm:pr-1' }, [skeleton({ rows: 2, variant: 'rows', label: 'Loading comments…' })]);
      commentsWrap.setAttribute('aria-busy', 'true');
      const input = element('input', { className: 'field-control', attrs: { type: 'text', maxlength: '1000', placeholder: 'Write a comment…', 'aria-label': 'Write a comment' } });
      const send = element('button', { className: 'icon-button shrink-0', text: '➤', attrs: { type: 'button', 'aria-label': 'Send comment' } });
      const submitComment = () => withPendingAction(send, async () => {
        const text = String(input.value || '').trim();
        if (!text) { showToast('Write something first.', 'error'); return; }
        await apiRequest(`/api/community/posts/${post.id}/comments`, { method: 'POST', body: { body: text } });
        input.value = '';
        post.commentCount = Number(post.commentCount || 0) + 1;
        // Phase 7: reloadComments is load-bearing for the visible list only.
        // No onRefresh full feed reload — the dialog count delta stands alone.
        await reloadComments();
      }).catch((error) => showToast(error?.message || 'Unable to comment.', 'error'));
      send.addEventListener('click', submitComment);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submitComment(); } });
      const isEditedFor = (node) => {
        try {
          if (!node?.updatedAt || !node?.createdAt) return node?.edited === true;
          if (node.edited === true) return true;
          return Math.abs(new Date(node.updatedAt).getTime() - new Date(node.createdAt).getTime()) > 1000;
        } catch {
          return node?.edited === true;
        }
      };
      const attachInlineEditor = ({ bodyText, editedNote, item, label }) => {
        const area = element('textarea', { className: 'field-control mt-2 min-h-16 w-full', attrs: { rows: '2', maxlength: '1000', 'aria-label': label } });
        area.value = item.body || '';
        const save = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Save', attrs: { type: 'button' } });
        const cancel = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Cancel', attrs: { type: 'button' } });
        const editor = element('div', { className: 'mt-2 grid min-w-0 gap-2' }, [area, element('div', { className: 'flex flex-wrap gap-2' }, [save, cancel])]);
        bodyText.replaceWith(editor);
        area.focus();
        cancel.addEventListener('click', () => editor.replaceWith(bodyText));
        save.addEventListener('click', () => withPendingAction(save, async () => {
          const text = String(area.value || '').trim();
          if (!text) { showToast('Write something first.', 'error'); return; }
          const updated = await apiRequest(`/api/community/comments/${item.id}`, { method: 'PUT', body: { body: text } });
          item.body = updated?.body || text;
          item.updatedAt = updated?.updatedAt || new Date().toISOString();
          item.edited = true;
          bodyText.textContent = item.body;
          editor.replaceWith(bodyText);
          editedNote.hidden = false;
          showToast('Comment updated.');
        }).catch((error) => showToast(error?.message || 'Unable to update.', 'error')));
      };
      const openReplyComposer = (parent, host, replyButton, paintReplies) => {
        if (host.firstChild) {
          try { host.querySelector('input')?.focus(); } catch { /* noop */ }
          return;
        }
        host.hidden = false;
        const targetName = parent.authorDisplay || parent.authorUsername || 'someone';
        const replyInput = element('input', { className: 'field-control min-w-0 flex-1', attrs: { type: 'text', maxlength: '1000', placeholder: `Reply to ${targetName}…`, 'aria-label': `Reply to ${targetName}` } });
        const replySend = element('button', { className: 'icon-button shrink-0', text: '➤', attrs: { type: 'button', 'aria-label': 'Send reply' } });
        const replyCancel = element('button', { className: 'button-secondary min-h-8 shrink-0 px-2.5 py-1 text-xs', text: 'Cancel', attrs: { type: 'button', 'aria-label': 'Cancel reply' } });
        host.replaceChildren(element('div', { className: 'flex min-w-0 gap-2' }, [replyInput, replySend, replyCancel]));
        try { replyInput.focus(); } catch { /* noop */ }
        const closeComposer = (refocus = true) => {
          host.replaceChildren();
          host.hidden = true;
          if (refocus) { try { replyButton.focus(); } catch { /* noop */ } }
        };
        replyCancel.addEventListener('click', () => closeComposer(true));
        const submitReply = () => withPendingAction(replySend, async () => {
          const text = String(replyInput.value || '').trim();
          if (!text) { showToast('Write something first.', 'error'); return; }
          const created = await apiRequest(`/api/community/posts/${post.id}/comments`, { method: 'POST', body: { body: text, parentCommentId: parent.id } });
          const merged = created && typeof created === 'object' ? created : {};
          const replyNode = {
            id: merged.id,
            authorId: merged.authorId,
            mine: merged.mine === true,
            body: merged.body || text,
            authorUsername: merged.authorUsername || null,
            authorDisplay: merged.authorDisplay || null,
            authorAvatar: merged.authorAvatar || null,
            createdAt: merged.createdAt || new Date().toISOString(),
            updatedAt: merged.updatedAt || merged.createdAt || new Date().toISOString(),
            edited: merged.edited === true,
            parentCommentId: merged.parentCommentId ?? parent.id
          };
          if (!Array.isArray(parent.replies)) parent.replies = [];
          parent.replies.push(replyNode);
          parent.replyCount = Number(parent.replyCount || 0) + 1;
          post.commentCount = Number(post.commentCount || 0) + 1;
          closeComposer(false);
          paintReplies();
          // Phase 7: local paintReplies + count delta only — no full reload.
          try { replyButton.focus(); } catch { /* noop */ }
        }, { pendingLabel: 'Sending…' }).catch((error) => showToast(error?.message || 'Unable to reply.', 'error'));
        replySend.addEventListener('click', submitReply);
        replyInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); submitReply(); }
          else if (event.key === 'Escape') { event.preventDefault(); closeComposer(true); }
        });
      };
      const buildReply = (reply, parent, paintReplies) => {
        const replyAuthor = reply.authorDisplay || reply.authorUsername || 'Someone';
        const replyBody = element('p', { className: 'mt-1 break-words text-sm leading-6 text-ink/90', text: reply.body });
        const replyEdited = element('p', { className: 'mt-1 text-xs italic text-muted', text: 'edited' });
        replyEdited.hidden = !isEditedFor(reply);
        const replyTime = element('span', { className: 'shrink-0 text-xs text-muted', text: timeAgo(reply.createdAt) });
        // Single level only: replies show NO Reply button of their own.
        // Own replies reuse the comment edit/delete path; others reuse the
        // comment report path (targetType comment).
        // BATCH 2(a): Report is plain text (borderless, background-less);
        // Edit/Delete stay untouched (bordered) per spec.
        const replyHeadRight = reply.mine
          ? element('div', { className: 'flex shrink-0 items-center gap-1' }, [
            replyTime,
            element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Edit', attrs: { type: 'button', 'aria-label': 'Edit reply' } }),
            element('button', { className: 'icon-button icon-button--danger shrink-0', text: '🗑', attrs: { type: 'button', 'aria-label': 'Delete reply' } })
          ])
          : element('div', { className: 'flex shrink-0 items-center gap-1' }, [
            replyTime,
            commentTextAction({ text: 'Report', ariaLabel: 'Report reply' })
          ]);
        const replyRow = element('div', { className: 'min-w-0 rounded-lg border border-stone bg-paper p-2' }, [
          element('div', { className: 'flex min-w-0 items-center gap-2' }, [
            avatarFace(reply.authorDisplay, reply.authorUsername, avatarUrlFor(reply), 'size-8 text-xs'),
            element('p', { className: 'min-w-0 flex-1 truncate text-xs font-semibold text-ink', text: replyAuthor }),
            replyHeadRight
          ]),
          replyBody,
          replyEdited
        ]);
        const headButtons = replyRow.querySelectorAll('button');
        if (reply.mine) {
          const [editButton, deleteButton] = headButtons;
          editButton?.addEventListener('click', () => attachInlineEditor({ bodyText: replyBody, editedNote: replyEdited, item: reply, label: 'Edit reply' }));
          deleteButton?.addEventListener('click', () => {
            confirmDialog({
              title: 'Delete this reply?',
              description: 'This cannot be undone.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                try {
                  await apiRequest(`/api/community/comments/${reply.id}`, { method: 'DELETE' });
                  parent.replies = (Array.isArray(parent.replies) ? parent.replies : []).filter((entry) => entry.id !== reply.id);
                  parent.replyCount = Math.max(0, Number(parent.replyCount || 1) - 1);
                  post.commentCount = Math.max(0, Number(post.commentCount || 1) - 1);
                  paintReplies();
                  // Phase 7: local list update only — no full feed reload.
                } catch (error) {
                  showToast(error?.message || 'Unable to delete.', 'error');
                }
              }
            });
          });
        } else {
          const [reportButton] = headButtons;
          reportButton?.addEventListener('click', () => openReportDialog('comment', reply.id));
        }
        return replyRow;
      };
      const buildTopLevel = (comment) => {
        if (!Array.isArray(comment.replies)) comment.replies = [];
        if (comment.replyCount === undefined || comment.replyCount === null) comment.replyCount = comment.replies.length;
        const authorName = comment.authorDisplay || comment.authorUsername || 'Someone';
        const bodyText = element('p', { className: 'mt-1 break-words text-sm leading-6 text-ink/90', text: comment.body });
        const editedNote = element('p', { className: 'mt-1 text-xs italic text-muted', text: 'edited' });
        editedNote.hidden = !isEditedFor(comment);
        const timeLabel = element('span', { className: 'shrink-0 text-xs text-muted', text: timeAgo(comment.createdAt) });
        // Timestamps stay visible for own comments too (comment polish).
        const headRight = comment.mine
          ? element('div', { className: 'flex shrink-0 items-center gap-1' }, [
            timeLabel,
            element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Edit', attrs: { type: 'button', 'aria-label': 'Edit comment' } }),
            element('button', { className: 'icon-button icon-button--danger shrink-0', text: '🗑', attrs: { type: 'button', 'aria-label': 'Delete comment' } })
          ])
          : element('div', { className: 'flex shrink-0 items-center gap-1' }, [timeLabel]);
        // Reply affordance lives only on top-level comments (one-level
        // threading). No comment likes per spec. Report reuses the comment
        // report path for others.
        // BATCH 2(a): Reply + Report are plain text (borderless,
        // background-less); Edit/Delete above stay untouched per spec.
        const replyButton = commentTextAction({ text: 'Reply', ariaLabel: `Reply to ${authorName}` });
        const reportButton = comment.mine
          ? null
          : commentTextAction({ text: 'Report', ariaLabel: 'Report comment' });
        if (reportButton) reportButton.addEventListener('click', () => openReportDialog('comment', comment.id));
        const actions = element('div', { className: 'mt-2 flex flex-wrap items-center gap-2' }, [replyButton, reportButton].filter(Boolean));
        // Shallow indent via left border + small padding (pl-2) so 360px
        // layouts never overflow horizontally. Replies are single level.
        const repliesBox = element('div', { className: 'mt-2 grid min-w-0 gap-2 border-l-2 border-stone pl-2' });
        // No per-thread paging endpoint exists — render the remaining count
        // as muted text only (never a dead button).
        const moreNote = element('p', { className: 'mt-1 text-xs text-muted', text: '' });
        moreNote.hidden = true;
        const composerHost = element('div', { className: 'mt-2 grid min-w-0 gap-2' });
        composerHost.hidden = true;
        const paintReplies = () => {
          const replies = Array.isArray(comment.replies) ? comment.replies : [];
          repliesBox.replaceChildren(...replies.map((reply) => buildReply(reply, comment, paintReplies)));
          repliesBox.hidden = replies.length === 0;
          const remaining = Number(comment.replyCount || 0) - replies.length;
          if (remaining > 0) {
            moreNote.textContent = `See ${remaining} more ${remaining === 1 ? 'reply' : 'replies'}`;
            moreNote.hidden = false;
          } else {
            moreNote.hidden = true;
          }
        };
        replyButton.addEventListener('click', () => openReplyComposer(comment, composerHost, replyButton, paintReplies));
        const row = element('div', { className: 'min-w-0 rounded-xl border border-stone bg-paper p-3' }, [
          element('div', { className: 'flex min-w-0 items-center gap-2' }, [
            avatarFace(comment.authorDisplay, comment.authorUsername, avatarUrlFor(comment), 'size-8 text-xs'),
            element('p', { className: 'min-w-0 flex-1 truncate text-xs font-semibold text-ink', text: authorName }),
            headRight
          ]),
          bodyText,
          editedNote,
          actions,
          repliesBox,
          moreNote,
          composerHost
        ]);
        if (comment.mine) {
          const [editButton, deleteButton] = headRight.querySelectorAll('button');
          editButton?.addEventListener('click', () => attachInlineEditor({ bodyText, editedNote, item: comment, label: 'Edit comment' }));
          deleteButton?.addEventListener('click', () => {
            confirmDialog({
              title: 'Delete this comment?',
              description: 'This cannot be undone.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                try {
                  await apiRequest(`/api/community/comments/${comment.id}`, { method: 'DELETE' });
                  post.commentCount = Math.max(0, Number(post.commentCount || 1) - 1);
                  // Phase 7: reloadComments is load-bearing for the list;
                  // no onRefresh full feed reload.
                  await reloadComments();
                } catch (error) {
                  showToast(error?.message || 'Unable to delete.', 'error');
                }
              }
            });
          });
        }
        paintReplies();
        return row;
      };
      async function reloadComments() {
        commentsWrap.setAttribute('aria-busy', 'true');
        // Keep the skeleton visible on reloads (replaces bare "Loading…" text).
        if (!commentsWrap.querySelector('[role="status"]')) commentsWrap.replaceChildren(skeleton({ rows: 2, variant: 'rows', label: 'Loading comments…' }));
        try {
          const data = await apiRequest(`/api/community/posts/${post.id}/comments?limit=30`);
          const items = Array.isArray(data?.items) ? data.items : [];
          commentsWrap.setAttribute('aria-busy', 'false');
          if (!items.length) {
            commentsWrap.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No comments yet. Start the conversation.' }));
            return;
          }
          commentsWrap.replaceChildren(...items.map((comment) => buildTopLevel(comment)));
        } catch (error) {
          commentsWrap.setAttribute('aria-busy', 'false');
          commentsWrap.replaceChildren(errorState(error, () => reloadComments()));
        }
      }
      // Dialog follow: post payloads carry no follow flags (genuinely absent),
      // so the single profile fetch in followButton stays (per-dialog, kept).
      const followRow = (post.mine || !post.authorUsername) ? null : followButton(post.authorUsername, () => {});
      // Linked learning content renders inline (same boxes as the cards —
      // reading titles open the excerpt dialog, decks open the viewer).
      const dialogLinked = linkedBox(post);
      if (dialogLinked) dialogLinked.addEventListener('click', (event) => event.stopPropagation());
      const dialogStats = post.postType === 'progress' ? statsBlock(post.stats) : null;
      const dialogExamples = post.postType === 'example' ? exampleActions(post) : null;
      if (dialogExamples) dialogExamples.addEventListener('click', (event) => event.stopPropagation());
      openDialog({
        title: `${post.authorDisplay || post.authorUsername || 'Someone'} · ${POST_TYPE_LABEL[post.postType] || post.postType}`,
        description: post.createdAt ? new Date(post.createdAt).toLocaleString() : '',
        // Desktop dead-space fix: the generic openDialog body is a 2-column grid
        // on sm+ (ui.js), so this single content node spans both columns
        // (sm:col-span-2) instead of leaving the whole right half an empty
        // void. Tight gap-3, no min-height, no large gaps — the footer sits
        // right under the content. Mobile stays single-column, unchanged.
        content: [element('div', { className: 'grid min-w-0 gap-3 sm:col-span-2' }, [
          ...(post.japaneseText ? [element('p', { className: 'break-words font-jp text-lg leading-8 text-ink', text: post.japaneseText, attrs: { lang: 'ja' } })] : []),
          ...(post.title ? [element('p', { className: 'break-words font-semibold text-ink', text: post.title })] : []),
          ...(post.body ? [element('p', { className: 'break-words text-sm leading-6 text-ink/90', text: post.body })] : []),
          ...(post.translation ? [element('p', { className: 'break-words text-sm leading-6 text-muted', text: post.translation })] : []),
          ...(dialogStats ? [dialogStats] : []),
          ...(dialogExamples ? [dialogExamples] : []),
          ...(dialogLinked ? [dialogLinked] : []),
          element('div', { className: 'flex flex-wrap items-center gap-2' }, [like, followRow].filter(Boolean)),
          element('div', { className: 'grid gap-2' }, [commentsWrap, element('div', { className: 'flex gap-2' }, [input, send])])
        ])],
        submitLabel: 'Close',
        onSubmit: async (form, close) => close()
      });
      reloadComments();
      if (focusComments) setTimeout(() => { try { input.focus(); } catch { /* noop */ } }, 60);
    }).catch((error) => showToast(error?.message || 'Unable to open the post.', 'error'));
  }

  function followButton(username, onChange, options = {}) {
    const button = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Follow', attrs: { type: 'button' } });
    // Backend is the source of truth: viewerFollowing (canonical, legacy
    // following kept for compat), followsYou, mutual. The button only
    // PRESENTS those decisions — Follow back when they follow you, Mutual
    // when both directions hold. No auth logic is derived here.
    // Phase 7: flagged rows (personRow, profile head, followers lists) pass
    // options and never fetch. The single fallback GET below fires only where
    // flags are genuinely absent — the post dialog (feed/discover/search post
    // payloads carry like/comment counts + identity, never follow flags).
    // That fetch is per-dialog-open (1 request), never per-row in a list.
    let following = options.initialFollowing ?? null;
    let followsYou = options.followsYou ?? false;
    let mutual = options.mutual ?? false;
    const paint = () => {
      if (mutual === true && following === true) {
        button.textContent = 'Mutual ✓';
      } else if (following) {
        button.textContent = 'Following ✓';
      } else if (followsYou) {
        button.textContent = 'Follow back';
      } else {
        button.textContent = 'Follow';
      }
      button.setAttribute('aria-pressed', String(following === true));
      const label = mutual === true && following === true
        ? `Mutual follow with ${username}`
        : following ? `Following ${username}` : followsYou ? `Follow back ${username}` : `Follow ${username}`;
      button.setAttribute('aria-label', label);
    };
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      withPendingAction(button, async () => {
        if (following) {
          await apiRequest('/api/community/unfollow', { method: 'POST', body: { username } });
          following = false;
          if (mutual) mutual = false;
        } else {
          await apiRequest('/api/community/follow', { method: 'POST', body: { username } });
          following = true;
          if (followsYou) mutual = true;
        }
        paint();
        if (typeof onChange === 'function') onChange(following);
      }).catch((error) => showToast(error?.message || 'Unable to update follow.', 'error'));
    });
    if (following === null || following === undefined) {
      apiRequest(`/api/community/profile/${encodeURIComponent(username)}`).then((profile) => {
        following = (profile.viewerFollowing ?? profile.following) === true;
        followsYou = profile.followsYou === true || followsYou;
        mutual = profile.mutual === true || (following && followsYou);
        paint();
      }).catch(() => { paint(); });
    }
    paint();
    return button;
  }

  function openReportDialog(targetType, targetId) {
    const reasons = ['spam', 'harassment', 'inappropriate', 'misleading', 'other'];
    const select = element('select', { className: 'field-control', attrs: { 'aria-label': 'Report reason' } },
      reasons.map((reason) => element('option', { text: reason, attrs: { value: reason } })));
    const details = element('textarea', { className: 'field-control min-h-16 w-full', attrs: { rows: '2', maxlength: '500', placeholder: 'Details (optional)', 'aria-label': 'Report details' } });
    openDialog({
      title: 'Report content',
      description: 'Reports are private. Repeated abuse leads to removal.',
      content: [element('div', { className: 'grid gap-3' }, [select, details])],
      submitLabel: 'Send report',
      onSubmit: async (form, close) => {
        try {
          await apiRequest('/api/community/reports', {
            method: 'POST',
            body: { targetType, targetId, reason: select.value, ...(details.value.trim() ? { details: details.value.trim() } : {}) }
          });
          showToast('Report sent. Thanks for keeping the community safe.');
          close();
        } catch (error) {
          showToast(error?.message || 'Unable to report.', 'error');
        }
      }
    });
  }

  // ---- composer (dialog-only: the + nav button is the SOLE entry, no
  // inline card remains in the feed body). Same 9 types, grouped picker,
  // conditional fields, and byte-identical payloads as the retired inline
  // card. Opens in openDialog; focus lands on the first field automatically,
  // Escape cancels and discards the draft (see dialog description).
  function openComposerDialog(onPublished) {
    // Grouped discovery: same 9 type values as COMPOSER_TYPES (payloads
    // byte-identical), only the picker UX is grouped. Compact select-based
    // with <optgroup> so 360px never overflows — no card grid.
    const typeSelect = element('select', { className: 'field-control w-full', attrs: { 'aria-label': 'Post type' } },
      COMPOSER_GROUPS.map((group) => element('optgroup', { attrs: { label: group.label } },
        group.types.map((type) => element('option', { text: type.label, attrs: { value: type.value } })))));
    const typeHint = element('p', { className: 'break-words text-xs text-muted', text: '', attrs: { 'aria-live': 'polite' } });
    const paintTypeHint = () => {
      const group = composerGroupFor(typeSelect.value);
      typeHint.textContent = group ? `${group.label}: ${group.hint}` : '';
    };
    const typeField = element('label', { className: 'grid min-w-0 gap-1.5' }, [
      element('span', { className: 'text-sm font-semibold text-ink', text: 'What do you want to share?' }),
      typeSelect,
      typeHint
    ]);
    const titleInput = element('input', { className: 'field-control', attrs: { type: 'text', maxlength: '200', placeholder: 'Title (optional)', 'aria-label': 'Post title' } });
    const bodyInput = element('textarea', { className: 'field-control min-h-24 w-full', attrs: { rows: '3', maxlength: '2000', placeholder: "What's on your mind?", 'aria-label': 'Post text' } });
    const japaneseInput = element('textarea', { className: 'field-control min-h-20 w-full', attrs: { rows: '2', maxlength: '2000', placeholder: 'Japanese sentence…', 'aria-label': 'Japanese text' } });
    const translationInput = element('textarea', { className: 'field-control min-h-16 w-full', attrs: { rows: '2', maxlength: '2000', placeholder: 'Translation (optional)…', 'aria-label': 'Translation' } });
    const linkBox = element('div', { className: 'grid gap-2' });
    // Progress (#7): "Attach my stats" toggle fetches the caller's OWN
    // verified snapshot for an honest preview. Client numbers are NEVER
    // sent — publish sends only includeStats:true + the personal message.
    const attachBox = element('input', { attrs: { type: 'checkbox', 'aria-label': 'Attach my stats' } });
    const statsPreview = element('div', { className: 'grid gap-1 text-sm text-ink/90', attrs: { 'aria-live': 'polite' } }, [
      element('p', { className: 'text-xs text-muted', text: 'Post without stats — body only.' })
    ]);
    const statsWrap = element('div', { className: 'grid gap-2 rounded-xl border border-stone bg-paper p-3' }, [
      element('label', { className: 'flex min-h-9 cursor-pointer items-center gap-2 text-sm text-ink' }, [
        attachBox,
        element('span', { text: 'Attach my stats (verified snapshot)' })
      ]),
      statsPreview
    ]);
    statsWrap.hidden = true;
    let statsCache = null;
    const paintStatsPreview = (data) => {
      const line = `🔥 ${Number(data.streakDays || 0)}-day streak · 📚 ${Number(data.vocabCount || 0)} vocab · 字 ${Number(data.kanjiCount || 0)} kanji · ⏱ ${Number(data.studiedMinutesMonth || 0)} min`;
      statsPreview.replaceChildren(
        element('p', { className: 'break-words text-sm tabular-nums text-ink/90', text: line }),
        element('p', { className: 'text-xs text-muted', text: 'last 30 days · verified snapshot at post time' })
      );
    };
    const refreshStatsPreview = async () => {
      if (!attachBox.checked) {
        statsPreview.replaceChildren(element('p', { className: 'text-xs text-muted', text: 'Post without stats — body only.' }));
        return;
      }
      if (statsCache) { paintStatsPreview(statsCache); return; }
      statsPreview.replaceChildren(element('p', { className: 'text-xs text-muted', text: 'Loading your stats…' }));
      attachBox.disabled = true;
      try {
        const data = await apiRequest('/api/community/share-stats');
        statsCache = data;
        paintStatsPreview(data);
      } catch (error) {
        statsPreview.replaceChildren(element('p', { className: 'text-xs text-red-700', text: error?.message || 'Stats are unavailable — you can still post without them.' }));
      } finally {
        attachBox.disabled = false;
      }
    };
    attachBox.addEventListener('change', refreshStatsPreview);
    let link = {};
    async function paintLink() {
      link = {};
      const type = typeSelect.value;
      const showJapanese = type === 'example';
      const showLink = type.startsWith('share_');
      japaneseInput.hidden = !showJapanese;
      translationInput.hidden = !(showJapanese || type === 'text' || type === 'question');
      statsWrap.hidden = type !== 'progress';
      linkBox.replaceChildren();
      if (!showLink) return;
      linkBox.appendChild(element('p', { className: 'text-xs text-muted', text: 'Loading your library…' }));
      try {
        if (type === 'share_deck') {
          const data = await apiRequest('/api/decks?mine=true&limit=50');
          const options = (Array.isArray(data?.items) ? data.items : [])
            .filter((row) => row && row.id !== undefined && row.id !== null)
            .map((row) => ({ id: row.id, label: `${row.title}${row.entity_type ? ` · ${row.entity_type}` : ''}` }));
          linkBox.replaceChildren(buildLinkPicker('Deck', options, (id) => { link.deckId = id; }));
          return;
        }
      } catch {
        linkBox.replaceChildren(buildLinkPicker('Deck', [], () => {}));
        return;
      }
      if (type === 'share_reading') {
        let mine = [];
        try {
          const me = await apiRequest('/api/users/me');
          const data = await apiRequest(`/api/reading/publications?ownerId=${encodeURIComponent(me?.id || me?.user?.id || '')}&limit=50`).catch(() => null);
          const list = data?.items || (await apiRequest('/api/reading/publications?limit=50').catch(() => ({ items: [] }))).items || [];
          mine = list.map((row) => ({ id: row.id, label: row.title }));
        } catch {
          mine = [];
        }
        linkBox.replaceChildren(buildLinkPicker('Reading text', mine, (id) => { link.readingId = id; }));
      } else {
        const entityType = type === 'share_vocab' ? 'vocabulary' : type === 'share_kanji' ? 'kanji' : 'grammar';
        const endpoint = entityType === 'vocabulary' ? '/api/vocabulary/options' : entityType === 'kanji' ? '/api/kanji/options' : '/api/grammar/options';
        const idKey = entityType === 'vocabulary' ? 'id_vocabulary' : entityType === 'kanji' ? 'id_kanji' : 'id_grammar';
        const labelOf = entityType === 'vocabulary'
          ? (row) => `${row.word}${row.reading ? ` · ${row.reading}` : ''}${row.meaning ? ` · ${row.meaning}` : ''}`
          : entityType === 'kanji'
            ? (row) => `${row.character_kanji}${row.meaning ? ` · ${row.meaning}` : ''}`
            : (row) => `${row.grammar_point}${row.meaning ? ` · ${row.meaning}` : ''}`;
        let options = [];
        try {
          const data = await apiRequest(`${endpoint}?limit=50`);
          options = (Array.isArray(data?.items) ? data.items : [])
            .filter((row) => row && row[idKey] !== undefined && row[idKey] !== null)
            .map((row) => ({ id: row[idKey], label: labelOf(row) }));
        } catch {
          options = [];
        }
        linkBox.replaceChildren(buildLinkPicker('Item', options, (id) => { link.entityType = entityType; link.entityId = id; }));
      }
    }
    function buildLinkPicker(label, options, onPick) {
      if (!options.length) {
        return element('p', { className: 'text-xs text-muted', text: `Nothing to share yet — create it in your library first.` });
      }
      const select = element('select', { className: 'field-control', attrs: { 'aria-label': label } },
        [element('option', { text: `Choose ${label.toLowerCase()}…`, attrs: { value: '' } }),
          ...options.map((option) => element('option', { text: option.label, attrs: { value: String(option.id) } }))]);
      select.addEventListener('change', () => {
        const id = Number(select.value);
        onPick(Number.isSafeInteger(id) && id > 0 ? id : null);
      });
      return select;
    }
    typeSelect.addEventListener('change', () => { paintTypeHint(); paintLink(); });
    paintTypeHint();
    paintLink();
    const fields = element('div', { className: 'grid gap-3 sm:col-span-2' }, [typeField, titleInput, bodyInput, japaneseInput, translationInput, linkBox, statsWrap]);
    // Dialog submit carries the byte-identical publish (same conditional
    // fields, same payload keys). Toast + close + refresh on success.
    openDialog({
      title: 'Share something',
      description: 'Post an example, a question, a milestone — or share learning content. Closing discards your draft.',
      content: [fields],
      submitLabel: 'Publish',
      pendingLabel: 'Publishing…',
      onSubmit: async (form, close) => {
        const type = typeSelect.value;
        const payload = { postType: type };
        if (titleInput.value.trim()) payload.title = titleInput.value.trim();
        if (type === 'text' || type === 'question' || type === 'progress') {
          payload.body = bodyInput.value.trim();
        } else if (bodyInput.value.trim()) {
          payload.body = bodyInput.value.trim();
        }
        if (type === 'example') payload.japaneseText = japaneseInput.value.trim();
        else if (japaneseInput.value.trim() && !japaneseInput.hidden) payload.japaneseText = japaneseInput.value.trim();
        if (translationInput.value.trim() && !translationInput.hidden) payload.translation = translationInput.value.trim();
        // Verified progress: flag only — server mints the snapshot, client
        // numbers are never sent (and would be ignored).
        if (type === 'progress' && attachBox.checked) payload.includeStats = true;
        Object.assign(payload, link);
        try {
          const post = await apiRequest('/api/community/posts', { method: 'POST', body: payload });
          showToast('Published to Community.');
          close();
          if (typeof onPublished === 'function') await onPublished(post);
        } catch (error) {
          showToast(error?.message || 'Unable to publish.', 'error');
        }
      }
    });
  }

  // ---- feed tabs
  function feedLoader(host, tab) {
    let page = 1;
    const list = element('div', { className: 'grid gap-3' });
    const moreWrap = element('div', { className: 'mt-4 flex justify-center' });
    host.replaceChildren(list, moreWrap);
    async function load(reset = false) {
      if (reset) { page = 1; list.replaceChildren(); }
      list.setAttribute('aria-busy', 'true');
      list.appendChild(skeleton({ rows: 3, variant: 'cards', label: 'Loading posts…' }));
      try {
        const data = await apiRequest(`/api/community/feed?tab=${tab}&page=${page}&limit=10`);
        const items = Array.isArray(data?.items) ? data.items : [];
        list.querySelectorAll('[role="status"]').forEach((node) => node.remove());
        list.setAttribute('aria-busy', 'false');
        if (!items.length && page === 1) {
          list.replaceChildren(feedEmptyState(tab));
          moreWrap.replaceChildren();
          return;
        }
        const refresh = () => load(true);
        for (const post of items) {
          list.appendChild(postCard(post, { onProfile: openProfile, onRefresh: refresh }));
        }
        const totalPages = Number(data?.pagination?.totalPages || 0);
        moreWrap.replaceChildren();
        if (page < totalPages) {
          const more = element('button', { className: 'button-secondary min-h-11 px-5 py-2.5 text-sm', text: 'See more', attrs: { type: 'button' } });
          more.addEventListener('click', () => { page += 1; load(); });
          moreWrap.appendChild(more);
        }
      } catch (error) {
        list.querySelectorAll('[role="status"]').forEach((node) => node.remove());
        list.setAttribute('aria-busy', 'false');
        list.appendChild(errorState(error, () => load(true)));
      }
    }
    load(true);
  }

  function feedEmptyState(tab) {
    if (tab === 'following') {
      return emptyState({
        title: 'Your community is quiet',
        description: 'Follow learners to build your feed, or share something you learned today.',
        action: element('button', {
          className: 'button-primary min-h-11 px-5 py-2.5 text-sm font-semibold', text: 'Discover learners', attrs: { type: 'button' }
        })
      });
    }
    return emptyState({
      title: 'No posts yet',
      description: 'Be the first to share something you learned today.',
      action: element('button', {
        className: 'button-primary min-h-11 px-5 py-2.5 text-sm font-semibold', text: 'Create a post', attrs: { type: 'button' }
      })
    });
  }

  function renderFeedRoot() {
    if (state.tab === 'discover') return renderDiscover();
    body.replaceChildren();
    // UI tab "feed" is the backend "latest" tab everywhere (the backend only
    // knows latest/following/discover; sending "feed" 400s with a scary error
    // right after publishing). No inline composer remains — the + nav button
    // is the SOLE entry via openComposerDialog.
    const apiTab = state.tab === 'following' ? 'following' : 'latest';
    const listHost = element('div', { className: 'mt-5' });
    const refreshFeed = () => feedLoader(listHost, apiTab);
    body.appendChild(listHost);
    refreshFeed();
    wireEmptyActions();
  }

  function wireEmptyActions() {
    body.querySelectorAll('button').forEach((button) => {
      if (button.textContent === 'Discover learners') {
        button.addEventListener('click', () => showTab('discover'));
      }
      if (button.textContent === 'Create a post') {
        button.addEventListener('click', () => {
          openComposerDialog(async () => {
            if (state.profile || state.tab !== 'feed') await showTab('feed');
            else renderFeedRoot();
          });
        });
      }
    });
  }

  // ---- discover: search + sections (Phase 4-frontend, V6.1 filter selector)
  // Search box stays on top; ONE YouTube-style filter selector button
  // (sliders icon + "Filter: <type>") filters the search endpoint. Sections
  // below come from a single GET /api/community/discover fetch (one loading
  // state, one error with retry). Empty sections hide — no dead "see more"
  // ends. Deck/reading rows reuse openDeckViewer / openReadingPreview so none
  // are dead. Post sections reuse postCard; person sections reuse personRow
  // (Follow + Follows-you from backend).
  function renderDiscover() {
    body.replaceChildren();
    const searchInput = element('input', { className: 'field-control', attrs: { type: 'search', placeholder: 'Search people, posts, Japanese words…', 'aria-label': 'Search community' } });
    const SEARCH_FILTERS = [
      { value: 'all', label: 'All' },
      { value: 'people', label: 'People' },
      { value: 'posts', label: 'Posts' },
      { value: 'vocabulary', label: 'Vocabulary' },
      { value: 'kanji', label: 'Kanji' },
      { value: 'grammar', label: 'Grammar' },
      { value: 'decks', label: 'Decks' },
      { value: 'reading', label: 'Reading' }
    ];
    if (!SEARCH_FILTERS.some((entry) => entry.value === state.searchType)) state.searchType = 'all';
    const filterLabelFor = (value) => (SEARCH_FILTERS.find((entry) => entry.value === value) || SEARCH_FILTERS[0]).label;
    // Single selector button: sliders glyph (icons.js `filter` → lucide
    // SlidersHorizontal, never emoji) + current selection text.
    const filterText = element('span', { className: 'truncate', text: `Filter: ${filterLabelFor(state.searchType)}` });
    const filterButton = element('button', {
      className: 'button-secondary inline-flex min-h-9 max-w-full items-center gap-2 px-3 py-1.5 text-xs',
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Search filter, current filter: ${filterLabelFor(state.searchType)}` }
    }, [icon('filter', { size: 16 }), filterText]);
    const filterMenu = element('div', {
      className: 'absolute left-0 top-[calc(100%+.25rem)] z-20 hidden min-w-44 max-w-[70vw] rounded-lg border border-stone bg-paper p-1 shadow-lg',
      attrs: { role: 'menu', 'aria-label': 'Search filter' }
    });
    const filterWrap = element('div', { className: 'relative inline-flex max-w-full' }, [filterButton, filterMenu]);
    const filterItems = new Map();
    const paintFilter = () => {
      const current = filterLabelFor(state.searchType);
      filterText.textContent = `Filter: ${current}`;
      filterButton.setAttribute('aria-label', `Search filter, current filter: ${current}`);
      for (const [value, item] of filterItems) {
        const active = value === state.searchType;
        item.classList.toggle('is-active', active);
        if (active) item.setAttribute('aria-current', 'true');
        else item.removeAttribute('aria-current');
        const check = item.querySelector('[data-check]');
        if (check) check.hidden = !active;
      }
    };
    let filterOpen = false;
    const closeFilter = (refocus = false) => {
      if (!filterOpen) return;
      filterOpen = false;
      filterMenu.classList.add('hidden');
      filterButton.setAttribute('aria-expanded', 'false');
      if (refocus) { try { filterButton.focus(); } catch { /* focus is best-effort */ } }
    };
    const openFilter = () => {
      filterOpen = true;
      filterMenu.classList.remove('hidden');
      filterButton.setAttribute('aria-expanded', 'true');
      try { (filterItems.get(state.searchType) || [...filterItems.values()][0])?.focus(); } catch { /* noop */ }
    };
    for (const entry of SEARCH_FILTERS) {
      const check = element('span', { className: 'shrink-0 font-bold', text: '✓', attrs: { 'aria-hidden': 'true', 'data-check': '' } });
      check.hidden = entry.value !== state.searchType;
      const item = element('button', {
        className: 'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-paper',
        attrs: { type: 'button', role: 'menuitem', 'aria-label': `Filter by ${entry.label}` }
      }, [element('span', { text: entry.label }), check]);
      if (entry.value === state.searchType) item.setAttribute('aria-current', 'true');
      item.addEventListener('click', () => {
        state.searchType = entry.value;
        paintFilter();
        closeFilter(true);
        // Immediate search with the current query text — including EMPTY
        // text (backend browse-mode lists recent content of that type).
        runSearch(searchInput.value.trim(), state.searchType, { browse: true });
      });
      filterItems.set(entry.value, item);
      filterMenu.appendChild(item);
    }
    paintFilter();
    filterButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (filterOpen) closeFilter(false);
      else openFilter();
    });
    filterButton.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeFilter(true); }
      if (event.key === 'ArrowDown' && !filterOpen) { event.preventDefault(); openFilter(); }
    });
    filterMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeFilter(true); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const items = [...filterItems.values()];
      const currentIndex = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown'
        ? items[(currentIndex + 1 + items.length) % items.length]
        : items[(currentIndex - 1 + items.length) % items.length];
      try { next?.focus(); } catch { /* noop */ }
    });
    document.addEventListener('click', (event) => {
      if (!filterOpen) return;
      if (filterWrap.contains(event.target)) return;
      closeFilter(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && filterOpen) closeFilter(true);
    });
    const results = element('div', { className: 'mt-4 grid min-w-0 gap-3', attrs: { 'aria-live': 'polite' } });
    const discoverHost = element('div', { className: 'mt-6 grid min-w-0 gap-6' });
    body.append(
      element('div', { className: 'grid min-w-0 gap-3' }, [searchInput, filterWrap]),
      results,
      discoverHost
    );
    // Deck rows open the shared deck viewer (same as post linked boxes).
    function deckRow(deck) {
      if (!deck || deck.id === undefined || deck.id === null) return null;
      const title = deck.title || 'Untitled deck';
      const metaParts = [];
      if (deck.ownerUsername) metaParts.push(`by @${deck.ownerUsername}`);
      if (deck.entityType) metaParts.push(deck.entityType);
      if (deck.itemCount !== undefined && deck.itemCount !== null) metaParts.push(`${Number(deck.itemCount)} items`);
      const button = element('button', {
        className: 'surface block w-full min-w-0 p-4 text-left',
        attrs: { type: 'button', 'aria-label': `Open deck ${title}` }
      }, [
        element('p', { className: 'truncate font-semibold text-ink', text: `📚 ${title}` }),
        ...(metaParts.length ? [element('p', { className: 'mt-1 truncate text-xs text-muted', text: metaParts.join(' · ') })] : [])
      ]);
      button.addEventListener('click', () => openDeckViewer(deck.id, title));
      return button;
    }
    // Reading rows open the excerpt preview (which carries Import).
    function readingRow(text) {
      if (!text || text.id === undefined || text.id === null) return null;
      const title = text.title || 'Untitled reading';
      const levelSuffix = text.level ? ` · Level ${text.level} (reference)` : '';
      const button = element('button', {
        className: 'surface block w-full min-w-0 p-4 text-left',
        attrs: { type: 'button', 'aria-label': `Preview reading ${title}` }
      }, [
        element('p', { className: 'truncate font-semibold text-ink', text: `📖 ${title}` }),
        element('p', { className: 'mt-1 truncate text-xs text-muted', text: `by @${text.ownerUsername || 'user'}${levelSuffix}`, attrs: { title: text.level ? 'Reference level — not official JLPT data' : undefined } })
      ]);
      button.addEventListener('click', () => openReadingPreview(text.id, title));
      return button;
    }
    // Learning-item hits (vocabulary/kanji/grammar): compact rows with
    // display (ja) + reading + meaning + level tag + source line. Click
    // opens the source post dialog or the source deck viewer.
    function learningRow(hit, refresh) {
      if (!hit || !hit.display) return null;
      const isPost = hit.source === 'post' && hit.postId !== null && hit.postId !== undefined;
      const isDeck = hit.source === 'deck' && hit.deckId !== null && hit.deckId !== undefined;
      if (!isPost && !isDeck) return null;
      const sourceText = isPost
        ? `shared by @${hit.authorUsername || 'user'}${hit.title ? ` · ${hit.title}` : ''}`
        : `from deck "${hit.title || 'Untitled deck'}"${hit.authorUsername ? ` by @${hit.authorUsername}` : ''}`;
      const row = element('button', {
        className: 'surface block w-full min-w-0 p-3 text-left',
        attrs: { type: 'button', 'aria-label': `${hit.display} — ${sourceText}` }
      }, [
        element('div', { className: 'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1' }, [
          element('span', { className: 'break-words font-jp text-base font-semibold text-ink', text: hit.display, attrs: { lang: 'ja' } }),
          ...(hit.reading ? [element('span', { className: 'break-words font-jp text-sm text-muted', text: hit.reading, attrs: { lang: 'ja' } })] : []),
          // Bare N5..N1 is the sharer's own tag (entityPage convention:
          // "Your label for filtering — not official reference data").
          ...(hit.level ? [element('span', { className: 'status-pill text-xs', text: hit.level, attrs: { title: 'Your tag — not official JLPT data', 'aria-label': `Your JLPT tag ${hit.level}` } })] : [])
        ]),
        ...(hit.meaning ? [element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: hit.meaning })] : []),
        element('p', { className: 'mt-1 truncate text-xs text-muted', text: sourceText })
      ]);
      row.addEventListener('click', () => {
        if (isPost) openPostDialog(hit.postId, { onProfile: openProfile, onRefresh: refresh });
        else openDeckViewer(hit.deckId, hit.title);
      });
      return row;
    }
    function discoverSection(title, subtitle) {
      const list = element('div', { className: 'grid min-w-0 gap-3' });
      const section = element('section', { className: 'grid min-w-0 gap-3', attrs: { 'aria-label': title } }, [
        element('div', { className: 'min-w-0' }, [
          element('h2', { className: 'font-semibold text-ink', text: title }),
          ...(subtitle ? [element('p', { className: 'mt-1 break-words text-sm text-muted', text: subtitle })] : [])
        ]),
        list
      ]);
      return { section, list };
    }
    let timer = null;
    searchInput.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => runSearch(searchInput.value.trim(), state.searchType), 300);
    });
    async function runSearch(query, type, opts = {}) {
      const safeType = type || state.searchType || 'all';
      // Typing keeps the 300ms debounce above; clearing the query restores
      // Discover. Filter-select passes {browse:true} so EMPTY text browses
      // recent content of that type (backend query-less browse, b6c4ab5).
      const browseMode = !query && opts.browse === true;
      if (!query && !browseMode) { results.replaceChildren(); results.setAttribute('aria-busy', 'false'); discoverHost.hidden = false; return; }
      discoverHost.hidden = true;
      results.setAttribute('aria-busy', 'true');
      results.replaceChildren(skeleton({ rows: 3, variant: 'cards', label: browseMode ? 'Browsing…' : 'Searching…' }));
      try {
        const url = browseMode
          ? `/api/community/search?type=${encodeURIComponent(safeType)}&limit=10`
          : `/api/community/search?q=${encodeURIComponent(query)}&type=${safeType}&limit=10`;
        const data = await apiRequest(url);
        const refresh = () => runSearch(query, safeType, opts);
        const blocks = [];
        const pushRow = (node) => { if (node) blocks.push(node); };
        if (safeType === 'all' || safeType === 'people') {
          for (const person of data.people || []) pushRow(personRow(person, refresh, openProfile));
        }
        if (safeType === 'all' || safeType === 'posts') {
          for (const post of data.posts || []) pushRow(postCard(post, { onProfile: openProfile, onRefresh: refresh }));
        }
        for (const key of ['vocabulary', 'kanji', 'grammar']) {
          if (safeType === 'all' || safeType === key) {
            for (const hit of data[key] || []) pushRow(learningRow(hit, refresh));
          }
        }
        if (safeType === 'all' || safeType === 'decks') {
          for (const deck of data.decks || []) pushRow(deckRow(deck));
        }
        if (safeType === 'all' || safeType === 'reading') {
          for (const text of data.reading || []) pushRow(readingRow(text));
        }
        results.replaceChildren(...(blocks.length ? blocks : [element('p', { className: 'text-sm text-muted', text: browseMode ? 'Nothing here yet. Try another filter.' : 'Nothing found. Try another search.' })]));
        results.setAttribute('aria-busy', 'false');
      } catch (error) {
        results.setAttribute('aria-busy', 'false');
        results.replaceChildren(errorState(error, () => runSearch(query, safeType, opts)));
      }
    }
    async function loadDiscover() {
      discoverHost.hidden = false;
      discoverHost.setAttribute('aria-busy', 'true');
      discoverHost.replaceChildren(skeleton({ rows: 3, variant: 'cards', label: 'Loading Discover…' }));
      try {
        const data = await apiRequest('/api/community/discover');
        const learners = Array.isArray(data?.learners) ? data.learners.slice(0, 5) : [];
        const popular = Array.isArray(data?.popular) ? data.popular.slice(0, 5) : [];
        const decks = Array.isArray(data?.content?.decks) ? data.content.decks.slice(0, 5) : [];
        const readings = Array.isArray(data?.content?.readings) ? data.content.readings.slice(0, 5) : [];
        const questions = Array.isArray(data?.questions) ? data.questions.slice(0, 5) : [];
        const sections = [];
        if (learners.length) {
          const { section, list } = discoverSection('Learners you may like', 'Active posters you do not follow yet — follow whoever inspires you.');
          for (const person of learners) {
            const row = personRow(person, () => {}, openProfile);
            if (row) list.appendChild(row);
          }
          sections.push(section);
        }
        if (popular.length) {
          const { section, list } = discoverSection('Popular this week', 'Engaging posts from the last 7 days.');
          // Post cards carry the subtle like/comment counts; the backend
          // score stays server-side (never rendered).
          for (const post of popular) {
            list.appendChild(postCard(post, { onProfile: openProfile, onRefresh: loadDiscover }));
          }
          sections.push(section);
        }
        if (decks.length || readings.length) {
          const { section, list } = discoverSection('Useful learning content', 'Recent decks and readings from the community.');
          for (const deck of decks) {
            const row = deckRow(deck);
            if (row) list.appendChild(row);
          }
          for (const text of readings) {
            const row = readingRow(text);
            if (row) list.appendChild(row);
          }
          sections.push(section);
        }
        if (questions.length) {
          const { section, list } = discoverSection('Questions', 'Open questions from learners — tap to answer.');
          for (const post of questions) {
            list.appendChild(postCard(post, { onProfile: openProfile, onRefresh: loadDiscover }));
          }
          sections.push(section);
        }
        if (!sections.length) {
          discoverHost.setAttribute('aria-busy', 'false');
          discoverHost.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Nothing to discover yet. Follow learners or share something to get started.' }));
          return;
        }
        discoverHost.setAttribute('aria-busy', 'false');
        discoverHost.replaceChildren(...sections);
      } catch (error) {
        discoverHost.setAttribute('aria-busy', 'false');
        discoverHost.replaceChildren(errorState(error, () => loadDiscover()));
      }
    }
    loadDiscover();
  }

  function personRow(person, onChange, onProfile) {
    // Followed-by signal: subtle "Follows you" text only when the backend
    // says so (search rows carry following/followsYou, follows member rows
    // carry viewerFollowing). No noise elsewhere.
    const followsYou = person?.followsYou === true;
    const rawFollowing = person?.following ?? person?.viewerFollowing ?? null;
    const hasInitial = rawFollowing === true || rawFollowing === false;
    const nameButton = element('button', { className: 'flex min-w-0 flex-1 items-center gap-3 text-left', attrs: { type: 'button', 'aria-label': `Open profile of ${person.username}` } }, [
      // Plain face here: the whole row button already navigates (buttons
      // cannot nest). Avatar renders when avatarUrl is served, else initials.
      avatarFace(person.displayName, person.username, avatarUrlFor({ avatarUrl: person.avatarUrl, authorAvatar: person.authorAvatar }), 'size-10 text-sm'),
      element('div', { className: 'min-w-0' }, [
        element('p', { className: 'truncate text-sm font-semibold text-ink', text: person.displayName || person.username }),
        element('p', { className: 'truncate text-xs text-muted', text: `@${person.username}${person.bio ? ` · ${person.bio}` : ''}` }),
        ...(followsYou ? [element('p', { className: 'truncate text-xs text-muted', text: 'Follows you' })] : [])
      ])
    ]);
    if (typeof onProfile === 'function') {
      nameButton.addEventListener('click', (event) => {
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('button') !== nameButton) return;
        onProfile(person.username);
      });
    }
    return element('div', { className: 'surface flex items-center justify-between gap-3 p-3' }, [
      nameButton,
      followButton(person.username, onChange, hasInitial ? {
        initialFollowing: rawFollowing === true,
        followsYou,
        mutual: person?.mutual === true || (rawFollowing === true && followsYou)
      } : {})
    ]);
  }

  // ---- edit own public profile (moved from Settings)
  // The same public-profile fields Settings used to own (username / bio /
  // current JLPT level / target JLPT / interests / is_public) now open in a
  // dialog from the own Community profile. Same GET prefill (/api/users/me)
  // and same PUT endpoint + payload shape byte-identically
  // ({ username: trimmed, bio, jlpt_level, target_jlpt, interests,
  // is_public }); success toasts + refreshes the profile view.
  function openEditProfileDialog(currentUsername) {
    const JLPT_PROFILE_OPTIONS = ['', 'N5', 'N4', 'N3', 'N2', 'N1'];
    const usernameInput = element('input', {
      className: 'field-control', attrs: { id: 'profile-username', name: 'username', type: 'text', maxlength: '30', autocomplete: 'username', placeholder: 'username', 'aria-describedby': 'profile-username-hint' }
    });
    const bioInput = element('textarea', {
      className: 'field-control', attrs: { id: 'profile-bio', name: 'bio', maxlength: '500', placeholder: 'A short bio (optional)' }
    });
    const levelSelect = element('select', { className: 'field-control', attrs: { id: 'profile-level', name: 'jlpt_level', 'aria-label': 'Current JLPT level' } },
      JLPT_PROFILE_OPTIONS.map((value) => element('option', { text: value === '' ? 'Current level: not set' : value, attrs: { value } })));
    const targetSelect = element('select', { className: 'field-control', attrs: { id: 'profile-target', name: 'target_jlpt', 'aria-label': 'Target JLPT level' } },
      JLPT_PROFILE_OPTIONS.map((value) => element('option', { text: value === '' ? 'Target level: not set' : value, attrs: { value } })));
    const interestsInput = element('input', {
      className: 'field-control', attrs: { id: 'profile-interests', name: 'interests', type: 'text', maxlength: '500', placeholder: 'Interests: manga, N3 grammar, travel…' }
    });
    const publicBox = element('input', { attrs: { id: 'profile-public', name: 'is_public', type: 'checkbox' } });
    const fillFrom = (saved) => {
      usernameInput.value = saved.username || '';
      bioInput.value = saved.bio || '';
      levelSelect.value = saved.jlptLevel || '';
      targetSelect.value = saved.targetJlpt || '';
      interestsInput.value = saved.interests || '';
      publicBox.checked = Boolean(saved.isPublic);
    };
    openDialog({
      title: 'Edit profile',
      description: 'Only what you publish is public.',
      content: [
        element('p', { className: 'text-sm text-muted sm:col-span-2', attrs: { id: 'profile-username-hint' }, text: 'Claim a username to be followable in Community. Only what you publish is public.' }),
        element('label', { className: 'field sm:col-span-2', attrs: { for: 'profile-username' } }, [element('span', { text: 'Username (2–30, lowercase, hyphens)' }), usernameInput]),
        element('label', { className: 'field sm:col-span-2', attrs: { for: 'profile-bio' } }, [element('span', { text: 'Bio' }), bioInput]),
        element('label', { className: 'field', attrs: { for: 'profile-level' } }, [element('span', { text: 'Current level' }), levelSelect]),
        element('label', { className: 'field', attrs: { for: 'profile-target' } }, [element('span', { text: 'Studying toward' }), targetSelect]),
        element('label', { className: 'field sm:col-span-2', attrs: { for: 'profile-interests' } }, [element('span', { text: 'Interests' }), interestsInput]),
        element('label', { className: 'flex items-center gap-2 text-sm text-ink sm:col-span-2', attrs: { for: 'profile-public' } }, [publicBox, element('span', { text: 'Public profile' })])
      ],
      submitLabel: 'Save changes',
      onSubmit: async (form, close) => {
        try {
          const saved = await apiRequest('/api/users/me', {
            method: 'PUT',
            body: {
              username: String(usernameInput.value || '').trim(),
              bio: bioInput.value,
              jlpt_level: levelSelect.value || '',
              target_jlpt: targetSelect.value || '',
              interests: interestsInput.value,
              is_public: publicBox.checked
            }
          });
          fillFrom(saved);
          showToast(saved.username ? `Public profile: ${saved.username}.` : 'Profile saved (private).');
          close();
          const next = saved.username || currentUsername;
          state.profile = next;
          renderProfile(next);
        } catch (error) {
          showToast(error?.message || 'Unable to save the public profile.', 'error');
        }
      }
    });
    // Fail-open prefill (same GET Settings used): blanks stay editable when
    // the fetch fails, so a save is still possible.
    apiRequest('/api/users/me').then(fillFrom).catch(() => {
      showToast('Could not load your profile. You can still edit and save.', 'error');
    });
  }

  // ---- profile
  async function renderProfile(username) {
    body.setAttribute('aria-busy', 'true');
    body.replaceChildren(skeleton({ rows: 2, variant: 'cards', label: 'Loading profile…' }));
    try {
      const profile = await apiRequest(`/api/community/profile/${encodeURIComponent(username)}`);
      const back = element('button', { className: 'mb-4 text-sm font-semibold text-vermilion hover:underline', text: '← Back', attrs: { type: 'button' } });
      back.addEventListener('click', backToFeed);
      // Self-only entry point to the public-profile editor dialog (moved from
      // Settings). Other viewers never see it (profile.isSelf gate).
      const editProfileButton = element('button', { className: 'mt-3 inline-block text-sm font-semibold text-vermilion hover:underline', text: 'Edit profile', attrs: { type: 'button', 'aria-label': 'Edit profile' } });
      editProfileButton.addEventListener('click', () => openEditProfileDialog(profile.username));
      const head = element('div', { className: 'surface p-5 sm:p-6' }, [
        element('div', { className: 'flex flex-wrap items-start justify-between gap-4' }, [
          element('div', { className: 'flex min-w-0 items-center gap-4' }, [
            avatarFace(profile.displayName, profile.username, avatarUrlFor(profile), 'size-16 text-xl'),
            element('div', { className: 'min-w-0' }, [
              element('h2', { className: 'truncate font-display text-xl font-semibold text-ink', text: profile.displayName || profile.username }),
              element('p', { className: 'truncate text-sm text-muted', text: `@${profile.username}` }),
              // Followed-by signal: "Follows you" pill only when the backend
              // says followsYou. Mutual lives on the follow button itself.
              ...(profile.followsYou === true ? [element('div', { className: 'mt-2 flex flex-wrap gap-2' }, [
                element('span', { className: 'status-pill text-xs', text: 'Follows you' })
              ])] : []),
              ...(profile.bio ? [element('p', { className: 'mt-1 break-words text-sm leading-6 text-ink/80', text: profile.bio })] : []),
              // The editor distinguishes Current level vs Studying toward —
              // render both labels (never bare "Studying N3" for the current
              // level). Your tags, not official JLPT data.
              ...((profile.jlptLevel || profile.targetJlpt) ? [element('p', { className: 'mt-1 break-words text-xs text-muted', text: `${profile.jlptLevel ? `Current level ${profile.jlptLevel}` : ''}${profile.jlptLevel && profile.targetJlpt ? ' · ' : ''}${profile.targetJlpt ? `Studying toward ${profile.targetJlpt}` : ''}`, attrs: { title: 'Your JLPT tags — not official data' } })] : []),
              // Interests are editable in the Edit profile dialog and served on
              // the profile payload — render them here (previously never displayed).
              ...(profile.interests ? [element('p', { className: 'mt-1 break-words text-xs text-muted', text: `Interests: ${profile.interests}` })] : [])
              // Streak: OMITTED — getCommunityProfile serves no streak key
              // (only share-stats / post stats carry streakDays). Never invent.
            ])
          ]),
          ...(profile.isSelf ? [] : [followButton(profile.username, () => {}, {
            initialFollowing: (profile.viewerFollowing ?? profile.following) === true,
            followsYou: profile.followsYou === true,
            mutual: profile.mutual === true
          })])
        ]),
        element('div', { className: 'mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm' }, [
          element('p', { className: 'text-muted', text: `${profile.counts.posts} posts · ${profile.counts.followers} followers · ${profile.counts.following} following` }),
          // Library sizes are owner-only: the backend sends null (= undisclosed,
          // never zero) for non-self viewers. Hide each null value; omit the row
          // entirely when all three are null so "null words" never renders.
          // Own profile (real numbers) renders unchanged.
          ...(() => {
            const counts = profile.counts || {};
            const parts = [
              (counts.vocabulary === null || counts.vocabulary === undefined) ? null : `${counts.vocabulary} words`,
              (counts.kanji === null || counts.kanji === undefined) ? null : `${counts.kanji} kanji`,
              (counts.grammar === null || counts.grammar === undefined) ? null : `${counts.grammar} grammar`
            ].filter(Boolean);
            if (!parts.length) return [];
            return [element('p', { className: 'text-muted', text: parts.join(' · ') })];
          })()
        ]),
        ...(profile.isSelf ? [editProfileButton] : [])
      ]);
      const lists = element('div', { className: 'mt-4 flex flex-wrap gap-2' });
      const postsHost = element('div', { className: 'mt-4 grid gap-3' });
      body.setAttribute('aria-busy', 'false');
      body.replaceChildren(back, head, lists, postsHost);
      const followersBtn = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: `Followers (${profile.counts.followers})`, attrs: { type: 'button' } });
      const followingBtn = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: `Following (${profile.counts.following})`, attrs: { type: 'button' } });
      lists.append(followersBtn, followingBtn);
      // Blocked-users management lives on the own-profile lists row (a self-only
      // "Blocked users" button beside Followers/Following — the smallest coherent
      // spot, reusing the same postsHost + loading/error primitives). Lists via
      // paged GET /api/community/blocks ({ items, pagination }); each row carries
      // an Unblock button (confirmDialog + withPendingAction pending state + toast
      // + list refresh) driving DELETE /api/community/blocks with { username }.
      // Block itself stays in the post menu — this surface only lists/unblocks.
      const showBlocked = async (page = 1, append = false) => {
        if (!append) {
          postsHost.setAttribute('aria-busy', 'true');
          postsHost.replaceChildren(skeleton({ rows: 3, variant: 'rows', label: 'Loading blocked users…' }));
        }
        try {
          const data = await apiRequest(`/api/community/blocks?page=${page}&limit=20`);
          const items = Array.isArray(data?.items) ? data.items : [];
          const pagination = data?.pagination || {};
          if (!append) postsHost.replaceChildren();
          postsHost.setAttribute('aria-busy', 'false');
          if (!items.length && page === 1) {
            postsHost.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No blocked users. People you block will appear here.' }));
            return;
          }
          for (const person of items) {
            const name = person.displayName || person.username || 'Someone';
            const unblock = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Unblock', attrs: { type: 'button', 'aria-label': `Unblock ${person.username || 'user'}` } });
            unblock.addEventListener('click', () => {
              confirmDialog({
                title: `Unblock @${person.username || 'user'}?`,
                description: 'You will be able to see each other in Community again.',
                confirmLabel: 'Unblock',
                onConfirm: async () => {
                  try {
                    await withPendingAction(unblock, async () => {
                      await apiRequest('/api/community/blocks', { method: 'DELETE', body: { username: person.username } });
                    }, { pendingLabel: 'Unblocking…' });
                    showToast('User unblocked.');
                    await showBlocked(1);
                  } catch (error) {
                    showToast(error?.message || 'Unable to unblock.', 'error');
                  }
                }
              });
            });
            postsHost.appendChild(element('div', { className: 'surface flex items-center justify-between gap-3 p-3' }, [
              element('div', { className: 'flex min-w-0 flex-1 items-center gap-3' }, [
                avatarFace(person.displayName, person.username, avatarUrlFor({ avatarUrl: person.avatarUrl, authorAvatar: person.authorAvatar }), 'size-10 text-sm'),
                element('div', { className: 'min-w-0' }, [
                  element('p', { className: 'truncate text-sm font-semibold text-ink', text: name }),
                  ...(person.username ? [element('p', { className: 'truncate text-xs text-muted', text: `@${person.username}` })] : [])
                ])
              ]),
              unblock
            ]));
          }
          if (Number(pagination.totalPages || 0) > page) {
            const more = element('button', { className: 'button-secondary min-h-9 self-center px-3 py-1.5 text-xs', text: 'Load more', attrs: { type: 'button' } });
            more.addEventListener('click', () => { more.remove(); showBlocked(page + 1, true); });
            postsHost.appendChild(more);
          }
        } catch (error) {
          postsHost.setAttribute('aria-busy', 'false');
          if (!append) postsHost.replaceChildren(errorState(error, () => showBlocked(1)));
          else showToast(error?.message || 'Unable to load more.', 'error');
        }
      };
      if (profile.isSelf) {
        const blockedBtn = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Blocked users', attrs: { type: 'button' } });
        blockedBtn.addEventListener('click', () => showBlocked(1));
        lists.append(blockedBtn);
      }
      const showList = async (direction) => {
        postsHost.setAttribute('aria-busy', 'true');
        postsHost.replaceChildren(skeleton({ rows: 3, variant: 'rows', label: 'Loading…' }));
        try {
          const data = await apiRequest(`/api/community/users/${encodeURIComponent(username)}/${direction}?limit=20`);
          const items = Array.isArray(data?.items) ? data.items : [];
          postsHost.setAttribute('aria-busy', 'false');
          postsHost.replaceChildren(...(items.length ? items.map((person) => personRow({ username: person.username, displayName: person.displayName, avatarUrl: person.avatarUrl, bio: person.bio, viewerFollowing: person.viewerFollowing, following: person.following ?? person.viewerFollowing, followsYou: person.followsYou, mutual: person.mutual }, showList.bind(null, direction), openProfile)) : [element('p', { className: 'text-sm text-muted', text: 'Nobody here yet.' })]));
        } catch (error) {
          postsHost.setAttribute('aria-busy', 'false');
          postsHost.replaceChildren(errorState(error, () => showList(direction)));
        }
      };
      followersBtn.addEventListener('click', () => showList('followers'));
      followingBtn.addEventListener('click', () => showList('following'));
      // Author timeline through the same gated feed.
      const loadAuthorPosts = async () => {
        postsHost.setAttribute('aria-busy', 'true');
        postsHost.replaceChildren(skeleton({ rows: 2, variant: 'cards', label: 'Loading posts…' }));
        try {
          const data = await apiRequest(`/api/community/feed?tab=latest&author=${encodeURIComponent(username)}&page=1&limit=10`);
          const items = Array.isArray(data?.items) ? data.items : [];
          postsHost.setAttribute('aria-busy', 'false');
          postsHost.replaceChildren(...(items.length
            ? items.map((post) => postCard(post, { onProfile: openProfile, onRefresh: () => renderProfile(username) }))
            : [element('p', { className: 'text-sm text-muted', text: 'No public posts yet.' })]));
        } catch (error) {
          postsHost.setAttribute('aria-busy', 'false');
          postsHost.replaceChildren(errorState(error, () => loadAuthorPosts()));
        }
      };
      await loadAuthorPosts();
    } catch (error) {
      body.setAttribute('aria-busy', 'false');
      const backButton = element('button', { className: 'mb-4 text-sm font-semibold text-vermilion hover:underline', text: '← Back', attrs: { type: 'button' } });
      backButton.addEventListener('click', backToFeed);
      // Gated (private/blocked/missing) profiles 404 with the same
      // "User not found." shape — show an honest locked state, not a
      // generic load error. Other failures keep errorState with retry.
      if (error?.status === 404) {
        body.replaceChildren(backButton, emptyState({
          title: '🔒 This profile is private',
          description: 'This learner keeps their profile private, or the account is no longer available.'
        }));
        return;
      }
      body.replaceChildren(backButton, errorState(error, () => renderProfile(username)));
    }
  }

  // ---- notifications
  async function openNotifications() {
    let page = 1;
    const list = element('div', { className: 'grid gap-2' });
    const moreWrap = element('div', { className: 'flex justify-center' });
    async function load(reset = false) {
      if (reset) page = 1;
      if (reset) {
        list.setAttribute('aria-busy', 'true');
        list.replaceChildren(skeleton({ rows: 3, variant: 'rows', label: 'Loading notifications…' }));
      } else {
        list.setAttribute('aria-busy', 'true');
        list.appendChild(skeleton({ rows: 1, variant: 'rows', label: 'Loading notifications…' }));
      }
      try {
        const data = await apiRequest(`/api/community/notifications?page=${page}&limit=15`);
        const items = Array.isArray(data?.items) ? data.items : [];
        list.querySelectorAll('[role="status"]').forEach((node) => node.remove());
        if (reset) list.replaceChildren();
        list.setAttribute('aria-busy', 'false');
        if (!items.length && page === 1) {
          list.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No notifications yet. Likes, comments and follows will appear here.' }));
        }
        for (const note of items) {
          // Backend context: actorDisplayName (canonical, actorDisplay kept
          // for compat) + excerpt (<=80 chars or null). Render "Yuki liked
          // your post" + excerpt 「…」 underneath + relative timestamp.
          // Follow-kind rows (no post) deep-link to the actor profile.
          const actorName = note.actorDisplayName || note.actorDisplay || note.actorUsername || 'Someone';
          const label = note.kind === 'like'
            ? 'liked your post'
            : note.kind === 'comment' ? 'commented on your post' : note.kind === 'reply' ? 'replied to your comment' : 'started following you';
          const kindLine = element('p', { className: 'break-words text-sm font-medium text-ink', text: `${actorName} ${label}.` });
          const excerptLine = note.excerpt
            ? element('p', { className: 'mt-0.5 break-words text-xs text-muted', text: `「${note.excerpt}」` })
            : null;
          const stamp = timeAgo(note.createdAt) || (note.createdAt ? new Date(note.createdAt).toLocaleString() : '');
          const timeLine = stamp ? element('p', { className: 'mt-0.5 text-xs text-muted', text: stamp }) : null;
          const row = element('button', {
            className: `flex w-full min-w-0 items-start gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-left ${note.isRead ? '' : 'border-ink/40'}`,
            attrs: { type: 'button', 'aria-label': `${actorName} ${label}` }
          }, [
            (() => {
              const actorAvatar = avatarUrlFor({ actorAvatar: note.actorAvatar, avatarUrl: note.avatarUrl });
              if (actorAvatar) return avatarFace(note.actorDisplayName || note.actorDisplay, note.actorUsername, actorAvatar, 'size-8 text-xs');
              return element('span', { className: 'mt-0.5 shrink-0', text: note.kind === 'like' ? '❤️' : note.kind === 'comment' || note.kind === 'reply' ? '💬' : '👤', attrs: { 'aria-hidden': 'true' } });
            })(),
            element('div', { className: 'min-w-0 flex-1' }, [kindLine, excerptLine, timeLine].filter(Boolean))
          ]);
          row.addEventListener('click', async () => {
            try {
              if (!note.isRead) await apiRequest(`/api/community/notifications/${note.id}/read`, { method: 'POST' });
            } catch { /* best-effort */ }
            if (note.postId) {
              closePanel();
              openPostDialog(note.postId, { onProfile: openProfile, onRefresh: () => {} });
            } else if (note.actorUsername) {
              closePanel();
              openProfile(note.actorUsername);
            }
            // Cheap badge refresh after the read + navigation (1 indexed COUNT).
            refreshOverflowBadge();
          });
          list.appendChild(row);
        }
        const totalPages = Number(data?.pagination?.totalPages || 0);
        moreWrap.replaceChildren();
        if (page < totalPages) {
          const more = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'See more', attrs: { type: 'button' } });
          more.addEventListener('click', () => { page += 1; load(); });
          moreWrap.appendChild(more);
        }
        // Phase 7: no per-page badge fetch — badge refreshes on mount + after
        // the inbox dialog closes (cheap unread-count), never during paging.
      } catch (error) {
        list.querySelectorAll('[role="status"]').forEach((node) => node.remove());
        list.setAttribute('aria-busy', 'false');
        list.replaceChildren(errorState(error, () => load(true)));
      }
    }
    const markAll = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Mark all read', attrs: { type: 'button' } });
    markAll.addEventListener('click', async () => {
      try {
        await apiRequest('/api/community/notifications/read-all', { method: 'POST' });
        await load(true);
      } catch (error) {
        showToast(error?.message || 'Unable to update.', 'error');
      }
    });
    const closePanel = openDialog({
      title: 'Notifications',
      description: '',
      content: [element('div', { className: 'grid gap-3' }, [markAll, list, moreWrap])],
      submitLabel: 'Close',
      // Phase 7: cheap badge refresh after the inbox closes (mount + close only).
      onSubmit: async (form, close) => { close(); refreshOverflowBadge().catch(() => {}); }
    });
    load(true);
  }

  await refreshOverflowBadge();
  await showTab('feed');
  refreshOverflowBadge().catch(() => {});
}
