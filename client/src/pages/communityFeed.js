// V6.0 Social Community feed: tabs, composer, post cards, profiles,
// notifications, search, and learning actions. The legacy decks hub stays
// untouched (mounted as the Decks tab). All bodies render via textContent;
// all identity comes from the server payloads (req.user.id server-side).
import { apiRequest } from '../api';
import {
  element, emptyState, errorState, loadingState, openDialog, confirmDialog,
  showToast, withPendingAction
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

function avatarNode(post, onProfile) {
  const face = element('span', {
    className: 'grid size-10 shrink-0 place-items-center rounded-full bg-ink font-display text-sm font-semibold text-paper',
    text: initialsFor(post.authorDisplay, post.authorUsername),
    attrs: { 'aria-hidden': 'true' }
  });
  // Usernames AND avatars open profiles — discoverability must not depend
  // on hitting the small handle text.
  if (post.authorUsername && typeof onProfile === 'function') {
    const button = element('button', {
      className: 'shrink-0 rounded-full',
      attrs: { type: 'button', 'aria-label': `Open profile of ${post.authorUsername}` }
    });
    button.addEventListener('click', (event) => { event.stopPropagation(); onProfile(post.authorUsername); });
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

function entityCreateEndpoint(entityType) {
  return entityType === 'vocabulary' ? '/api/vocabulary' : entityType === 'kanji' ? '/api/kanji' : '/api/grammar';
}

function entityCreateBody(entityType, snapshot) {
  if (entityType === 'vocabulary') {
    return { word: snapshot.display, ...(snapshot.reading ? { reading: snapshot.reading } : {}), meaning: snapshot.meaning || 'Saved from Community' };
  }
  if (entityType === 'kanji') {
    return { character_kanji: snapshot.display, meaning: snapshot.meaning || 'Saved from Community' };
  }
  return { grammar_point: snapshot.display, meaning: snapshot.meaning || 'Saved from Community' };
}

export async function mountSocialFeed({ tabs, body, renderDecksHub }) {
  const state = {
    tab: 'feed',
    pages: { feed: 1, following: 1, discover: 1 },
    profile: null,
    searchQuery: '',
    searchType: 'all'
  };

  const tabDefs = [
    { key: 'feed', label: 'Feed' },
    { key: 'following', label: 'Following' },
    { key: 'discover', label: 'Discover' },
    { key: 'decks', label: 'Decks' }
  ];
  const tabButtons = new Map();
  for (const def of tabDefs) {
    const button = element('button', {
      className: 'button-secondary min-h-9 px-3 py-1.5 text-sm',
      text: def.label,
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' }
    });
    button.addEventListener('click', () => showTab(def.key));
    tabButtons.set(def.key, button);
    tabs.appendChild(button);
  }

  // Notifications bell sits last in the tabs row, aligned with the tab
  // buttons (never floating in the header).
  const bell = element('button', {
    className: 'icon-button relative ml-auto min-h-9',
    attrs: { type: 'button', 'aria-label': 'Notifications' }
  });
  const bellBadge = element('span', {
    className: 'absolute -right-1 -top-1 hidden min-w-5 place-items-center rounded-full bg-vermilion px-1 text-[10px] font-bold text-paper',
    text: '0',
    attrs: { 'aria-label': 'unread notifications' }
  });
  bellBadge.style.display = 'none';
  bell.append(document.createTextNode('🔔'), bellBadge);
  bell.addEventListener('click', openNotifications);
  tabs.appendChild(bell);
  async function refreshBell() {
    try {
      const inbox = await apiRequest('/api/community/notifications?limit=1');
      const unread = Number(inbox?.unread || 0);
      bellBadge.textContent = unread > 99 ? '99+' : String(unread);
      bellBadge.style.display = unread > 0 ? 'grid' : 'none';
      bell.setAttribute('aria-label', unread > 0 ? `${unread} unread notifications` : 'Notifications');
    } catch {
      bellBadge.style.display = 'none';
    }
  }

  function setTabPressed() {
    for (const [key, button] of tabButtons) {
      const active = key === state.tab && !state.profile;
      button.setAttribute('aria-selected', String(active));
      button.classList.toggle('is-active', active);
    }
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
  function likeButton(post, onChange) {
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
      withPendingAction(button, async () => {
        const updated = await apiRequest(`/api/community/posts/${post.id}/like`, { method: 'POST' });
        post.liked = updated.liked === true;
        post.likeCount = Number(updated.likeCount || 0);
        paint(post.liked, post.likeCount);
        if (typeof onChange === 'function') onChange(post);
      }).catch((error) => showToast(error?.message || 'Unable to like.', 'error'));
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
    const close = () => { menu.classList.add('hidden'); toggle.setAttribute('aria-expanded', 'false'); };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = menu.classList.contains('hidden');
      menu.classList.toggle('hidden', !open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', close);
    const addItem = (label, handler) => {
      const itemButton = element('button', {
        className: 'flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-paper',
        text: label, attrs: { type: 'button', role: 'menuitem' }
      });
      // Stop bubbling: without this the click reaches the post card
      // underneath and opens the detail dialog on top of the confirm.
      itemButton.addEventListener('click', (event) => { event.stopPropagation(); close(); handler(); });
      menu.appendChild(itemButton);
    };
    if (post.mine) {
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
      return element('div', { className: 'mt-3 rounded-xl border border-stone bg-paper p-3' }, [
        element('p', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: '📖 Reading' }),
        element('p', { className: 'mt-1 break-words font-semibold text-ink', text: title }),
        ...(snapshot ? [element('p', { className: 'mt-1 text-xs text-muted', text: `${snapshot.level || 'No level'}${snapshot.chars ? ` · ${Number(snapshot.chars).toLocaleString()} characters` : ''}` })] : []),
        element('div', { className: 'mt-2 flex flex-wrap gap-2' }, [importReadingButton(post.readingId)])
      ]);
    }
    if ((post.postType === 'share_vocab' || post.postType === 'share_kanji' || post.postType === 'share_grammar') && snapshot?.display) {
      return element('div', { className: 'mt-3 rounded-xl border border-stone bg-paper p-3' }, [
        element('p', { className: 'text-xs font-semibold uppercase tracking-wide text-muted', text: 'Shared learning item' }),
        element('p', { className: 'mt-1 break-words font-jp text-lg font-semibold text-ink', text: snapshot.display }),
        ...(snapshot.reading ? [element('p', { className: 'break-words font-jp text-sm text-muted', text: snapshot.reading })] : []),
        ...(snapshot.meaning ? [element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: snapshot.meaning })] : []),
        element('div', { className: 'mt-2 flex flex-wrap gap-2' }, [saveEntityButton(post)])
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
    let detail = null;
    try {
      detail = await apiRequest(`/api/decks/${encodeURIComponent(deckId)}`);
    } catch (error) {
      showToast(error?.message || 'Unable to open the deck.', 'error');
      return;
    }
    const items = Array.isArray(detail?.items) ? detail.items : [];
    const rows = element('div', { className: 'grid gap-2' });
    const saveAll = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: `Save all (${items.length}) to my library`, attrs: { type: 'button' } });
    const savedIds = new Set();
    const paintRows = () => {
      rows.replaceChildren(...items.map((entry, index) => {
        const kind = entry.entityType || detail.entityType || 'vocabulary';
        const label = entry.display || entry.word || entry.title || `Item ${index + 1}`;
        const saved = savedIds.has(`${kind}:${label}`);
        const save = element('button', {
          className: 'button-secondary min-h-8 shrink-0 px-2.5 py-1 text-xs',
          text: saved ? 'Saved ✓' : 'Save',
          attrs: { type: 'button', ...(saved ? { disabled: '' } : {}) }
        });
        if (!saved) {
          save.addEventListener('click', async () => {
            const ok = await saveDeckItem(kind, entry);
            if (ok) { savedIds.add(`${kind}:${label}`); paintRows(); }
          });
        }
        return element('div', { className: 'flex items-center justify-between gap-3 rounded-xl border border-stone bg-paper px-3 py-2' }, [
          element('div', { className: 'min-w-0' }, [
            element('p', { className: 'truncate font-jp text-sm font-semibold text-ink', text: label }),
            ...(entry.meaning ? [element('p', { className: 'truncate text-xs text-muted', text: entry.meaning })] : [])
          ]),
          save
        ]);
      }));
    };
    paintRows();
    saveAll.addEventListener('click', () => withPendingAction(saveAll, async () => {
      let saved = 0;
      let skipped = 0;
      for (const entry of items) {
        const kind = entry.entityType || detail.entityType || 'vocabulary';
        // eslint-disable-next-line no-await-in-loop
        if (await saveDeckItem(kind, entry)) {
          saved += 1;
          savedIds.add(`${kind}:${entry.display || entry.word || entry.title}`);
        } else skipped += 1;
      }
      paintRows();
      showToast(saved ? `Saved ${saved} item${saved === 1 ? '' : 's'}${skipped ? `, ${skipped} already saved` : ''}.` : 'Everything was already saved.', saved ? 'success' : 'info');
    }).catch((error) => showToast(error?.message || 'Unable to save.', 'error')));
    openDialog({
      title: title || 'Shared deck',
      description: `${items.length} items`,
      content: [element('div', { className: 'grid gap-3' }, [saveAll, rows])],
      submitLabel: 'Close',
      onSubmit: async (form, close) => close()
    });
  }

  function openDeckViewerRefresh() {}

  async function saveDeckItem(kind, entry) {
    const display = entry.display || entry.word || entry.title;
    const meaning = entry.meaning || 'Saved from Community';
    if (!display) return false;
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
    const button = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Save to library', attrs: { type: 'button' } });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      withPendingAction(button, async () => {
        await apiRequest(entityCreateEndpoint(post.entityType), { method: 'POST', body: entityCreateBody(post.entityType, snapshot) });
        showToast('Saved to your library.');
      }, { pendingLabel: 'Saving…' }).catch((error) => showToast(error?.message || 'Unable to save (it may already be saved).', 'error'));
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
    const box = linkedBox(post);
    if (box) {
      box.addEventListener('click', (event) => event.stopPropagation());
      card.appendChild(box);
    }
    const foot = element('div', { className: 'mt-3 flex items-center gap-1 border-t border-stone pt-3' }, [
      likeButton(post, onRefresh),
      commentButton(post, () => openPostDialog(post.id, { onProfile, onRefresh, focusComments: true }))
    ]);
    foot.addEventListener('click', (event) => event.stopPropagation());
    card.appendChild(foot);
    return card;
  }

  function openPostDialog(postId, { onProfile, onRefresh, focusComments = false } = {}) {
    apiRequest(`/api/community/posts/${encodeURIComponent(postId)}`).then((post) => {
      const like = likeButton(post, onRefresh);
      const commentsWrap = element('div', { className: 'grid gap-2' }, [element('p', { className: 'text-sm text-muted', text: 'Loading comments…' })]);
      const input = element('input', { className: 'field-control', attrs: { type: 'text', maxlength: '1000', placeholder: 'Write a comment…', 'aria-label': 'Write a comment' } });
      const send = element('button', { className: 'icon-button shrink-0', text: '➤', attrs: { type: 'button', 'aria-label': 'Send comment' } });
      const submitComment = () => withPendingAction(send, async () => {
        const text = String(input.value || '').trim();
        if (!text) { showToast('Write something first.', 'error'); return; }
        await apiRequest(`/api/community/posts/${post.id}/comments`, { method: 'POST', body: { body: text } });
        input.value = '';
        post.commentCount = Number(post.commentCount || 0) + 1;
        await reloadComments();
        if (typeof onRefresh === 'function') onRefresh();
      }).catch((error) => showToast(error?.message || 'Unable to comment.', 'error'));
      send.addEventListener('click', submitComment);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submitComment(); } });
      async function reloadComments() {
        try {
          const data = await apiRequest(`/api/community/posts/${post.id}/comments?limit=30`);
          const items = Array.isArray(data?.items) ? data.items : [];
          if (!items.length) {
            commentsWrap.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No comments yet. Start the conversation.' }));
            return;
          }
          commentsWrap.replaceChildren(...items.map((comment) => {
            const isEdited = (() => {
              try {
                if (!comment.updatedAt || !comment.createdAt) return false;
                return Math.abs(new Date(comment.updatedAt).getTime() - new Date(comment.createdAt).getTime()) > 1000;
              } catch {
                return false;
              }
            })();
            const bodyText = element('p', { className: 'mt-1 break-words text-sm leading-6 text-ink/90', text: comment.body });
            const editedNote = element('p', { className: 'mt-1 text-xs italic text-muted', text: 'edited' });
            editedNote.hidden = !isEdited;
            const row = element('div', { className: 'rounded-xl border border-stone bg-paper p-3' }, [
              element('div', { className: 'flex items-center justify-between gap-2' }, [
                element('p', { className: 'truncate text-xs font-semibold text-ink', text: comment.authorDisplay || comment.authorUsername || 'Someone' }),
                comment.mine ? element('div', { className: 'flex shrink-0 items-center gap-1' }, [
                  element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Edit', attrs: { type: 'button', 'aria-label': 'Edit comment' } }),
                  element('button', { className: 'icon-button icon-button--danger shrink-0', text: '🗑', attrs: { type: 'button', 'aria-label': 'Delete comment' } })
                ]) : element('span', { className: 'text-xs text-muted', text: timeAgo(comment.createdAt) })
              ]),
              bodyText,
              editedNote
            ]);
            if (comment.mine) {
              const [editButton, deleteButton] = row.querySelectorAll('button');
              editButton?.addEventListener('click', () => {
                const area = element('textarea', { className: 'field-control mt-2 min-h-16 w-full', attrs: { rows: '2', maxlength: '1000', 'aria-label': 'Edit comment' } });
                area.value = comment.body;
                const save = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Save', attrs: { type: 'button' } });
                const cancel = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Cancel', attrs: { type: 'button' } });
                const editor = element('div', { className: 'mt-2 grid gap-2' }, [area, element('div', { className: 'flex gap-2' }, [save, cancel])]);
                bodyText.replaceWith(editor);
                area.focus();
                cancel.addEventListener('click', () => editor.replaceWith(bodyText));
                save.addEventListener('click', () => withPendingAction(save, async () => {
                  const text = String(area.value || '').trim();
                  if (!text) { showToast('Write something first.', 'error'); return; }
                  const updated = await apiRequest(`/api/community/comments/${comment.id}`, { method: 'PUT', body: { body: text } });
                  comment.body = updated?.body || text;
                  comment.updatedAt = new Date().toISOString();
                  bodyText.textContent = comment.body;
                  editor.replaceWith(bodyText);
                  editedNote.hidden = false;
                  showToast('Comment updated.');
                }).catch((error) => showToast(error?.message || 'Unable to update.', 'error')));
              });
              deleteButton?.addEventListener('click', () => {
                confirmDialog({
                  title: 'Delete this comment?',
                  description: 'This cannot be undone.',
                  confirmLabel: 'Delete',
                  onConfirm: async () => {
                    try {
                      await apiRequest(`/api/community/comments/${comment.id}`, { method: 'DELETE' });
                      post.commentCount = Math.max(0, Number(post.commentCount || 1) - 1);
                      await reloadComments();
                      if (typeof onRefresh === 'function') onRefresh();
                    } catch (error) {
                      showToast(error?.message || 'Unable to delete.', 'error');
                    }
                  }
                });
              });
            }
            return row;
          }));
        } catch {
          commentsWrap.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Comments are unavailable.' }));
        }
      }
      const followRow = (post.mine || !post.authorUsername) ? null : followButton(post.authorUsername, () => {});
      openDialog({
        title: `${post.authorDisplay || post.authorUsername || 'Someone'} · ${POST_TYPE_LABEL[post.postType] || post.postType}`,
        description: post.createdAt ? new Date(post.createdAt).toLocaleString() : '',
        content: [element('div', { className: 'grid gap-3' }, [
          ...(post.japaneseText ? [element('p', { className: 'break-words font-jp text-lg leading-8 text-ink', text: post.japaneseText, attrs: { lang: 'ja' } })] : []),
          ...(post.title ? [element('p', { className: 'break-words font-semibold text-ink', text: post.title })] : []),
          ...(post.body ? [element('p', { className: 'break-words text-sm leading-6 text-ink/90', text: post.body })] : []),
          ...(post.translation ? [element('p', { className: 'break-words text-sm leading-6 text-muted', text: post.translation })] : []),
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

  function followButton(username, onChange) {
    const button = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Follow', attrs: { type: 'button' } });
    let following = null;
    const paint = () => {
      button.textContent = following ? 'Following ✓' : 'Follow';
      button.setAttribute('aria-pressed', String(following === true));
    };
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      withPendingAction(button, async () => {
        if (following) {
          await apiRequest('/api/community/unfollow', { method: 'POST', body: { username } });
          following = false;
        } else {
          await apiRequest('/api/community/follow', { method: 'POST', body: { username } });
          following = true;
        }
        paint();
        if (typeof onChange === 'function') onChange(following);
      }).catch((error) => showToast(error?.message || 'Unable to update follow.', 'error'));
    });
    apiRequest(`/api/community/profile/${encodeURIComponent(username)}`).then((profile) => {
      following = profile.following === true;
      paint();
    }).catch(() => { paint(); });
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

  // ---- composer
  function composerCard(onPublished) {
    const wrap = element('div', { className: 'surface p-4 sm:p-5' });
    const typeSelect = element('select', { className: 'field-control', attrs: { 'aria-label': 'Post type' } },
      COMPOSER_TYPES.map((type) => element('option', { text: type.label, attrs: { value: type.value } })));
    const titleInput = element('input', { className: 'field-control', attrs: { type: 'text', maxlength: '200', placeholder: 'Title (optional)', 'aria-label': 'Post title' } });
    const bodyInput = element('textarea', { className: 'field-control min-h-24 w-full', attrs: { rows: '3', maxlength: '2000', placeholder: "What's on your mind?", 'aria-label': 'Post text' } });
    const japaneseInput = element('textarea', { className: 'field-control min-h-20 w-full', attrs: { rows: '2', maxlength: '2000', placeholder: 'Japanese sentence…', 'aria-label': 'Japanese text' } });
    const translationInput = element('textarea', { className: 'field-control min-h-16 w-full', attrs: { rows: '2', maxlength: '2000', placeholder: 'Translation (optional)…', 'aria-label': 'Translation' } });
    const linkBox = element('div', { className: 'grid gap-2' });
    const fields = element('div', { className: 'mt-3 grid gap-3' });
    const publish = element('button', { className: 'button-primary mt-3 min-h-11 px-5 py-2.5 text-sm font-semibold', text: 'Publish', attrs: { type: 'button' } });
    let link = {};
    async function paintLink() {
      link = {};
      const type = typeSelect.value;
      const showJapanese = type === 'example';
      const showLink = type.startsWith('share_');
      japaneseInput.hidden = !showJapanese;
      translationInput.hidden = !(showJapanese || type === 'text' || type === 'question');
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
    typeSelect.addEventListener('change', paintLink);
    publish.addEventListener('click', () => withPendingAction(publish, async () => {
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
      Object.assign(payload, link);
      const post = await apiRequest('/api/community/posts', { method: 'POST', body: payload });
      titleInput.value = '';
      bodyInput.value = '';
      japaneseInput.value = '';
      translationInput.value = '';
      showToast('Published to Community.');
      if (typeof onPublished === 'function') onPublished(post);
    }, { pendingLabel: 'Publishing…' }).catch((error) => showToast(error?.message || 'Unable to publish.', 'error')));
    fields.append(typeSelect, titleInput, bodyInput, japaneseInput, translationInput, linkBox, publish);
    wrap.append(
      element('div', { className: 'flex items-center gap-3' }, [element('h2', { className: 'font-semibold text-ink', text: 'Share something' })]),
      element('p', { className: 'mt-1 text-sm text-muted', text: 'Post an example, a question, a milestone — or share learning content.' }),
      fields
    );
    paintLink();
    return wrap;
  }

  // ---- feed tabs
  function feedLoader(host, tab) {
    let page = 1;
    const list = element('div', { className: 'grid gap-3' });
    const moreWrap = element('div', { className: 'mt-4 flex justify-center' });
    host.replaceChildren(list, moreWrap);
    async function load(reset = false) {
      if (reset) { page = 1; list.replaceChildren(); }
      list.appendChild(loadingState('Loading posts…'));
      try {
        const data = await apiRequest(`/api/community/feed?tab=${tab}&page=${page}&limit=10`);
        const items = Array.isArray(data?.items) ? data.items : [];
        list.querySelectorAll('[role="status"]').forEach((node) => node.remove());
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
    // UI tab "feed" is the backend "latest" tab everywhere, composer
    // refresh included (the backend only knows latest/following/discover;
    // sending "feed" 400s with a scary error right after publishing).
    const apiTab = state.tab === 'following' ? 'following' : 'latest';
    const listHost = element('div', { className: 'mt-5' });
    const refreshFeed = () => feedLoader(listHost, apiTab);
    if (state.tab === 'feed') {
      body.appendChild(composerCard(() => refreshFeed()));
    }
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
          body.querySelector('select')?.focus();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
    });
  }

  // ---- discover: search + people
  function renderDiscover() {
    body.replaceChildren();
    const searchInput = element('input', { className: 'field-control', attrs: { type: 'search', placeholder: 'Search people, posts, decks, readings…', 'aria-label': 'Search community' } });
    const typeSelect = element('select', { className: 'field-control sm:max-w-44', attrs: { 'aria-label': 'Search type' } },
      [['all', 'All'], ['posts', 'Posts'], ['people', 'People'], ['decks', 'Decks'], ['reading', 'Reading']]
        .map(([value, label]) => element('option', { text: label, attrs: { value } })));
    const results = element('div', { className: 'mt-4 grid gap-3' });
    const people = element('div', { className: 'mt-6' });
    body.append(
      element('div', { className: 'grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]' }, [searchInput, typeSelect]),
      results,
      people
    );
    let timer = null;
    searchInput.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => runSearch(searchInput.value.trim(), typeSelect.value), 300);
    });
    typeSelect.addEventListener('change', () => runSearch(searchInput.value.trim(), typeSelect.value));
    async function runSearch(query, type) {
      if (!query) { results.replaceChildren(); return; }
      results.replaceChildren(loadingState('Searching…'));
      try {
        const data = await apiRequest(`/api/community/search?q=${encodeURIComponent(query)}&type=${type}&limit=10`);
        const blocks = [];
        for (const person of data.people || []) {
          blocks.push(personRow(person, () => runSearch(query, type), openProfile));
        }
        for (const post of data.posts || []) {
          blocks.push(postCard(post, { onProfile: openProfile, onRefresh: () => runSearch(query, type) }));
        }
        for (const deck of data.decks || []) {
          blocks.push(element('button', {
            className: 'surface metric-link block w-full p-4 text-left',
            text: `📚 ${deck.title} — by @${deck.ownerUsername || 'user'}`,
            attrs: { type: 'button' }
          }));
        }
        for (const text of data.reading || []) {
          const row = element('div', { className: 'surface flex items-center justify-between gap-3 p-4' }, [
            element('div', { className: 'min-w-0' }, [
              element('p', { className: 'truncate font-semibold text-ink', text: `📖 ${text.title}` }),
              element('p', { className: 'text-xs text-muted', text: `by @${text.ownerUsername || 'user'}${text.level ? ` · ${text.level}` : ''}` })
            ])
          ]);
          blocks.push(row);
        }
        results.replaceChildren(...(blocks.length ? blocks : [element('p', { className: 'text-sm text-muted', text: 'Nothing found. Try another search.' })]));
      } catch {
        results.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Search is unavailable.' }));
      }
    }
    // People suggestions from recent community activity (honest label).
    people.appendChild(element('h2', { className: 'font-semibold text-ink', text: 'Active learners' }));
    people.appendChild(element('p', { className: 'mt-1 text-sm text-muted', text: 'People posting recently — follow whoever inspires you.' }));
    const suggestHost = element('div', { className: 'mt-3 grid gap-2' });
    people.appendChild(suggestHost);
    apiRequest('/api/community/feed?tab=discover&page=1&limit=20').then((data) => {
      const seen = new Map();
      for (const post of data?.items || []) {
        if (!post.authorUsername || post.mine) continue;
        if (!seen.has(post.authorUsername)) {
          seen.set(post.authorUsername, { username: post.authorUsername, displayName: post.authorDisplay, avatarUrl: post.authorAvatar });
        }
        if (seen.size >= 5) break;
      }
      suggestHost.replaceChildren(...[...seen.values()].map((person) => personRow(person, () => {}, openProfile)));
      if (!seen.size) suggestHost.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No active learners yet.' }));
    }).catch(() => suggestHost.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Suggestions are unavailable.' })));
  }

  function personRow(person, onChange, onProfile) {
    const nameButton = element('button', { className: 'flex min-w-0 flex-1 items-center gap-3 text-left', attrs: { type: 'button', 'aria-label': `Open profile of ${person.username}` } }, [
      // Plain face here: the whole row button already navigates (buttons
      // cannot nest).
      avatarNode({ authorDisplay: person.displayName, authorUsername: person.username }, null),
      element('div', { className: 'min-w-0' }, [
        element('p', { className: 'truncate text-sm font-semibold text-ink', text: person.displayName || person.username }),
        element('p', { className: 'truncate text-xs text-muted', text: `@${person.username}${person.bio ? ` · ${person.bio}` : ''}` })
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
      followButton(person.username, onChange)
    ]);
  }

  // ---- profile
  async function renderProfile(username) {
    body.replaceChildren(loadingState('Loading profile…'));
    try {
      const profile = await apiRequest(`/api/community/profile/${encodeURIComponent(username)}`);
      const back = element('button', { className: 'mb-4 text-sm font-semibold text-vermilion hover:underline', text: '← Back', attrs: { type: 'button' } });
      back.addEventListener('click', backToFeed);
      const head = element('div', { className: 'surface p-5 sm:p-6' }, [
        element('div', { className: 'flex flex-wrap items-start justify-between gap-4' }, [
          element('div', { className: 'flex min-w-0 items-center gap-4' }, [
            element('span', {
              className: 'grid size-16 shrink-0 place-items-center rounded-full bg-ink font-display text-xl font-semibold text-paper',
              text: initialsFor(profile.displayName, profile.username),
              attrs: { 'aria-hidden': 'true' }
            }),
            element('div', { className: 'min-w-0' }, [
              element('h2', { className: 'truncate font-display text-xl font-semibold text-ink', text: profile.displayName || profile.username }),
              element('p', { className: 'truncate text-sm text-muted', text: `@${profile.username}` }),
              ...(profile.bio ? [element('p', { className: 'mt-1 break-words text-sm leading-6 text-ink/80', text: profile.bio })] : []),
              ...((profile.jlptLevel || profile.targetJlpt) ? [element('p', { className: 'mt-1 text-xs text-muted', text: `${profile.jlptLevel ? `Studying ${profile.jlptLevel}` : ''}${profile.jlptLevel && profile.targetJlpt ? ' → ' : ''}${profile.targetJlpt || ''}` })] : [])
            ])
          ]),
          ...(profile.isSelf ? [] : [followButton(profile.username, () => {})])
        ]),
        element('div', { className: 'mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm' }, [
          element('p', { className: 'text-muted', text: `${profile.counts.posts} posts · ${profile.counts.followers} followers · ${profile.counts.following} following` }),
          element('p', { className: 'text-muted', text: `${profile.counts.vocabulary} words · ${profile.counts.kanji} kanji · ${profile.counts.grammar} patterns` })
        ]),
        ...(profile.isSelf ? [element('a', { className: 'mt-3 inline-block text-sm font-semibold text-vermilion hover:underline', text: 'Edit profile in Settings', attrs: { href: '#settings' } })] : [])
      ]);
      const lists = element('div', { className: 'mt-4 flex gap-2' });
      const postsHost = element('div', { className: 'mt-4 grid gap-3' });
      body.replaceChildren(back, head, lists, postsHost);
      const followersBtn = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: `Followers (${profile.counts.followers})`, attrs: { type: 'button' } });
      const followingBtn = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: `Following (${profile.counts.following})`, attrs: { type: 'button' } });
      lists.append(followersBtn, followingBtn);
      const showList = async (direction) => {
        postsHost.replaceChildren(loadingState('Loading…'));
        try {
          const data = await apiRequest(`/api/community/users/${encodeURIComponent(username)}/${direction}?limit=20`);
          const items = Array.isArray(data?.items) ? data.items : [];
          postsHost.replaceChildren(...(items.length ? items.map((person) => personRow({ username: person.username, displayName: person.displayName, avatarUrl: person.avatarUrl, bio: person.bio }, showList.bind(null, direction), openProfile)) : [element('p', { className: 'text-sm text-muted', text: 'Nobody here yet.' })]));
        } catch {
          postsHost.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Unable to load.' }));
        }
      };
      followersBtn.addEventListener('click', () => showList('followers'));
      followingBtn.addEventListener('click', () => showList('following'));
      // Author timeline through the same gated feed.
      postsHost.replaceChildren(loadingState('Loading posts…'));
      try {
        const data = await apiRequest(`/api/community/feed?tab=latest&author=${encodeURIComponent(username)}&page=1&limit=10`);
        const items = Array.isArray(data?.items) ? data.items : [];
        postsHost.replaceChildren(...(items.length
          ? items.map((post) => postCard(post, { onProfile: openProfile, onRefresh: () => renderProfile(username) }))
          : [element('p', { className: 'text-sm text-muted', text: 'No public posts yet.' })]));
      } catch {
        postsHost.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Posts are unavailable.' }));
      }
    } catch (error) {
      const backButton = element('button', { className: 'mb-4 text-sm font-semibold text-vermilion hover:underline', text: '← Back', attrs: { type: 'button' } });
      backButton.addEventListener('click', backToFeed);
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
      try {
        const data = await apiRequest(`/api/community/notifications?page=${page}&limit=15`);
        const items = Array.isArray(data?.items) ? data.items : [];
        if (reset) list.replaceChildren();
        if (!items.length && page === 1) {
          list.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No notifications yet. Likes, comments and follows will appear here.' }));
        }
        for (const note of items) {
          const label = note.kind === 'like'
            ? `liked your post`
            : note.kind === 'comment' ? `commented on your post` : `started following you`;
          const row = element('button', {
            className: `flex w-full items-center gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-left text-sm ${note.isRead ? '' : 'border-ink/40'}`,
            attrs: { type: 'button' }
          }, [
            element('span', { text: note.kind === 'like' ? '❤️' : note.kind === 'comment' ? '💬' : '👤', attrs: { 'aria-hidden': 'true' } }),
            element('span', { className: 'min-w-0', text: `${note.actorDisplay || note.actorUsername || 'Someone'} ${label}.` })
          ]);
          row.addEventListener('click', async () => {
            try {
              if (!note.isRead) await apiRequest(`/api/community/notifications/${note.id}/read`, { method: 'POST' });
            } catch { /* best-effort */ }
            if (note.postId) {
              closePanel();
              openPostDialog(note.postId, { onProfile: openProfile, onRefresh: () => {} });
            }
            refreshBell();
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
        refreshBell();
      } catch {
        list.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Notifications are unavailable.' }));
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
      onSubmit: async (form, close) => close()
    });
    load(true);
  }

  await refreshBell();
  await showTab('feed');
  refreshBell().catch(() => {});
}
