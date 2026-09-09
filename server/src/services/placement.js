// NippoTrack v5.1 — Quick Placement quiz (10 questions drawn per user from a
// 40-item bank, N5..N3 bands only).
//
// ANSWER-KEY CONTAINMENT: this module is the canonical (and only) holder of
// bands + correct options + bank version. The public serializer
// (getPlacementQuestions) strips `band`, `type`, and `correctOption`, so
// clients only ever receive
// {id, prompt:{text,reading,translation}, options:[{id,text,reading,gloss}]}.
// scorePlacement / gradePlacement are pure (no I/O); persistence touches ONLY
// user_first_experience (placement_status / placement_estimate /
// placement_source / placement_completed_at / placement_total_correct /
// placement_correct_n5/n4/n3, migrations 015-017) keyed by the
// caller-supplied userId (req.user.id at the controller boundary). Raw
// answers are never stored, user_jlpt_target is never touched, and spoofed
// estimate/source/result fields in the request body are ignored (estimate and
// counts always derive from server-side grading; source always derives from
// which endpoint completed the placement).
//
// BANK v1 (40 items: N5 x12 / N4 x12 / N3 x16; every correctOption is 'a').
// Canonical types are 'vocab' | 'reading' | 'grammar' | 'comp' (the legacy
// 'vocab-meaning' / 'comprehension' labels retired with the old q01-q10 ids).
// Ten items are byte-identical renames of the old bank (prompts, options,
// readings, translations, correct option copied verbatim; only the id — and
// the type label where it used a legacy name — changed):
//   n5_reading_01 <- q01, n5_grammar_01 <- q02, n4_vocab_01 <- q03,
//   n4_reading_01 <- q04, n3_grammar_01 <- q05, n3_comp_01 <- q06,
//   n5_vocab_01 <- q07, n4_grammar_01 <- q08, n3_grammar_02 <- q09,
//   n3_comp_02 <- q10.
// The rename is safe: completed rows persist only per-band counts (never
// question ids), server-side id references existed only in this module and
// its tests, and the client builds submit payloads from server-provided ids.
// Thirty items are new (N5 vocab x3 + reading x3 + grammar x1 + comp x2,
// N4 vocab x3 + reading x3 + grammar x1 + comp x2, N3 vocab x4 + reading x4
// + grammar x2 + comp x2). Authoring notes for ambiguous details:
//   - N5 vocab/reading/comp items mirror the q07/q01 sentence patterns
//     (negated-antonym meaning choices; kana-spaced prompts for vocab).
//   - n3_grammar_03 tests the passive (ほめ__ました); the null affix is
//     encoded as option d { text: '（なし）', gloss: 'active (no affix)' }.
//   - Time options carry kana readings (ろくじ etc.) and '-o-clock' glosses;
//     sentence options carry kana readings and concise English glosses.
//
// DETERMINISTIC PER-USER STRATIFIED SELECTION (no runtime entropy anywhere
// in this module — the only crypto use is the SHA-256 seed hash):
//   seed32 = first 4 bytes, little-endian, of
//            SHA-256("<userId>:<PLACEMENT_BANK_VERSION>").
//   A single mulberry32 stream seeded with seed32 drives every draw of one
//   selectPlacementQuestions(userId) call, in this fixed order:
//   1. Slot picks in SLOT order: N5 vocab, N5 reading, N5 flex
//      (grammar|comp combined pool), N4 vocab, N4 reading, N4 flex, N3 vocab,
//      N3 reading, N3 grammar, N3 comp. Candidates within each (band,type)
//      group are sorted by id ascending first; each pick takes
//      index = floor(draw * pool.length) with remove-after-pick (pools are
//      disjoint by type within a band, so the removal is belt-and-braces).
//   2. Within-band Fisher-Yates shuffles on the continuing stream (N5, then
//      N4, then N3): for i from len-1 down to 1, j = floor(draw * (i+1)).
//   Output order is N5(3) + N4(3) + N3(4). Same userId + version yields the
//   identical 10 ids on every call, process, and restart (until a version
//   bump, which re-seeds every user). selectPlacementQuestions is exported
//   pure so tests pin it.
//
// WIRING: GET /placement/questions serves exactly selectPlacementQuestions
// (req.user.id) — the user scope comes ONLY from the authenticated identity;
// query/body user ids are never read (the controller does not forward them
// and the service takes no such parameter). POST /placement/submit accepts
// EXACTLY that 10-id set in any order, each with a canonical option id or an
// explicit null abstention: an in-bank-but-not-selected id, a wrong-size
// array, a duplicate, an unknown id, or an invalid optionId ("unknown", "",
// an option not offered by its question) is a 400.
//
// SCORING (highest qualifying band wins; default N5; NEVER returns N2/N1 —
// structurally impossible: PLACEMENT_BANDS contains only N5/N4/N3, byBand
// holds only N5/N4/N3 keys, and the function body holds only the literals
// 'N4'/'N3' plus the 'N5' default). Guards are BAND-AWARE with foundation
// gates (they count correct answers by bank band, not by id, so every
// stratified 3/3/4 selection grades identically). Abstentions (optionId null)
// score 0 and leave denominators fixed (bands 3/3/4, total 10):
// - N4 iff ALL of: >=4 correct among the 6 foundation items (selected N5+N4)
//       AND >=2 correct among N5 AND >=1 correct among N4.
// - N3 iff ALL of: >=7 correct of all 10 AND >=2 correct among N5
//       AND >=2 correct among N4 AND >=2 correct among N3 (selected N3 = 4).
// N3 implies the N4 conditions (min foundation 2+2=4), so highest-wins
// resolves deterministically to N3. Perfect 10/10 returns N3.
// This REPLACES the old gates (N4: >=4/6 + >=1 N4 with no N5 floor; N3: >=7
// + >=2 N3 with no N5/N4 floors) with strictly stronger foundation gates:
// a weak foundation can no longer be carried by the top band.
//
// DB NOTE (for Database Engineer): NO migration is required for this change.
// Questions live in code, never in the database; submit writes the same
// columns as before and every selection yields counts within the migration
// 017 ranges (total 0..10, N5 0..3, N4 0..3, N3 0..4), mirrored by
// assertPlacementCountsInRange. Historical completed rows are untouched (no
// regrade): they persist counts only, and GET surfaces the N5/N4/N3 subset
// via firstExperience.toPlacementResult, which already ignores the vestigial
// n2/n1 columns even if an old row carried nonzero values there.

const crypto = require('crypto');

const { PlacementAlreadyCompletedError, ValidationError } = require('../errors/http');

const PLACEMENT_BANK_VERSION = 1;
const PLACEMENT_SELECTION_SIZE = 10;
const PLACEMENT_ESTIMATES = ['N5', 'N4', 'N3', 'N2', 'N1'];
// Quiz bands: structurally N3-max — no N2/N1 band exists, so scorePlacement
// and gradePlacement cannot produce them (see scoring header).
const PLACEMENT_BANDS = ['N5', 'N4', 'N3'];
const PLACEMENT_SOURCES = ['quiz', 'self_reported'];
const SELF_REPORT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const PLACEMENT_OPTION_IDS = ['a', 'b', 'c', 'd'];

