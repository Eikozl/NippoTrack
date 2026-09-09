import { element } from './ui.js';

export function enableGrammarReferenceAutofill(content, request) {
  const point = content.find((node) => node.querySelector?.('[name="grammar_point"]'))?.querySelector?.('[name="grammar_point"]');
  if (!point) return;
  const fields = Object.fromEntries(['grammar_point', 'meaning', 'structure', 'example', 'jlpt_level'].map((name) => [name, content.find((node) => node.querySelector?.(`[name="${name}"]`))?.querySelector?.(`[name="${name}"]`)]));
  const dirty = new Set();
  ['meaning', 'structure', 'example', 'jlpt_level'].forEach((name) => fields[name]?.addEventListener('input', () => dirty.add(name)));
  const referenceId = element('input', { attrs: { type: 'hidden', name: 'reference_id' } });
  const results = element('div', { className: 'hidden grid gap-2 sm:col-span-2', attrs: { role: 'listbox', 'aria-label': 'Grammar reference matches' } });
  content.push(referenceId, results);
  let sequence = 0; let timer = null;
  const lookup = async () => {
    const query = point.value.trim(); const current = ++sequence;
    if (!query) { results.classList.add('hidden'); return; }
    try {
      const data = await request(`/api/grammar/reference?search=${encodeURIComponent(query)}&limit=6`);
      if (current !== sequence) return;
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) { results.classList.add('hidden'); return; }
      results.replaceChildren(element('p', { className: 'text-xs font-semibold text-muted', text: 'Reference matches' }));
      items.forEach((reference) => {
        const button = element('button', { className: 'button-secondary min-h-9 justify-start px-3 py-1.5 text-left text-sm', text: `${reference.grammarPoint} · ${reference.meaning} · ${reference.jlptLevel} reference`, attrs: { type: 'button', role: 'option' } });
        button.addEventListener('click', () => {
          referenceId.value = String(reference.referenceId);
          fields.grammar_point.value = reference.grammarPoint;
          if (!dirty.has('meaning')) fields.meaning.value = reference.meaning || '';
          if (!dirty.has('structure')) fields.structure.value = (reference.structures || []).join('\n');
          if (!dirty.has('example')) fields.example.value = reference.examples?.find((item) => item?.ja)?.ja || '';
          if (!dirty.has('jlpt_level')) fields.jlpt_level.value = reference.jlptLevel || '';
          results.classList.add('hidden');
        });
        results.append(button);
      });
      results.classList.remove('hidden');
    } catch (_) { results.classList.add('hidden'); }
  };
  point.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 300); });
}
