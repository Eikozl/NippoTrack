// Grammar Intelligence consumes only JLT's normalized lexical tokens. Surface
// checks are constraints on those tokens, never searches against raw text.
const { loadGrammarCatalog } = require('./grammarReference');

const RULES = [
  ['tai','tai','たい'], ['te-iru','te-iru','ている'], ['te-aru','te-aru','てある'], ['te-kara','te-kara','てから'], ['te-kudasai','te-kudasai','てください'], ['temo-ii','temo-ii','てもいい'], ['te-wa-ikenai','tewa-naranai','てはいけない'], ['nakute-mo-ii','nakute-mo-ii','なくてもいい'], ['ta-koto-ga-aru','ta-koto-ga-aru','たことがある'], ['hou-ga-ii','hou-ga-ii','たほうがいい'], ['nai-hou-ga-ii','nai-hou-ga-ii','ないほうがいい'], ['sugiru','sugiru','すぎる'], ['node','node','ので'], ['mae-ni','mae-ni','前に'], ['deshou','deshou','でしょう'],
  ['te-oku','te-oku','ておく'], ['te-miru','te-miru','てみる'], ['te-shimau','te-shimau-chau','てしま'], ['te-kureru','te-kureru','てくれ'], ['te-morau','te-morau','てもら'], ['te-ageru','te-ageru','てあげ'], ['nakereba-naranai','nakereba-naranai','なければならない'], ['koto-ga-dekiru','koto-ga-dekiru','ことができ'], ['koto-ni-suru','koto-ni-suru','ことにし'], ['koto-ni-naru','koto-ni-naru','ことにな'], ['you-ni-suru','you-ni-suru','ようにし'], ['you-ni-naru','you-ni-naru','ようにな'], ['you-to-omou','you-to-omou','ようと思'], ['kamo-shirenai','kamo-shirenai','かもしれない'], ['ka-dou-ka','ka-dou-ka','かどうか'], ['nagara','nagara','ながら'], ['tara','tara','たら'], ['nara','nara','なら'], ['ba','ba-hodo','ば'], ['temo','temo','ても'], ['hazu-da','hazu-da','はずだ'], ['to-omou','to-omou','と思'],
  ['wake-dewa-nai','wake-dewa-nai','わけではない'], ['wake-ga-nai','wake-ga-nai','わけがない'], ['wake-niwa-ikanai','wake-niwa-ikanai','わけにはいかない'], ['ni-chigai-nai','ni-chigai-nai','に違いない'], ['ba-hodo','ba-hodo','ば'], ['tabi-ni','tabi-ni','たびに'], ['ta-totan','ta-totan','たとたん'], ['you-to-suru','you-to-suru','ようとし'], ['dake-de-nakute-mo','dake-de-nakute-mo','だけでなく'], ['okage-de','okage-de','おかげで'], ['sei-de','sei-de','せいで'], ['saichuu-ni','saichuu-ni','最中に'], ['dokoro-ka','dokoro-ka','どころか']
].map(([id, sourceSlug, pattern], index) => ({ id, sourceSlug, pattern, priority: 100 - index }));

const FAMILIES = [
  ['souda',['souda-appearance','souda-hearsay'],'そうだ'], ['rashii',['rashii','rashii-typical'],'らしい'], ['noni',['noni-although','noni-in-order-to'],'のに'], ['tame-ni',['tame-ni','tame-ni-purpose'],'ために'], ['you-ni',['you-ni-suru','you-ni-naru'],'ように'], ['you-da',['you-da'],'ようだ'], ['mitai',['mitai-da','mitai-na'],'みたい'], ['tokoro',['ru-tokoro-da','teiru-tokoro','ta-tokoro'],'ところ'], ['bakari',['ta-bakari','bakari'],'ばかり'], ['ni-tsuite',['ni-tsuite'],'について'], ['ni-totte',['ni-totte'],'にとって'], ['to-iu',['to-iu'],'という'], ['to-iu-koto',['to-iu-koto'],'ということ'], ['wake-da',['wake-da'],'わけだ'], ['mono',['mono-dakara','monono','mono-nara','mono-da'],'もの']
].map(([id, sourceSlugs, pattern]) => ({ id, sourceSlugs, pattern }));

function textAt(tokens, start, end) { return tokens.slice(start, end + 1).map((token) => token.surface).join(''); }
function candidate(tokens, start, end, rule) {
  const first = tokens[start]; const last = tokens[end];
  if (!first || !last || first.start == null || last.end == null || first.pos === 'symbol') return null;
  const text = textAt(tokens, start, end);
  if (!text.includes(rule.pattern)) return null;
  // A construction must include a verb/auxiliary/particle or copula; bare
  // noun text cannot become grammar merely because a string resembles one.
  if (!tokens.slice(start, end + 1).some((token) => ['verb','auxiliary','particle','copula','i-adjective'].includes(token.pos))) return null;
  return { ...rule, detected: { text, start: first.start, end: last.end } };
}
function resolveOverlaps(matches) {
  const specificity = (match) => ({ 'nakute-mo-ii': 1000, 'ba-hodo': 900, 'you-ni-suru': 800, 'you-ni-naru': 800, 'to-iu-koto': 700 }[match.ruleId || match.familyId] || match.priority || 0);
  return matches.sort((a,b) => (b.detected.end-b.detected.start) - (a.detected.end-a.detected.start) || specificity(b) - specificity(a))
    .reduce((kept, item) => kept.some((other) => item.detected.start < other.detected.end && item.detected.end > other.detected.start) ? kept : [...kept, item], []);
}
function detectGrammar(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const determinate = [];
  for (let start = 0; start < list.length; start += 1) for (let end = start; end < Math.min(list.length, start + 8); end += 1) {
    for (const rule of RULES) { const found = candidate(list, start, end, rule); if (found) determinate.push({ ...found, status: 'DETERMINATE', ruleId: rule.id }); }
  }
  const resolved = resolveOverlaps(determinate);
  const families = [];
  for (let start = 0; start < list.length; start += 1) for (let end = start; end < Math.min(list.length, start + 8); end += 1) {
    for (const family of FAMILIES) {
      if (resolved.some((match) => start >= list.findIndex((token) => token.start === match.detected.start) && end <= list.findIndex((token) => token.end === match.detected.end))) continue;
      const found = candidate(list, start, end, family); if (found) families.push({ ...found, status: family.sourceSlugs.length === 1 ? 'DETERMINATE' : 'AMBIGUOUS', familyId: family.id });
    }
  }
  return resolveOverlaps([...resolved, ...families]);
}
function validateRuleMappings() {
  const slugs = new Set(loadGrammarCatalog().map((reference) => reference.sourceSlug));
  const required = [...RULES.map((rule) => rule.sourceSlug), ...FAMILIES.flatMap((family) => family.sourceSlugs)];
  if (RULES.length !== 50 || FAMILIES.length !== 15 || required.some((slug) => !slugs.has(slug))) throw new Error('Grammar rule mapping validation failed.');
  return true;
}
module.exports = { FAMILIES, RULES, detectGrammar, resolveOverlaps, validateRuleMappings };
