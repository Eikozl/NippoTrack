// V6.0 Community feed — source assertions. No DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('community shell owns tabs, legacy hub mounts as Decks', () => {
  const shell = readSource('src/pages/community.js');
  assert.ok(shell.includes('export async function renderDecksHub'), 'legacy hub preserved under its own export');
  assert.ok(shell.includes("export async function renderCommunity"), 'shell keeps the route entry');
  assert.ok(shell.includes('mountSocialFeed'), 'shell delegates to the feed module');
  const feed = readSource('src/pages/communityFeed.js');
  for (const tab of ['feed', 'following', 'discover', 'decks']) {
    assert.ok(feed.includes(`key: '${tab}'`), `${tab} tab exists`);
  }
  assert.ok(feed.includes('renderDecksHub(body)'), 'Decks tab mounts the untouched hub');
});

test('composer covers all post types with existing pickers', () => {
  const source = readSource('src/pages/communityFeed.js');
  for (const type of ['text', 'example', 'question', 'progress', 'share_deck', 'share_reading', 'share_vocab', 'share_kanji', 'share_grammar']) {
    assert.ok(source.includes(`'${type}'`), `composer type ${type} exists`);
  }
  assert.ok(source.includes('/api/vocabulary/options'), 'entity picker reuses options endpoints');
  assert.ok(source.includes('/api/decks?mine=true'), 'deck picker lists own decks inline');
  assert.ok(!source.includes('loadOptions('), 'no dangling picker helper calls');
  assert.ok(source.includes('/api/reading/publications'), 'reading picker reuses publications');
  assert.ok(source.includes('/api/community/posts'), 'publishes through the posts endpoint');
});

test('post cards show identity, counts and learning actions', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('authorDisplay'), 'display name shown');
  assert.ok(source.includes('likeCount') && source.includes('commentCount'), 'counts shown');
  assert.ok(source.includes('function timeAgo'), 'relative dates, no raw timestamps');
  assert.ok(source.includes('Save to library'), 'save action present');
  assert.ok(source.includes('/api/reading/publications/'), 'reading import reuses the idempotent endpoint');
  assert.ok(source.includes('Open deck'), 'shared decks open with per-item save');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML anywhere in social rendering');
});

test('reading posts preview the text inside the detail dialog', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('openReadingPreview'), 'reading titles open a dedicated excerpt dialog');
  assert.ok(source.includes('/api/reading/publications/${encodeURIComponent(post.readingId)}') || source.includes('/api/reading/publications/${encodeURIComponent(readingId)}'), 'excerpt fetched from the public endpoint');
});

test('deck viewer lays items out in a wrapping multi-column grid', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('grid-cols-2') && source.includes('xl:grid-cols-3'), 'columns from mobile up, more when space allows');
});

test('composer stays collapsed behind a summary toggle', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('data-composer'), 'composer identifiable');
  assert.ok(source.includes('aria-expanded'), 'toggle exposes state');
  assert.ok(source.includes('setCollapsed(true)'), 'collapses after publish');
});

test('shared deck items show han characters, never generic placeholders', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function deckItemDisplay'), 'per-type display mapping exists');
  assert.ok(source.includes('character_kanji') && source.includes('grammar_point'), 'kanji and grammar columns mapped');
});

test('own posts can be edited through the existing endpoint', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Edit post'), 'edit menu entry for own posts');
  assert.ok(source.includes('/api/community/posts/${post.id}'), 'update reuses the posts endpoint');
});

test('likes, comments, follows, reports and blocks all wire to endpoints', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/like'), 'like toggle endpoint used');
  assert.ok(source.includes('/comments'), 'comments endpoints used');
  assert.ok(source.includes('/api/community/follow'), 'follow endpoint used');
  assert.ok(source.includes('/api/community/unfollow'), 'unfollow endpoint used');
  assert.ok(source.includes('/api/community/reports'), 'report endpoint used');
  assert.ok(source.includes('/api/community/blocks'), 'block endpoint used');
  assert.ok(source.includes('Delete post'), 'own-post delete present');
});

