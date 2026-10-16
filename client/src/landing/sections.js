function themeToggle() {
  return `
    <button class="landing-theme-toggle" type="button" data-landing-theme-toggle aria-label="Switch to dark mode">
      <svg data-theme-icon="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" hidden><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"></path></svg>
      <svg data-theme-icon="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.4 13.2A8.4 8.4 0 0 1 10.8 3.6a8.4 8.4 0 1 0 9.6 9.6Z"></path></svg>
    </button>`;
}

export function navbar(wordmarkUrl, themeAssets = {}, options = {}) {
  const lightSrc = themeAssets.lightSrc || wordmarkUrl;
  const darkSrc = themeAssets.darkSrc || wordmarkUrl;
  // The dedicated /how-it-works page reuses this navbar with
  // { variant: 'how-it-works' }: Features points back to the landing anchor
  // and the current page is marked with aria-current. Landing keeps its
  // same-page Features anchor; both link How it works to /how-it-works.
  const isHowItWorks = options.variant === 'how-it-works';
  const featuresHref = isHowItWorks ? '/#features' : '#features';
  const howItWorksHref = '/how-it-works';
  const howItWorksCurrent = isHowItWorks ? ' aria-current="page"' : '';
  return `
    <header class="landing-header" data-landing-header>
      <p class="landing-issue"><span class="landing-container">NippoTrack — Study ledger · N5–N1 · <span lang="ja">日本語</span></span></p>
      <div class="landing-container landing-nav">
        <a class="landing-brand" href="/" aria-label="NippoTrack home">
          <img class="masthead-seal" src="/seal.svg" alt="" aria-hidden="true" width="30" height="30">
          <img src="${wordmarkUrl}" data-landing-wordmark data-light-src="${lightSrc}" data-dark-src="${darkSrc}" alt="NippoTrack" width="260" height="88" fetchpriority="high">
        </a>
        <nav class="landing-desktop-nav" aria-label="Main navigation">
          <a href="${featuresHref}">Features</a>
          <a href="${howItWorksHref}"${howItWorksCurrent}>How it works</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div class="landing-nav-actions">
          <a class="landing-text-link" href="/app?auth=sign-in" data-auth-open="sign-in">Log in</a>
          <a class="landing-button landing-button-primary landing-nav-cta" href="/app?auth=sign-up" data-auth-open="sign-up">Get started</a>
        </div>
        <div class="landing-nav-tools">
          ${themeToggle()}
          <button class="landing-menu-button" type="button" aria-label="Open menu" aria-controls="landing-mobile-menu" aria-expanded="false" data-menu-button>
            <span></span><span></span>
          </button>
        </div>
      </div>
      <nav class="landing-mobile-menu" id="landing-mobile-menu" aria-label="Mobile navigation" hidden data-mobile-menu>
        <a href="${featuresHref}">Features</a>
        <a href="${howItWorksHref}"${howItWorksCurrent}>How it works</a>
        <a href="#faq">FAQ</a>
        <a href="/app?auth=sign-in" data-auth-open="sign-in">Log in</a>
        <a class="landing-button landing-button-primary" href="/app?auth=sign-up" data-auth-open="sign-up">Get started</a>
      </nav>
    </header>`;
}

export const HERO_HEADLINE_MAIN = 'Bring your Japanese learning together.';
export const HERO_HEADLINE_ALT_ONE = 'Track anywhere.';

