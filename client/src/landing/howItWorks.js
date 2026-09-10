import './landing.css';
import './howItWorks.css';
import wordmarkLight from '../assets/Logo_Modo_Claro.png';
import wordmarkDark from '../assets/Logo_Modo_Oscuro.png';
import { footer, navbar } from './sections.js';
import { initEstimateRotation, initLandingInteractions } from './interactions.js';
import { initHowItWorksMotion } from './howItWorksMotion.js';
import { initLandingSmoothScroll } from './smoothScroll.js';

// Same canonical Auth entry as the Landing: public sign-up CTAs open the
// modal in place, with plain navigation as the no-JS/dynamic-import fallback.
function initAuthModalTriggers(root) {
  if (!root || typeof root.addEventListener !== 'function') return;
  root.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.('[data-auth-open]');
    if (!trigger || !root.contains(trigger)) return;
    event.preventDefault();
    const view = trigger.dataset.authOpen === 'sign-up' ? 'sign-up' : 'sign-in';
    import('../authModal.js').then(({ openAuthModal }) => {
      openAuthModal({
        host: document.body,
        background: root,
        initialView: view,
        trigger,
        onAuthenticated: () => window.location.assign('/app')
      });
    }).catch(() => {
      window.location.href = trigger.getAttribute('href') || '/app';
    });
  });
}
import {
  applyLandingTheme,
  persistLandingTheme,
  readStoredLandingTheme,
  resolveLandingTheme,
  watchLandingSystemTheme,
  wordmarkForTheme,
} from './theme.js';

// Static semantic foundation for the dedicated /how-it-works page.
// Presentation-only: hardcoded representative copy, no Supabase,
// no app/auth/backend initialization. Each chapter owns a data-hiw-demo
// mount point with visual steps layered inside; the fallback copy inside
// each mount stays as the no-JS final state. Product-truth wording only:
// suggest / dictionary suggestion / ready to add / you decide.

function hero() {
  return `
    <section class="hiw-hero tone-hero" aria-labelledby="hiw-title">
      <div class="landing-container hiw-hero-grid">
        <div class="hiw-hero-copy">
          <span class="landing-eyebrow">How it works</span>
          <h1 id="hiw-title">See how your Japanese moves through NippoTrack.</h1>
          <p class="hiw-lede">From something you encounter to something you understand, keep, review, and build on.</p>
          <div class="hiw-hero-actions">
            <a class="landing-button landing-button-primary" href="/app?auth=sign-up" data-auth-open="sign-up">Start with NippoTrack</a>
            <a class="landing-text-link" href="/">Back to overview</a>
          </div>
        </div>
        <div class="hiw-hero-card">
          <span class="demo-label">Example</span>
          <p class="hiw-hero-word" lang="ja">旅行</p>
          <div data-hiw-hero-journey>
            <div class="hiw-journey" aria-hidden="true">
              <div class="hiw-jstep" style="--step-delay:200ms"><span class="hiw-jlabel">Found</span><strong lang="ja">旅行</strong></div>
              <span class="hiw-jarrow" aria-hidden="true">→</span>
              <div class="hiw-jstep" style="--step-delay:800ms"><span class="hiw-jlabel">Reading · meaning</span><span><span lang="ja">りょこう</span> · travel</span></div>
              <span class="hiw-jarrow" aria-hidden="true">→</span>
              <div class="hiw-jstep" style="--step-delay:1400ms"><span class="hiw-jlabel">Keep</span><span class="hiw-chip">Ready to add</span></div>
              <span class="hiw-jarrow" aria-hidden="true">→</span>
              <div class="hiw-jstep" style="--step-delay:2000ms"><span class="hiw-jlabel">Review</span><span class="hiw-chip hiw-chip-good">Good</span></div>
              <span class="hiw-jarrow" aria-hidden="true">→</span>
              <div class="hiw-jstep hiw-jmark" style="--step-delay:2600ms"><span class="hiw-jlabel">Progress</span><strong>N4 <small>range</small></strong></div>
            </div> <br>
            <p class="hiw-journey-caption">Encountered → understood → kept → reviewed → visible. Dictionary suggestions only; you decide.</p>
          </div>
        </div>
      </div>
    </section>`;
}

