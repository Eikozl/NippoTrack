const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJapanese, engineMetadata } = require('../src/services/japaneseParser');
const { adaptTokens } = require('../src/services/lexicalTokenAdapter');
const { detectGrammar } = require('../src/services/grammarDetector');

async function ids(text) { const parsed = await parseJapanese(text); return detectGrammar(adaptTokens(parsed.rawTokens, text, engineMetadata())).map((match) => match.ruleId || match.familyId); }

const positives = {
  tai:'日本へ行きたい。','te-iru':'今、本を読んでいる。','te-aru':'机の上に資料が置いてある。','te-kara':'宿題をしてから寝る。','te-kudasai':'ここに名前を書いてください。','temo-ii':'この椅子に座ってもいい。','te-wa-ikenai':'ここで写真を撮ってはいけない。','nakute-mo-ii':'明日は来なくてもいい。','ta-koto-ga-aru':'京都へ行ったことがある。','hou-ga-ii':'早く寝たほうがいい。','nai-hou-ga-ii':'夜はコーヒーを飲まないほうがいい。',sugiru:'昨日は食べすぎた。',node:'雨が降っているので、家にいる。','mae-ni':'寝る前に歯を磨く。',deshou:'明日は寒いでしょう。',
  'te-oku':'旅行の前にホテルを予約しておく。','te-miru':'この料理を食べてみる。','te-shimau':'財布を忘れてしまった。','te-kureru':'友達が宿題を手伝ってくれた。','te-morau':'先生に作文を直してもらった。','te-ageru':'妹に日本語を教えてあげた。','nakereba-naranai':'明日は早く起きなければならない。','koto-ga-dekiru':'ここで日本語を勉強することができる。','koto-ni-suru':'毎日三十分勉強することにした。','koto-ni-naru':'来月大阪へ行くことになった。','you-ni-suru':'毎日漢字を書くようにしている。','you-ni-naru':'日本語が少し話せるようになった。','you-to-omou':'来年日本へ行こうと思う。','kamo-shirenai':'明日は雨が降るかもしれない。','ka-dou-ka':'彼が来るかどうか分からない。',nagara:'音楽を聞きながら勉強する。',tara:'家に着いたら電話する。',nara:'日本へ行くなら、春がおすすめだ。',ba:'毎日練習すれば上手になる。',temo:'雨が降っても試合をする。','hazu-da':'彼はもう家に着いたはずだ。','to-omou':'この本は面白いと思う。',
  'wake-dewa-nai':'日本語が嫌いなわけではない。','wake-ga-nai':'彼がそんなことをするわけがない。','wake-niwa-ikanai':'休むわけにはいかない。','ni-chigai-nai':'あの人は先生に違いない。','ba-hodo':'練習すればするほど上手になる。','tabi-ni':'この歌を聞くたびに高校時代を思い出す。','ta-totan':'ドアを開けたとたん、猫が飛び出した。','you-to-suru':'出かけようとしたとき、電話が鳴った。','dake-de-nakute-mo':'彼は英語だけでなく、中国語も話せる。','okage-de':'先生のおかげで試験に合格できた。','sei-de':'雨のせいで試合が中止になった。','saichuu-ni':'会議の最中に電話が鳴った。','dokoro-ka':'歩くどころか、立つこともできない。'
};

test('all 50 frozen deterministic rule fixtures are recognized through the installed tokenizer', async () => {
  assert.equal(Object.keys(positives).length, 50);
  for (const [ruleId, text] of Object.entries(positives)) assert.ok((await ids(text)).includes(ruleId), `${ruleId}: ${text}`);
});

test('false-positive and overlap corpus stays conservative', async () => {
  for (const text of ['鯛を食べた。','これは鯛です。','奈良へ行った。','本を机に置く。','映画を見て、本を読む。','先生から本をもらった。','弟に本をあげた。','本を手に取って読む。','これは私のものです。','そんなことはない。']) assert.deepEqual(await ids(text), []);
  assert.deepEqual(await ids('来なくてもいい。'), ['nakute-mo-ii']);
  assert.deepEqual(await ids('座ってもいい。'), ['temo-ii']);
  assert.deepEqual(await ids('練習すればするほど上手になる。'), ['ba-hodo']);
  assert.deepEqual(await ids('漢字を書くようにしている。'), ['you-ni-suru']);
});

test('all 15 frozen ambiguity-aware families are found without treating lexical lookalikes as grammar', async () => {
  const fixtures = {
    souda:'雨が降りそうだ。', rashii:'明日は雨らしい。', noni:'冬なのに暖かい。', 'tame-ni':'日本へ行くために日本語を勉強している。', 'you-ni':'忘れないようにメモする。', 'you-da':'彼は先生のようだ。', mitai:'彼は先生みたいだ。', tokoro:'出かけるところだ。', bakari:'今食べたばかりだ。', 'ni-tsuite':'日本について話す。', 'ni-totte':'私にとって大切だ。', 'to-iu':'これは日本語という言葉だ。', 'to-iu-koto':'日本語ということだ。', 'wake-da':'だから遅いわけだ。', mono:'雨なので行けないものだ。'
  };
  for (const [familyId, text] of Object.entries(fixtures)) assert.ok((await ids(text)).includes(familyId), `${familyId}: ${text}`);
  assert.equal((await ids('映画を見たい。')).includes('mitai'), false);
  assert.equal((await ids('本を手に取って読む。')).includes('ni-totte'), false);
  assert.equal((await ids('これは私のものです。')).includes('mono'), false);
});
