import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/landing/sections.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/landing/landing.css', import.meta.url), 'utf8');
const interactionsSource = readFileSync(new URL('../src/landing/interactions.js', import.meta.url), 'utf8');

test('landing source follows the approved narrative order', () => {
  const headings = [
    'Bring your Japanese learning together.',
    'Your Japanese study is already everywhere.',
    'Understand the Japanese you actually encounter.',
    'Less typing. More intentional tracking.',
    "Keep kanji connected to what you're learning.",
    "Review what you've actually collected.",
    'See your learning take shape.',
    'Start from where you are.',
    'Know what to do next.',
    'Ready to bring your Japanese study together?'
  ];

  let previous = -1;
  for (const heading of headings) {
    const position = source.indexOf(heading);
    assert.ok(position > previous, 'missing or out-of-order heading: ' + heading);
    previous = position;
  }
});

test('landing demos remain presentation-only and make no application requests', () => {
  assert.ok(!source.includes('apiRequest('));
  assert.ok(!source.includes('supabase'));
  assert.ok(!source.includes('fetch('));
  assert.ok(!source.includes('<button class="demo-'));
});

test('Japanese examples declare their language', () => {
  for (const text of ['旅行', 'りょこう', '殻', '約束', 'やくそく', '雨', 'あめ', '降っている', '図書館', 'としょかん', '日', '料理', 'りょうり']) {
    assert.ok(source.includes('lang="ja">' + text), 'missing lang=ja for ' + text);
  }
  assert.ok(source.includes('<b lang="ja">来年、日本へ旅行します。</b>'), 'hero context keeps lang=ja');
  assert.ok(source.includes('<p class="analyzer-sentence" lang="ja">雨が降っている。</p>'), 'analyzer sentence keeps lang=ja');
  assert.ok(source.includes('<b lang="ja">雨が降っている。</b>'), 'analyzer context keeps lang=ja');
  assert.ok(source.includes('<p class="flow-sentence" lang="ja">'), 'flow sentence keeps lang=ja');
  assert.ok(source.includes('<b lang="ja">昨日、日本料理を作った。</b>'), 'flow context keeps lang=ja');
});

test('navigation, hero, and final CTA use their frozen labels', () => {
  const navigation = source.slice(source.indexOf('landing-nav-actions'), source.indexOf('landing-menu-button'));
  assert.ok(navigation.indexOf('Log in') < navigation.indexOf('Get started'));
  assert.ok(source.includes('href="/app?auth=sign-up"'), 'sign-up fallback destinations kept');
  assert.ok(source.includes('data-auth-open="sign-up">Register</a>'), 'hero CTA opens the modal in place');
  assert.ok(source.includes('data-auth-open="sign-up">Start with NippoTrack</a>'), 'final CTA opens the modal in place');
  assert.ok(source.includes('Already have an account? Log in'));
});

test('how-it-works shows the visible loop heading, subcopy, and three editorial stages', () => {
  assert.ok(source.includes('id="how-it-works"'));
  assert.ok(source.includes('aria-labelledby="flow-title"'));
  assert.ok(source.includes('<h2 id="flow-title">A simple loop for the way you already learn.</h2>'));
  assert.ok(!source.includes('<h2 class="visually-hidden" id="flow-title">'));
  assert.ok(source.includes('Capture what you encounter, understand it in context, then review what you chose to keep.'));
  assert.ok(source.includes('<h3>Capture</h3>'));
  assert.ok(source.includes('<h3>Understand</h3>'));
  assert.ok(source.includes('<h3>Review</h3>'));
  assert.ok(source.includes('flow-chips'));
  assert.ok(source.includes('Vocabulary</li>'));
  assert.ok(source.includes('Study session</li>'));
  assert.ok(source.includes('flow-context'));
  assert.ok(source.includes('flow-rating'));
  assert.ok(source.includes('>Again</span>'));
  assert.ok(source.includes('>Hard</span>'));
  assert.ok(source.includes('>Good</span>'));
  // Second-pass coherent 料理 flow (single word through the loop).
  assert.ok(source.includes('flow-tracked'));
  assert.ok(source.includes('flow-sentence-hit'));
  assert.ok(source.includes('flow-reveal'));
  assert.ok(source.includes('>Reveal</span>'));
  assert.ok(source.includes('cooking · cuisine'));
});

