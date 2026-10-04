// Public decks page: browse public decks, follow, view items, manage own
// decks (suggestions inbox + analytics), collections and public profile.
// Vanilla, fail-open sections: each block loads independently.
import { apiRequest } from '../api';
import { element, emptyState, errorState, loadingState, openDialog, pageHeader, showToast, withPendingAction } from '../ui';
import { speakJapanese } from '../speech.js';

function section(title, description) {
  const body = element('div', { className: 'grid gap-3' });
  const wrap = element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': title } }, [
    element('h2', { className: 'font-semibold text-ink', text: title }),
    element('p', { className: 'mt-1 text-sm text-muted', text: description }),
    body
  ]);
  return { wrap, body };
}

function deckCard(deck, actions = []) {
  return element('article', { className: 'rounded-md bg-paper p-3' }, [
    element('p', { className: 'font-medium text-ink', text: `${deck.title} · ${deck.entityType || ''}` }),
    ...(deck.description ? [element('p', { className: 'mt-1 text-sm text-muted', text: deck.description })] : []),
    element('p', { className: 'mt-1 text-xs text-muted', text: `${deck.itemCount ?? '?'} items · ${deck.followers ?? 0} followers` }),
    ...(actions.length ? [element('div', { className: 'mt-2 flex flex-col gap-2 sm:flex-row' }, actions)] : [])
  ]);
}

function smallButton(label, ariaLabel) {
  return element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: label, attrs: { type: 'button', 'aria-label': ariaLabel || label } });
}

function viewItemsDialog(deckId, title) {
  apiRequest(`/api/decks/${deckId}`)
    .then((detail) => {
      const items = Array.isArray(detail.items) ? detail.items : [];
      const playAll = smallButton('Play all', 'Play all items aloud');
      playAll.addEventListener('click', () => {
        const first = items.map((entry) => entry.word || entry.character_kanji || entry.grammar_point).find(Boolean);
        if (!first) { showToast('Nothing to play.', 'error'); return; }
        const verdict = speakJapanese(first, {
          synthesis: typeof window !== 'undefined' ? window.speechSynthesis : null,
          Utterance: typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null
        });
        if (!verdict.ok) showToast(verdict.message || 'Audio playback is unavailable.', 'error');
      });
      openDialog({
        title: title || 'Deck',
        description: `${items.length} items (first word plays aloud).`,
        content: [
          playAll,
          element('ul', { className: 'grid max-h-56 gap-1 overflow-y-auto text-sm text-ink', attrs: { role: 'list' } }, items.map((entry) => {
            const item = entry.word || entry.character_kanji || entry.grammar_point || 'item';
            return element('li', { text: item });
          }))
        ],
        submitLabel: 'Close',
        onSubmit: async (form, close) => { close(); }
      });
    })
    .catch((error) => showToast(error?.message || 'Unable to load the deck.', 'error'));
}