// Slot template: exactly 10 picks (N5 x3 / N4 x3 / N3 x4). A slot with two
// types draws from the combined (band, either-type) pool.
const PLACEMENT_SLOTS = [
  { band: 'N5', types: ['vocab'] },
  { band: 'N5', types: ['reading'] },
  { band: 'N5', types: ['grammar', 'comp'] },
  { band: 'N4', types: ['vocab'] },
  { band: 'N4', types: ['reading'] },
  { band: 'N4', types: ['grammar', 'comp'] },
  { band: 'N3', types: ['vocab'] },
  { band: 'N3', types: ['reading'] },
  { band: 'N3', types: ['grammar'] },
  { band: 'N3', types: ['comp'] }
];

// Server-canonical bank: `band`, `type`, and `correctOption` NEVER leave the
// server. Items are grouped N5 vocab / N5 reading / N5 grammar / N5 comp,
// then N4, then N3.
const PLACEMENT_BANK = [
  {
    id: 'n5_vocab_01',
    band: 'N5',
    type: 'vocab',
    prompt: {
      text: '「この かばんは おもいです。」おもいの 意味は どれですか。',
      reading: 'このかばんはおもいです。おもいのいみはどれですか。',
      translation: 'This bag is heavy. Which means heavy?'
    },
    options: [
      { id: 'a', text: 'かるくない', reading: 'かるくない', gloss: 'not light' },
      { id: 'b', text: 'ちいさい', reading: 'ちいさい', gloss: 'small' },
      { id: 'c', text: 'あたらしい', reading: 'あたらしい', gloss: 'new' },
      { id: 'd', text: 'きれいな', reading: 'きれいな', gloss: 'pretty, clean' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_vocab_02',
    band: 'N5',
    type: 'vocab',
    prompt: {
      text: '「この 自転車は あたらしいです。」あたらしいの 意味は どれですか。',
      reading: 'このじてんしゃはあたらしいです。あたらしいのいみはどれですか。',
      translation: 'This bicycle is new. Which means new?'
    },
    options: [
      { id: 'a', text: 'ふるくない', reading: 'ふるくない', gloss: 'not old' },
      { id: 'b', text: 'ちいさい', reading: 'ちいさい', gloss: 'small' },
      { id: 'c', text: 'あかい', reading: 'あかい', gloss: 'red' },
      { id: 'd', text: 'ながい', reading: 'ながい', gloss: 'long' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_vocab_03',
    band: 'N5',
    type: 'vocab',
    prompt: {
      text: '「この 家は おおきいです。」おおきいの 意味は どれですか。',
      reading: 'このいえはおおきいです。おおきいのいみはどれですか。',
      translation: 'This house is big. Which means big?'
    },
    options: [
      { id: 'a', text: 'ちいさくない', reading: 'ちいさくない', gloss: 'not small' },
      { id: 'b', text: 'みじかい', reading: 'みじかい', gloss: 'short' },
      { id: 'c', text: 'くらい', reading: 'くらい', gloss: 'dark' },
      { id: 'd', text: 'からい', reading: 'からい', gloss: 'spicy' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_vocab_04',
    band: 'N5',
    type: 'vocab',
    prompt: {
      text: '「冬は さむいです。」さむいの 意味は どれですか。',
      reading: 'ふゆはさむいです。さむいのいみはどれですか。',
      translation: 'Winter is cold. Which means cold?'
    },
    options: [
      { id: 'a', text: 'あつくない', reading: 'あつくない', gloss: 'not hot' },
      { id: 'b', text: 'あつい', reading: 'あつい', gloss: 'hot' },
      { id: 'c', text: 'つめたい', reading: 'つめたい', gloss: 'cold to touch' },
      { id: 'd', text: 'いたい', reading: 'いたい', gloss: 'painful' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_reading_01',
    band: 'N5',
    type: 'reading',
    prompt: {
      text: '「水をのみます。」水のよみ方は？',
      reading: 'みずをのみます',
      translation: 'How do you read 水? (Drink water.)'
    },
    options: [
      { id: 'a', text: 'みず', reading: 'みず', gloss: 'water' },
      { id: 'b', text: 'すい', reading: 'すい', gloss: 'On-reading' },
      { id: 'c', text: 'みす', reading: 'みす', gloss: 'non-word' },
      { id: 'd', text: 'むず', reading: 'むず', gloss: 'non-word' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_reading_02',
    band: 'N5',
    type: 'reading',
    prompt: {
      text: '「魚をたべます。」魚のよみ方は？',
      reading: 'さかなをたべます',
      translation: 'How do you read 魚? (Eat fish.)'
    },
    options: [
      { id: 'a', text: 'さかな', reading: 'さかな', gloss: 'fish' },
      { id: 'b', text: 'ぎょ', reading: 'ぎょ', gloss: 'On-reading' },
      { id: 'c', text: 'さなか', reading: 'さなか', gloss: 'non-word' },
      { id: 'd', text: 'ざかな', reading: 'ざかな', gloss: 'non-word' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_reading_03',
    band: 'N5',
    type: 'reading',
    prompt: {
      text: '「牛乳をのみます。」牛乳のよみ方は？',
      reading: 'ぎゅうにゅうをのみます',
      translation: 'How do you read 牛乳? (Drink milk.)'
    },
    options: [
      { id: 'a', text: 'ぎゅうにゅう', reading: 'ぎゅうにゅう', gloss: 'milk' },
      { id: 'b', text: 'ぎゅうゆう', reading: 'ぎゅうゆう', gloss: 'non-word' },
      { id: 'c', text: 'うしちち', reading: 'うしちち', gloss: 'literal-mashup' },
      { id: 'd', text: 'ごにゅう', reading: 'ごにゅう', gloss: 'non-word' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_reading_04',
    band: 'N5',
    type: 'reading',
    prompt: {
      text: '「机の上に本があります。」机のよみ方は？',
      reading: 'つくえのうえにほんがあります',
      translation: 'How do you read 机? (There is a book on the desk.)'
    },
    options: [
      { id: 'a', text: 'つくえ', reading: 'つくえ', gloss: 'desk' },
      { id: 'b', text: 'つきえ', reading: 'つきえ', gloss: 'non-word' },
      { id: 'c', text: 'きづくえ', reading: 'きづくえ', gloss: 'non-word' },
      { id: 'd', text: 'づくえ', reading: 'づくえ', gloss: 'non-word' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_grammar_01',
    band: 'N5',
    type: 'grammar',
    prompt: {
      text: '先生は教室__います。',
      reading: 'せんせいはきょうしつ__います',
      translation: 'The teacher is in the classroom.'
    },
    options: [
      { id: 'a', text: 'に', reading: 'に', gloss: 'location' },
      { id: 'b', text: 'を', reading: 'を', gloss: 'object' },
      { id: 'c', text: 'が', reading: 'が', gloss: 'subject' },
      { id: 'd', text: 'へ', reading: 'へ', gloss: 'direction' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_grammar_02',
    band: 'N5',
    type: 'grammar',
    prompt: {
      text: 'わたしは友だち__話します。',
      reading: 'わたしはともだち__はなします',
      translation: 'I talk with my friend.'
    },
    options: [
      { id: 'a', text: 'と', reading: 'と', gloss: 'with' },
      { id: 'b', text: 'に', reading: 'に', gloss: 'target' },
      { id: 'c', text: 'を', reading: 'を', gloss: 'object' },
      { id: 'd', text: 'へ', reading: 'へ', gloss: 'direction' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_comp_01',
    band: 'N5',
    type: 'comp',
    prompt: {
      text: '「あさは パンは ありません。ごはんを 食べます。」Q: あさは 何を 食べますか。',
      reading: 'あさはぱんはありません。ごはんをたべます。Q: あさはなにをたべますか。',
      translation: 'Morning: there is no bread; (I) eat rice. Q: What do you eat in the morning?'
    },
    options: [
      { id: 'a', text: 'ごはん', reading: 'ごはん', gloss: 'rice, meal' },
      { id: 'b', text: 'パン', reading: 'ぱん', gloss: 'bread' },
      { id: 'c', text: 'さかな', reading: 'さかな', gloss: 'fish' },
      { id: 'd', text: 'たまご', reading: 'たまご', gloss: 'egg' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n5_comp_02',
    band: 'N5',
    type: 'comp',
    prompt: {
      text: '田中「佐藤さんは何時に起きますか。」佐藤「6時に起きます。」Q: 佐藤さんは何時に起きますか。',
      reading: 'たなか「さとうさんはなんじにおきますか。」さとう「ろくじにおきます。」Q: さとうさんはなんじにおきますか。',
      translation: 'Tanaka asks Sato what time he gets up; Sato answers 6. Q: What time does Sato get up?'
    },
    options: [
      { id: 'a', text: '6時', reading: 'ろくじ', gloss: '6-o-clock' },
      { id: 'b', text: '7時', reading: 'しちじ', gloss: '7-o-clock' },
      { id: 'c', text: '9時', reading: 'くじ', gloss: '9-o-clock' },
      { id: 'd', text: '12時', reading: 'じゅうにじ', gloss: '12-o-clock' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_vocab_01',
    band: 'N4',
    type: 'vocab',
    prompt: {
      text: 'この駅はとても便利です。',
      reading: 'このえきはとてもべんりです',
      translation: 'This station is very convenient.'
    },
    options: [
      { id: 'a', text: 'つかうのにいい', reading: 'つかうのにいい', gloss: 'convenient' },
      { id: 'b', text: 'ひとがおおい', reading: 'ひとがおおい', gloss: 'crowded' },
      { id: 'c', text: 'ゆうめいな', reading: 'ゆうめいな', gloss: 'famous' },
      { id: 'd', text: 'しずかな', reading: 'しずかな', gloss: 'quiet' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_vocab_02',
    band: 'N4',
    type: 'vocab',
    prompt: {
      text: '「バスに間に合いました。」正しい意味は？',
      reading: 'ばすにまにあいました。ただしいいみは？',
      translation: 'I caught the bus in time. Which meaning is correct?'
    },
    options: [
      { id: 'a', text: '時間に遅れなかった', reading: 'じかんにおくれなかった', gloss: 'was-not-late' },
      { id: 'b', text: '時間がかかった', reading: 'じかんがかかった', gloss: 'took-time' },
      { id: 'c', text: '早く乗りたかった', reading: 'はやくのりたかった', gloss: 'wanted-to-ride-early' },
      { id: 'd', text: '乗りたくなかった', reading: 'のりたくなかった', gloss: 'did-not-want-to-ride' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_vocab_03',
    band: 'N4',
    type: 'vocab',
    prompt: {
      text: '「古い手紙を捨てました。」正しい意味は？',
      reading: 'ふるいてがみをすてました。ただしいいみは？',
      translation: 'I threw away the old letter. Which meaning is correct?'
    },
    options: [
      { id: 'a', text: 'ごみに出した', reading: 'ごみにだした', gloss: 'put-out-as-trash' },
      { id: 'b', text: '大事にしまった', reading: 'だいじにしまった', gloss: 'put-away-carefully' },
      { id: 'c', text: 'きれいに洗った', reading: 'きれいにあらった', gloss: 'washed-clean' },
      { id: 'd', text: '友だちに送った', reading: 'ともだちにおくった', gloss: 'sent-to-a-friend' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_vocab_04',
    band: 'N4',
    type: 'vocab',
    prompt: {
      text: '「朝のスーパーは混みます。」正しい意味は？',
      reading: 'あさのすーぱーはこみます。ただしいいみは？',
      translation: 'The morning supermarket is crowded. Which meaning is correct?'
    },
    options: [
      { id: 'a', text: '人でいっぱい', reading: 'ひとでいっぱい', gloss: 'full-of-people' },
      { id: 'b', text: '物が安い', reading: 'ものがやすい', gloss: 'things-are-cheap' },
      { id: 'c', text: '店が広い', reading: 'みせがひろい', gloss: 'store-is-big' },
      { id: 'd', text: '人が少ない', reading: 'ひとがすくない', gloss: 'few-people' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_reading_01',
    band: 'N4',
    type: 'reading',
    prompt: {
      text: '日曜日は休みです。',
      reading: 'にちようびはやすみです',
      translation: 'Sunday is a day off.'
    },
    options: [
      { id: 'a', text: 'やすみ', reading: 'やすみ', gloss: 'day-off' },
      { id: 'b', text: 'やすむ', reading: 'やすむ', gloss: 'to-rest' },
      { id: 'c', text: 'きゅうみ', reading: 'きゅうみ', gloss: 'invalid' },
      { id: 'd', text: 'おやすみ', reading: 'おやすみ', gloss: 'honorific-form' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_reading_02',
    band: 'N4',
    type: 'reading',
    prompt: {
      text: '「お金を借りました。」借りましたのよみ方は？',
      reading: 'おかねをかりました。かりましたのよみかたは？',
      translation: 'How do you read 借りました? (Borrowed money.)'
    },
    options: [
      { id: 'a', text: 'かりました', reading: 'かりました', gloss: 'borrowed' },
      { id: 'b', text: 'かしました', reading: 'かしました', gloss: 'lent' },
      { id: 'c', text: 'かかりました', reading: 'かかりました', gloss: 'took (time, cost)' },
      { id: 'd', text: 'しゃく', reading: 'しゃく', gloss: 'On-reading' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_reading_03',
    band: 'N4',
    type: 'reading',
    prompt: {
      text: '「荷物を届けます。」届けますのよみ方は？',
      reading: 'にもつをとどけます。とどけますのよみかたは？',
      translation: 'How do you read 届けます? (Deliver luggage.)'
    },
    options: [
      { id: 'a', text: 'とどけます', reading: 'とどけます', gloss: 'deliver (transitive)' },
      { id: 'b', text: 'とどきます', reading: 'とどきます', gloss: 'arrive (intransitive)' },
      { id: 'c', text: 'おどけます', reading: 'おどけます', gloss: 'non-word' },
      { id: 'd', text: 'とどめます', reading: 'とどめます', gloss: 'invalid' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_reading_04',
    band: 'N4',
    type: 'reading',
    prompt: {
      text: '「スープが暖かいです。」暖かいのよみ方は？',
      reading: 'すーぷがあたたかいです。あたたかいのよみかたは？',
      translation: 'How do you read 暖かい? (The soup is warm.)'
    },
    options: [
      { id: 'a', text: 'あたたかい', reading: 'あたたかい', gloss: 'warm' },
      { id: 'b', text: 'あったかい', reading: 'あったかい', gloss: 'colloquial-variant' },
      { id: 'c', text: 'あたたきい', reading: 'あたたきい', gloss: 'malformed' },
      { id: 'd', text: 'だんかい', reading: 'だんかい', gloss: 'invalid' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_grammar_01',
    band: 'N4',
    type: 'grammar',
    prompt: {
      text: '「へやが 暗くなる前に、電気を つけて __。」入る ものは？',
      reading: 'へやがくらくなるまえに、でんきをつけて__。はいるものは？',
      translation: 'Before it gets dark, ___ turning on the light.'
    },
    options: [
      { id: 'a', text: 'おきましょう', reading: 'おきましょう', gloss: 'advance-prep' },
      { id: 'b', text: 'みましょう', reading: 'みましょう', gloss: 'try' },
      { id: 'c', text: 'しまいましょう', reading: 'しまいましょう', gloss: 'end up' },
      { id: 'd', text: 'ありましょう', reading: 'ありましょう', gloss: 'ungrammatical' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_grammar_02',
    band: 'N4',
    type: 'grammar',
    prompt: {
      text: '「一人で船に__。」入るものは？',
      reading: 'ひとりでふねに__。はいるものは？',
      translation: 'I can ride the boat alone. (potential form)'
    },
    options: [
      { id: 'a', text: 'のれます', reading: 'のれます', gloss: 'can-ride' },
      { id: 'b', text: 'のります', reading: 'のります', gloss: 'ride' },
      { id: 'c', text: 'のりましょう', reading: 'のりましょう', gloss: 'lets-ride' },
      { id: 'd', text: 'のって', reading: 'のって', gloss: 'te-form' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_comp_01',
    band: 'N4',
    type: 'comp',
    prompt: {
      text: '「ドアに 午後6時まで通れますと書いてあります。」Q: 午後7時にここはどうですか。',
      reading: 'どあにごごろくじまでとおれますとかいてあります。Q: ごごしちじにここはどうですか。',
      translation: 'Sign: passable until 6pm. Q: What about this place at 7pm?'
    },
    options: [
      { id: 'a', text: '通れません', reading: 'とおれません', gloss: 'cannot-pass' },
      { id: 'b', text: '通れます', reading: 'とおれます', gloss: 'can-pass' },
      { id: 'c', text: '開いています', reading: 'あいています', gloss: 'is-open' },
      { id: 'd', text: '明るい', reading: 'あかるい', gloss: 'bright' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n4_comp_02',
    band: 'N4',
    type: 'comp',
    prompt: {
      text: '店員「シャツを交換しますね。まず試してください。」Q: 客は何をしますか。',
      reading: 'てんいん「しゃつをこうかんしますね。まずためしてください。」Q: きゃくはなにをしますか。',
      translation: 'Clerk: we will exchange the shirt; please try it on first. Q: What does the customer do?'
    },
    options: [
      { id: 'a', text: 'シャツを試します', reading: 'しゃつをためします', gloss: 'try-on-the-shirt' },
      { id: 'b', text: 'シャツを買います', reading: 'しゃつをかいます', gloss: 'buy-the-shirt' },
      { id: 'c', text: 'シャツを捨てます', reading: 'しゃつをすてます', gloss: 'throw-away-the-shirt' },
      { id: 'd', text: 'シャツを作ります', reading: 'しゃつをつくります', gloss: 'make-the-shirt' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_vocab_01',
    band: 'N3',
    type: 'vocab',
    prompt: {
      text: '「状況を教えてください。」状況の意味は？',
      reading: 'じょうきょうをおしえてください。じょうきょうのいみは？',
      translation: 'Please tell me the situation (状況 じょうきょう). Which meaning is correct?'
    },
    options: [
      { id: 'a', text: '今の様子や状態', reading: 'いまのようすやじょうたい', gloss: 'current-state' },
      { id: 'b', text: 'これからの予定', reading: 'これからのよてい', gloss: 'future-plans' },
      { id: 'c', text: '昨日の天気', reading: 'きのうのてんき', gloss: 'yesterdays-weather' },
      { id: 'd', text: '人の名前', reading: 'ひとのなまえ', gloss: 'persons-name' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_vocab_02',
    band: 'N3',
    type: 'vocab',
    prompt: {
      text: '「適切な答えを書いてください。」適切の意味は？',
      reading: 'てきせつなこたえをかいてください。てきせつのいみは？',
      translation: 'Write a fitting answer (適切 てきせつ). Which meaning is correct?'
    },
    options: [
      { id: 'a', text: '状況に合って正しい', reading: 'じょうきょうにあってただしい', gloss: 'fitting-and-correct' },
      { id: 'b', text: 'とても難しい', reading: 'とてもむずかしい', gloss: 'very-difficult' },
      { id: 'c', text: '少し古い', reading: 'すこしふるい', gloss: 'slightly-old' },
      { id: 'd', text: '誰も分からない', reading: 'だれもわからない', gloss: 'no-one-knows' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_vocab_03',
    band: 'N3',
    type: 'vocab',
    prompt: {
      text: '「無駄な努力はしたくない。」無駄の意味は？',
      reading: 'むだなどりょくはしたくない。むだのいみは？',
      translation: 'I do not want to make a wasted effort (無駄 むだ). Which meaning is correct?'
    },
    options: [
      { id: 'a', text: '意味がなくもったいない', reading: 'いみがなくもったいない', gloss: 'meaningless-and-wasteful' },
      { id: 'b', text: 'とても役に立つ', reading: 'とてもやくにたつ', gloss: 'very-useful' },
      { id: 'c', text: '少し難しい', reading: 'すこしむずかしい', gloss: 'slightly-difficult' },
      { id: 'd', text: '皆が褒める', reading: 'みんながほめる', gloss: 'everyone-praises' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_vocab_04',
    band: 'N3',
    type: 'vocab',
    prompt: {
      text: '「彼の答えは曖昧だ。」曖昧の意味は？',
      reading: 'かれのこたえはあいまいだ。あいまいのいみは？',
      translation: 'His answer is vague (曖昧 あいまい). Which meaning is correct?'
    },
    options: [
      { id: 'a', text: 'はっきりしない', reading: 'はっきりしない', gloss: 'not-clear' },
      { id: 'b', text: 'とても長い', reading: 'とてもながい', gloss: 'very-long' },
      { id: 'c', text: 'すぐ終わる', reading: 'すぐおわる', gloss: 'ends-quickly' },
      { id: 'd', text: '必ず正しい', reading: 'かならずただしい', gloss: 'always-correct' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_reading_01',
    band: 'N3',
    type: 'reading',
    prompt: {
      text: '「大人が三人います。」大人のよみ方は？',
      reading: 'おとながさんにんいます。おとなのよみかたは？',
      translation: 'How do you read 大人? (Three adults are here.)'
    },
    options: [
      { id: 'a', text: 'おとな', reading: 'おとな', gloss: 'adult' },
      { id: 'b', text: 'おおひと', reading: 'おおひと', gloss: 'literal-mashup' },
      { id: 'c', text: 'だいにん', reading: 'だいにん', gloss: 'invalid' },
      { id: 'd', text: 'たいじん', reading: 'たいじん', gloss: 'invalid' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_reading_02',
    band: 'N3',
    type: 'reading',
    prompt: {
      text: '「代金を支払います。」支払いますのよみ方は？',
      reading: 'だいきんをしはらいます。しはらいますのよみかたは？',
      translation: 'How do you read 支払います? (Pay the charge.)'
    },
    options: [
      { id: 'a', text: 'しはらいます', reading: 'しはらいます', gloss: 'pay' },
      { id: 'b', text: 'はらいます', reading: 'はらいます', gloss: 'pay (plain verb)' },
      { id: 'c', text: 'しばらいます', reading: 'しばらいます', gloss: 'non-word' },
      { id: 'd', text: 'しはらえります', reading: 'しはらえります', gloss: 'malformed' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_reading_03',
    band: 'N3',
    type: 'reading',
    prompt: {
      text: '「彼の話を疑います。」疑いますのよみ方は？',
      reading: 'かれのはなしをうたがいます。うたがいますのよみかたは？',
      translation: 'How do you read 疑います? (Doubt his story.)'
    },
    options: [
      { id: 'a', text: 'うたがいます', reading: 'うたがいます', gloss: 'doubt' },
      { id: 'b', text: 'うたがいします', reading: 'うたがいします', gloss: 'malformed-suru' },
      { id: 'c', text: 'ぎいます', reading: 'ぎいます', gloss: 'non-word' },
      { id: 'd', text: 'うたがきます', reading: 'うたがきます', gloss: 'malformed' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_reading_04',
    band: 'N3',
    type: 'reading',
    prompt: {
      text: '「親戚を訪ねます。」訪ねますのよみ方は？',
      reading: 'しんせきをたずねます。たずねますのよみかたは？',
      translation: 'How do you read 訪ねます? (Visit relatives.)'
    },
    options: [
      { id: 'a', text: 'たずねます', reading: 'たずねます', gloss: 'visit' },
      { id: 'b', text: 'おとずれます', reading: 'おとずれます', gloss: 'visit (homograph)' },
      { id: 'c', text: 'ほうねます', reading: 'ほうねます', gloss: 'non-word' },
      { id: 'd', text: 'たずれます', reading: 'たずれます', gloss: 'non-word' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_grammar_01',
    band: 'N3',
    type: 'grammar',
    prompt: {
      text: '「いそがしい」の「たら」形は？',
      reading: '「いそがしい」の「たら」形は？',
      translation: 'What is the tara-form of いそがしい (busy)?'
    },
    options: [
      { id: 'a', text: 'いそがしかったら', reading: 'いそがしかったら', gloss: 'tara-form' },
      { id: 'b', text: 'いそがしければ', reading: 'いそがしければ', gloss: 'ba-form' },
      { id: 'c', text: 'いそがしいたら', reading: 'いそがしいたら', gloss: 'malformed' },
      { id: 'd', text: 'いそがしかったば', reading: 'いそがしかったば', gloss: 'malformed' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_grammar_02',
    band: 'N3',
    type: 'grammar',
    prompt: {
      text: '「練習 __、上手に なります。」入る ものは？',
      reading: 'れんしゅう__、じょうずになります。はいるものは？',
      translation: 'The more you practice, the better you get.'
    },
    options: [
      { id: 'a', text: 'すればするほど', reading: 'すればするほど', gloss: 'the more, the more' },
      { id: 'b', text: 'したらしたほど', reading: 'したらしたほど', gloss: 'malformed' },
      { id: 'c', text: 'してもしてもほど', reading: 'してもしてもほど', gloss: 'malformed' },
      { id: 'd', text: 'するればするほど', reading: 'するればするほど', gloss: 'malformed' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_grammar_03',
    band: 'N3',
    type: 'grammar',
    prompt: {
      text: '「息子は近所の人にほめ__ました。」入るものは？',
      reading: 'むすこはきんじょのひとにほめ__ました。はいるものは？',
      translation: 'My son was praised by the neighbors. (passive)'
    },
    options: [
      { id: 'a', text: 'られ', reading: 'られ', gloss: 'passive' },
      { id: 'b', text: 'させ', reading: 'させ', gloss: 'causative' },
      { id: 'c', text: 'させられ', reading: 'させられ', gloss: 'causative-passive' },
      { id: 'd', text: '（なし）', reading: 'なし', gloss: 'active (no affix)' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_grammar_04',
    band: 'N3',
    type: 'grammar',
    prompt: {
      text: '「遠く__歩きます。」入るものは？',
      reading: 'とおく__あるきます。はいるものは？',
      translation: 'Even if it is far, I walk. (concessive)'
    },
    options: [
      { id: 'a', text: 'ても', reading: 'ても', gloss: 'even-if' },
      { id: 'b', text: 'たら', reading: 'たら', gloss: 'if-when' },
      { id: 'c', text: 'ば', reading: 'ば', gloss: 'if' },
      { id: 'd', text: 'なら', reading: 'なら', gloss: 'if-so' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_comp_01',
    band: 'N3',
    type: 'comp',
    prompt: {
      text: 'メモ「ケーキは半分だけ食べてください。」正しい理解は？',
      reading: 'けーきははんぶんだけたべてください',
      translation: 'Memo: please eat only half the cake. Which understanding is correct?'
    },
    options: [
      { id: 'a', text: '半分食べてもいい', reading: 'はんぶんたべてもいい', gloss: 'may-eat-half' },
      { id: 'b', text: '全部食べてもいい', reading: 'ぜんぶたべてもいい', gloss: 'may-eat-all' },
      { id: 'c', text: '食べてはいけない', reading: 'たべてはいけない', gloss: 'must-not' },
      { id: 'd', text: '何も食べないほうがいい', reading: 'なにもたべないほうがいい', gloss: 'better-not' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_comp_02',
    band: 'N3',
    type: 'comp',
    prompt: {
      text: '「この 駐車場は、当店を ご利用の 方に 限らせて いただきます。」正しい 理解は？',
      reading: 'このちゅうしゃじょうは、とうてんをごりようのかたにかぎらせていただきます。ただしいりかいは？',
      translation: 'Parking is restricted to store customers. Which is correct?'
    },
    options: [
      { id: 'a', text: '店で買い物や食事をした人だけ止められる', reading: 'みせでかいものやしょくじをしたひとだけとめられる', gloss: 'only-customers-may-park' },
      { id: 'b', text: '誰でも自由に止められる', reading: 'だれでもじゆうにとめられる', gloss: 'anyone-may-park' },
      { id: 'c', text: '店の人だけ止められて客は止められない', reading: 'みせのひとだけとめられてきゃくはとめられない', gloss: 'staff-only' },
      { id: 'd', text: '車がない人も休むために使える', reading: 'くるまがないひともやすむためにつかえる', gloss: 'rest-without-car' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_comp_03',
    band: 'N3',
    type: 'comp',
    prompt: {
      text: '会議室「使う前に名前を書いて、使った後は椅子を戻してください。」Q: 使う人は何をしますか。',
      reading: 'かいぎしつ「つかうまえになまえをかいて、つかったあとはいすをもどしてください。」Q: つかうひとはなにをしますか。',
      translation: 'Meeting room: write your name before use, put chairs back after. Q: What does a user do?'
    },
    options: [
      { id: 'a', text: '前に名前を書いて後に椅子を戻す', reading: 'まえになまえをかいてあとにいすをもどす', gloss: 'write-before-return-after' },
      { id: 'b', text: '使った後だけ名前を書く', reading: 'つかったあとだけなまえをかく', gloss: 'write-only-after' },
      { id: 'c', text: '使う前にだけ椅子を戻す', reading: 'つかうまえにだけいすをもどす', gloss: 'return-chairs-only-before' },
      { id: 'd', text: '何もしなくていい', reading: 'なにもしなくていい', gloss: 'do-nothing' }
    ],
    correctOption: 'a'
  },
  {
    id: 'n3_comp_04',
    band: 'N3',
    type: 'comp',
    prompt: {
      text: '「集まりは3時です。遅れる人は連絡してください。持ち物はいりません。」Q: 遅れる人はどうしますか。',
      reading: 'あつまりはさんじです。おくれるひとはれんらくしてください。もちものはいりません。Q: おくれるひとはどうしますか。',
      translation: 'Gathering at 3; latecomers must contact; no belongings needed. Q: What does a late person do?'
    },
    options: [
      { id: 'a', text: '連絡します', reading: 'れんらくします', gloss: 'contact' },
      { id: 'b', text: '持ち物を持ってきます', reading: 'もちものをもってきます', gloss: 'bring-belongings' },
      { id: 'c', text: '来ません', reading: 'きません', gloss: 'not-come' },
      { id: 'd', text: '3時より前に来ます', reading: 'さんじよりまえにきます', gloss: 'come-before-3' }
    ],
    correctOption: 'a'
  }
];

const BANK_BY_ID = new Map(PLACEMENT_BANK.map((question) => [question.id, question]));
const PLACEMENT_BANK_IDS = PLACEMENT_BANK.map((question) => question.id);

// User scope is the authenticated identity ONLY (req.user.id at the
// controller boundary). This guard rejects empty/non-string scopes so a
// missing identity can never silently select or grade; query/body user ids
// are never accepted because the service takes no such parameter.
function assertPlacementUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ValidationError('placement user scope is required.');
  }
}

// Seed = first 4 bytes (little-endian) of SHA-256("<userId>:<version>").
// The hash is the ONLY crypto use in this module (seeding, never output).
function seedFromUserId(userId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${userId}:${PLACEMENT_BANK_VERSION}`, 'utf8')
    .digest();
  return digest.readUInt32LE(0);
}

// mulberry32: small seeded PRNG (documented so tests can pin the stream).
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pure deterministic stratified selection: 10 ids ordered N5(3) + N4(3) +
// N3(4). Procedure (pinned by tests): single mulberry32 stream per call;
// slot picks in PLACEMENT_SLOTS order from id-sorted pools with
// remove-after-pick; then within-band Fisher-Yates shuffles (N5, N4, N3) on
// the continuing stream. Same userId + version => identical output forever.
function selectPlacementQuestions(userId) {
  assertPlacementUserId(userId);
  const next = mulberry32(seedFromUserId(userId));
  const picked = new Set();
  const take = (band, types) => {
    const wanted = new Set(types);
    const pool = PLACEMENT_BANK
      .filter((question) => question.band === band && wanted.has(question.type))
      .map((question) => question.id)
      .sort()
      .filter((id) => !picked.has(id));
    if (pool.length === 0) {
      throw new ValidationError('placement bank cannot fill the requested slot.');
    }
    const questionId = pool[Math.floor(next() * pool.length)];
    picked.add(questionId);
    return questionId;
  };
  const byBand = { N5: [], N4: [], N3: [] };
  for (const slot of PLACEMENT_SLOTS) {
    byBand[slot.band].push(take(slot.band, slot.types));
  }
  for (const band of PLACEMENT_BANDS) {
    const items = byBand[band];
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
  }
  return [...byBand.N5, ...byBand.N4, ...byBand.N3];
}

// Public serializer: the user's 10 selected questions in selection order,
// deep-copied with band + type + correctOption stripped. The only question
// payload the client is ever allowed to see.
function getPlacementQuestions(userId) {
  const selected = selectPlacementQuestions(userId);
  return selected.map((id) => {
    const question = BANK_BY_ID.get(id);
    return {
      id: question.id,
      prompt: { ...question.prompt },
      options: question.options.map((option) => ({ ...option }))
    };
  });
}

// Pure scoring: highest qualifying band wins, default N5. Band-aware: bands
// resolve through the bank lookup, so any stratified 3/3/4 selection grades
// identically (foundation max 6, N3 max 4). Foundation-gate thresholds: N4 =
// >=4/6 foundation + >=2 N5 + >=1 N4; N3 = >=7/10 + >=2 N5 + >=2 N4 + >=2 N3.
// N3 is the structural maximum — no N2/N1 literals exist on any return path
// and PLACEMENT_BANDS holds only N5/N4/N3. Unknown/missing/null entries count
// as incorrect (validation rejects unknown/missing at the API boundary and
// accepts null as an explicit zero-credit abstention; this keeps the pure
// function total).
function scorePlacement(answers) {
  const { totalCorrect, byBand } = countCorrectByBand(answers);
  return applyPlacementThresholds(totalCorrect, byBand);
}

function applyPlacementThresholds(totalCorrect, byBand) {
  // Foundation-gate scoring (highest qualifying wins, default N5).
  // N3 (max): strong cumulative (7/10) + foundation floors (>=2 N5, >=2 N4)
  //   + at least half the top band (>=2/4 N3, blocks single-lucky-guess
  //   promotion and top-band carries of a weak foundation).
  // N4: foundation majority (4/6 N5+N4) + N5 floor (>=2/3) + >=1 N4 item.
  const source = byBand && typeof byBand === 'object' ? byBand : {};
  const n5 = source.N5 || 0;
  const n4 = source.N4 || 0;
  const n3 = source.N3 || 0;
  if (totalCorrect >= 7 && n5 >= 2 && n4 >= 2 && n3 >= 2) return 'N3';
  if (n5 + n4 >= 4 && n5 >= 2 && n4 >= 1) return 'N4';
  return 'N5';
}

// Shared band counter (unknown/missing entries ignored => incorrect).
// Explicit abstentions (optionId null) fall through the correctOption check
// and contribute 0 to their band's correct count; denominators stay fixed
// (bands 3/3/4, total 10) because the selection — not the answers — sets them.
function countCorrectByBand(answers) {
  const byBand = { N5: 0, N4: 0, N3: 0 };
  let totalCorrect = 0;
  if (Array.isArray(answers)) {
    for (const entry of answers) {
      if (!entry || typeof entry !== 'object') continue;
      const question = BANK_BY_ID.get(entry.questionId);
      if (question && entry.optionId === question.correctOption) {
        byBand[question.band] += 1;
        totalCorrect += 1;
      }
    }
  }
  return { totalCorrect, byBand };
}

// Pure grading: per-band correct counts + total, derived server-side from the
// bank (never from client-supplied counts — spoofed `result` fields in the
// request body are ignored, exactly like spoofed estimates). Bands counted
// are N5/N4/N3 only (structural N3-max: no N2/N1 keys exist).
function gradePlacement(answers) {
  const { totalCorrect, byBand } = countCorrectByBand(answers);
  return { estimate: applyPlacementThresholds(totalCorrect, byBand), totalCorrect, byBand };
}

// Strict validation: exactly the caller's 10 SELECTED question ids (order
// insensitive), no duplicates, no extras; every optionId is either null
// (explicit "I don't know" abstention: accepted, scores 0, never stored) or a
// valid canonical option id FOR ITS OWN question (per-question membership, not
// just bank-global). An in-bank-but-not-selected id is a 400 exactly like an
// unknown id (prevents answering a forged easier/harder set). Unknown strings
// (e.g. "unknown"), "" / wrong types / missing optionId, an option id that is
// not offered by its question, a duplicate, a wrong-size array, or a missing
// selected id is a 400. Spoofed estimate / result fields live outside
// `answers` and are never read. No fake option id exists: the bank offers only
// a/b/c/d per question, and null is the sole non-id abstention signal.
function normalizePlacementAnswers(body, expectedQuestionIds) {
  const expected = Array.isArray(expectedQuestionIds) ? expectedQuestionIds : [];
  if (
    expected.length !== PLACEMENT_SELECTION_SIZE ||
    new Set(expected).size !== PLACEMENT_SELECTION_SIZE ||
    !expected.every((id) => BANK_BY_ID.has(id))
  ) {
    throw new ValidationError('placement selection is invalid.');
  }
  const expectedSet = new Set(expected);
  const source = body && typeof body === 'object' ? body : {};
  const answers = source.answers;
  if (!Array.isArray(answers) || answers.length !== PLACEMENT_SELECTION_SIZE) {
    throw new ValidationError('answers must be an array of exactly 10 {questionId, optionId} entries.');
  }
  const seen = new Set();
  for (const entry of answers) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError('Each answer must be a {questionId, optionId} object.');
    }
    const { questionId, optionId } = entry;
    if (typeof questionId !== 'string' || !BANK_BY_ID.has(questionId)) {
      throw new ValidationError(`Unknown questionId: ${typeof questionId === 'string' ? questionId : '(invalid)'}.`);
    }
    if (!expectedSet.has(questionId)) {
      throw new ValidationError('answers must match your assigned placement questions exactly.');
    }
    if (seen.has(questionId)) {
      throw new ValidationError(`Duplicate answer for question ${questionId}.`);
    }
    seen.add(questionId);
    const question = BANK_BY_ID.get(questionId);
    if (optionId === null) {
      continue;
    }
    if (typeof optionId !== 'string' || !PLACEMENT_OPTION_IDS.includes(optionId) ||
        !question.options.some((option) => option.id === optionId)) {
      throw new ValidationError(`Invalid optionId for question ${questionId}: must be one of a, b, c, d, or null (abstain).`);
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) {
      throw new ValidationError('answers must match your assigned placement questions exactly.');
    }
  }
  return answers;
}

function normalizeStoredEstimate(value) {
  return PLACEMENT_ESTIMATES.includes(value) ? value : null;
}

function normalizeStoredSource(value) {
  return PLACEMENT_SOURCES.includes(value) ? value : null;
}

// Strict self-report validation: exactly { level: 'N5'..'N1' }. Any other
// shape (missing, non-string, wrong case, out-of-enum) is a 400. Spoofed
// estimate/source/result/count fields are never read — the persisted estimate
// always equals `level` and counts are always NULL (no quiz data fabricated).
function normalizeSelfReportLevel(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof source.level !== 'string' || !SELF_REPORT_LEVELS.includes(source.level)) {
    throw new ValidationError("level must be one of 'N5', 'N4', 'N3', 'N2', 'N1'.");
  }
  return source.level;
}

// Defense-in-depth range check mirroring the migration 017 DB CHECKs: total
// 0..10, N5 0..3, N4 0..3, N3 0..4. The graded path can never violate these
// (every selection holds 3 N5 + 3 N4 + 4 N3); the DB CHECKs remain
// authoritative. Throws 400.
function assertPlacementCountsInRange(totalCorrect, byBand) {
  if (!Number.isInteger(totalCorrect) || totalCorrect < 0 || totalCorrect > 10) {
    throw new ValidationError('placement totalCorrect must be an integer between 0 and 10.');
  }
  const source = byBand && typeof byBand === 'object' ? byBand : {};
  const maxima = { N5: 3, N4: 3, N3: 4 };
  for (const band of PLACEMENT_BANDS) {
    const value = source[band];
    if (!Number.isInteger(value) || value < 0 || value > maxima[band]) {
      throw new ValidationError(`placement byBand.${band} must be an integer between 0 and ${maxima[band]}.`);
    }
  }
}

// Serves the caller's deterministic 10-question set unless placement is
// already completed (one-time quiz: completed users get 409
// PLACEMENT_ALREADY_COMPLETED and read their persisted result via GET
// /api/first-experience instead). Completed via EITHER source (quiz or
// self_reported) blocks questions — the check is on placement_status, never
// on source.
// Read-only: single bounded SELECT, no writes.
async function getPlacementQuestionsForUser(database, userId) {
  assertPlacementUserId(userId);
  const [rows] = await database.execute(
    'SELECT placement_status FROM user_first_experience WHERE user_id = ?',
    [userId]
  );
  if (rows && rows[0] && rows[0].placement_status === 'completed') {
    throw new PlacementAlreadyCompletedError();
  }
  return getPlacementQuestions(userId);
}

// Scores, then persists placement_status='completed' + estimate + source
// 'quiz' + the full per-band breakdown + timestamp atomically. Answers must
// cover EXACTLY the caller's selected set (order insensitive); anything else
// is a 400 and persists nothing. ONE-TIME ACROSS BOTH SOURCES: a completed
// row (quiz OR self_reported) can never be re-completed (409
// PLACEMENT_ALREADY_COMPLETED) — the guard reads only placement_status,
// never source.
// RACE SAFETY: validation runs before the transaction; inside it we
// ensure-then-lock the row (INSERT ... ON CONFLICT DO NOTHING + SELECT ...
// FOR UPDATE on the single-user row) so concurrent submits serialize on the
// row lock — the loser sees 'completed' and rolls back with 409 instead of
// double-completing. Absent row => created (onboarding stays incomplete,
// sources stay default); present row => onboarding/sources untouched. Single
// transaction; never stores raw answers; never touches user_jlpt_target.
// placement_correct_n2/n1 are written as 0: the bank holds no N2/N1 items, so
// they are vestigial columns kept at 0 for schema compat (total always
// equals N5+N4+N3).
async function submitPlacement(pool, userId, body) {
  assertPlacementUserId(userId);
  const expected = selectPlacementQuestions(userId);
  const answers = normalizePlacementAnswers(body, expected);
  const { estimate, totalCorrect, byBand } = gradePlacement(answers);
  assertPlacementCountsInRange(totalCorrect, byBand);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      'INSERT INTO user_first_experience (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
    const [rows] = await connection.execute(
      'SELECT placement_status FROM user_first_experience WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    if (rows && rows[0] && rows[0].placement_status === 'completed') {
      throw new PlacementAlreadyCompletedError();
    }
    await connection.execute(
      'UPDATE user_first_experience SET placement_status = \'completed\', placement_estimate = ?, placement_source = \'quiz\', ' +
      'placement_total_correct = ?, placement_correct_n5 = ?, placement_correct_n4 = ?, ' +
      'placement_correct_n3 = ?, placement_correct_n2 = 0, placement_correct_n1 = 0, ' +
      'placement_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [estimate, totalCorrect, byBand.N5, byBand.N4, byBand.N3, userId]
    );
    await connection.commit();
    connection.release();
    connection = null;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Transaction rollback failed:', rollbackError);
      } finally {
        connection.release();
      }
    }
    throw error;
  }
  return { estimate, placement: { status: 'completed', estimate } };
}

// Persists a self-reported starting level: validates {level} (400 otherwise),
// then atomically marks placement completed with estimate=level +
// source='self_reported' + completedAt and NULLs every count column (no quiz
// data is fabricated — result therefore reads as null via GET). ONE-TIME
// ACROSS BOTH SOURCES: throws 409 PLACEMENT_ALREADY_COMPLETED when the row
// is already completed via quiz OR self-report. Same ensure-then-lock
// transaction as submitPlacement so a concurrent quiz submit and self-report
// serialize on the row lock (loser rolls back with 409). Never touches
// onboarding columns, study sources, or user_jlpt_target. Returns the level;
// the controller composes the full GET shape for the HTTP response.
async function selfReportPlacement(pool, userId, body) {
  const level = normalizeSelfReportLevel(body);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      'INSERT INTO user_first_experience (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
    const [rows] = await connection.execute(
      'SELECT placement_status FROM user_first_experience WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    if (rows && rows[0] && rows[0].placement_status === 'completed') {
      throw new PlacementAlreadyCompletedError();
    }
    await connection.execute(
      'UPDATE user_first_experience SET placement_status = \'completed\', placement_estimate = ?, ' +
      "placement_source = 'self_reported', placement_total_correct = NULL, placement_correct_n5 = NULL, " +
      'placement_correct_n4 = NULL, placement_correct_n3 = NULL, placement_correct_n2 = NULL, ' +
      'placement_correct_n1 = NULL, placement_completed_at = CURRENT_TIMESTAMP, ' +
      'updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [level, userId]
    );
    await connection.commit();
    connection.release();
    connection = null;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Transaction rollback failed:', rollbackError);
      } finally {
        connection.release();
      }
    }
    throw error;
  }
  return { estimate: level };
}

// Marks placement skipped while preserving the stored estimate and
// completion timestamp. NEVER downgrades: a completed row (quiz OR
// self_reported source) stays completed (returns the current completed
// state, 200). Absent row => created as skipped with null estimate. Same
// ensure-then-lock transaction as submit so a concurrent submit cannot be
// clobbered into 'skipped'.
async function skipPlacement(pool, userId) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      'INSERT INTO user_first_experience (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
    const [rows] = await connection.execute(
      'SELECT placement_status, placement_estimate FROM user_first_experience WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    const current = rows && rows[0] ? rows[0] : null;
    if (current && current.placement_status === 'completed') {
      const estimate = normalizeStoredEstimate(current.placement_estimate);
      await connection.commit();
      connection.release();
      connection = null;
      return { estimate, placement: { status: 'completed', estimate } };
    }
    await connection.execute(
      'UPDATE user_first_experience SET placement_status = \'skipped\', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [userId]
    );
    const estimate = normalizeStoredEstimate(current && current.placement_estimate);
    await connection.commit();
    connection.release();
    connection = null;
    return { estimate, placement: { status: 'skipped', estimate } };
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Transaction rollback failed:', rollbackError);
      } finally {
        connection.release();
      }
    }
    throw error;
  }
}

module.exports = {
  PLACEMENT_BANK,
  PLACEMENT_BANDS,
  PLACEMENT_BANK_IDS,
  PLACEMENT_BANK_VERSION,
  PLACEMENT_ESTIMATES,
  PLACEMENT_OPTION_IDS,
  PLACEMENT_SELECTION_SIZE,
  PLACEMENT_SOURCES,
  SELF_REPORT_LEVELS,
  assertPlacementCountsInRange,
  getPlacementQuestions,
  getPlacementQuestionsForUser,
  gradePlacement,
  normalizePlacementAnswers,
  normalizeSelfReportLevel,
  normalizeStoredSource,
  scorePlacement,
  selectPlacementQuestions,
  selfReportPlacement,
  skipPlacement,
  submitPlacement
};
