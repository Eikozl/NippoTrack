import test from 'node:test';
import assert from 'node:assert/strict';

import { INSUFFICIENT_GUIDANCE, levelEstimateModel, NOT_USED_LINES } from '../src/levelEstimate.js';

const payload = (overrides = {}) => ({
  estimate: { level: 'N4', status: 'estimated', confidence: 'moderate', approachingBand: 'N3' },
  evidence: {
    eligibleKanji: 14, retainedKanji: 8, reviewedKanji: 14, exposureKanji: 5,
    collectedKanji: 30, unreviewedKanji: 16, classifiedEligibleKanji: 14, unclassifiedEligibleKanji: 0
  },
  distribution: {
    N5: { eligible: 8, retained: 5 }, N4: { eligible: 6, retained: 3 },
    N3: { eligible: 2, retained: 0 }, N2: { eligible: 0, retained: 0 }, N1: { eligible: 0, retained: 0 }
  },
  reasoning: ['14 reviewed kanji with reference JLPT classifications (8 reviewed more than once).'],
  limitations: ['NippoTrack study estimate only.'],
  disclaimer: 'This is a NippoTrack study estimate based on reviewed kanji only — not an official JLPT assessment, certification, or proof of passing.',
  ...overrides
});

test('Level estimate model: estimated state carries level, confidence, and disclaimer', () => {
  const model = levelEstimateModel(payload());
  assert.equal(model.status, 'estimated');
  assert.equal(model.metricValue, 'N4');
  assert.match(model.metricNote, /Moderate estimate confidence/);
  assert.match(model.metricNote, /NippoTrack estimate/);
  assert.match(model.subline, /most consistent with N4-band kanji study/);
  assert.match(model.subline, /Approaching N3/);
  assert.equal(model.disclaimer, 'This is a NippoTrack study estimate based on reviewed kanji only — not an official JLPT assessment, certification, or proof of passing.');
  assert.equal(model.bandRows.length, 5);
  assert.deepEqual(model.bandRows[0], { band: 'N5', eligible: 8, retained: 5 });
  assert.ok(model.notUsedLines.includes('Pasted Smart Text Analyzer text'));
});

test('Level estimate model: copy never claims official results or pass proof', () => {
  const model = levelEstimateModel(payload());
  const { disclaimer: _disclaimer, ...rest } = JSON.parse(JSON.stringify(model));
  const text = JSON.stringify(rest);
  assert.doesNotMatch(text, /official/i);
  assert.doesNotMatch(text, /certif/i);
  assert.doesNotMatch(text, /pass(ing|ed)? (the|an) exam/i);
  assert.doesNotMatch(text, /would pass/i);
  assert.match(model.disclaimer, /not an official JLPT assessment/);
});

test('Level estimate model: insufficient evidence is first-class, never N5', () => {
  const model = levelEstimateModel(payload({
    estimate: { level: null, status: 'insufficient_evidence', confidence: null, approachingBand: null },
    evidence: { eligibleKanji: 2, retainedKanji: 0, reviewedKanji: 2, exposureKanji: 0, collectedKanji: 10, unreviewedKanji: 8, classifiedEligibleKanji: 2, unclassifiedEligibleKanji: 0 }
  }));
  assert.equal(model.status, 'insufficient_evidence');
  assert.equal(model.level, null);
  assert.equal(model.metricValue, '—');
  assert.equal(model.headline, 'Not enough evidence yet');
  assert.equal(model.subline, INSUFFICIENT_GUIDANCE);
  assert.doesNotMatch(`${model.headline} ${model.subline} ${model.metricValue}`, /N5/);
  assert.match(model.evidenceLines[0], /do not count until reviewed/);
});

test('Level estimate model: missing payload hides the section gracefully', () => {
  assert.equal(levelEstimateModel(null), null);
  assert.equal(levelEstimateModel({}), null);
});

test('Level estimate model: missing limitations fall back to the OpenJLPT line', () => {
  const model = levelEstimateModel(payload({ limitations: [] }));
  assert.ok(model.limitationLines.some((line) => /OpenJLPT/i.test(line)));
  const noDisclaimer = levelEstimateModel(payload({ disclaimer: null }));
  assert.match(noDisclaimer.disclaimer, /not an official JLPT assessment/);
});

test('Level estimate model: unknown confidence and no approaching band degrade cleanly', () => {
  const model = levelEstimateModel(payload({
    estimate: { level: 'N5', status: 'estimated', confidence: 'extreme', approachingBand: null }
  }));
  assert.equal(model.confidence, 'extreme');
  assert.match(model.metricNote, /Low estimate confidence/);
  assert.doesNotMatch(model.subline, /Approaching/);
  assert.equal(model.approachingBand, null);
});

test('Level estimate model: not-used list names imports, analyzer text, and status labels', () => {
  assert.ok(NOT_USED_LINES.some((line) => /Imported kanji/i.test(line)));
  assert.ok(NOT_USED_LINES.some((line) => /Analyzer text/i.test(line)));
  assert.ok(NOT_USED_LINES.some((line) => /Status labels/i.test(line)));
  const model = levelEstimateModel(payload());
  assert.deepEqual(model.notUsedLines, NOT_USED_LINES);
});
