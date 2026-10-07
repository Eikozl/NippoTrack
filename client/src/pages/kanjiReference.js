import { apiRequest } from '../api';
import { element, errorState, loadingState, pageHeader } from '../ui';
import { buildKanjiIdentity, normalizeKanjiReferenceIdentity } from '../kanjiDetail.js';

function referenceContent(reference) {
  return element('div', { className: 'grid gap-5' }, [
    buildKanjiIdentity(normalizeKanjiReferenceIdentity(reference), element),
    vocabularyExamplesSection(reference)
  ]);
}

// Reference vocabulary examples (read-only, max 3): compact JMdict-derived
// illustration of the character in real words. Never user collection data,
// never Review/Encounter evidence — no actions, no ownership states.
function vocabularyExamplesSection(reference) {
  const section = element('section', { className: 'kanji-reference-examples surface p-5 sm:p-7', attrs: { 'aria-label': 'Vocabulary examples' } }, [
    element('h2', { className: 'text-lg font-semibold text-ink', text: 'Vocabulary examples' }),
    element('p', { className: 'mt-1 text-sm text-muted', text: 'Reference vocabulary from JMdict' })
  ]);
  const examples = Array.isArray(reference?.vocabularyExamples) ? reference.vocabularyExamples : null;
  if (examples === null || reference?.vocabularyExamplesStatus === 'unavailable') {
    section.append(element('p', { className: 'mt-3 text-sm leading-6 text-muted', text: 'Reference vocabulary is currently unavailable.' }));
    return section;
  }
  if (!examples.length) {
    section.append(element('p', { className: 'mt-3 text-sm leading-6 text-muted', text: 'No reference vocabulary examples available.' }));
    return section;
  }
  section.append(element('div', { className: 'mt-4 grid gap-3 sm:grid-cols-3' }, examples.slice(0, 3).map((item) => (
    element('article', { className: 'detail-panel min-w-0 p-4' }, [
      element('p', { className: 'break-words font-jp text-lg font-semibold leading-7 text-ink', text: item.word, attrs: { lang: 'ja' } }),
      element('p', { className: 'mt-1 break-words font-jp text-sm leading-6 text-muted', text: item.reading, attrs: { lang: 'ja' } }),
      element('p', { className: 'mt-1 break-words text-sm leading-6 text-ink/80', text: item.meaning })
    ])
  ))));
  return section;
}

// B.2 stroke-order overlay: lazy + fail-open — the reference content never
// depends on it. The module (and its tiny eligibility table) loads only
// when a reference hero actually renders, keeping it out of the main chunk.
function mountStrokeOrderSlots(root) {
  import('../strokeOrder.js').then((module) => module.mountStrokeSlots(root)).catch(() => {});
}

export async function renderKanjiReference(container, character) {
  const header = () => pageHeader({ title: 'Kanji reference', description: 'Reference details for this kanji.' });
  container.replaceChildren(header(), loadingState('Loading kanji reference…'));
  try {
    const reference = await apiRequest(`/api/kanji/lookup/${encodeURIComponent(character)}`);
    container.replaceChildren(pageHeader({ title: `Kanji ${reference.character}`, description: 'Shared JLPT reference data. Classifications are community/reference data, not an official syllabus.' }), referenceContent(reference));
    mountStrokeOrderSlots(container);
  } catch (error) {
    const message = error?.status === 404 ? 'This kanji is not present in the shared JLPT reference data.' : error;
    container.replaceChildren(header(), errorState(message, () => renderKanjiReference(container, character)));
  }
}
