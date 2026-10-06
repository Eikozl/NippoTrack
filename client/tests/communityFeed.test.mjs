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

test('discover has search plus honest people suggestions', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('/api/community/search'), 'search endpoint used');
  assert.ok(source.includes('Active learners'), 'suggestions labeled by what they are');
});

test('avatars and names both open profiles', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Open profile of'), 'profile entry points labeled');
  assert.ok(source.includes('tabs.appendChild(bell)'), 'bell sits last in the tabs row, aligned with tabs');
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