function chapterOne() {
  return `
    <section class="hiw-section tone-ivory" aria-labelledby="hiw-ch1-title" data-hiw-chapter="placement">
      <div class="landing-container hiw-narrow hiw-center">
        <span class="landing-eyebrow">Chapter 1 · Placement</span>
        <h2 id="hiw-ch1-title">Start from where you are.</h2>
        <p class="hiw-lede">A short, optional placement helps NippoTrack shape your first experience without pretending to give you an official JLPT diagnosis.</p>
        <div class="hiw-demo hiw-demo-stage" data-hiw-demo="placement">
          <div class="hiw-placement">
            <div class="hiw-p-card hiw-step" style="--step-delay:200ms">
              <span class="demo-label">Welcome</span>
              <p class="hiw-p-title">Want to estimate your starting point?</p>
              <p class="hiw-note">About 2 minutes. You can skip it anytime.</p>
            </div>
            <div class="hiw-p-qs">
              <div class="hiw-p-q hiw-step" style="--step-delay:900ms">
                <span class="demo-label">Question 1 of 3</span>
                <p class="hiw-p-prompt">Choose the reading for <b lang="ja">映画</b></p>
                <div class="hiw-p-opts"><span lang="ja">えいが</span><span lang="ja">えいご</span></div>
              </div>
              <div class="hiw-p-q hiw-step" style="--step-delay:1300ms">
                <span class="demo-label">Question 2 of 3</span>
                <p class="hiw-p-prompt">Choose the meaning for <b lang="ja">図書館</b></p>
                <div class="hiw-p-opts"><span>library</span><span>museum</span></div>
              </div>
              <div class="hiw-p-q hiw-step" style="--step-delay:1700ms">
                <span class="demo-label">Question 3 of 3</span>
                <p class="hiw-p-prompt">Choose the line you understand</p>
                <div class="hiw-p-opts"><span lang="ja">週末は友達と映画を見ます。</span><span lang="ja">雨が降っている。</span></div>
              </div>
            </div>
            <p class="hiw-p-processing hiw-step" style="--step-delay:2300ms">Preparing your starting estimate…</p>
            <div class="hiw-p-result hiw-step" style="--step-delay:3000ms">
              <span class="demo-label">Starting estimate</span>
              <strong aria-hidden="true"><span class="estimate-value" data-estimate-value data-estimate-delay="3400" aria-hidden="true">N4</span> <small>range</small></strong>
              <span class="visually-hidden">Starting estimate, for example N4 range</span>
              <p class="hiw-note">Starting estimate, not an official JLPT assessment.</p>
            </div>
          </div>
        </div>
      </div>
    </section>`;
}

function chapterTwo() {
  return `
    <section class="hiw-section tone-canvas" aria-labelledby="hiw-ch2-title" data-hiw-chapter="encounter">
      <div class="landing-container hiw-wide">
        <span class="landing-eyebrow">Chapter 2 · Encounter</span>
        <h2 id="hiw-ch2-title">Your Japanese doesn't begin inside NippoTrack.</h2>
        <br>
        <p class="hiw-lede">It begins in the things you already use—anime, manga, textbooks, YouTube, classes, conversations, and your own notes.</p>
        <ul class="hiw-source-list">
          <li class="hiw-step" style="--step-delay:100ms">Anime</li>
          <li class="hiw-step" style="--step-delay:200ms">Manga</li>
          <li class="hiw-step" style="--step-delay:300ms">Textbooks</li>
          <li class="hiw-step" style="--step-delay:400ms">YouTube</li>
          <li class="hiw-step" style="--step-delay:500ms">Classes</li>
          <li class="hiw-step" style="--step-delay:600ms">Conversations</li>
          <li class="hiw-step" style="--step-delay:700ms">Your own notes</li>
        </ul>
        <div class="hiw-demo hiw-demo-editorial" data-hiw-demo="encounter">
          <p class="hiw-sentence hiw-step" style="--step-delay:1200ms" lang="ja">週末は友達と<span class="hiw-hit" style="--step-delay:1800ms" lang="ja">映画</span>を見ます。</p>
          <p class="hiw-gloss hiw-step" style="--step-delay:2100ms"><strong lang="ja">映画</strong><span lang="ja">えいが</span><span>movie</span></p>
          <p class="hiw-capture hiw-step" style="--step-delay:2500ms"><span class="hiw-capture-token"><strong lang="ja">映画</strong><span lang="ja">えいが</span><span>movie</span></span><span class="hiw-capture-note">Brought in to inspect — you decide what to keep.</span></p>
        </div>
      </div>
    </section>`;
}