test('profiles show counts, follow and timelines without private data', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/profile/'), 'profile endpoint used');
  assert.ok(source.includes('followers') && source.includes('following'), 'relationship counts shown');
  assert.ok(!source.includes('email'), 'no email anywhere in social UI');
  assert.ok(source.includes('author='), 'timeline reuses the gated feed');
});

test('notifications bell tracks unread and opens an inbox', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/notifications'), 'inbox endpoint used');
  assert.ok(source.includes('notifications/read-all') || source.includes('markAll'), 'mark-all-read present');
  assert.ok(source.includes('unread'), 'unread badge tracked');
});

test('discover sections come from a single discover fetch', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/discover'), 'single discover fetch');
  for (const heading of ['Learners you may like', 'Popular this week', 'Useful learning content', 'Questions']) {
    assert.ok(source.includes(heading), `section "${heading}" exists`);
  }
  assert.ok(source.includes('slice(0, 5)'), 'each backend list capped at 5');
  assert.ok(source.includes('Loading Discover'), 'one loading state for the whole fetch');
  assert.ok(source.includes('errorState(error'), 'one error state with retry');
  assert.ok(source.includes('if (learners.length)'), 'learners section hides when empty');
  assert.ok(source.includes('if (popular.length)'), 'popular section hides when empty');
  assert.ok(source.includes('if (questions.length)'), 'questions section hides when empty');
  assert.ok(source.includes('if (!sections.length)'), 'all-empty still guides instead of 4 empty states');
  assert.ok(!source.includes('.score'), 'raw popular score never rendered');
  assert.ok(!source.includes('Active learners'), 'old derived label removed');
  assert.ok(!source.includes('tab=discover&page'), 'old derived discover-feed fetch removed');
  assert.ok(source.includes('personRow(person'), 'learners reuse personRow with Follow + Follows-you');
  assert.ok(source.includes('postCard(post'), 'popular/questions reuse post cards opening the post dialog');
  assert.ok(source.includes("element('section'"), 'sections use landmark sections');
  assert.ok(source.includes("element('h2'"), 'sections have headings');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML in discover rendering');
});

test('discover deck and reading rows open live viewers, never dead ends', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function deckRow'), 'deck rows extend the shared renderer');
  assert.ok(source.includes('function readingRow'), 'reading rows extend the shared renderer');
  assert.ok(source.includes('openDeckViewer(deck.id'), 'deck row opens the deck viewer');
  assert.ok(source.includes('openReadingPreview(text.id'), 'reading row opens the excerpt preview');
  assert.ok(source.includes('importReadingButton(readingId)'), 'preview carries Import');
  assert.ok(source.includes('Open deck'), 'deck viewer affordance labeled');
  assert.ok(source.includes('Preview reading'), 'reading row labeled for keyboard/screen-reader reach');
  assert.ok(source.includes('min-w-0'), 'rows bound widths so 360px never overflows');
});

test('search offers category chips and compact learning rows', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/search'), 'search endpoint used');
  for (const value of ["value: 'all'", "value: 'people'", "value: 'posts'", "value: 'vocabulary'", "value: 'kanji'", "value: 'grammar'", "value: 'decks'", "value: 'reading'"]) {
    assert.ok(source.includes(value), `chip ${value} exists`);
  }
  assert.ok(source.includes('Search category'), 'chip group labeled');
  assert.ok(source.includes('aria-pressed'), 'chip selection exposed');
  assert.ok(source.includes('function learningRow'), 'learning hits render compact rows');
  assert.ok(source.includes('font-jp'), 'display uses Japanese type');
  assert.ok(source.includes("lang: 'ja'"), 'display/reading tagged lang=ja');
  assert.ok(source.includes('hit.display') && source.includes('hit.reading') && source.includes('hit.meaning'), 'display + reading + meaning shown');
  assert.ok(source.includes('hit.level'), 'level tag shown');
  assert.ok(source.includes('shared by @'), 'post source credits the sharer');
  assert.ok(source.includes('from deck'), 'deck source names the deck');
  assert.ok(source.includes('openPostDialog(hit.postId'), 'post hit opens the source post dialog');
  assert.ok(source.includes('openDeckViewer(hit.deckId'), 'deck hit opens the source deck viewer');
  assert.ok(source.includes('clearTimeout') && source.includes('setTimeout'), 'debounce preserved');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML in search rendering');
});

