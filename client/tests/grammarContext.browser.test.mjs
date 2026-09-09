import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './helpers/browser.mjs';

test('Grammar Intelligence context renders a reviewable Add to Grammar flow', { skip: !process.env.JLT_BROWSER, timeout: 120000 }, async () => {
  const browser = await browserFixture();
  try {
    const result = await browser.evaluate(`(async () => {
      window.requests = [];
      window.fetch = async (path, options = {}) => {
        const url = String(path);
        const body = options.body ? JSON.parse(options.body) : null;
        window.requests.push({ url, method: options.method || 'GET', body });
        const response = url === '/api/vocabulary?page=1&limit=30'
          ? { items: [{ id_vocabulary: 1, word: '勉強', reading: 'べんきょう', meaning: 'study', status: 'Learning' }], pagination: { page: 1, totalPages: 1, total: 1, limit: 30 } }
          : url === '/api/vocabulary/1'
            ? { id_vocabulary: 1, word: '勉強', reading: 'べんきょう', meaning: 'study', status: 'Learning', examples: [{ id_usage_example: 7, sentence: '日本語を勉強している。' }], kanji: [] }
            : url === '/api/vocabulary/1/grammar-context'
              ? { examples: [{ idUsageExample: 7, sentence: '日本語を勉強している。', matches: [{ status: 'DETERMINATE', reference: { referenceId: 19, grammarPoint: '〜ている', meaning: 'ongoing action', structures: ['Vている'], examples: [{ japanese: '勉強している。' }], jlptLevel: 'N5' }, collection: { inGrammar: false } }] }], truncated: false }
              : { id_grammar: 22 };
        return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
      const { renderEntityPage, ENTITY_CONFIGS } = await import('/src/pages/entityPage.js');
      renderEntityPage(document.getElementById('app'), ENTITY_CONFIGS.vocabulary);
      await tick();
      [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'View').click();
      await tick(); await tick();
      const context = document.querySelector('[data-grammar-example-context]').textContent;
      [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add to Grammar').click();
      await tick();
      const dialog = document.querySelector('#modal-root [role="dialog"]');
      const meaning = dialog.querySelector('[name="meaning"]');
      meaning.value = 'reviewed meaning';
      [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add to Grammar').click();
      await tick();
      return { context, posted: window.requests.find((request) => request.url === '/api/grammar' && request.method === 'POST')?.body };
    })()`);
    assert.match(result.context, /〜ている/);
    assert.match(result.context, /Add to Grammar/);
    assert.deepEqual(result.posted, {
      grammar_point: '〜ている', meaning: 'reviewed meaning', structure: 'Vている', example: '勉強している。', jlpt_level: 'N5', reference_id: 19
    });
  } finally {
    await browser.close();
  }
});