function chapterThree() {
  return `
    <section class="hiw-section tone-ivory" aria-labelledby="hiw-ch3-title" data-hiw-chapter="analyzer">
      <div class="landing-container hiw-wide">
        <span class="landing-eyebrow">Chapter 3 · Understand</span>
        <h2 id="hiw-ch3-title">Turn real Japanese into something you can understand.</h2>
        <br>
        <p class="hiw-lede">Inspect words in context, see readings and dictionary information, and decide what is useful to you.</p>
        <div class="hiw-demo hiw-demo-workspace" data-hiw-demo="analyzer">
          <div class="hiw-ws-bar" aria-hidden="true"><span></span><span></span><span></span><b>Text Analyzer</b></div>
          <p class="hiw-sentence" lang="ja"><span lang="ja">雨</span><span lang="ja">が降っている。</span></p>
          <p class="hiw-analyzing hiw-step" style="--step-delay:500ms">Analyzing…</p>
          <div class="hiw-cands hiw-step" style="--step-delay:1200ms" aria-hidden="true"><span class="hiw-cand hiw-cand-active" lang="ja">雨</span><span class="hiw-cand" lang="ja">降っている</span></div>
          <div class="hiw-result hiw-step" style="--step-delay:2000ms">
            <div><strong lang="ja">雨</strong><span lang="ja">あめ</span><span>rain</span></div>
            <div><small>Context</small><b lang="ja">雨が降っている。</b></div>
          </div>
          <p class="hiw-note hiw-step" style="--step-delay:2600ms"><span lang="ja">降っている</span> builds on <span lang="ja">降る</span> “to fall”.</p>
          <p class="hiw-actionrow hiw-step" style="--step-delay:3200ms"><span class="hiw-action">Keep this word</span><span class="hiw-action">Add to Vocabulary</span></p>
          <p class="hiw-note">Dictionary suggestion · you decide what to keep. Ready to add.</p>
          <p class="hiw-truth-note" data-hiw-truth>Detected ≠ matched ≠ interpreted ≠ added</p>
        </div>
      </div>
    </section>`;
}

function chapterFour() {
  return `
    <section class="hiw-section tone-canvas" aria-labelledby="hiw-ch4-title" data-hiw-chapter="autofill">
      <div class="landing-container hiw-narrow hiw-center">
        <span class="landing-eyebrow">Chapter 4 · Keep</span>
        <h2 id="hiw-ch4-title">Save the pieces worth coming back to.</h2>
        <p class="hiw-lede">NippoTrack can reduce repetitive typing while leaving the final decision with you.</p>
        <div class="hiw-demo hiw-demo-form" data-hiw-demo="autofill">
          <div class="hiw-form-card">
            <p class="hiw-field hiw-step" style="--step-delay:200ms"><span>Word</span><strong lang="ja">図書館</strong></p>
            <p class="hiw-lookup hiw-step" style="--step-delay:900ms">Looking up dictionary…</p>
            <p class="hiw-field hiw-step" style="--step-delay:1500ms"><span>Reading suggestion</span><strong lang="ja">としょかん</strong></p>
            <p class="hiw-field hiw-step" style="--step-delay:1900ms"><span>Meaning suggestion</span><strong>library</strong></p>
            <p class="hiw-prov hiw-step" style="--step-delay:2300ms"><span class="hiw-prov-tag">JMdict</span><small>Dictionary suggestion · you decide what to keep</small></p>
            <p class="hiw-ready hiw-step" style="--step-delay:2700ms"><span aria-hidden="true">✓</span> Ready to add</p>
            <p class="hiw-confirm hiw-step" style="--step-delay:3000ms"><span class="hiw-confirm-box" aria-hidden="true"></span> You confirm before anything is kept.</p>
            <p class="hiw-note">Dictionary suggestion · you decide what to keep. Ready to add.</p>
          </div>
        </div>
      </div>
    </section>`;
}

