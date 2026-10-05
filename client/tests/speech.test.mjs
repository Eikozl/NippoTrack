// Shared Japanese speech verdicts: pure module, no DOM, no server.
import test from 'node:test';
import assert from 'node:assert/strict';

import { findJapaneseVoice, japaneseVoiceGuidance, speakJapanese } from '../src/speech.js';

function fakeSynthesis(voices = []) {
  const spoken = [];
  return {
    spoken,
    getVoices: () => voices.slice(),
    cancel() {},
    speak(utterance) { spoken.push(utterance); }
  };
}

function fakeUtterance(text) {
  this.text = text;
  this.lang = '';
  this.rate = 1;
}

test('findJapaneseVoice matches ja variants and ignores the rest', () => {
  assert.equal(findJapaneseVoice([{ lang: 'ja-JP' }])?.lang, 'ja-JP');
  assert.equal(findJapaneseVoice([{ lang: 'en-US' }, { lang: 'ja_JP' }])?.lang, 'ja_JP');
  assert.equal(findJapaneseVoice([{ lang: 'en-US' }]), null);
  assert.equal(findJapaneseVoice([]), null);
});

test('speakJapanese speaks with the Japanese voice and rate', () => {
  const synthesis = fakeSynthesis([{ lang: 'ja-JP' }]);
  const verdict = speakJapanese('水', { rate: 0.5, synthesis, Utterance: fakeUtterance });
  assert.equal(verdict.ok, true);
  assert.equal(synthesis.spoken.length, 1);
  assert.equal(synthesis.spoken[0].text, '水');
  assert.equal(synthesis.spoken[0].lang, 'ja-JP');
  assert.equal(synthesis.spoken[0].rate, 0.5);
  assert.equal(synthesis.spoken[0].voice?.lang, 'ja-JP');
});

test('speakJapanese reports no-voice with guidance instead of silence', () => {
  const synthesis = fakeSynthesis([{ lang: 'en-US' }]);
  const verdict = speakJapanese('水', { synthesis, Utterance: fakeUtterance });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no-voice');
  assert.match(verdict.message, /No Japanese voice/);
  assert.equal(synthesis.spoken.length, 0, 'nothing spoken without a Japanese voice');
  assert.match(japaneseVoiceGuidance(), /No Japanese voice/);
});

test('speakJapanese reports unsupported without speech synthesis', () => {
  const verdict = speakJapanese('水', { synthesis: null, Utterance: fakeUtterance });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported');
  const empty = speakJapanese('   ', { synthesis: fakeSynthesis(), Utterance: fakeUtterance });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
});