function hero() {
  return `
    <section class="landing-hero tone-hero" aria-labelledby="hero-title">
      <div class="landing-container landing-hero-grid">
        <div class="landing-hero-copy">
          <div class="hero-title-stack" data-hero-title-stack>
            <h1 id="hero-title">${HERO_HEADLINE_MAIN}</h1>
            <p class="hero-typing" aria-hidden="true" data-hero-typing>
              <span class="hero-typing-line is-active" data-hero-line>${HERO_HEADLINE_MAIN}</span>
              <span class="hero-typing-line" data-hero-line>${HERO_HEADLINE_ALT_ONE}</span>
            </p>
          </div>
          <p class="landing-lede">Organize what you learn, understand Japanese in context, and keep a clear view of your progress.</p>
          <div class="landing-hero-actions">
            <a class="landing-button landing-button-primary" href="/app?auth=sign-up" data-auth-open="sign-up">Register</a>
            <a class="landing-text-link landing-arrow-link" href="/how-it-works">See how it works <span aria-hidden="true">→</span></a>
          </div>
          <p class="landing-supporting">Built for the way you already study Japanese.</p>
        </div>
        <div class="hero-ecosystem" aria-hidden="true">
          <article class="hero-card hero-vocabulary" data-float="one">
            <span class="demo-label">Vocabulary</span>
            <p class="hero-japanese" lang="ja">旅行</p>
            <p class="hero-reading" lang="ja">りょこう</p>
            <p class="hero-meaning">travel</p>
            <div class="hero-context"><span>Context</span><b lang="ja">来年、日本へ旅行します。</b></div>
          </article>
          <article class="hero-card hero-kanji" data-float="two">
            <span class="demo-label">Kanji</span>
            <p class="hero-kanji-glyph" lang="ja">殻</p>
            <p>shell · husk</p>
          </article>
          <article class="hero-card hero-level" data-float="three">
            <span class="demo-label">Starting estimate</span>
            <strong class="estimate-value" data-estimate-value data-estimate-delay="0" aria-hidden="true">N4</strong><span aria-hidden="true"> range</span><span class="visually-hidden">Starting estimate, for example N4 range</span>
          </article>
          <article class="hero-card hero-streak" data-float="four">
            <span class="demo-label">Study streak</span>
            <strong data-hero-streak="30">30</strong><span> days</span>
          </article>
          <article class="hero-card hero-review" data-float="five">
            <span class="demo-label">Ready to review</span>
            <p lang="ja">約束 <span lang="ja">やくそく</span></p>
            <small>Your collection, in motion</small>
          </article>
        </div>
      </div>
    </section>`;
}

function studySources() {
  return `
    <section class="landing-section editorial-section tone-ivory" aria-labelledby="sources-title">
      <div class="landing-container editorial-content">
        <h2 id="sources-title">Your Japanese study is already everywhere.</h2>
        <p class="source-words" data-reveal-group><span>Textbooks.</span><span>Anime.</span><span>Manga.</span><span>YouTube.</span><span>Classes.</span><span>Flashcards.</span><span>Conversations.</span></p>
        <p class="editorial-bridge">NippoTrack doesn't replace them.<br>It connects what you learn from them.</p>
      </div>
    </section>`;
}

function coreFlow() {
  return `
    <section class="landing-section flow-section tone-muted" id="how-it-works" aria-labelledby="flow-title" data-demo="flow">
      <div class="landing-container">
        <div class="flow-heading">
          <h2 id="flow-title">A simple loop for the way you already learn.</h2>
          <p class="flow-sub">Capture what you encounter, understand it in context, then review what you chose to keep.</p>
        </div>
        <div class="core-flow">
          <article class="flow-stage demo-step" style="--step-delay:100ms">
            <span class="flow-number">01</span>
            <h3>Capture</h3>
            <div class="flow-card">
              <strong class="flow-word flow-tracked" style="--step-delay:500ms" lang="ja">料理</strong>
              <ul class="flow-chips" aria-hidden="true">
                <li>Vocabulary</li>
                <li>Kanji</li>
                <li>Grammar</li>
                <li>Study session</li>
              </ul>
            </div>
          </article>
          <span class="flow-connector" aria-hidden="true" style="--step-delay:450ms"></span>
          <article class="flow-stage demo-step" style="--step-delay:700ms">
            <span class="flow-number">02</span>
            <h3>Understand</h3>
            <div class="flow-card">
              <p class="flow-sentence" lang="ja">昨日、日本<span class="flow-sentence-hit" style="--step-delay:1000ms" lang="ja">料理</span>を作った。</p>
              <p class="flow-gloss demo-step" style="--step-delay:1250ms"><strong lang="ja">料理</strong><span lang="ja">りょうり</span><span>cooking · cuisine</span></p>
              <p class="flow-context demo-step" style="--step-delay:1500ms"><span>Context</span><b lang="ja">昨日、日本料理を作った。</b></p>
            </div>
          </article>
          <span class="flow-connector" aria-hidden="true" style="--step-delay:1050ms"></span>
          <article class="flow-stage demo-step" style="--step-delay:1350ms">
            <span class="flow-number">03</span>
            <h3>Review</h3>
            <div class="flow-card">
              <strong class="flow-word" lang="ja">料理</strong>
              <p class="flow-reveal"><span>Reveal</span></p>
              <p class="flow-gloss demo-step" style="--step-delay:1750ms"><strong lang="ja">料理</strong><span lang="ja">りょうり</span><span>cooking · cuisine</span></p>
              <p class="flow-rating demo-step" style="--step-delay:2000ms" aria-hidden="true"><span>Again</span><span>Hard</span><span class="rating-good flow-good" style="--step-delay:2200ms">Good</span></p>
            </div>
          </article>
        </div>
        <p class="flow-more"><a class="landing-text-link landing-arrow-link" href="/how-it-works">See the full flow <span aria-hidden="true">→</span></a></p>
      </div>
    </section>`;
}