function chapterFive() {
  return `
    <section class="hiw-section tone-ivory" aria-labelledby="hiw-ch5-title" data-hiw-chapter="connections">
      <div class="landing-container hiw-wide">
        <span class="landing-eyebrow">Chapter 5 · Connect</span>
        <h2 id="hiw-ch5-title">See how the pieces fit together.</h2>
        <p class="hiw-lede">Vocabulary, kanji, context, and grammar become more useful when you can see their relationships.</p>
        <div class="hiw-demo hiw-demo-connect" data-hiw-demo="connections">
          <div class="hiw-connect-diagram" aria-hidden="true">
            <div class="hiw-node hiw-node-center hiw-step" style="--step-delay:300ms"><span class="demo-label">Kanji</span><strong lang="ja">読</strong></div>
            <svg class="hiw-link hiw-link-one" viewBox="0 0 200 24" preserveAspectRatio="none" focusable="false"><line x1="0" y1="12" x2="200" y2="12"></line></svg>
            <div class="hiw-node hiw-step" style="--step-delay:900ms"><span class="demo-label">Vocabulary</span><strong lang="ja">読書</strong><span><span lang="ja">どくしょ</span> · reading</span></div>
            <svg class="hiw-link hiw-link-two" viewBox="0 0 200 24" preserveAspectRatio="none" focusable="false"><line x1="0" y1="12" x2="200" y2="12"></line></svg>
            <div class="hiw-node hiw-step" style="--step-delay:1800ms"><span class="demo-label">Context</span><strong lang="ja">本を読む。</strong><span lang="ja">ほんをよむ。</span></div>
            <p class="hiw-node-readings hiw-step" style="--step-delay:2400ms"><span>On’yomi <b lang="ja">ドク</b></span><span>Kun’yomi <b lang="ja">よむ</b></span></p>
          </div>
          <div class="hiw-connect-list">
            <p class="hiw-field"><span>Kanji</span><strong lang="ja">読</strong></p>
            <p class="hiw-gloss"><span>On’yomi</span><span lang="ja">ドク</span><span>Kun’yomi</span><span lang="ja">よむ</span></p>
            <p class="hiw-field"><span>Vocabulary</span><strong lang="ja">読書</strong></p>
            <p class="hiw-gloss"><span lang="ja">どくしょ</span><span>reading</span></p>
            <p class="hiw-field"><span>Context</span><strong lang="ja">本を読む。</strong></p>
            <p class="hiw-gloss"><span lang="ja">ほんをよむ。</span><span>read a book</span></p>
          </div>
        </div>
      </div>
    </section>`;
}

function chapterSix() {
  return `
    <section class="hiw-section tone-canvas" aria-labelledby="hiw-ch6-title" data-hiw-chapter="session">
      <div class="landing-container hiw-narrow">
        <span class="landing-eyebrow">Chapter 6 · Track</span>
        <h2 id="hiw-ch6-title">Track the work behind the words.</h2>
        <p class="hiw-lede">Vocabulary matters, but so does the time you spend listening, reading, speaking, reviewing, and studying.</p>
        <div class="hiw-demo hiw-demo-session" data-hiw-demo="session">
          <dl class="hiw-session">
            <div class="hiw-step" style="--step-delay:200ms"><dt>Source</dt><dd>YouTube</dd></div>
            <div class="hiw-step" style="--step-delay:600ms"><dt>Focus</dt><dd>Listening</dd></div>
            <div class="hiw-step hiw-duration" style="--step-delay:1000ms"><dt>Duration</dt><dd>35 min</dd></div>
            <div class="hiw-step" style="--step-delay:1400ms"><dt>Note</dt><dd>Shadowing practice</dd></div>
          </dl>
          <p class="hiw-logged hiw-step" style="--step-delay:1800ms"><span aria-hidden="true">✓</span> Session logged in this example</p>
          <div class="hiw-timeline hiw-step" style="--step-delay:2200ms" aria-hidden="true">
            <span></span><span></span><span></span><span></span><span></span><span></span><span class="hiw-tick-new"></span>
          </div>
        </div>
      </div>
    </section>`;
}

