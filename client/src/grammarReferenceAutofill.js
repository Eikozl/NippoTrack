import { element } from './ui.js';

function fieldFor(content, name) {
  return content.map((node) => node.matches?.(`[name="${name}"]`) ? node : node.querySelector?.(`[name="${name}"]`)).find(Boolean);
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Reference catalogs have used strings and structured entries for patterns.
// Keep the user-facing field a simple, editable newline-delimited value.
export function formatGrammarReferenceStructures(structures) {
  const entries = Array.isArray(structures) ? structures : [structures];
  return entries.map((entry) => {
    if (typeof entry === 'string') return entry.trim();
    if (!entry || typeof entry !== 'object') return '';
    return [entry.pattern, entry.structure, entry.value, entry.form, entry.text]
      .map(textValue)
      .find(Boolean) || '';
  }).filter(Boolean).join('\n');
}

// Accept the known catalog variants without leaking source-specific shapes into
// the dialog. The first natural-language Japanese sentence is enough here.
export function grammarReferenceExample(examples) {
  const entries = Array.isArray(examples) ? examples : [examples];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim()) return entry.trim();
    if (!entry || typeof entry !== 'object') continue;
    const sentence = [entry.ja, entry.japanese, entry.sentence].map(textValue).find(Boolean);
    if (sentence) return sentence;
  }
  return '';
}

export function enableGrammarReferenceAutofill(content, request) {
  const point = fieldFor(content, 'grammar_point');
  if (!point) return;
  const fields = Object.fromEntries(['grammar_point', 'meaning', 'structure', 'example', 'jlpt_level'].map((name) => [name, fieldFor(content, name)]));
  const dirty = new Set();
  ['meaning', 'structure', 'example', 'jlpt_level'].forEach((name) => {
    fields[name]?.addEventListener('input', () => dirty.add(name));
    fields[name]?.addEventListener('change', () => dirty.add(name));
  });

  const referenceId = element('input', { attrs: { type: 'hidden', name: 'reference_id' } });
  const status = element('p', {
    className: 'grammar-reference-status hidden text-xs text-muted sm:col-span-2',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  const results = element('div', {
    className: 'grammar-reference-results hidden grid gap-2 sm:col-span-2',
    attrs: { role: 'group', 'aria-label': 'Grammar reference matches' }
  });
  // Keep lookup feedback adjacent to the two identifying fields instead of
  // leaving it below notes at the end of the dialog.
  content.splice(2, 0, status, results);
  content.push(referenceId);

  const clearResults = () => {
    results.replaceChildren();
    results.classList.add('hidden');
  };
  const showStatus = (message = '') => {
    status.textContent = message;
    status.classList.toggle('hidden', !message);
  };
  let sequence = 0;
  let timer = null;

  const lookup = async (query, current) => {
    try {
      const data = await request(`/api/grammar/reference?search=${encodeURIComponent(query)}&limit=6`);
      if (current !== sequence || point.value.trim() !== query) return;
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        clearResults();
        showStatus('No reference matches found. You can still create a Grammar record manually.');
        return;
      }
      showStatus();
      results.replaceChildren(element('p', { className: 'text-xs font-semibold text-muted', text: 'Reference matches' }));
      items.forEach((reference) => {
        const button = element('button', {
          className: 'button-secondary min-h-9 justify-start gap-2 px-3 py-1.5 text-left text-sm',
          attrs: { type: 'button' }
        }, [
          element('span', { className: 'font-jp font-semibold text-ink', text: reference.grammarPoint || query, attrs: { lang: 'ja' } }),
          element('span', { className: 'text-ink/80', text: reference.meaning || 'Meaning not provided' }),
          element('span', { className: 'text-xs font-semibold text-muted', text: `JLPT ${reference.jlptLevel || 'not set'}` })
        ]);
        button.addEventListener('click', () => {
          referenceId.value = reference.referenceId === undefined || reference.referenceId === null ? '' : String(reference.referenceId);
          fields.grammar_point.value = reference.grammarPoint || point.value;
          if (!dirty.has('meaning')) fields.meaning.value = reference.meaning || '';
          if (!dirty.has('structure')) fields.structure.value = formatGrammarReferenceStructures(reference.structures);
          if (!dirty.has('example')) fields.example.value = grammarReferenceExample(reference.examples);
          if (!dirty.has('jlpt_level')) fields.jlpt_level.value = reference.jlptLevel || '';
          clearResults();
          showStatus();
        });
        results.append(button);
      });
      results.classList.remove('hidden');
    } catch (_) {
      if (current !== sequence || point.value.trim() !== query) return;
      clearResults();
      showStatus('Reference lookup unavailable. You can still create a Grammar record manually.');
    }
  };

  point.addEventListener('input', () => {
    clearTimeout(timer);
    const query = point.value.trim();
    const current = ++sequence;
    // A reference is a deliberate candidate selection, never merely typed text.
    referenceId.value = '';
    clearResults();
    if (!query) {
      showStatus();
      return;
    }
    showStatus('Looking up grammar references...');
    timer = setTimeout(() => lookup(query, current), 300);
  });
}