test('legacy latest and following tabs stay untouched', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function feedLoader'), 'paged feed loader preserved');
  assert.ok(source.includes("state.tab === 'following'"), 'following tab still routes');
  assert.ok(source.includes("'following' : 'latest'") || source.includes("'latest'"), 'latest tab still routes');
  assert.ok(source.includes('composerCard'), 'composer untouched');
  assert.ok(source.includes('Your community is quiet'), 'following empty state untouched');
});

test('avatars and names both open profiles', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Open profile of'), 'profile entry points labeled');
  assert.ok(source.includes('tabs.appendChild(bell)'), 'bell sits in the bottom pill with the tabs');
});

test('empty states guide instead of dead-ending', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Your community is quiet'), 'empty following guides to discover');
  assert.ok(source.includes('Discover learners'), 'empty following offers an action');
  assert.ok(source.includes('No posts yet'), 'empty latest invites creation');
});

test('settings edits the full public identity incl. visibility', () => {
  const source = readSource('src/pages/settings.js');
  for (const marker of ['profile-level', 'profile-target', 'profile-interests', 'profile-public', 'jlpt_level', 'target_jlpt']) {
    assert.ok(source.includes(marker), `settings edits ${marker}`);
  }
});

test('reply threads nest single-level with inline composer', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('parentCommentId'), 'reply create sends parentCommentId');
  assert.ok(source.includes('replyCount') && source.includes('replies'), 'listComments replies + replyCount consumed');
  assert.ok(source.includes('Reply to'), 'top-level Reply affordance with composer placeholder');
  assert.ok(source.includes('aria-label'), 'reply buttons labeled');
  assert.ok(source.includes('See ${remaining} more'), 'overflow count renders as muted text');
  assert.ok(source.includes('Cancel reply') && source.includes('Send reply'), 'composer has send/cancel');
  assert.ok(source.includes('Report reply') || source.includes('Report comment'), 'report affordance on threads');
  assert.ok(!source.includes('/comments/like') && !source.includes('commentLike'), 'no comment likes added');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML in reply rendering');
});

test('notification inbox shows excerpt, actor and time with follow deep-link', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('excerpt'), 'excerpt rendered under the kind line');
  assert.ok(source.includes('actorDisplayName'), 'canonical actor display name consumed');
  assert.ok(source.includes('timeAgo(note.createdAt)'), 'notification timestamp present');
  assert.ok(source.includes('openProfile(note.actorUsername)'), 'follow rows link to actor profile');
});

test('followed-by signals show without noise', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Follows you'), 'follows-you pill/text present');
  assert.ok(source.includes('Mutual'), 'mutual button state present');
  assert.ok(source.includes('viewerFollowing'), 'canonical viewerFollowing consumed');
  assert.ok(source.includes('followsYou'), 'followsYou consumed');
});

test('progress composer attaches verified stats without sending numbers', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/share-stats'), 'share-stats fetched for preview');
  assert.ok(source.includes('Attach my stats'), 'attach toggle labeled');
  assert.ok(source.includes('includeStats'), 'publish sends the flag only');
  assert.ok(!source.includes('streakDays:'), 'no client-computed numbers sent (server mints the snapshot)');
  assert.ok(source.includes('last 30 days'), 'window note shown (last 30 days)');
  assert.ok(source.includes('Loading your stats'), 'loading state for the preview fetch');
  assert.ok(source.includes('Stats are unavailable'), 'error state keeps manual posting possible');
});

test('progress cards present the verified snapshot, manual-only stays body-only', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function statsBlock'), 'shared snapshot renderer exists');
  assert.ok(source.includes('verified snapshot'), 'honesty note present, never claims live data');
  assert.ok(source.includes('stats.asOf') || source.includes('stats?.asOf') || source.includes('asOf'), 'asOf date shown');
  assert.ok(source.includes("post.postType === 'progress'"), 'progress-gated rendering');
  assert.ok(source.includes('post.stats'), 'additive stats key consumed (null when absent)');
});

