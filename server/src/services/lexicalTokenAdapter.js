// Phase 12-A — JLT normalized lexical token adapter (pure, engine-isolated).
//
// Raw Kuromoji/IPADIC output -> JLT-owned normalized token contract. This is
// the ONLY module that knows Kuromoji field names (surface_form, basic_form,
// reading, pronunciation, pos, pos_detail_1..3, conjugated_type,
// conjugated_form, word_type, word_position). Controllers, routes, and the
// frontend must depend on the JLT contract below, never on vendor fields, so
// the engine can be swapped without touching product code.
//
// OFFSET CONVENTION (documented, tested): Unicode code-point indexes against
// the ORIGINAL input text. start = word_position - 1, end = start +
// codePointLength(surface). The engine counts positions in code points, NOT
// UTF-16 code units (proven with astral-plane input: A𠀋学校B). Reconstruct
// with Array.from(text).slice(start, end).join('') — never text.slice().
//
// READING SEMANTICS (proven against @sglkc/kuromoji + bundled IPADIC):
// - Kuromoji `pronunciation` = surface pronunciation of THIS occurrence
//   (は→ワ, 学校→ガッコー). -> surfaceReading (hiragana, may contain ー).
// - Kuromoji `reading` = dictionary/orthographic reading of the token's own
//   form (は→ハ, 学校→ガッコウ). It is NOT the lemma reading for inflected
//   tokens (行っ→イッ is a fragment, not 行く=いく).
// - lemmaReading is therefore exposed ONLY when surface === basic_form (the
//   dictionary form was actually observed); otherwise null. False null beats
//   false linguistic data. Proper nouns and unknown/symbol tokens always
//   withhold readings (names/counters/jukujikun failure modes).
// - Whole-word readings are NEVER split across kanji (invariant, tested).

const { katakanaToHiragana } = require('../search/japaneseSearch');

function codePointLength(value) {
  return Array.from(value).length;
}

function nullIfStar(value) {
  return value === '*' ? null : value;
}

function nullIfEmpty(value) {
  return value === '' || value === undefined || value === null ? null : value;
}

function toHiraganaOrNull(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return katakanaToHiragana(value);
  } catch (_) {
    return null;
  }
}

// Coarse JLT POS. Raw IPADIC detail is preserved separately in posDetail.
// Reviewed mapping notes:
// - 動詞+非自立 (みる in てみる, いる in ている) is auxiliary USE: auxiliary.
// - 助動詞+特殊・ダ/デス (だ/です/な/だった) is the copula: copula.
// - 名詞+形容動詞語幹 (静か) is a na-adjective stem: na-adjective.
// - 名詞+数 (三) stays noun with detail; the CANDIDATE classifier excludes it.
// - 名詞/動詞+接尾 (さん, 本 in 三本) and 接頭詞 are affixes, not vocabulary.
// - 連体詞 (この/同じ) is adnominal: visible token, not a candidate.
// - フィラー (えーと) behaves as an interjection.
// - その他 (rare) and word_type UNKNOWN map to unknown.
function normalizePos(raw) {
  const pos = raw.pos || '';
  const detail1 = raw.pos_detail_1 || '';
  const conjugatedType = raw.conjugated_type || '';
  const basicForm = raw.basic_form || '';
  if (raw.word_type === 'UNKNOWN') return 'unknown';
  switch (pos) {
    case '名詞':
      if (detail1 === '固有名詞') return 'proper-noun';
      if (detail1 === '形容動詞語幹') return 'na-adjective';
      if (detail1 === '接尾') return 'suffix';
      return 'noun';
    case '動詞':
      return detail1 === '非自立' ? 'auxiliary' : 'verb';
    case '形容詞':
      return 'i-adjective';
    case '副詞':
      return 'adverb';
    case '連体詞':
      return 'adnominal';
    case '接続詞':
      return 'conjunction';
    case '感動詞':
    case 'フィラー':
      return 'interjection';
    case '助詞':
      return 'particle';
    case '助動詞':
      if (
        conjugatedType === '特殊・ダ' ||
        conjugatedType === '特殊・デス' ||
        basicForm === 'だ' ||
        basicForm === 'です' ||
        basicForm === 'である' ||
        basicForm === 'でございます'
      ) {
        return 'copula';
      }
      return 'auxiliary';
    case '接頭詞':
      return 'prefix';
    case '接尾辞':
      return 'suffix';
    case '記号':
      return 'symbol';
    default:
      return 'unknown';
  }
}

