import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './helpers/browser.mjs';

test('new Grammar dialog keeps reference lookup visible and manual-friendly', { skip: !process.env.JLT_BROWSER, timeout: 120000 }, async () => {
  const browser = await browserFixture();
  try {
    const result = await browser.evaluate(`(async () => {
      const requests = [];
      const references = {
        'てもいい': {
          referenceId: 101, grammarPoint: 'てもいい', meaning: 'may do; it is okay to do', jlptLevel: 'N5',
          structures: [{ pattern: 'Vて + もいい' }],
          examples: [{ japanese: 'ここで写真を撮ってもいいです。' }]
        },
        tai: {
          referenceId: 102, grammarPoint: 'たい', meaning: 'want to do', jlptLevel: 'N5',
          structures: ['Vます-stem + たい'],
          examples: [{ sentence: '日本へ行きたいです。' }]
        },
        permission: {
          referenceId: 103, grammarPoint: 'てもいい', meaning: 'permission; may do', jlptLevel: 'N5',
          structures: ['Vて + もいい'],
          examples: [{ ja: 'ここに座ってもいいですか。' }]
        }
      };
      window.fetch = async (path, options = {}) => {
        const url = String(path);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ url, method: options.method || 'GET', body });
        if (url.startsWith('/api/grammar/reference?')) {
          const query = new URL(url, 'http://local').searchParams.get('search');
          if (query === 'failure') throw new Error('network unavailable');
          return new Response(JSON.stringify({ items: references[query] ? [references[query]] : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('/api/grammar?')) {
          return new Response(JSON.stringify({ items: [], pagination: { page: 1, totalPages: 1, total: 0, limit: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url === '/api/grammar' && options.method === 'POST') {
          return new Response(JSON.stringify({ id_grammar: 77 }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const wait = (ms = 380) => new Promise((resolve) => setTimeout(resolve, ms));
      const input = async (field, value) => {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        await wait();
      };
      const { renderEntityPage, ENTITY_CONFIGS } = await import('/src/pages/entityPage.js');
      renderEntityPage(document.getElementById('app'), ENTITY_CONFIGS.grammar);
      await wait(100);
      [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add grammar point').click();
      const dialog = document.querySelector('#modal-root [role="dialog"]');
      const point = dialog.querySelector('[name="grammar_point"]');
      const meaning = dialog.querySelector('[name="meaning"]');
      const structure = dialog.querySelector('[name="structure"]');
      const example = dialog.querySelector('[name="example"]');
      const level = dialog.querySelector('[name="jlpt_level"]');

      await input(point, 'てもいい');
      const japaneseVisible = dialog.textContent.includes('Reference matches') && dialog.textContent.includes('てもいい');
      const referenceResults = dialog.querySelector('.grammar-reference-results');
      const notes = dialog.querySelector('[name="notes"]');
      const firstCandidate = dialog.querySelector('.grammar-reference-results button');
      const grammarReferencePositioned = Boolean(referenceResults && notes && (referenceResults.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING));
      const candidateStructured = Boolean(firstCandidate && firstCandidate.querySelectorAll(':scope > span').length === 3);
      const candidateClean = Boolean(firstCandidate && !/[\u00c2\u00c3\ufffd]/.test(firstCandidate.textContent));
      [...dialog.querySelectorAll('.grammar-reference-results button')][0].click();
      const firstSelection = {
        meaning: meaning.value,
        structure: structure.value,
        example: example.value,
        level: level.value,
        referenceId: dialog.querySelector('[name="reference_id"]').value
      };

      meaning.value = 'manual meaning'; meaning.dispatchEvent(new Event('input', { bubbles: true }));
      structure.value = 'manual structure'; structure.dispatchEvent(new Event('input', { bubbles: true }));
      example.value = 'manual example'; example.dispatchEvent(new Event('input', { bubbles: true }));
      level.value = 'N4'; level.dispatchEvent(new Event('change', { bubbles: true }));

      await input(point, 'tai');
      const romajiVisible = dialog.textContent.includes('want to do') && dialog.textContent.includes('たい');
      [...dialog.querySelectorAll('.grammar-reference-results button')][0].click();
      const dirtyPreserved = { meaning: meaning.value, structure: structure.value, example: example.value, level: level.value };

      await input(point, 'permission');
      const englishVisible = dialog.textContent.includes('permission; may do');
      await input(point, 'no-result');
      const noResultVisible = dialog.textContent.includes('No reference matches found');
      const referenceAfterTyping = dialog.querySelector('[name="reference_id"]').value;
      await input(point, 'failure');
      const failureVisible = dialog.textContent.includes('Reference lookup unavailable');

      await input(point, 'tai');
      [...dialog.querySelectorAll('.grammar-reference-results button')][0].click();
      dialog.querySelector('button[type="submit"]').click();
      await wait(100);
      return {
        japaneseVisible,
        grammarReferencePositioned,
        candidateStructured,
        candidateClean,
        romajiVisible,
        englishVisible,
        noResultVisible,
        failureVisible,
        referenceAfterTyping,
        firstSelection,
        dirtyPreserved,
        posted: requests.find((request) => request.url === '/api/grammar' && request.method === 'POST')?.body,
        referenceRequests: requests.filter((request) => request.url.startsWith('/api/grammar/reference?')).map((request) => request.url)
      };
    })()`);

    assert.equal(result.japaneseVisible, true);
    assert.equal(result.grammarReferencePositioned, true);
    assert.equal(result.candidateStructured, true);
    assert.equal(result.candidateClean, true);
    assert.equal(result.romajiVisible, true);
    assert.equal(result.englishVisible, true);
    assert.equal(result.noResultVisible, true);
    assert.equal(result.failureVisible, true);
    assert.equal(result.referenceAfterTyping, '');
    assert.deepEqual(result.firstSelection, {
      meaning: 'may do; it is okay to do',
      structure: 'Vて + もいい',
      example: 'ここで写真を撮ってもいいです。',
      level: 'N5',
      referenceId: '101'
    });
    assert.deepEqual(result.dirtyPreserved, {
      meaning: 'manual meaning', structure: 'manual structure', example: 'manual example', level: 'N4'
    });
    assert.deepEqual(result.posted, {
      grammar_point: 'たい', meaning: 'manual meaning', structure: 'manual structure', example: 'manual example', jlpt_level: 'N4', status: 'New', notes: '', reference_id: '102'
    });
    assert.equal(result.referenceRequests.length, 6);
  } finally {
    await browser.close();
  }
});