test('honesty gates block invented glosses from the library and review', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(!source.includes('Saved from Community'), 'invented gloss string gone from save paths');
  assert.ok(source.includes('function isUsableMeaning'), 'usable-meaning gate reused from review.js');
  assert.ok(source.includes('No dictionary meaning available'), 'honest disabled reason shown');
  assert.ok(source.includes('disabled'), 'ungated Save renders disabled');
  assert.ok(source.includes('entityCreateBody(post.entityType'), 'single saves gate through the body builder');
});

test('kanji saves require a single Han character before any request', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Script=Han'), 'single-Han validation present (same as Decks hub)');
  assert.ok(source.includes('single kanji character is required'), 'honest error toast, no request fired');
  assert.ok(source.includes('deckItemSaveable'), 'deck per-item gating reuses the same rule');
});

test('shared vocab/kanji/grammar boxes gain Practice and Details via existing routes only', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Practice in Review'), 'practice action present');
  assert.ok(source.includes("href: '#review'"), 'practice links the existing review hub');
  assert.ok(source.includes('save first to include'), 'practice never claims the item is queued');
  assert.ok(source.includes('kanji-reference/'), 'kanji details reuse the existing reference route');
  assert.ok(source.includes('function detailsLink') || source.includes('Details'), 'details helper present with omission for vocab/grammar');
});

test('shared deck viewer adds Start Review beside Save-all with gated per-item saves', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Start Review'), 'deck viewer review entry present');
  assert.ok(source.includes("href: '#review'"), 'deck review links the existing hub, no new study logic');
  assert.ok(source.includes('topRow') || source.includes('Save all'), 'save-all stays beside the new link');
  assert.ok(source.includes("lang: 'ja'"), 'deck han labels tagged lang=ja');
});

test('shared readings keep Import and preview-as-Read with Analyze honestly omitted', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('importReadingButton(readingId)'), 'import reuses the idempotent endpoint');
  assert.ok(source.includes('openReadingPreview'), 'preview stays the Read entry (no bogus publication-id reader link)');
  assert.ok(source.includes('Analyze') && source.includes('OMITTED'), 'omission documented in code (no prefill support)');
  assert.ok(!source.includes('#analyzer?text=') && !source.includes('#immersion?text='), 'no fabricated prefill routes invented');
});

test('japanese examples save gated plus TTS, never fabricated analysis', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function exampleActions'), 'per-example actions exist');
  assert.ok(source.includes('Save as vocab'), 'example save present');
  assert.ok(source.includes('speakJapanese'), 'TTS reuses the shared speech infrastructure');
  assert.ok(source.includes('playJapaneseText'), 'single-utterance wrapper, no queue invention');
  assert.ok(!source.includes('<ruby') && !source.includes('furigana:'), 'no fabricated ruby/furigana markup');
});

test('jlpt labels qualify bare levels and profile renders both settings fields', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Current level') && source.includes('Studying toward'), 'profile shows both settings labels, never bare Studying N3');
  assert.ok(source.includes('Your tag') || source.includes('Your JLPT tag'), 'level pills qualified per entityPage convention');
  assert.ok(source.includes('not official'), 'reference disclaimer present');
  assert.ok(!source.includes('Studying ${profile.jlptLevel}'), 'old misleading profile string removed');
});

test('kana/kanji reading nodes carry lang=ja and characters wording stays unified', () => {
  const source = readSource('src/pages/communityFeed.js');
  const langCount = source.split("lang: 'ja'").length - 1;
  assert.ok(langCount >= 8, `at least 8 lang=ja nodes after the fix, got ${langCount}`);
  assert.ok(source.includes('snapshot.display, attrs: { lang'), 'shared display tagged');
  assert.ok(source.includes('snapshot.reading'), 'shared reading tagged');
  assert.ok(source.includes('characters'), 'unified characters wording kept');
});

