// Story Registry (V5.6 phase 1): paste text, preview the linguistic
// extraction, enroll selections into SRS. No external fetching yet: embeds
// and transcripts arrive in phase 2. Vanilla, fail-open blocks.
import { apiRequest } from '../api';
import { element, emptyState, openDialog, pageHeader, showToast, withPendingAction } from '../ui';
import { speakJapanese } from '../speech.js';

function smallButton(label, ariaLabel) {
  return element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: label, attrs: { type: 'button', 'aria-label': ariaLabel || label } });
}

function speechPieces() {
  const hasWindow = typeof window !== 'undefined';
  return {
    synthesis: hasWindow ? window.speechSynthesis : null,
    Utterance: hasWindow ? window.SpeechSynthesisUtterance : null
  };
}

function candidateLabel(kind, entry) {
  if (kind === 'kanji') return `${entry.char} (${entry.reading || '?'} · ${entry.meaning || '?'}) ×${entry.frequency}`;
  if (kind === 'vocab') return `${entry.word} (${entry.reading || '?'} · ${entry.meaning || '?'})`;
  return `${entry.pattern} · ${entry.meaning || '?'}`;
}

function openEnrollDialog(storyId, storyTitle, preview) {
  const groups = [
    { kind: 'kanji', label: 'Kanji', entries: Array.isArray(preview?.kanji) ? preview.kanji : [] },
    { kind: 'vocab', label: 'Vocabulary', entries: Array.isArray(preview?.vocab) ? preview.vocab : [] },
    { kind: 'grammar', label: 'Grammar', entries: Array.isArray(preview?.grammar) ? preview.grammar : [] }
  ];
  const picks = [];
  const sections = groups.map(({ kind, label, entries }) => {
    if (!entries.length) return null;
    const boxes = entries.map((entry) => {
      const box = element('input', { attrs: { type: 'checkbox', 'aria-label': `Enroll ${candidateLabel(kind, entry)}` } });
      box.checked = false;
      return { id: entry.id, box };
    });
    picks.push(boxes);
    return element('div', { className: 'grid gap-1.5' }, [
      element('p', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: `${label} (${entries.length})` }),
      element('div', { className: 'grid max-h-44 gap-1 overflow-y-auto' }, entries.map((entry, index) => {
        const play = smallButton('Play', `Play ${candidateLabel(kind, entry)} aloud`);
        play.addEventListener('click', () => {
          const word = kind === 'kanji' ? entry.char : kind === 'vocab' ? entry.word : entry.pattern;
          const verdict = speakJapanese(word, { ...speechPieces() });
          if (!verdict.ok) showToast(verdict.message || 'Audio playback is unavailable.', 'error');
        });
        return element('label', { className: 'flex items-center gap-2 text-sm text-ink' }, [
          boxes[index].box,
          element('span', { className: 'flex-1', text: candidateLabel(kind, entry) }),
          play
        ]);
      }))
    ]);
  }).filter(Boolean);
  if (!sections.length) {
    showToast('Nothing detected to enroll.', 'error');
    return;
  }
  const enroll = element('button', { className: 'button-primary min-h-9 px-3 py-1.5 text-sm', text: 'Enroll selected', attrs: { type: 'button' } });
  enroll.addEventListener('click', () => {
    const selected = picks.flat().filter(({ box }) => box.checked).map(({ id }) => id).filter(Boolean);
    if (!selected.length) { showToast('Select at least one candidate.', 'error'); return; }
    withPendingAction(enroll, async () => {
      const result = await apiRequest(`/api/stories/${storyId}/enroll-srs`, { method: 'POST', body: { selected } });
      showToast(`Enrolled ${result.created} review items.`);
    }).catch((error) => showToast(error?.message || 'Unable to enroll.', 'error'));
  });
  openDialog({
    title: `Enroll from ${storyTitle}`,
    description: 'Checked rows become SRS review items. Practice only until graded.',
    content: [...sections, enroll],
    submitLabel: 'Close',
    onSubmit: async (form, close) => { close(); }
  });
}