test('per-section curated examples stay exact and word-level', () => {
  // HERO vocabulary card.
  assert.ok(source.includes('<p class="hero-japanese" lang="ja">旅行</p>'));
  assert.ok(source.includes('<p class="hero-reading" lang="ja">りょこう</p>'));
  assert.ok(source.includes('<p class="hero-meaning">travel</p>'));
  assert.ok(source.includes('<b lang="ja">来年、日本へ旅行します。</b>'));
  // HERO review tile foreshadows the Review showcase; kanji identity is kept.
  assert.ok(source.includes('<p lang="ja">約束 <span lang="ja">やくそく</span></p>'));
  assert.ok(source.includes('<p class="hero-kanji-glyph" lang="ja">殻</p>'));
  // ANALYZER demo keeps the same structure with new strings.
  assert.ok(source.includes('<p class="analyzer-sentence" lang="ja">雨が降っている。</p>'));
  assert.ok(source.includes('<span class="candidate-active" lang="ja">雨</span>'));
  assert.ok(source.includes('<span lang="ja">降っている</span>'));
  assert.ok(source.includes('<strong lang="ja">雨</strong>'));
  assert.ok(source.includes('<span lang="ja">あめ</span>'));
  assert.ok(source.includes('<span>rain</span>'));
  // VOCABULARY demo keeps word → reading → meaning → JMdict → ready.
  assert.ok(source.includes('<strong class="typing-word" lang="ja">図書館</strong>'));
  assert.ok(source.includes('<strong lang="ja">としょかん</strong>'));
  assert.ok(source.includes('<strong>library</strong>'));
  assert.ok(source.includes('JMdict'));
  assert.ok(source.includes('Ready to add'));
  // KANJI showcase is the scripted 3-kanji stroke sequence (日 → 空 → 深).
  assert.ok(source.includes('data-kanji-sequence'), 'kanji stroke-sequence hook present');
  assert.ok(interactionsSource.includes('ニチ・ジツ') && interactionsSource.includes('ひ・か') && interactionsSource.includes('クウ') && interactionsSource.includes('そら・あく') && interactionsSource.includes('シン') && interactionsSource.includes('ふか・い'), 'restrained Japanese readings present');
  for (const forbidden of ['sun/day', 'sky/empty', '>deep<', 'reference N5 range', 'reference N4 range', 'reference N3 range', 'levels approximate, not official']) {
    assert.ok(!source.includes(forbidden), `landing kanji showcase omits ${forbidden}`);
  }
  assert.ok(source.includes('data-kanji-seq-readings lang="ja"'), 'stage readings inherit Japanese language metadata');
  // REVIEW showcase keeps Reveal → answer → Again/Hard/Good.
  assert.ok(source.includes('<p class="review-word" lang="ja">約束</p>'));
  assert.ok(source.includes('<strong lang="ja">やくそく</strong>'));
  assert.ok(source.includes('<span>promise</span>'));
  assert.ok(source.includes('Reveal answer'));
  // HOW-IT-WORKS is one coherent 料理 flow.
  assert.ok(source.includes('lang="ja">料理'));
  assert.ok(source.includes('lang="ja">りょうり'));
  assert.ok(source.includes('cooking · cuisine'));
  assert.ok(source.includes('昨日、日本'));
  assert.ok(source.includes('を作った'));
  assert.ok(source.includes('<b lang="ja">昨日、日本料理を作った。</b>'));
});

