// Story Registry enroll dialog (shared with the Content Log): candidate
// checkboxes with TTS preview, server-id enrollment. No fetching here.
import { apiRequest } from '../api';
import { element, openDialog, showToast, withPendingAction } from '../ui';
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

export function openEnrollDialog(storyId, storyTitle, preview) {
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