function chapterSeven() {
  return `
    <section class="hiw-section tone-ivory" aria-labelledby="hiw-ch7-title" data-hiw-chapter="review">
      <div class="landing-container hiw-narrow hiw-center">
        <span class="landing-eyebrow">Chapter 7 · Review</span>
        <h2 id="hiw-ch7-title">Review your Japanese, not somebody else's course.</h2>
        <p class="hiw-lede">Your review flow grows from the vocabulary you intentionally collected and studied.</p>
        <div class="hiw-demo hiw-demo-review" data-hiw-demo="review">
          <div class="hiw-review-stage">
            <span class="demo-label">Your vocabulary · example</span>
            <p class="hiw-review-word hiw-step" style="--step-delay:200ms" lang="ja">約束</p>
            <p class="hiw-reveal hiw-step" style="--step-delay:600ms">Reveal answer</p>
            <p class="hiw-gloss hiw-answer hiw-step" style="--step-delay:900ms"><strong lang="ja">やくそく</strong><span>promise</span></p>
            <p class="hiw-note hiw-step" style="--step-delay:1400ms">Context <b lang="ja">約束を忘れないで。</b></p>
            <p class="hiw-rating hiw-step" style="--step-delay:1900ms" aria-hidden="true"><span>Again</span><span>Hard</span><span class="hiw-good" style="--step-delay:2300ms">Good</span></p>
          </div>
        </div>
      </div>
    </section>`;
}

function chapterEight() {
  return `
    <section class="hiw-section tone-mist" aria-labelledby="hiw-ch8-title" data-hiw-chapter="progress">
      <div class="landing-container hiw-wide">
        <span class="landing-eyebrow">Chapter 8 · See</span>
        <h2 id="hiw-ch8-title">See your learning become visible.</h2>
        <p class="hiw-lede">NippoTrack helps you see what you've collected, reviewed, and actually spent time studying.</p>
        <p class="hiw-truth hiw-step" style="--step-delay:2600ms">Collected ≠ Reviewed ≠ Known</p>
        <div class="hiw-demo hiw-demo-progress" data-hiw-demo="progress">
          <ul class="hiw-metrics">
            <li class="hiw-step" style="--step-delay:200ms"><span>Vocabulary collected</span><strong data-hiw-count="312">312</strong></li>
            <li class="hiw-step" style="--step-delay:400ms"><span>Kanji collected</span><strong data-hiw-count="184">184</strong></li>
            <li class="hiw-step" style="--step-delay:600ms"><span>Sessions logged</span><strong data-hiw-count="27">27</strong></li>
            <li class="hiw-step" style="--step-delay:800ms"><span>Study time</span><strong data-hiw-count="18" data-hiw-suffix="h">18h</strong></li>
          </ul>
          <div class="hiw-chart hiw-step" style="--step-delay:1200ms" role="img" aria-label="Representative study activity chart showing varied study over eight weeks">
            <div class="hiw-chart-head"><span>Study activity</span><small>Last 8 weeks</small></div>
            <svg viewBox="0 0 760 180" preserveAspectRatio="none" aria-hidden="true"><path class="hiw-grid" d="M0 30H760M0 90H760M0 150H760"></path><path class="hiw-area" d="M0 152 C70 145 72 118 145 126 S228 67 302 88 S387 112 454 62 S541 78 608 43 S690 58 760 20 L760 180 L0 180 Z"></path><path class="hiw-line" d="M0 152 C70 145 72 118 145 126 S228 67 302 88 S387 112 454 62 S541 78 608 43 S690 58 760 20"></path></svg>
          </div>
          <p class="hiw-estimate hiw-step" style="--step-delay:2400ms">Starting estimate N4 range</p>
          <p class="hiw-estimate hiw-step" style="--step-delay:2500ms">Current focus Building toward N3</p>
        </div>
      </div>
    </section>`;
}

function philosophy() {
  return `
    <section class="hiw-philosophy tone-canvas" aria-label="Our philosophy">
      <div class="landing-container hiw-narrow">
        <p class="hiw-statement">NippoTrack doesn't replace how you learn Japanese.<br>It makes the way you already learn Japanese smarter.</p>
      </div>
    </section>`;
}

function finalCta() {
  return `
    <section class="final-cta" id="hiw-final" aria-labelledby="hiw-final-title">
      <div class="landing-container"><h2 id="hiw-final-title">Bring your Japanese learning together.</h2><div><a class="landing-button landing-button-primary" href="/app?auth=sign-up" data-auth-open="sign-up">Start with NippoTrack</a><a class="landing-text-link" href="/">Back to overview</a></div></div>
    </section>`;
}