test('how-it-works is mobile-safe with vertical connectors and no horizontal overflow', () => {
  assert.ok(cssSource.includes('@media (max-width: 767px)'));
  const mobileBlock = cssSource.slice(cssSource.indexOf('@media (max-width: 767px)'));
  assert.ok(mobileBlock.includes('.core-flow'));
  assert.ok(mobileBlock.includes('grid-template-columns: 1fr'));
  assert.ok(cssSource.includes('.flow-connector'));
  assert.ok(cssSource.includes('scaleY'));
  assert.ok(!source.includes('flow-arrow'));
  // Flow internals never force horizontal overflow.
  assert.ok(cssSource.includes('.flow-card'));
  assert.ok(cssSource.includes('min-width: 0'));
});

function mediaBlock(marker) {
  const start = cssSource.indexOf(marker);
  assert.ok(start > -1, 'missing ' + marker);
  const next = cssSource.indexOf('@media', start + marker.length);
  return cssSource.slice(start, next === -1 ? undefined : next);
}

function ruleBody(block, selector) {
  const match = block.match(new RegExp(selector + '\\s*\\{([^}]*)\\}'));
  assert.ok(match, 'missing rule: ' + selector);
  return match[1];
}

test('hero splits by viewport: constellation on desktop, simple ledger on mobile', () => {
  // Desktop: the floating constellation owns the hero visual column.
  assert.ok(source.includes('class="hero-ecosystem"'), 'constellation markup present');
  assert.equal((source.match(/data-float="/g) || []).length, 5, 'five floating cards');
  assert.ok(source.includes('data-hero-streak="30"'), 'streak counts to its final value');
  assert.ok(cssSource.includes('@keyframes heroDriftOne'), 'drift system present');
  assert.ok(cssSource.includes('.hero-ecosystem .hero-card[data-float="one"]'), 'float hooks scoped');
  assert.ok(cssSource.includes('.hero-ecosystem::before'), 'orbit ring present');
  // Mobile (≤900px): constellation hides, the plain ledger stack shows.
  const band900 = mediaBlock('@media (max-width: 900px)');
  assert.ok(band900.includes('.hero-ecosystem'), 'swap lives in the 900 band');
  const eco900 = ruleBody(band900, '\\.hero-ecosystem');
  assert.ok(eco900.includes('display: none'), 'constellation hides on mobile');
  const ledger900 = ruleBody(band900, '\\.hero-ledger');
  assert.ok(ledger900.includes('display: grid'), 'ledger shows on mobile');
  // Base (desktop-first): ledger hides, constellation flows.
  assert.match(cssSource, /\.hero-ledger\s*\{[^}]*display:\s*none/, 'ledger hidden on desktop');
  // The ledger stack itself stays plain flow with safe wrapping.
  const mobile = mediaBlock('@media (max-width: 640px)');
  assert.ok(mobile.includes('.hero-ledger'), 'ledger owns the small hero');
  assert.ok(mobile.includes('.hero-context'), 'context wraps instead of clipping');
  // Type sizes are frozen for both systems.
  assert.match(cssSource, /\.hero-ecosystem \.hero-japanese\s*\{[^}]*font-size:\s*42px/, 'constellation word size frozen');
  assert.match(cssSource, /\.hero-japanese\s*\{[^}]*font-size:\s*30px/, 'strip word size frozen');
  assert.ok(cssSource.includes('.hero-typing-sentence'), 'analyzer sentence styled');
  assert.ok(cssSource.includes('.tategaki-rail'), 'margin rail present');
  assert.ok(cssSource.includes('.hanko-stamp'), 'stamp system present');
  // Narrowest widths keep the plain stack — no satellite grid returns.
  const narrow = mediaBlock('@media (max-width: 380px)');
  assert.ok(narrow.includes('.hero-panel'), 'panels only tighten padding');
  assert.ok(!/grid-template-columns:\s*1fr 1fr/.test(narrow), 'no satellite grid returns');
  // No new breakpoints were introduced for this pass.
  const breakpoints = [...cssSource.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(breakpoints)].sort(), ['1100', '380', '479', '640', '767', '900']);
});

test('Android download lives only at the close (final CTA + footer), never in the hero', () => {
  const heroStart = source.indexOf('<section class="landing-hero');
  const heroBlock = source.slice(heroStart, source.indexOf('</section>', heroStart));
  assert.ok(!heroBlock.includes('data-android-download'), 'no download hook in hero');
  assert.ok(!heroBlock.includes('Download on Android'), 'no download copy in hero');
  const ctaStart = source.indexOf('id="final-cta"');
  assert.ok(source.slice(ctaStart, ctaStart + 1200).includes('Download on Android'), 'final CTA keeps the download');
  assert.ok(source.includes('data-android-download'), 'download hook survives at the close');
});

test('mobile ledger cannot force horizontal overflow', () => {
  const band900 = mediaBlock('@media (max-width: 900px)');
  assert.ok(band900.includes('minmax(0, 1fr)'), 'grid track yields instead of bleeding');
  assert.match(cssSource, /\.hero-ledger\s*\{[^}]*min-width:\s*0/, 'ledger shrinks');
  assert.match(cssSource, /\.hero-panel\s*\{[^}]*min-width:\s*0/, 'panels shrink');
  assert.match(cssSource, /\.ledger-refrain\s*\{[^}]*flex-wrap:\s*wrap/, 'refrain wraps');
  assert.match(cssSource, /\.hero-result\s*\{[^}]*flex-wrap:\s*wrap/, 'result wraps');
  assert.match(cssSource, /\.hero-candidates\s*\{[^}]*flex-wrap:\s*wrap/, 'candidates wrap');
});

test('section rhythm uses explicit tonal chapters without alternating washes', () => {
  assert.ok(!cssSource.includes('.showcase-section:nth-of-type(even)::before'));
  for (const tone of ['tone-ivory', 'tone-muted', 'tone-mist', 'tone-canvas', 'tone-hero']) {
    assert.ok(source.includes(tone) || cssSource.includes('.' + tone), 'missing tonal hook: ' + tone);
  }
  assert.ok(source.includes('editorial-section tone-ivory'));
  assert.ok(source.includes('flow-section tone-muted'));
  assert.ok(source.includes('progress-section tone-mist'));
  assert.ok(cssSource.includes('.tone-ivory'));
  assert.ok(cssSource.includes('background: #fffcf7'));
  assert.ok(cssSource.includes('.tone-muted'));
  assert.ok(cssSource.includes('.tone-mist'));
  // V6: tools wall + emotional slab retired; the final CTA carries the close.
  assert.ok(!source.includes('tools-section'), 'tools wall removed from markup');
  assert.ok(!source.includes('emotional-section'), 'emotional slab removed from markup');
  assert.ok(!cssSource.includes('.tools-list'), 'tools styles retired');
});

test('dark theme remaps land on tokens with no pure black or pure-white text', () => {
  assert.ok(cssSource.includes('[data-nippotrack-theme="dark"] .landing-page'));
  for (const token of ['#1c1a18', '#24211e', '#2b2723', '#f5f0e8', '#b8aea4', '#3a3530', '#d98a6f']) {
    assert.ok(cssSource.toLowerCase().includes(token), 'missing dark token: ' + token);
  }
  assert.ok(!cssSource.includes('#000000'));
  // Only dark-scoped declarations must avoid pure white/black text.
  const darkDeclarations = cssSource
    .split('}')
    .filter((chunk) => chunk.includes('[data-nippotrack-theme="dark"]'))
    .join('}');
  assert.ok(!darkDeclarations.includes('#fff;'));
  assert.ok(!darkDeclarations.toLowerCase().includes('#ffffff'));
  assert.ok(!darkDeclarations.includes('#000;'));
  assert.ok(darkDeclarations.includes('color: #1c1a18'));
});

test('only approved Japanese examples appear and keep lang="ja"', () => {
  const runs = source.match(/[\u3040-\u30ff\u4e00-\u9faf]+/g) || [];
  const allowed = new Set(['旅行', 'りょこう', '来年', '日本へ旅行します', '殻', '約束', 'やくそく', '料理', '昨日', '日本', 'を作った', 'りょうり', '日本料理を作った', '雨が降っている', '雨', '降っている', 'あめ', '図書館', 'としょかん', '日', 'ニチ・ジツ', 'ひ・か', '毎朝', '新聞を', '読みます', '読んだ', '日本語', '日本語の学びを', 'ひとつに']);
  for (const run of runs) {
    assert.ok(allowed.has(run), 'unexpected Japanese: ' + run);
  }
  // Placement copy (毎朝、新聞を__/読みます/読んだ) predates this pass and is
  // covered by frozen showcase semantics; all other runs are the curated
  // second-pass examples listed above.
});

test('large-screen containment reuses the 1100 band with no mobile changes', () => {
  const band1100 = mediaBlock('@media (max-width: 1100px)');
  assert.ok(band1100.includes('.hero-ledger'), 'ledger stays inside its column');
  assert.ok(band1100.includes('width: min(100%, 520px)'), 'ledger narrows before the stack');
  assert.ok(band1100.includes('.hero-ecosystem'), 'constellation scales before the swap');
  assert.ok(band1100.includes('.core-flow article'), 'flow columns breathe at tablet');
  assert.ok(band1100.includes('padding: 0 28px'), 'flow rhythm eases without new breakpoints');
  assert.ok(band1100.includes('.analyzer-result'), 'dense panel eases at tablet');
  assert.ok(cssSource.includes('min-height: 440px'), 'onboarding panel holds absolute cards');
  assert.ok(cssSource.includes('.placement-preparing'), 'preparing beat hooks exist');
  // No new breakpoints were introduced for this pass.
  const breakpoints = [...cssSource.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(breakpoints)].sort(), ['1100', '380', '479', '640', '767', '900']);
  // Mobile bands stay untouched: no large-screen fixes leak below 768px.
  for (const marker of ['@media (max-width: 767px)', '@media (max-width: 640px)', '@media (max-width: 479px)', '@media (max-width: 380px)']) {
    const mobile = mediaBlock(marker);
    assert.ok(!mobile.includes('width: min(100%, 520px)'), 'mobile keeps its constellation: ' + marker);
    assert.ok(!mobile.includes('.estimate-value'), 'rotation lock stays global: ' + marker);
    assert.ok(!mobile.includes('placementPreparing'), 'staging stays desktop: ' + marker);
    assert.ok(!mobile.includes('padding: 0 28px'), 'flow easing stays tablet: ' + marker);
  }
  // Rotating estimates never shift layout and never spam screen readers.
  assert.ok(source.includes('data-estimate-value'), 'rotation hooks present');
  assert.ok(source.includes('aria-hidden="true"'), 'rotating text hides from AT');
  assert.ok(source.includes('Starting estimate, for example N4 range'), 'static sr-only example present');
  assert.ok(source.includes('not an official JLPT assessment'), 'diagnosis disclaimer preserved');
});

test('landing stays keyboard, focus, and landmark safe', () => {
  assert.ok(source.includes('landing-skip-link'));
  assert.ok(source.includes('href="#landing-main"'));
  assert.ok(source.includes('<main id="landing-main"'));
  assert.ok(source.includes('aria-label="Main navigation"'));
  assert.ok(source.includes('aria-label="Mobile navigation"'));
  assert.ok(cssSource.includes(':focus-visible'));
  assert.ok(source.includes('type="button" data-landing-theme-toggle'));
});
