// Phase 12-A — engine-backed linguistic QA corpus (checkpoint assertions).
//
// No full parse-tree equality: segmentation varies legitimately, so each
// sentence asserts checkpoints (segmentation spots, lemma recovery, POS,
// readings) plus the global lossless-stream invariant (surfaces rejoin to the
// input), which is what future phrase composition depends on.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJapanese, engineMetadata, resetParserForTests } = require('../src/services/japaneseParser');
const { adaptTokens } = require('../src/services/lexicalTokenAdapter');

let ENGINE = null;

async function tokensFor(sentence) {
  if (!ENGINE) {
    resetParserForTests();
    ENGINE = engineMetadata();
  }
  const { rawTokens } = await parseJapanese(sentence);
  const tokens = adaptTokens(rawTokens, sentence, ENGINE);
  // Global invariant: lossless stream — surfaces rejoin exactly, every token
  // carries valid code-point offsets into the original text.
  assert.equal(tokens.map((t) => t.surface).join(''), sentence, `lossless stream: ${sentence}`);
  const chars = Array.from(sentence);
  for (const token of tokens) {
    assert.equal(chars.slice(token.start, token.end).join(''), token.surface, `offsets: ${token.surface}`);
  }
  return tokens;
}

function lemmaOf(tokens, surface) {
  const found = tokens.find((t) => t.surface === surface);
  assert.ok(found, `expected surface ${surface}`);
  return found.lemma;
}

function tokenOf(tokens, surface) {
  const found = tokens.find((t) => t.surface === surface);
  assert.ok(found, `expected surface ${surface}`);
  return found;
}

// ---------------- HARD GATE DISCRIMINATORS (must pass) ----------------

test('discriminator: 学校 is one coherent lexical unit', async () => {
  const tokens = await tokensFor('俺は学校に行った。');
  const school = tokenOf(tokens, '学校');
  assert.equal(school.lemma, '学校');
  assert.equal(school.pos, 'noun');
  assert.equal(school.lemmaReading, 'がっこう');
});

test('discriminator: 行った → 行く', async () => {
  const tokens = await tokensFor('俺は学校に行った。');
  assert.equal(lemmaOf(tokens, '行っ'), '行く');
  assert.equal(tokenOf(tokens, '行っ').pos, 'verb');
  assert.equal(tokenOf(tokens, '行っ').inflectionType, '五段・カ行促音便');
});

test('discriminator: 食べなかった → 食べる', async () => {
  const tokens = await tokensFor('昨日は何も食べなかった。');
  assert.equal(lemmaOf(tokens, '食べ'), '食べる');
});

test('discriminator: 来なかった → 来る', async () => {
  const tokens = await tokensFor('彼女は来なかった。');
  assert.equal(lemmaOf(tokens, '来'), '来る');
  assert.equal(tokenOf(tokens, '来').inflectionType, 'カ変・来ル');
});

test('discriminator: できなかった → できる', async () => {
  const tokens = await tokensFor('できなかった。');
  assert.equal(lemmaOf(tokens, 'でき'), 'できる');
});

// ---------------- REPRESENTATIVE COVERAGE ----------------

test('polite past recovers the plain lemma: 行きました → 行く', async () => {
  const tokens = await tokensFor('学校に行きました。');
  assert.equal(lemmaOf(tokens, '行き'), '行く');
});

test('sahen composition stays recoverable: 勉強している → 勉強 + する', async () => {
  const tokens = await tokensFor('日本語を勉強している。');
  assert.equal(lemmaOf(tokens, '勉強'), '勉強');
  assert.equal(lemmaOf(tokens, 'し'), 'する');
  assert.equal(tokenOf(tokens, 'いる').pos, 'auxiliary'); // 非自立 is use, not vocabulary
});

test('proper nouns stay visible with withheld readings', async () => {
  const tokens = await tokensFor('明日は東京へ行く予定です。');
  const tokyo = tokenOf(tokens, '東京');
  assert.equal(tokyo.pos, 'proper-noun');
  assert.equal(tokyo.surfaceReading, null);
  assert.equal(tokyo.lemmaReading, null);
  assert.equal(tokenOf(tokens, 'です').pos, 'copula');
});

test('adjective conjugations: 面白かった → 面白い, 静かな → 静か', async () => {
  const oo = await tokensFor('これはとても面白かった。');
  assert.equal(lemmaOf(oo, '面白かっ'), '面白い');
  assert.equal(tokenOf(oo, 'とても').pos, 'adverb');
  const shizuka = await tokensFor('静かな部屋で休みたい。');
  assert.equal(lemmaOf(shizuka, '静か'), '静か');
  assert.equal(tokenOf(shizuka, '静か').pos, 'na-adjective');
  assert.equal(tokenOf(shizuka, 'な').pos, 'copula');
  assert.equal(lemmaOf(shizuka, '休み'), '休む');
});