function analyzerShowcase() {
  return `
    <section class="landing-section showcase-section showcase-demo-first tone-canvas tone-analyzer" id="features" aria-labelledby="analyzer-title" data-demo="analyzer">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Analyzer</span><h2 id="analyzer-title">Understand the Japanese you actually encounter.</h2><p>Analyze real Japanese text, inspect vocabulary in context, and decide what is worth keeping.</p></div>
        <div class="showcase-panel analyzer-demo" aria-hidden="true">
          <div class="demo-window-bar"><span></span><span></span><span></span><b>Text Analyzer</b></div>
          <p class="analyzer-sentence" lang="ja">雨が降っている。</p>
          <p class="demo-status demo-step" style="--step-delay:500ms">Analyzing…</p>
          <div class="candidate-row demo-step" style="--step-delay:1200ms"><span class="candidate-active" lang="ja">雨</span><span lang="ja">降っている</span></div>
          <div class="analyzer-result demo-step" style="--step-delay:2500ms"><div><strong lang="ja">雨</strong><span lang="ja">あめ</span><span>rain</span></div><div><small>Context</small><b lang="ja">雨が降っている。</b></div></div>
          <span class="demo-action demo-step" style="--step-delay:3200ms">Add to Vocabulary</span>
        </div>
      </div>
    </section>`;
}

function vocabularyShowcase() {
  return `
    <section class="landing-section showcase-section tone-ivory" aria-labelledby="vocabulary-title" data-demo="vocabulary">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Vocabulary Auto-Fill</span><h2 id="vocabulary-title">Less typing. More intentional tracking.</h2><p>NippoTrack can suggest readings and dictionary meanings while leaving the final decision to you.</p></div>
        <div class="showcase-panel vocabulary-demo" aria-hidden="true">
          <div class="demo-window-bar"><span></span><span></span><span></span><b>New vocabulary</b></div>
          <label class="demo-field"><span>Word</span><strong class="typing-word" lang="ja">図書館</strong></label>
          <p class="lookup-status demo-step" style="--step-delay:950ms">Looking up dictionary…</p>
          <div class="demo-fields">
            <label class="demo-field demo-step" style="--step-delay:1750ms"><span>Reading</span><strong lang="ja">としょかん</strong></label>
            <label class="demo-field demo-step" style="--step-delay:2200ms"><span>Meaning</span><strong>library</strong></label>
          </div>
          <div class="demo-provenance demo-step" style="--step-delay:2700ms"><span>JMdict</span><small>Dictionary suggestion · you decide what to keep</small></div>
          <p class="demo-ready demo-step" style="--step-delay:3100ms"><span aria-hidden="true">✓</span> Ready to add</p>
        </div>
      </div>
    </section>`;
}

function kanjiShowcase() {
  return `
    <section class="landing-section showcase-section showcase-demo-first tone-canvas" aria-labelledby="kanji-title" data-demo="kanji">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Kanji</span><h2 id="kanji-title">Keep kanji connected to what you're learning.</h2><p>See meanings, readings and study information together without separating kanji from the rest of your Japanese journey.</p></div>
        <div class="showcase-panel kanji-demo" aria-hidden="true">
          <div class="kanji-sequence" data-kanji-sequence>
            <div class="kanji-seq-stage demo-step" style="--step-delay:500ms" data-kanji-seq-stage>
              <div class="kanji-seq-glyph" data-kanji-seq-glyph="日" lang="ja">日</div>
              <p class="kanji-seq-caption"><small data-kanji-seq-readings lang="ja">ニチ・ジツ<br>ひ・か</small></p>
            </div>
          </div>
        </div>
      </div>
    </section>`;
}