function journeyThread() {
  return `
    <p class="visually-hidden">How it works journey: start, encounter, understand, keep, connect, track, review, see.</p>
    <nav class="hiw-thread" data-hiw-thread aria-hidden="true">
      <span class="hiw-thread-line"></span>
      <ol>
        <li data-hiw-node="start"><span class="hiw-dot"></span><span>Start</span></li>
        <li data-hiw-node="encounter"><span class="hiw-dot"></span><span>Encounter</span></li>
        <li data-hiw-node="understand"><span class="hiw-dot"></span><span>Understand</span></li>
        <li data-hiw-node="keep"><span class="hiw-dot"></span><span>Keep</span></li>
        <li data-hiw-node="connect"><span class="hiw-dot"></span><span>Connect</span></li>
        <li data-hiw-node="track"><span class="hiw-dot"></span><span>Track</span></li>
        <li data-hiw-node="review"><span class="hiw-dot"></span><span>Review</span></li>
        <li data-hiw-node="see"><span class="hiw-dot"></span><span>See</span></li>
      </ol>
    </nav>`;
}

export function createHowItWorksMarkup(wordmarkUrl, themeAssets = {}) {
  const lightSrc = themeAssets.lightSrc || wordmarkUrl;
  const darkSrc = themeAssets.darkSrc || wordmarkUrl;
  const resolved = { lightSrc, darkSrc };
  const initialSrc = wordmarkUrl || lightSrc;
  const navOptions = { variant: 'how-it-works' };
  return `
    <a class="landing-skip-link" href="#hiw-main">Skip to main content</a>
    <div class="landing-page hiw-page">
      ${navbar(initialSrc, resolved, navOptions)}
      <main id="hiw-main" tabindex="-1">
        ${hero()}
        ${journeyThread()}
        ${chapterOne()}
        ${chapterTwo()}
        ${chapterThree()}
        ${chapterFour()}
        ${chapterFive()}
        ${chapterSix()}
        ${chapterSeven()}
        ${chapterEight()}
        ${philosophy()}
        ${finalCta()}
      </main>
      ${footer(initialSrc, resolved, navOptions)}
    </div>`;
}

const root = document.getElementById('landing-root');

if (root) {
  document.documentElement.classList.add('landing-js', 'hiw-js');
  const themeAssets = { lightSrc: wordmarkLight, darkSrc: wordmarkDark };
  const initialTheme = resolveLandingTheme();
  // Same pre-paint theme sync as the landing boot: dataset + colorScheme +
  // meta theme-color. Pre-paint dataset is also set by theme-init.js.
  applyLandingTheme(initialTheme, themeAssets);
  const fontStylesheet = document.createElement('link');
  fontStylesheet.rel = 'stylesheet';
  fontStylesheet.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap';
  document.head.append(fontStylesheet);
  document.title = 'NippoTrack — How it works';
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content',
    'From something you encounter to something you understand, keep, review, and build on.'
  );
  document.body.classList.add('has-landing');
  root.innerHTML = createHowItWorksMarkup(wordmarkForTheme(initialTheme, themeAssets), themeAssets);
  applyLandingTheme(initialTheme, themeAssets);
  root.querySelectorAll('[data-landing-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const current = document.documentElement.dataset.nippotrackTheme === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      persistLandingTheme(next, localStorage);
      applyLandingTheme(next, themeAssets);
    });
  });
  // Follow the OS theme only while the visitor has no explicit stored choice.
  watchLandingSystemTheme((systemTheme) => {
    try {
      if (readStoredLandingTheme(localStorage)) return;
    } catch {
      return;
    }
    applyLandingTheme(systemTheme, themeAssets);
  });
  // Reuses the landing header/menu wiring plus the single-observer chapter
  // motion pass (visible -> short delay -> play once -> remain final).
  initLandingInteractions(root);
  const stopHiwMotion = initHowItWorksMotion(root);
  initEstimateRotation(root);
  initAuthModalTriggers(root);
  // v5.1-E.3 Lenis: public How-It-Works too (same fail-open contract).
  try { initLandingSmoothScroll(root)?.catch?.(() => {}); } catch { /* native scroll */ }
  try {
    window.addEventListener('pagehide', () => {
      try {
        stopHiwMotion?.();
      } catch {
        // Cleanup is careful and quiet.
      }
    }, { once: true });
  } catch {
    // pagehide guard is progressive enhancement.
  }
  const anchor = window.location.hash.slice(1);
  if (anchor && document.getElementById(anchor)) {
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }
}