test('composer groups all 9 types under optgroups with identical payloads', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('COMPOSER_GROUPS'), 'grouped definition exists alongside the flat list');
  assert.ok(source.includes("element('optgroup'"), 'compact select-based grouping (no card grid)');
  for (const label of ['Discuss', 'Japanese', 'Progress', 'Learning material']) {
    assert.ok(source.includes(`label: '${label}'`), `group "${label}" exists`);
  }
  for (const value of ['text', 'example', 'question', 'progress', 'share_deck', 'share_reading', 'share_vocab', 'share_kanji', 'share_grammar']) {
    assert.ok(source.includes(`value: '${value}'`), `grouped picker keeps type value ${value}`);
  }
  assert.ok(source.includes('What do you want to share?'), 'picker has a short discovery label');
  assert.ok(source.includes('aria-live') && source.includes('composerGroupFor'), 'one-line per-group description updates with selection');
  // Payloads byte-identical: same value drives the same conditional fields.
  assert.ok(source.includes('const payload = { postType: type }'), 'publish still keys off the select value');
  assert.ok(source.includes('payload.body') && source.includes('payload.japaneseText'), 'body/japaneseText wiring untouched');
  assert.ok(source.includes('payload.translation') && source.includes('payload.includeStats'), 'translation/verified-stats flag untouched');
  assert.ok(source.includes('Object.assign(payload, link)'), 'linked-content payload untouched');
  assert.ok(source.includes("type === 'example'") && source.includes("type.startsWith('share_')"), 'conditional field gates untouched');
  assert.ok(source.includes('statsWrap.hidden'), 'progress stats gate untouched');
});

test('avatars render img with lazy + fallback wherever identity is served', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes("element('img'"), 'avatar <img> rendered when served');
  assert.ok(source.includes('loading') && source.includes('lazy'), 'avatars lazy-load');
  assert.ok(source.includes('alt:'), 'avatars carry alt="{name}"');
  assert.ok(source.includes("addEventListener('error'"), 'onerror fallback hides the img revealing initials');
  assert.ok(source.includes('initialsFor'), 'initials remain the fallback');
  assert.ok(source.includes('authorAvatar') && source.includes('avatarUrl') && source.includes('actorAvatar'), 'all served avatar keys consumed');
  assert.ok(source.includes('avatarUrlFor'), 'single safe resolver for every surface');
  assert.ok(source.includes('avatarFace('), 'shared face renderer reused');
  assert.ok(source.includes('avatarFace(reply.authorDisplay'), 'replies render avatars');
  assert.ok(source.includes('avatarFace(comment.authorDisplay'), 'comments render avatars');
  assert.ok(source.includes('avatarFace(note.actorDisplayName'), 'notifications render actor avatars');
  assert.ok(source.includes('avatarFace(profile.displayName'), 'profiles render avatars');
  assert.ok(source.includes('avatarFace(person.displayName'), 'person rows / followers lists render avatars');
  assert.ok(!source.toLowerCase().includes('avatar upload'), 'no avatar upload UI (backend does not exist)');
});

test('profiles render interests, gate honestly, and never invent a streak', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('profile.interests'), 'interests consumed from the served profile payload');
  assert.ok(source.includes('Interests:'), 'interests rendered with a compact label');
  assert.ok(source.includes('This profile is private'), 'honest locked state for gated profiles');
  assert.ok(source.includes('error?.status === 404'), 'gated/404 branch reuses the existing handling');
  assert.ok(source.includes('emptyState({'), 'private state guides instead of erroring');
  assert.ok(!source.includes('profile.streak'), 'no invented profile streak (payload serves none)');
});

test('comment/menu polish uses errorState, Escape, and loading-first viewers', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(!source.includes('Search is unavailable.'), 'search errors use errorState, not plain <p>');
  assert.ok(!source.includes('Notifications are unavailable.'), 'notification errors use errorState, not plain <p>');
  assert.ok(!source.includes('Comments are unavailable.'), 'comment errors use errorState, not plain <p>');
  assert.ok(!source.includes('Unable to load.'), 'followers errors use errorState, not plain <p>');
  assert.ok(!source.includes('Posts are unavailable.'), 'author-timeline errors use errorState, not plain <p>');
  assert.ok(source.includes('errorState(error, () => runSearch'), 'search retry preserved');
  assert.ok(source.includes('errorState(error, () => reloadComments'), 'comments retry preserved');
  assert.ok(source.includes('errorState(error, () => showList'), 'followers retry preserved');
  assert.ok(source.includes('errorState(error, () => load'), 'timeline/notifications/deck viewers retry in place');
  assert.ok(source.includes("'Escape'") && source.includes('close(true)'), 'post menu Escape-closes');
  assert.ok(source.includes('toggle.focus()'), 'post menu returns focus to the toggle');
  assert.ok(source.includes("loadingState('Loading deck"), 'deck viewer opens with a skeleton first');
  assert.ok(source.includes("loadingState('Loading preview"), 'reading preview opens with a skeleton first');
  assert.ok(source.includes('errorState(error, () => loadDeck'), 'deck errors stay in-dialog with retry');
  assert.ok(source.includes('errorState(error, () => loadPreview'), 'preview errors stay in-dialog with retry');
});