function reviewShowcase() {
  return `
    <section class="landing-section showcase-section tone-muted" aria-labelledby="review-title" data-demo="review">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Review</span><h2 id="review-title">Review what you've actually collected.</h2><p>Your review flow grows from your own vocabulary and study activity—not from a generic course.</p></div>
        <div class="showcase-panel review-demo" aria-hidden="true">
          <span class="demo-label">Your vocabulary · 18 due</span>
          <p class="review-word" lang="ja">約束</p>
          <span class="review-reveal">Reveal answer</span>
          <div class="review-answer demo-step" style="--step-delay:900ms"><strong lang="ja">やくそく</strong><span>promise</span></div>
          <div class="review-rating demo-step" style="--step-delay:1500ms"><span>Again</span><span>Hard</span><span class="rating-good">Good</span></div>
        </div>
      </div>
    </section>`;
}

function progressShowcase() {
  return `
    <section class="landing-section progress-section tone-mist" aria-labelledby="progress-title" data-demo="progress">
      <div class="landing-container">
        <div class="showcase-copy progress-copy"><span class="landing-eyebrow">Progress</span><h2 id="progress-title">See your learning take shape.</h2><p>Progress isn't just a number. NippoTrack helps you see what you've collected, reviewed and actually spent time studying.</p></div>
        <div class="showcase-panel progress-demo">
          <div class="progress-metrics">
            <div aria-label="312 vocabulary entries collected"><span>Vocabulary</span><strong data-counter="312">312</strong><small>collected</small></div>
            <div aria-label="184 kanji collected"><span>Kanji</span><strong data-counter="184">184</strong><small>collected</small></div>
            <div aria-label="27 study sessions logged"><span>Sessions</span><strong data-counter="27">27</strong><small>logged</small></div>
          </div>
          <div class="study-chart" aria-label="Representative study activity chart showing varied study over eight weeks" role="img">
            <div class="chart-heading"><span>Study activity</span><small>Last 8 weeks</small></div>
            <svg viewBox="0 0 760 180" preserveAspectRatio="none" aria-hidden="true"><path class="chart-grid" d="M0 30H760M0 90H760M0 150H760"></path><path class="chart-area" d="M0 152 C70 145 72 118 145 126 S228 67 302 88 S387 112 454 62 S541 78 608 43 S690 58 760 20 L760 180 L0 180 Z"></path><path class="chart-line" d="M0 152 C70 145 72 118 145 126 S228 67 302 88 S387 112 454 62 S541 78 608 43 S690 58 760 20"></path></svg>
          </div>
          <p class="progress-truth"><span>Collected</span><b>≠</b><span>Reviewed</span><b>≠</b><span>Known</span></p>
        </div>
      </div>
    </section>`;
}

function onboardingShowcase() {
  return `
    <section class="landing-section showcase-section tone-ivory" aria-labelledby="onboarding-title" data-demo="onboarding">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Quick placement</span><h2 id="onboarding-title">Start from where you are.</h2><p>A short, optional placement can help NippoTrack tailor your starting experience.</p></div>
        <div class="showcase-panel onboarding-demo" aria-hidden="true">
          <div class="placement-card placement-welcome"><span class="demo-label">Welcome</span><h3>Want to estimate your starting point?</h3><p>About 2 minutes</p><span class="demo-action">Start quick placement</span><span class="placement-skip">Skip for now</span></div>
          <div class="placement-card placement-question demo-step" style="--step-delay:1200ms"><span class="demo-label">Quick placement · 3 of 5</span><p lang="ja">毎朝、新聞を＿＿。</p><div><span>読みます</span><span>読んだ</span></div></div>
          <p class="placement-preparing demo-step" style="--step-delay:3800ms">Preparing your estimate…</p>
          <div class="placement-card placement-result demo-step" style="--step-delay:4600ms"><span class="demo-label">Starting estimate</span><strong aria-hidden="true"><span class="estimate-value" data-estimate-value data-estimate-delay="4800" aria-hidden="true">N4</span> <small>range</small></strong><span class="visually-hidden">Starting estimate, for example N4 range</span><p>This is a starting estimate, not an official JLPT assessment.</p></div>
        </div>
      </div>
    </section>`;
}