test('obligation frame preserves composable pieces: し + ない + ば + なる', async () => {
  const tokens = await tokensFor('宿題をしなければならない。');
  assert.equal(lemmaOf(tokens, 'し'), 'する');
  assert.ok(tokens.some((t) => t.lemma === 'なる'), 'なる piece preserved for future composition');
});

test('desiderative and progressive: 飲みたい → 飲む, 使っています → 使う', async () => {
  const nomitai = await tokensFor('コーヒーを飲みたい。');
  assert.equal(tokenOf(nomitai, 'コーヒー').pos, 'noun');
  assert.equal(lemmaOf(nomitai, '飲み'), '飲む');
  const tsukau = await tokensFor('コンピューターを使っています。');
  assert.equal(tokenOf(tsukau, 'コンピューター').pos, 'noun');
  assert.equal(lemmaOf(tsukau, '使っ'), '使う');
});

test('polite formula keeps the verb: お願いします → する', async () => {
  const tokens = await tokensFor('お願いします。');
  assert.equal(lemmaOf(tokens, 'し'), 'する');
});

test('names, loans, mixed scripts parse without crashing', async () => {
  const names = await tokensFor('田中さんは大阪で寿司を食べた。');
  assert.equal(tokenOf(names, '田中').pos, 'proper-noun');
  assert.equal(tokenOf(names, 'さん').pos, 'suffix');
  assert.equal(lemmaOf(names, '食べ'), '食べる');
  const mixed = await tokensFor('Tシャツを3枚買った。');
  assert.equal(tokenOf(mixed, 'Tシャツ').pos, 'noun');
  assert.equal(lemmaOf(mixed, '買っ'), '買う');
  const punct = await tokensFor('食べてみたら？');
  assert.equal(tokenOf(punct, '？').pos, 'symbol');
  assert.equal(lemmaOf(punct, '食べ'), '食べる');
  assert.equal(tokenOf(punct, 'み').pos, 'auxiliary'); // てみる みる is 非自立
});

test('jukujikun stays whole with word-level readings: 今日', async () => {
  const tokens = await tokensFor('今日は良い天気です。');
  const kyou = tokenOf(tokens, '今日');
  assert.equal(kyou.lemma, '今日');
  assert.equal(kyou.lemmaReading, 'きょう');
});

// ---------------- HEURISTIC CASES (documented, tolerant) ----------------

test('heuristic: kana-only long text stays lossless without lemma guarantees', async () => {
  // Without kanji anchors the engine guesses (ひ→ひる etc.). P12-A claims
  // only: no crash, lossless stream, valid offsets.
  const tokens = await tokensFor('ひらがなだけでかいたぶんしょうです。');
  assert.ok(tokens.length > 0);
});

test('heuristic: colloquial contractions preserve the verb lemma', async () => {
  const chau = await tokensFor('食べちゃった。');
  assert.equal(lemmaOf(chau, '食べ'), '食べる');
  const shiteta = await tokensFor('昨日テレビを見てた。');
  assert.equal(lemmaOf(shiteta, '見'), '見る');
  const janai = await tokensFor('これは本じゃない。');
  assert.ok(janai.length > 0); // じゃ segmentation is dictionary-specific; surface preserved
  const nakya = await tokensFor('早く行かなきゃ。');
  assert.equal(lemmaOf(nakya, '行か'), '行く');
  assert.equal(lemmaOf(nakya, '早く'), '早い');
});

test('heuristic: という and かもしれない stay visible for future composition', async () => {
  const toiu = await tokensFor('彼は来るという話だ。');
  assert.equal(lemmaOf(toiu, '来る'), '来る');
  assertSpanCovered(toiu, '彼は来るという話だ。', 'という');
  const kamo = await tokensFor('明日は雨が降るかもしれない。');
  assert.equal(lemmaOf(kamo, '降る'), '降る');
  assertSpanCovered(kamo, '明日は雨が降るかもしれない。', 'かもしれない');
});

// A multi-token expression is "preserved" when consecutive tokens cover its
// exact character span, regardless of how the dictionary splits it today.
function assertSpanCovered(tokens, sentence, span) {
  const start = sentence.indexOf(span);
  assert.ok(start >= 0, `fixture contains ${span}`);
  const end = start + Array.from(span).length;
  const covering = tokens.filter((t) => t.start >= start && t.end <= end);
  assert.ok(covering.length > 0, `tokens cover ${span}`);
  assert.equal(covering.map((t) => t.surface).join(''), span, `lossless span: ${span}`);
  assert.equal(covering[0].start, start);
  assert.equal(covering[covering.length - 1].end, end);
}
