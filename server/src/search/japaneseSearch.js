const { ValidationError } = require('../errors/http');

const ROMAJI_TO_HIRAGANA = {
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
  sha: 'しゃ', shu: 'しゅ', sho: 'しょ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ',
  nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
  mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
  gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  ja: 'じゃ', ju: 'じゅ', jo: 'じょ',
  bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
  pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  shi: 'し', chi: 'ち', tsu: 'つ',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
  sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ',
  ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', fu: 'ふ', hu: 'ふ', he: 'へ', ho: 'ほ',
  ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', yo: 'よ',
  ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
  wa: 'わ', wo: 'を',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
  za: 'ざ', ji: 'じ', zi: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
  da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お'
};

const HIRAGANA_TO_ROMAJI = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po'
};

const HAS_JAPANESE_TEXT = /[ぁ-ゖァ-ヶ一-龯]/;

function requireString(input) {
  if (typeof input !== 'string') throw new ValidationError('search input must be a string.');
}

function normalizeRomaji(input) {
  requireString(input);
  const normalized = input
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[’‘`´]/g, "'")
    .trim()
    .replace(/\s+/g, ' ');
  return normalized && /^[a-z' -]+$/.test(normalized) ? normalized : null;
}

function convertNormalizedRomaji(normalized) {
  const romaji = normalized.replace(/[ -]/g, '');
  let result = '';
  let unresolved = '';
  let trailingNBase = null;

  for (let index = 0; index < romaji.length;) {
    const current = romaji[index];
    const next = romaji[index + 1];

    if (current === "'") {
      index += 1;
      continue;
    }
    if (romaji.slice(index, index + 3) === 'tch') {
      result += 'っ';
      index += 1;
      continue;
    }
    if (current === next && /[bcdfghjkmprstvwxyz]/.test(current) && current !== 'n') {
      result += 'っ';
      index += 1;
      continue;
    }
    if (current === 'n' && next === 'n') {
      result += 'ん';
      if (index + 2 === romaji.length) {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (current === 'n' && (index === romaji.length - 1 || next === "'" || (next && !/[aiueoyn]/.test(next)))) {
      if (index === romaji.length - 1) trailingNBase = result;
      result += 'ん';
      index += next === "'" ? 2 : 1;
      continue;
    }

    let matched = false;
    for (const length of [3, 2, 1]) {
      const syllable = romaji.slice(index, index + length);
      if (ROMAJI_TO_HIRAGANA[syllable]) {
        result += ROMAJI_TO_HIRAGANA[syllable];
        index += length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    unresolved = romaji.slice(index).replace(/'/g, '');
    break;
  }

  return {
    complete: unresolved.length === 0,
    hiragana: result || null,
    trailingNBase,
    unresolved
  };
}

function romajiToHiragana(input) {
  const normalized = normalizeRomaji(input);
  if (!normalized) return null;
  return convertNormalizedRomaji(normalized).hiragana;
}

function katakanaToHiragana(input) {
  requireString(input);
  return input.normalize('NFKC').replace(/[ァ-ヶ]/g, (character) => (
    String.fromCodePoint(character.codePointAt(0) - 0x60)
  ));
}

function hiraganaToKatakana(input) {
  requireString(input);
  return input.replace(/[ぁ-ゖ]/g, (character) => (
    String.fromCodePoint(character.codePointAt(0) + 0x60)
  ));
}

function normalizeJapaneseReading(input) {
  requireString(input);
  return katakanaToHiragana(input)
    .trim()
    .replace(/[.．・･·\s〜～~\/／,，、;；:：()（）\[\]【】]/g, '');
}

// Reference-search helpers (Parts B + D). New code only; the shared
// normalization above is intentionally untouched so user-owned
// vocabulary/kanji/grammar search semantics cannot shift.

const HAN_PATTERN = /\p{Script=Han}/u;
const DIRECT_KANA_PATTERN = /[ぁ-ゖァ-ヶ]/;

// Deterministic intent heuristic for kanji reference search. Latin input is
// NEVER exclusively classified: complete romaji keeps both the reading and
// the English-meaning channels, and relevance tiers decide the weights.
// Returns { primary, hasHan, hasKana, romajiComplete }.
function classifyReferenceQuery(raw, candidates) {
  const text = typeof raw === 'string' ? raw : '';
  const hasHan = HAN_PATTERN.test(text);
  const hasKana = DIRECT_KANA_PATTERN.test(text);
  const romajiComplete = Boolean(candidates && candidates.romajiComplete);
  let primary = 'meaning';
  if (hasHan) primary = 'han';
  else if (hasKana) primary = 'kana';
  else if (romajiComplete) primary = 'romaji';
  return { primary, hasHan, hasKana, romajiComplete };
}

// KANJIDIC morphology markers (ひと-, -うえ) are metadata, not sound.
function stripReadingHyphens(value) {
  requireString(value);
  return value.replace(/-/g, '');
}

// Symmetric voicing alternates for the lossy ず/づ and じ/ぢ pairs.
// Emits the input plus single-occurrence flips plus the full flip, bounded
// and deterministic. Never rewrites globally: variants are extra candidates.
function dakutenVariants(kana) {
  requireString(kana);
  const pairs = { 'ず': 'づ', 'づ': 'ず', 'じ': 'ぢ', 'ぢ': 'じ', 'ズ': 'ヅ', 'ヅ': 'ズ', 'ジ': 'ヂ', 'ヂ': 'ジ' };
  const hits = [];
  for (let index = 0; index < kana.length; index += 1) {
    if (pairs[kana[index]]) hits.push(index);
  }
  const variants = [kana];
  hits.forEach((position) => {
    variants.push(`${kana.slice(0, position)}${pairs[kana[position]]}${kana.slice(position + 1)}`);
  });
  if (hits.length > 1) {
    variants.push([...kana].map((character) => pairs[character] || character).join(''));
  }
  return [...new Set(variants)];
}

// Long-vowel alternates: だあす ↔ だーす. Emitted as extra candidates so
// stored ー forms are reachable from plain-vowel romaji and vice versa.
function vowelFor(kanaChar) {
  const romaji = HIRAGANA_TO_ROMAJI[kanaChar] || HIRAGANA_TO_ROMAJI[katakanaToHiragana(kanaChar)];
  if (!romaji) return null;
  const vowel = romaji[romaji.length - 1];
  return 'aeiou'.includes(vowel) ? vowel : null;
}

function longVowelVariants(kana) {
  requireString(kana);
  const variants = new Set([kana]);
  const hiraVowel = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' };
  const kataVowel = { a: 'ア', i: 'イ', u: 'ウ', e: 'エ', o: 'オ' };
  const expanded = kana.replace(/([ぁ-ゖァ-ヶ])ー/g, (match, previous) => {
    const vowel = vowelFor(previous);
    if (!vowel) return match;
    const table = previous >= 'ァ' && previous <= 'ヶ' ? kataVowel : hiraVowel;
    return `${previous}${table[vowel]}`;
  });
  if (expanded !== kana) variants.add(expanded);
  const plain = expanded;
  const hiraVowels = 'あいうえお';
  const kataVowels = 'アイウエオ';
  for (let index = 0; index < plain.length - 1; index += 1) {
    const second = plain[index + 1];
    // Any vowel second mora may be written with a length mark instead
    // (だあす ↔ だーす). Variants only add recall for rows that actually
    // contain the ー form, so over-generation is harmless.
    if (hiraVowels.includes(second) || kataVowels.includes(second)) {
      variants.add(`${plain.slice(0, index + 1)}ー${plain.slice(index + 2)}`);
    }
  }
  return [...variants];
}

// Expands kana candidates into weighted reading groups for reference search:
// strong (direct kana + complete romaji, plus dakuten/long-vowel variants)
// and weak (unresolved-prefix guesses, substring recall only). Bounded and
// deterministic. Stored readings are never rewritten.
function expandReferenceReadings(candidates, { strongLimit = 24 } = {}) {
  const list = candidates?.kanaCandidates || [];
  const origins = candidates?.candidateOrigins || [];
  const strong = [];
  const weak = [];
  const seenStrong = new Set();
  const seenWeak = new Set();
  function pushKey(target, seen, hiragana) {
    const key = stripReadingHyphens(normalizeJapaneseReading(hiragana));
    if (!key || seen.has(key)) return;
    seen.add(key);
    target.push({ hiragana: key, katakana: hiraganaToKatakana(key) });
  }
  list.forEach((candidate, index) => {
    const origin = origins[index] || 'direct';
    const target = origin === 'prefix' ? weak : strong;
    const seen = origin === 'prefix' ? seenWeak : seenStrong;
    pushKey(target, seen, candidate.hiragana);
    pushKey(target, seen, candidate.katakana);
  });
  const base = strong.slice();
  base.forEach(({ hiragana }) => {
    dakutenVariants(hiragana).forEach((variant) => pushKey(strong, seenStrong, variant));
    longVowelVariants(hiragana).forEach((variant) => pushKey(strong, seenStrong, variant));
  });
  return { strong: strong.slice(0, strongLimit), weak: weak.slice(0, 16) };
}

function hiraganaToRomaji(input) {
  const hiragana = normalizeJapaneseReading(input);
  let result = '';

  for (let index = 0; index < hiragana.length;) {
    if (hiragana[index] === 'っ') {
      const next = HIRAGANA_TO_ROMAJI[hiragana.slice(index + 1, index + 3)]
        || HIRAGANA_TO_ROMAJI[hiragana[index + 1]];
      if (next) result += next[0];
      index += 1;
      continue;
    }
    if (hiragana[index] === 'ん') {
      const next = HIRAGANA_TO_ROMAJI[hiragana.slice(index + 1, index + 3)]
        || HIRAGANA_TO_ROMAJI[hiragana[index + 1]]
        || '';
      result += /^[aeiouy]/.test(next) ? "n'" : 'n';
      index += 1;
      continue;
    }
    if (hiragana[index] === 'ー') {
      const vowel = result.match(/[aeiou](?!.*[aeiou])/);
      if (vowel) result += vowel[0];
      index += 1;
      continue;
    }

    const pair = hiragana.slice(index, index + 2);
    if (HIRAGANA_TO_ROMAJI[pair]) {
      result += HIRAGANA_TO_ROMAJI[pair];
      index += 2;
      continue;
    }
    const single = HIRAGANA_TO_ROMAJI[hiragana[index]];
    if (!single) return null;
    result += single;
    index += 1;
  }
  return result || null;
}

function buildSearchCandidates(input) {
  requireString(input);
  const raw = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const normalizedRomaji = normalizeRomaji(raw);
  const conversion = normalizedRomaji ? convertNormalizedRomaji(normalizedRomaji) : null;
  const hiragana = conversion?.hiragana || null;
  const normalizedJapanese = normalizeJapaneseReading(hiragana || raw);
  // Each kana string is tagged with its origin so reference search can
  // weight direct/complete conversions above unresolved-prefix guesses.
  // Origins: 'direct' (Japanese input), 'complete' (full romaji mapping),
  // 'prefix' (unresolved-tail or trailing-n expansion). Additive only.
  const kana = [];

  if (conversion?.unresolved) {
    const prefix = conversion.hiragana || '';
    Object.entries(ROMAJI_TO_HIRAGANA)
      .filter(([romaji]) => romaji.startsWith(conversion.unresolved))
      .forEach(([, syllable]) => kana.push({ value: `${prefix}${syllable}`, origin: 'prefix' }));
  } else if (conversion?.complete && hiragana) {
    kana.push({ value: hiragana, origin: 'complete' });
    if (conversion.trailingNBase !== null) {
      Object.entries(ROMAJI_TO_HIRAGANA)
        .filter(([romaji]) => romaji.startsWith('n'))
        .forEach(([, syllable]) => kana.push({ value: `${conversion.trailingNBase}${syllable}`, origin: 'prefix' }));
    }
  } else if (!normalizedRomaji && HAS_JAPANESE_TEXT.test(normalizedJapanese)) {
    kana.push({ value: normalizedJapanese, origin: 'direct' });
  }

  const seen = new Set();
  const kanaCandidates = [];
  const candidateOrigins = [];
  kana.slice(0, 48).forEach(({ value, origin }) => {
    const hiraganaCandidate = normalizeJapaneseReading(value);
    const katakanaCandidate = hiraganaToKatakana(hiraganaCandidate);
    const key = `${hiraganaCandidate}|${katakanaCandidate}`;
    if (seen.has(key)) return;
    seen.add(key);
    kanaCandidates.push({ hiragana: hiraganaCandidate, katakana: katakanaCandidate });
    candidateOrigins.push(origin);
  });
  kanaCandidates.splice(16);
  candidateOrigins.splice(16);

  return {
    raw,
    normalizedRomaji,
    hiragana,
    katakana: normalizedJapanese ? hiraganaToKatakana(normalizedJapanese) : null,
    kanaCandidates,
    candidateOrigins,
    normalizedJapanese,
    romajiComplete: Boolean(normalizedRomaji && conversion?.complete)
  };
}

module.exports = {
  buildSearchCandidates,
  classifyReferenceQuery,
  dakutenVariants,
  expandReferenceReadings,
  hiraganaToKatakana,
  hiraganaToRomaji,
  katakanaToHiragana,
  longVowelVariants,
  normalizeJapaneseReading,
  normalizeRomaji,
  romajiToHiragana,
  stripReadingHyphens
};