function firstUseDashboard() {
  return `
    <section class="landing-section showcase-section showcase-demo-first tone-canvas" aria-labelledby="first-use-title" data-demo="first-use">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Your first steps</span><h2 id="first-use-title">Know what to do next.</h2><p>NippoTrack guides your first steps, then gradually gets out of the way as your own study data takes over.</p></div>
        <div class="showcase-panel first-use-demo" aria-hidden="true">
          <div class="first-use-heading demo-step" style="--step-delay:0ms"><div><span class="demo-label">Dashboard</span><h3>Welcome <span>👋</span></h3></div><p><small>Starting estimate</small><strong aria-hidden="true"><span class="estimate-value" data-estimate-value data-estimate-delay="800" aria-hidden="true">N4</span> range</strong><span class="visually-hidden">Starting estimate, for example N4 range</span></p></div>
          <div class="first-steps demo-step" style="--step-delay:300ms"><h4>Your first steps</h4><ul><li class="is-complete"><span>✓</span> Complete your placement</li><li><span>○</span> Add your first vocabulary</li><li><span>○</span> Analyze your first Japanese sentence</li><li><span>○</span> Log your first study session</li></ul></div>
        </div>
      </div>
    </section>`;
}

function finalCta() {
  return `
    <section class="final-cta" id="final-cta" aria-labelledby="final-cta-title">
      <div class="landing-container"><h2 id="final-cta-title">Ready to bring your Japanese study together?</h2><div><a class="landing-button landing-button-primary" href="/app?auth=sign-up" data-auth-open="sign-up">Start with NippoTrack</a><a class="landing-button" data-android-download href="https://github.com/Eikozl/NippoTrack/releases/latest">Download on Android</a><a class="landing-text-link" href="/app?auth=sign-in" data-auth-open="sign-in">Already have an account? Log in</a></div><p class="final-cta-micro">Free · PWA + Android · Your data stays yours</p></div>
    </section>`;
}

export function footer(wordmarkUrl, themeAssets = {}, options = {}) {
  const lightSrc = themeAssets.lightSrc || wordmarkUrl;
  const darkSrc = themeAssets.darkSrc || wordmarkUrl;
  // Same variant contract as navbar(): the dedicated /how-it-works page
  // reuses this footer with { variant: 'how-it-works' } so Product links
  // resolve cross-page. Landing defaults stay byte-identical.
  const isHowItWorks = options.variant === 'how-it-works';
  const featuresHref = isHowItWorks ? '/#features' : '#features';
  const howItWorksHref = isHowItWorks ? '/how-it-works' : '#how-it-works';
  return `
    <footer class="landing-footer tone-canvas" id="faq">
      <div class="landing-container footer-grid">
        <div class="footer-brand"><img src="${wordmarkUrl}" data-landing-wordmark data-light-src="${lightSrc}" data-dark-src="${darkSrc}" alt="NippoTrack" width="260" height="88" loading="lazy"></div>
        <div><h2>Product</h2><a href="${featuresHref}">Features</a><a href="${howItWorksHref}">How it works</a><a data-android-download href="https://github.com/Eikozl/NippoTrack/releases/latest">Android app</a></div>
        <div><h2>Data &amp; notices</h2><span>About the data</span><span>Third-party notices</span></div>
        <div><h2>Legal</h2><span>Privacy</span><span>Terms</span></div>
      </div>
      <div class="landing-container footer-bottom"><p>JMdict/EDRDG and KanjiVG data are used within NippoTrack. See third-party notices in the project distribution.</p><p>© 2026 NippoTrack</p></div>
    </footer>`;
}

export function createLandingMarkup(wordmarkUrl, themeAssets = {}) {
  const lightSrc = themeAssets.lightSrc || wordmarkUrl;
  const darkSrc = themeAssets.darkSrc || wordmarkUrl;
  const resolved = { lightSrc, darkSrc };
  const initialSrc = wordmarkUrl || lightSrc;
  return `
    <a class="landing-skip-link" href="#landing-main">Skip to main content</a>
    <div class="landing-page">
      ${navbar(initialSrc, resolved)}
      <main id="landing-main" tabindex="-1">
        ${hero()}
        ${studySources()}
        ${coreFlow()}
        ${analyzerShowcase()}
        ${vocabularyShowcase()}
        ${kanjiShowcase()}
        ${reviewShowcase()}
        ${progressShowcase()}
        ${onboardingShowcase()}
        ${firstUseDashboard()}
        ${finalCta()}
      </main>
      ${footer(initialSrc, resolved)}
    </div>`;
}