export async function renderDecks(container) {
  container.replaceChildren(pageHeader({
    eyebrow: 'Social',
    title: 'Decks',
    description: 'Public decks to follow, your publications, collections and public profile.'
  }));
  const browse = section('Browse public decks', 'Follow decks you like. Publishing snapshots your items.');
  const mine = section('My decks', 'Your publications with suggestions and analytics.');
  const collections = section('Collections', 'Group decks into playlists and share them as one code.');
  const profile = section('Public profile', 'Claim a username to be followable. Only what you publish is public.');
  container.append(browse.wrap, mine.wrap, collections.wrap, profile.wrap);

  // Browse
  browse.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading public decks…' }));
  try {
    const data = await apiRequest('/api/decks?limit=20');
    const decks = Array.isArray(data?.items) ? data.items : [];
    if (!decks.length) {
      browse.body.replaceChildren(emptyState({ title: 'No public decks yet', description: 'Publish one from Vocabulary, Kanji or Grammar.' }));
    } else {
      browse.body.replaceChildren(element('div', { className: 'grid gap-3' }, decks.map((deck) => {
        const follow = smallButton('Follow', `Follow ${deck.title}`);
        follow.addEventListener('click', () => {
          withPendingAction(follow, async () => {
            const result = await apiRequest(`/api/decks/${deck.id}/follow`, { method: 'POST' });
            showToast(`Following (${result.followers} followers).`);
          }).catch((error) => showToast(error?.message || 'Unable to follow the deck.', 'error'));
        });
        const view = smallButton('View items', `View items of ${deck.title}`);
        view.addEventListener('click', () => viewItemsDialog(deck.id, deck.title));
        return deckCard(deck, [follow, view]);
      })));
    }
  } catch {
    browse.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Public decks are unavailable.' }));
  }

  // My decks + suggestions + analytics
  mine.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading your decks…' }));
  try {
    const data = await apiRequest('/api/decks?mine=true&limit=50');
    const decks = Array.isArray(data?.items) ? data.items : [];
    if (!decks.length) {
      mine.body.replaceChildren(emptyState({ title: 'No decks published', description: 'Publish one from Vocabulary, Kanji or Grammar.' }));
    } else {
      const cards = [];
      for (const deck of decks) {
        const suggestionsBox = element('div', { className: 'grid gap-2' });
        const analyticsLine = element('p', { className: 'mt-1 text-xs text-muted', text: 'Loading analytics…' });
        const card = deckCard(deck, []);
        const view = smallButton('View items', `View items of ${deck.title}`);
        view.addEventListener('click', () => viewItemsDialog(deck.id, deck.title));
        card.append(view, analyticsLine, suggestionsBox);
        cards.push(card);
        apiRequest(`/api/decks/${deck.id}/analytics?period=30d`)
          .then((analytics) => {
            analyticsLine.textContent = `${analytics.overview.followers} followers · ${analytics.overview.items} items · suggestions ${analytics.overview.suggestions.pending} pending`;
          })
          .catch(() => { analyticsLine.textContent = 'Analytics unavailable.'; });
        apiRequest(`/api/decks/${deck.id}/suggestions`)
          .then((incoming) => {
            const items = Array.isArray(incoming?.items) ? incoming.items.filter((entry) => entry.status === 'pending') : [];
            if (!items.length) return;
            suggestionsBox.append(element('p', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: `Suggestions (${items.length})` }));
            for (const suggestion of items) {
              const changes = (Array.isArray(suggestion.changes) ? suggestion.changes : [])
                .map((change) => `${change.field}: ${change.oldValue} → ${change.newValue} (${change.reason})`).join(' · ');
              const accept = smallButton('Accept', `Accept suggestion ${suggestion.id}`);
              const reject = smallButton('Reject', `Reject suggestion ${suggestion.id}`);
              const decide = (decision) => {
                withPendingAction(accept, async () => {
                  await apiRequest(`/api/decks/suggestions/${suggestion.id}/decision`, { method: 'POST', body: { decision } });
                  showToast(`Suggestion ${decision}ed.`);
                  suggestionsBox.replaceChildren();
                }).catch((error) => showToast(error?.message || 'Unable to decide.', 'error'));
              };
              accept.addEventListener('click', () => decide('accept'));
              reject.addEventListener('click', () => decide('reject'));
              suggestionsBox.append(element('div', { className: 'rounded-md border border-stone p-2' }, [
                element('p', { className: 'text-sm text-ink', text: changes || 'No changes listed.' }),
                element('div', { className: 'mt-2 flex gap-2' }, [accept, reject])
              ]));
            }
          })
          .catch(() => {});
      }
      mine.body.replaceChildren(element('div', { className: 'grid gap-3' }, cards));
    }
  } catch {
    mine.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Your decks are unavailable.' }));
  }

  // Collections
  collections.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading collections…' }));
  const refreshCollections = async () => {
    try {
      const data = await apiRequest('/api/collections?scope=mine&limit=20');
      const items = Array.isArray(data?.items) ? data.items : [];
      const createTitle = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'New collection title', placeholder: 'New collection title', maxLength: '120' } });
      const create = smallButton('Create collection', 'Create collection');
      create.addEventListener('click', () => {
        const title = String(createTitle.value || '').trim();
        if (!title) { showToast('Give the collection a title.', 'error'); return; }
        withPendingAction(create, async () => {
          await apiRequest('/api/collections', { method: 'POST', body: { title } });
          showToast('Collection created.');
          await refreshCollections();
        }).catch((error) => showToast(error?.message || 'Unable to create the collection.', 'error'));
      });
      const list = element('div', { className: 'grid gap-3' }, items.map((collection) => {
        const share = smallButton('Share', `Share collection ${collection.title}`);
        share.addEventListener('click', () => {
          apiRequest(`/api/collections/${collection.id}/share`, { method: 'POST' })
            .then((result) => {
              const output = element('textarea', { className: 'field-control font-mono text-xs', attrs: { readonly: '', rows: '3', 'aria-label': 'Collection share code' } });
              output.value = result.shareCode;
              openDialog({
                title: `Share ${collection.title}`,
                description: `Covers ${result.deckCount} decks. Importing copies every item.`,
                content: [output],
                submitLabel: 'Close',
                onSubmit: async (form, close) => { close(); }
              });
            })
            .catch((error) => showToast(error?.message || 'Unable to share the collection.', 'error'));
        });
        return deckCard({ title: collection.title, description: collection.description, entityType: 'collection', itemCount: `${collection.deckCount} decks`, followers: '' }, [share]);
      }));
      collections.body.replaceChildren(
        element('div', { className: 'flex flex-col gap-2 sm:flex-row' }, [createTitle, create]),
        list
      );
    } catch {
      collections.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Collections are unavailable.' }));
    }
  };
  await refreshCollections();

  // Profile
  const usernameInput = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'Username', placeholder: 'username (2-30, lowercase, hyphens)', maxLength: '30' } });
  const displayInput = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'Display name', placeholder: 'Display name (optional)', maxLength: '50' } });
  const bioInput = element('textarea', { className: 'field-control', attrs: { 'aria-label': 'Bio', placeholder: 'Bio (optional)', maxLength: '500' } });
  const publicBox = element('input', { attrs: { type: 'checkbox', 'aria-label': 'Public profile' } });
  const save = smallButton('Save profile', 'Save public profile');
  save.addEventListener('click', () => {
    withPendingAction(save, async () => {
      const saved = await apiRequest('/api/users/me', {
        method: 'PUT',
        body: {
          username: String(usernameInput.value || '').trim(),
          display_name: displayInput.value,
          bio: bioInput.value,
          is_public: publicBox.checked
        }
      });
      usernameInput.value = saved.username || '';
      displayInput.value = saved.displayName || '';
      bioInput.value = saved.bio || '';
      publicBox.checked = Boolean(saved.isPublic);
      showToast(saved.username ? `Public profile: ${saved.username}.` : 'Profile saved (private).');
    }).catch((error) => showToast(error?.message || 'Unable to save the profile.', 'error'));
  });
  profile.body.replaceChildren(
    usernameInput, displayInput, bioInput,
    element('label', { className: 'flex items-center gap-2 text-sm text-ink' }, [publicBox, element('span', { text: 'Public profile' })]),
    save
  );
}