test('phase 7: like costs one mutation without full feed reload', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/posts/${post.id}/like'), 'like mutation present');
  assert.ok(source.includes('function likeButton(post)'), 'like button takes post only (no onRefresh reload)');
  assert.ok(!source.includes('likeButton(post, onRefresh)'), 'like no longer wires full feed reload');
  assert.ok(source.includes('post.liked') && source.includes('post.likeCount'), 'local count delta + painted state kept');
  assert.ok(source.includes('Unable to like.'), 'like failure toasts (with revert)');
  assert.ok(source.includes('prevLiked') && source.includes('prevCount'), 'failure reverts to previous state');
  assert.ok(source.includes('await reloadComments()'), 'comment list reload kept where load-bearing for the visible list');
  assert.ok(source.includes('postMenuButton(post, onRefresh)'), 'menu edit/delete/block still refresh (load-bearing)');
});

test('phase 7: bell badge uses cheap unread-count, inbox flows unchanged', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/notifications/unread-count'), 'badge uses cheap unread-count');
  assert.ok(!source.includes('/api/community/notifications?limit=1'), 'expensive list?limit=1 badge fetch removed');
  assert.ok(source.includes('/api/community/notifications?page='), 'inbox paging unchanged');
  assert.ok(source.includes('/notifications/${note.id}/read'), 'single mark-read unchanged');
  assert.ok(source.includes('/notifications/read-all'), 'mark-all unchanged');
});

test('own profile manages blocked users with an unblock path', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/blocks?page='), 'blocked list uses the paged GET endpoint');
  assert.ok(source.includes("method: 'DELETE'") && source.includes('/api/community/blocks'), 'unblock uses DELETE /api/community/blocks');
  assert.ok(source.includes('Blocked users'), 'self-only entry point beside Followers/Following');
  assert.ok(source.includes('profile.isSelf'), 'blocked surface is self-only');
  assert.ok(source.includes('Unblock'), 'per-row unblock action with confirm');
  assert.ok(source.includes('Unblock @'), 'unblock confirm names the user');
  assert.ok(source.includes('Unblocking…'), 'unblock pending state');
  assert.ok(source.includes('User unblocked.'), 'unblock success toast plus list refresh');
  assert.ok(source.includes('Unable to unblock.'), 'unblock failure toast');
  assert.ok(source.includes('No blocked users.'), 'blocked empty state guides');
  assert.ok(source.includes('Loading blocked users'), 'blocked loading state');
  assert.ok(source.includes('Load more'), 'blocked paging beyond page one');
});

test('profile library counts hide undisclosed null values', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(!source.includes('${profile.counts.vocabulary} words'), 'no raw null-vocabulary interpolation');
  assert.ok(!source.includes('${profile.counts.kanji} kanji'), 'no raw null-kanji interpolation');
  assert.ok(!source.includes('${profile.counts.grammar} patterns'), 'no raw null-grammar interpolation');
  assert.ok(source.includes('undisclosed'), 'null-means-undisclosed documented in code');
  assert.ok(source.includes("parts.join(' · ')"), 'remaining non-null values joined, row omitted when all null');
  assert.ok(source.includes('posts} posts'), 'public posts/followers/following row unchanged');
});

test('phase 7: flagged rows reuse follow flags without per-row profile fetch', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('viewerFollowing') && source.includes('followsYou'), 'follow flags consumed');
  assert.ok(source.includes('hasInitial'), 'flagged rows skip the fetch');
  assert.ok(source.includes('initialFollowing'), 'initial state comes from the payload');
  assert.ok(source.includes('/api/community/profile/${encodeURIComponent(username)}'), 'single profile fetch kept only where flags are genuinely absent (post dialog)');
  assert.ok(source.includes('genuinely absent'), 'absent-flags surface documented in code');
});