function adaptToken(raw, engine) {
  const surface = typeof raw.surface_form === 'string' ? raw.surface_form : '';
  const basicForm = nullIfStar(nullIfEmpty(raw.basic_form));
  const wordPosition = Number.isInteger(raw.word_position) && raw.word_position > 0 ? raw.word_position : null;
  const start = wordPosition === null ? null : wordPosition - 1;
  const end = start === null ? null : start + codePointLength(surface);
  const pos = normalizePos(raw || {});
  const posDetail = [nullIfStar(raw.pos_detail_1 || null), nullIfStar(raw.pos_detail_2 || null), nullIfStar(raw.pos_detail_3 || null)];
  const isUnknown = raw.word_type === 'UNKNOWN' || pos === 'unknown';
  const withholdReading = isUnknown || pos === 'symbol' || pos === 'proper-noun';
  const surfaceReading = withholdReading ? null : toHiraganaOrNull(nullIfEmpty(raw.pronunciation));
  // lemmaReading only when the dictionary form itself was observed and the
  // token is not a proper noun (names are never claimed).
  const lemmaReading =
    withholdReading || basicForm === null || surface !== basicForm
      ? null
      : toHiraganaOrNull(nullIfEmpty(raw.reading));
  const lemma = basicForm === null || basicForm === '' ? null : basicForm;
  const isContentWord =
    !isUnknown &&
    (pos === 'noun' || pos === 'verb' || pos === 'i-adjective' || pos === 'na-adjective' || pos === 'adverb' || pos === 'interjection');
  return {
    surface,
    lemma,
    surfaceReading,
    lemmaReading,
    pos,
    posDetail,
    inflectionType: nullIfStar(nullIfEmpty(raw.conjugated_type)),
    inflectionForm: nullIfStar(nullIfEmpty(raw.conjugated_form)),
    start,
    end,
    isContentWord,
    isUnknown,
    engine,
  };
}

function adaptTokens(rawTokens, text, engine) {
  if (typeof text !== 'string') {
    throw new TypeError('lexicalTokenAdapter.adaptTokens requires string input.');
  }
  if (!Array.isArray(rawTokens)) return [];
  return rawTokens.map((raw) => adaptToken(raw || {}, engine));
}

// Minimal foundation classifier for P12-B: ALL TOKENS vs LIKELY VOCABULARY
// CANDIDATES. Conservative: particles, auxiliaries, copulas, symbols,
// affixes, numerals, proper nouns, and unknowns are visible tokens but never
// candidates. No phrase composition here (deferred spans stay visible with
// candidate:false).
function classifyCandidate(token) {
  if (!token || typeof token !== 'object') return { candidate: false, reason: 'unknown' };
  if (token.isUnknown) return { candidate: false, reason: 'unknown' };
  switch (token.pos) {
    case 'symbol':
      return { candidate: false, reason: 'symbol' };
    case 'proper-noun':
      return { candidate: false, reason: 'proper-noun' };
    case 'particle':
    case 'auxiliary':
    case 'copula':
    case 'conjunction':
    case 'adnominal':
    case 'prefix':
    case 'suffix':
      return { candidate: false, reason: 'function-word' };
    case 'noun':
      if (Array.isArray(token.posDetail) && token.posDetail[0] === '数') {
        return { candidate: false, reason: 'numeral' };
      }
      return { candidate: true, reason: 'content-word' };
    case 'verb':
    case 'i-adjective':
    case 'na-adjective':
    case 'adverb':
    case 'interjection':
      return { candidate: true, reason: 'content-word' };
    default:
      return { candidate: false, reason: 'unknown' };
  }
}

module.exports = {
  adaptToken,
  adaptTokens,
  classifyCandidate,
  codePointLength,
  normalizePos,
};
