import test from 'node:test';
import assert from 'node:assert/strict';

import { BAND_ORDER, FALLBACK_DISCLAIMER, jlptProgressModel } from '../src/jlptProgress.js';

function payload(overrides = {}) {
  return {
    bands: {
      N5: { referenceTotal: 80, collected: 60, reviewed: 58, repeated: 30, unreviewedCollected: 2, reviewedPercent: 72.5 },
      N4: { referenceTotal: 170, collected: 50, reviewed: 42, repeated: 10, unreviewedCollected: 8, reviewedPercent: 24.7 },
      N3: { referenceTotal: 370, collected: 25, reviewed: 21, repeated: 0, unreviewedCollected: 4, reviewedPercent: 5.7 },
      N2: { referenceTotal: 380, collected: 0, reviewed: 0, repeated: 0, unreviewedCollected: 0, reviewedPercent: 0 },
      N1: { referenceTotal: 1000, collected: 5, reviewed: 0, repeated: 0, unreviewedCollected: 5, reviewedPercent: 0 }
    },
    cumulative: {
      N5: { referenceTotal: 80, reviewed: 58 },
      N4: { referenceTotal: 250, reviewed: 100 },
      N3: { referenceTotal: 620, reviewed: 121 },
      N2: { referenceTotal: 1000, reviewed: 121 },
      N1: { referenceTotal: 2000, reviewed: 121 }
    },
    summary: { referenceTotal: 2000, reviewed: 121, repeated: 40 },
    unclassified: { collected: 3, reviewed: 2 },
    limitations: ['Only reviewed kanji count as progress.'],
    disclaimer: 'Reference Kanji coverage only.',
    ...overrides
  };
}

test('jlptProgressModel: null payload hides the section gracefully', () => {
  assert.equal(jlptProgressModel(null), null);
  assert.equal(jlptProgressModel({}), null);
  assert.equal(jlptProgressModel({ bands: null }), null);
});

test('jlptProgressModel: band rows carry explicit reviewed/reference counts', () => {
  const model = jlptProgressModel(payload());
  assert.deepEqual(model.rows.map((row) => row.band), BAND_ORDER);
  const n5 = model.rows[0];
  assert.equal(n5.countLine, '58 / 80 reviewed');
  assert.equal(n5.reviewedPercent, 72.5);
  assert.equal(n5.barPercent, 72.5);
  assert.ok(n5.countLine.includes('reviewed'));
});

test('jlptProgressModel: cumulative lines use coverage wording, never readiness', () => {
  const model = jlptProgressModel(payload());
  const throughN4 = model.cumulative.find((entry) => entry.band === 'N4');
  assert.equal(throughN4.line, 'N4: 100 / 250 reviewed');
  const joined = model.cumulative.map((entry) => entry.line).join(' ');
  assert.doesNotMatch(joined, /readiness|exam ready|passing|complete/i);
  assert.ok(joined.includes('reviewed'));
});

test('jlptProgressModel: empty bands render zero counts without crashing', () => {
  const model = jlptProgressModel(payload());
  const n2 = model.rows.find((row) => row.band === 'N2');
  assert.equal(n2.countLine, '0 / 380 reviewed');
  assert.equal(n2.barPercent, 0);
});

test('jlptProgressModel: unclassified reviewed kanji surface separately', () => {
  assert.equal(jlptProgressModel(payload()).unclassifiedReviewed, 2);
  assert.equal(jlptProgressModel(payload({ unclassified: { collected: 0, reviewed: 0 } })).unclassifiedReviewed, 0);
});

test('jlptProgressModel: disclaimer and limitations travel with the model', () => {
  const model = jlptProgressModel(payload());
  assert.equal(model.disclaimer, 'Reference Kanji coverage only.');
  assert.deepEqual(model.limitationLines, ['Only reviewed kanji count as progress.']);
  const fallback = jlptProgressModel(payload({ disclaimer: '', limitations: [] }));
  assert.equal(fallback.disclaimer, FALLBACK_DISCLAIMER);
  assert.ok(fallback.limitationLines.length > 0);
});

test('jlptProgressModel: reviewed counts clamp to collected', () => {
  const broken = payload({ bands: { N5: { referenceTotal: 80, collected: 2, reviewed: 9, repeated: 12 } } });
  const model = jlptProgressModel(broken);
  assert.equal(model.rows[0].reviewed, 2);
  assert.equal(model.rows[0].repeated, 2);
  assert.equal(model.rows[0].countLine, '2 / 80 reviewed');
});

test('jlptProgressModel: string counts and missing reference totals stay safe', () => {
  const model = jlptProgressModel(payload({
    bands: {
      N5: { referenceTotal: '80', collected: '60', reviewed: '58', repeated: '30' },
      N4: { referenceTotal: 0, collected: 5, reviewed: 0, repeated: 0 }
    }
  }));
  assert.equal(model.rows[0].countLine, '58 / 80 reviewed');
  assert.equal(model.rows[1].reviewedPercent, null);
  assert.equal(model.rows[1].barPercent, 0);
  assert.equal(model.rows[1].countLine, '0 / 0 reviewed');
  const over = jlptProgressModel(payload({ bands: { N5: { referenceTotal: 4, collected: 6, reviewed: 6, repeated: 0 } } }));
  assert.equal(over.rows[0].reviewedPercent, 150);
  assert.equal(over.rows[0].barPercent, 100);
});
