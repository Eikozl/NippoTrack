import { apiRequest } from '../api';
import { element, emptyState, errorState, loadingState, pageHeader, showToast } from '../ui';

const RESULTS = [
  ['Again', 'button-danger'],
  ['Hard', 'button-secondary'],
  ['Good', 'button-primary']
];

function reviewCard(item, onReview) {
  const actions = RESULTS.map(([result, className]) => {
    const button = element('button', { className, text: result, attrs: { type: 'button' } });
    button.addEventListener('click', () => onReview(item, result, button));
    return button;
  });
  return element('article', { className: 'surface p-5 sm:p-6' }, [
    element('div', { className: 'flex flex-wrap items-start justify-between gap-3' }, [
      element('div', {}, [element('span', { className: 'status-pill', text: item.item_type }), element('h2', { className: 'mt-3 text-xl font-semibold text-ink', text: item.title }), ...(item.reading ? [element('p', { className: 'mt-1 text-sm text-muted', text: item.reading })] : []), element('p', { className: 'mt-2 text-sm text-ink/80', text: item.meaning })]),
      element('span', { className: 'text-xs font-semibold text-muted', text: item.last_result ? `Last result: ${item.last_result}` : 'First review' })
    ]),
    element('div', { className: 'mt-5 flex flex-wrap gap-3 border-t border-stone pt-5' }, actions)
  ]);
}

export async function renderReview(container) {
  const content = element('div');
  container.replaceChildren(element('section', {}, [pageHeader({ eyebrow: 'Recall', title: 'Review', description: 'Review what is due today. Again returns tomorrow, Hard returns in 3 days, and Good returns in 7 days.' }), content]));
  async function load() {
    content.replaceChildren(loadingState('Loading review queue…'));
    try {
      const data = await apiRequest('/api/review');
      if (!data.items.length) { content.replaceChildren(emptyState({ title: 'Nothing due today', description: 'New vocabulary, kanji and grammar entries will appear here automatically when they are ready to review.' })); return; }
      content.replaceChildren(element('div', { className: 'grid gap-4' }, data.items.map((item) => reviewCard(item, async (record, result, button) => {
        button.disabled = true;
        try { await apiRequest(`/api/review/${record.id_review_item}`, { method: 'POST', body: { result } }); showToast(`Review recorded: ${result}.`); await load(); } catch (error) { button.disabled = false; showToast(error.message, 'error'); }
      }))));
    } catch (error) { content.replaceChildren(errorState(error, load)); }
  }
  await load();
}