test('bottom nav restyles the existing tabs node as a floating glass pill', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('community-bottom-nav'), 'pill owns a dedicated class');
  assert.ok(source.includes('backdrop-blur'), 'glass background uses backdrop blur');
  assert.ok(source.includes('bg-paper/80'), 'translucent surface');
  assert.ok(source.includes('rounded-full'), 'pill shape');
  assert.ok(source.includes('safe-area-inset-bottom'), 'home-indicator safe area respected');
  assert.ok(source.includes('fixed bottom-4') && source.includes('-translate-x-1/2'), 'fixed bottom, centered placement');
  assert.ok(source.includes('max-w-md'), 'desktop width capped');
  assert.ok(source.includes('paddingBottom'), 'content reserve so the pill never covers the last posts');
  assert.ok(!source.includes('button-secondary min-h-9 px-3 py-1.5 text-sm'), 'old top tab buttons removed');
  assert.ok(!source.includes('ml-auto'), 'old trailing-bell alignment removed');
});

test('bottom nav carries six icon-only buttons with aria-labels, no emoji', () => {
  const source = readSource('src/pages/communityFeed.js');
  for (const label of ['Feed', 'Following', 'Discover', 'Share something', 'Notifications', 'Decks']) {
    assert.ok(source.includes(label), `icon button labeled "${label}"`);
  }
  assert.ok(!source.includes('🔔'), 'no emoji bell anywhere in the new bar');
  assert.ok(source.includes("icon('bell'"), 'bell reuses the monochrome icons.js set');
  assert.ok(source.includes("iconName: 'home'") && source.includes("iconName: 'users'") && source.includes("iconName: 'search'"), 'feed/following/discover glyphs come from icons.js');
  assert.ok(source.includes("icon('plus'") && source.includes("iconName: 'dots'"), 'share/decks glyphs come from icons.js');
  assert.ok(source.includes('min-h-11') && source.includes('min-w-11'), 'compact 44px touch targets fit 360px');
  assert.ok(source.includes('bg-vermilion'), 'vermilion unread count badge kept (it carries information)');
  assert.ok(source.includes('unread notifications'), 'badge aria-label updates kept');
});

test('bottom nav keeps tab semantics, keyboard reachability and active state', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes("'tablist'"), 'pill keeps the tablist role');
  assert.ok(source.includes("role: 'tab'"), 'section entries keep role=tab');
  assert.ok(source.includes('aria-selected'), 'selection stays exposed');
  assert.ok(source.includes("element('button'"), 'real buttons, keyboard reachable');
  const styles = readSource('src/styles.css');
  assert.ok(styles.includes('button:focus-visible'), 'global focus-visible ring covers the pill buttons');
  assert.ok(source.includes("classList.toggle('is-active'"), 'active pill highlight toggles with the tab');
  assert.ok(styles.includes('.community-bottom-nav [role="tab"].is-active'), 'active state styled in the shared stylesheet');
});

test('share entry reuses the feed composer instead of inventing a new one', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('data-composer'), 'share targets the existing composer');
  assert.ok(source.includes("showTab('feed')"), 'share switches to the feed tab when needed');
  assert.ok(source.includes('scrollIntoView'), 'share scrolls to the composer');
  assert.ok(source.includes('.focus('), 'share focuses the composer');
  assert.ok(source.includes('aria-expanded'), 'share expands the collapsed composer');
  assert.ok(source.includes("showTab('decks')"), 'decks overflow entry still mounts the untouched hub');
});

test('community nav glyphs all resolve inside the shared icons.js set', () => {
  const source = readSource('src/icons.js');
  for (const key of ['home:', 'users:', 'bell:', 'plus:', 'dots:']) {
    assert.ok(source.includes(key), `icons.js serves "${key}"`);
  }
  assert.ok(source.includes('House') && source.includes('Users') && source.includes('Bell') && source.includes('Plus') && source.includes('Ellipsis'), 'lucide glyphs reused, no inline one-off SVG');
});