export async function renderStories(container) {
  container.replaceChildren(pageHeader({
    eyebrow: 'Immersion',
    title: 'Stories',
    description: 'Paste text, preview what the engine hears in it, enroll it into SRS.'
  }));
  const createSection = element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': 'New story' } });
  const listSection = element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': 'My stories' } });
  container.append(createSection, listSection);

  const titleInput = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'Story title', placeholder: 'Story title', maxLength: '255' } });
  const textInput = element('textarea', { className: 'field-control min-h-32', attrs: { 'aria-label': 'Story text', placeholder: 'Paste Japanese text (up to 5000 characters)…' } });
  const create = element('button', { className: 'button-primary min-h-9 px-3 py-1.5 text-sm', text: 'Analyze text', attrs: { type: 'button' } });
  const previewBox = element('div', { className: 'grid gap-2' });
  create.addEventListener('click', () => {
    const text = String(textInput.value || '');
    if (!text.trim()) { showToast('Paste some text first.', 'error'); return; }
    if (!String(titleInput.value || '').trim()) { showToast('Give the story a title.', 'error'); return; }
    withPendingAction(create, async () => {
      const preview = await apiRequest('/api/stories/extract-preview', { method: 'POST', body: { text } });
      const data = preview?.preview || {};
      const counts = [
        `${(data.kanji || []).length} kanji`,
        `${(data.vocab || []).length} vocabulary`,
        `${(data.grammar || []).length} grammar`
      ].join(' · ');
      const save = smallButton('Save story with extraction', 'Save story with extraction');
      save.addEventListener('click', () => {
        withPendingAction(save, async () => {
          const story = await apiRequest('/api/stories', {
            method: 'POST',
            body: { title: titleInput.value, text, auto_extract: true }
          });
          showToast(`Story saved (${story.extracted ? `${story.extracted.kanji + story.extracted.vocab + story.extracted.grammar} candidates` : 'extracted'}).`);
          titleInput.value = '';
          textInput.value = '';
          previewBox.replaceChildren();
          await refreshStories();
        }).catch((error) => showToast(error?.message || 'Unable to save the story.', 'error'));
      });
      previewBox.replaceChildren(
        element('p', { className: 'text-sm font-semibold text-ink', text: `Detected: ${counts}` }),
        save
      );
    }).catch((error) => showToast(error?.message || 'Unable to analyze the text.', 'error'));
  });
  createSection.append(
    element('h2', { className: 'font-semibold text-ink', text: 'New story' }),
    titleInput, textInput, create, previewBox
  );

  const listBox = element('div', { className: 'grid gap-3' });
  listSection.append(element('h2', { className: 'font-semibold text-ink', text: 'My stories' }), listBox);
  async function refreshStories() {
    listBox.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading stories…' }));
    try {
      const data = await apiRequest('/api/content?limit=30');
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        listBox.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No stories yet — paste text above.' }));
        return;
      }
      listBox.replaceChildren(element('div', { className: 'grid gap-3' }, items.map((story) => {
        const extract = smallButton('Extract', `Extract ${story.title}`);
        extract.addEventListener('click', () => {
          withPendingAction(extract, async () => {
            const result = await apiRequest(`/api/stories/${story.id_content_entry}/extract`, { method: 'POST' });
            openEnrollDialog(story.id_content_entry, story.title, result?.extracted);
          }).catch((error) => showToast(error?.message || 'Story has no text to extract from.', 'error'));
        });
        const enroll = smallButton('Enroll', `Enroll ${story.title} into SRS`);
        enroll.addEventListener('click', () => {
          withPendingAction(enroll, async () => {
            const result = await apiRequest(`/api/stories/${story.id_content_entry}/extract`, { method: 'POST' });
            openEnrollDialog(story.id_content_entry, story.title, result?.extracted);
          }).catch((error) => showToast(error?.message || 'Story has no text to extract from.', 'error'));
        });
        return element('article', { className: 'rounded-md bg-paper p-3' }, [
          element('p', { className: 'font-medium text-ink', text: story.title }),
          element('p', { className: 'mt-1 text-xs text-muted', text: `${story.content_type || ''} · ${story.content_date || ''}` }),
          element('div', { className: 'mt-2 flex flex-col gap-2 sm:flex-row' }, [extract, enroll])
        ]);
      })));
    } catch {
      listBox.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Stories are unavailable.' }));
    }
  }
  await refreshStories();
}
