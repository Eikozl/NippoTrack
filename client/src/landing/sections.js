function navbar(wordmarkUrl) {
  return `
    <header class="landing-header" data-landing-header>
      <div class="landing-container landing-nav">
        <a class="landing-brand" href="/" aria-label="NippoTrack home">
          <img src="${wordmarkUrl}" alt="NippoTrack" width="260" height="88">
        </a>
        <nav class="landing-desktop-nav" aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div class="landing-nav-actions">
          <a class="landing-text-link" href="/app?auth=sign-in">Log in</a>
          <a class="landing-button landing-button-primary landing-nav-cta" href="/app?auth=sign-up">Get started</a>
        </div>
        <button class="landing-menu-button" type="button" aria-label="Open menu" aria-controls="landing-mobile-menu" aria-expanded="false" data-menu-button>
          <span></span><span></span>
        </button>
      </div>
      <nav class="landing-mobile-menu" id="landing-mobile-menu" aria-label="Mobile navigation" hidden data-mobile-menu>
        <a href="#features">Features</a>
        <a href="#how-it-works">How it works</a>
        <a href="#faq">FAQ</a>
        <a href="/app?auth=sign-in">Log in</a>
        <a class="landing-button landing-button-primary" href="/app?auth=sign-up">Get started</a>
      </nav>
    </header>`;
}

function hero() {
  return `
    <section class="landing-hero" aria-labelledby="hero-title">
      <div class="landing-container landing-hero-grid">
        <div class="landing-hero-copy">
          <h1 id="hero-title">Bring your Japanese learning together.</h1>
          <p class="landing-lede">Organize what you learn, understand Japanese in context, and keep a clear view of your progress.</p>
          <div class="landing-hero-actions">
            <a class="landing-button landing-button-primary" href="/app?auth=sign-up">Start free</a>
            <a class="landing-text-link landing-arrow-link" href="#how-it-works">See how it works <span aria-hidden="true">→</span></a>
          </div>
          <p class="landing-supporting">Built for the way you already study Japanese.</p>
        </div>
        <div class="hero-ecosystem" aria-hidden="true">
          <article class="hero-card hero-vocabulary" data-float="one">
            <span class="demo-label">Vocabulary</span>
            <p class="hero-japanese" lang="ja">学校</p>
            <p class="hero-reading" lang="ja">がっこう</p>
            <p class="hero-meaning">school</p>
            <div class="hero-context"><span>Context</span><b lang="ja">学校に行った。</b></div>
          </article>
          <article class="hero-card hero-kanji" data-float="two">
            <span class="demo-label">Kanji</span>
            <p class="hero-kanji-glyph" lang="ja">殻</p>
            <p>shell · husk</p>
          </article>
          <article class="hero-card hero-level" data-float="three">
            <span class="demo-label">Starting estimate</span>
            <strong>N4</strong><span> range</span>
          </article>
          <article class="hero-card hero-streak" data-float="four">
            <span class="demo-label">Study streak</span>
            <strong>12</strong><span> days</span>
          </article>
          <article class="hero-card hero-review" data-float="five">
            <span class="demo-label">Ready to review</span>
            <p lang="ja">学校 <span>がっこう</span></p>
            <small>Your collection, in motion</small>
          </article>
        </div>
      </div>
    </section>`;
}

function studySources() {
  return `
    <section class="landing-section editorial-section" aria-labelledby="sources-title">
      <div class="landing-container editorial-content">
        <h2 id="sources-title">Your Japanese study is already everywhere.</h2>
        <p class="source-words" data-reveal-group><span>Textbooks.</span><span>Anime.</span><span>Manga.</span><span>YouTube.</span><span>Classes.</span><span>Flashcards.</span><span>Conversations.</span></p>
        <p class="editorial-bridge">NippoTrack doesn't replace them.<br>It connects what you learn from them.</p>
        <p class="editorial-statement">NippoTrack doesn't replace how you learn Japanese.<br>It makes the way you already learn Japanese smarter.</p>
      </div>
    </section>`;
}

function coreFlow() {
  return `
    <section class="landing-section flow-section" id="how-it-works" aria-labelledby="flow-title">
      <div class="landing-container">
        <h2 class="visually-hidden" id="flow-title">How NippoTrack works</h2>
        <div class="core-flow">
          <article><span class="flow-number">01</span><h3>Capture</h3><p>Vocabulary<br>Kanji<br>Grammar<br>Sessions</p></article>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <article><span class="flow-number">02</span><h3>Understand</h3><p>Context<br>Readings<br>Meanings<br>Real Japanese</p></article>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <article><span class="flow-number">03</span><h3>Review</h3><p>What you've actually collected and studied</p></article>
        </div>
      </div>
    </section>`;
}

function analyzerShowcase() {
  return `
    <section class="landing-section showcase-section showcase-demo-first" id="features" aria-labelledby="analyzer-title" data-demo="analyzer">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Analyzer</span><h2 id="analyzer-title">Understand the Japanese you actually encounter.</h2><p>Analyze real Japanese text, inspect vocabulary in context, and decide what is worth keeping.</p></div>
        <div class="showcase-panel analyzer-demo" aria-hidden="true">
          <div class="demo-window-bar"><span></span><span></span><span></span><b>Text Analyzer</b></div>
          <p class="analyzer-sentence" lang="ja">学校に行った。</p>
          <p class="demo-status demo-step" style="--step-delay:500ms">Analyzing…</p>
          <div class="candidate-row demo-step" style="--step-delay:1200ms"><span class="candidate-active" lang="ja">学校</span><span lang="ja">行った</span></div>
          <div class="analyzer-result demo-step" style="--step-delay:2500ms"><div><strong lang="ja">学校</strong><span lang="ja">がっこう</span><span>school</span></div><div><small>Context</small><b lang="ja">学校に行った。</b></div></div>
          <span class="demo-action demo-step" style="--step-delay:3200ms">Add to Vocabulary</span>
        </div>
      </div>
    </section>`;
}

function vocabularyShowcase() {
  return `
    <section class="landing-section showcase-section" aria-labelledby="vocabulary-title" data-demo="vocabulary">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Vocabulary Auto-Fill</span><h2 id="vocabulary-title">Less typing. More intentional tracking.</h2><p>NippoTrack can suggest readings and dictionary meanings while leaving the final decision to you.</p></div>
        <div class="showcase-panel vocabulary-demo" aria-hidden="true">
          <div class="demo-window-bar"><span></span><span></span><span></span><b>New vocabulary</b></div>
          <label class="demo-field"><span>Word</span><strong class="typing-word" lang="ja">学校</strong></label>
          <p class="lookup-status demo-step" style="--step-delay:950ms">Looking up dictionary…</p>
          <div class="demo-fields">
            <label class="demo-field demo-step" style="--step-delay:1750ms"><span>Reading</span><strong lang="ja">がっこう</strong></label>
            <label class="demo-field demo-step" style="--step-delay:2200ms"><span>Meaning</span><strong>school</strong></label>
          </div>
          <div class="demo-provenance demo-step" style="--step-delay:2700ms"><span>JMdict</span><small>Dictionary suggestion · you decide what to keep</small></div>
          <p class="demo-ready demo-step" style="--step-delay:3100ms"><span aria-hidden="true">✓</span> Ready to add</p>
        </div>
      </div>
    </section>`;
}

function kanjiShowcase() {
  return `
    <section class="landing-section showcase-section showcase-demo-first" aria-labelledby="kanji-title" data-demo="kanji">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Kanji</span><h2 id="kanji-title">Keep kanji connected to what you're learning.</h2><p>See meanings, readings and study information together without separating kanji from the rest of your Japanese journey.</p></div>
        <div class="showcase-panel kanji-demo" aria-hidden="true">
          <div class="kanji-focus" lang="ja">殻</div>
          <dl class="kanji-details">
            <div class="demo-step" style="--step-delay:600ms"><dt>Meaning</dt><dd>shell · husk</dd></div>
            <div class="demo-step" style="--step-delay:1600ms"><dt>On'yomi</dt><dd lang="ja">カク</dd></div>
            <div class="demo-step" style="--step-delay:2200ms"><dt>Kun'yomi</dt><dd lang="ja">から</dd></div>
          </dl>
        </div>
      </div>
    </section>`;
}

function reviewShowcase() {
  return `
    <section class="landing-section showcase-section" aria-labelledby="review-title" data-demo="review">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Review</span><h2 id="review-title">Review what you've actually collected.</h2><p>Your review flow grows from your own vocabulary and study activity—not from a generic course.</p></div>
        <div class="showcase-panel review-demo" aria-hidden="true">
          <span class="demo-label">Your vocabulary · 18 due</span>
          <p class="review-word" lang="ja">学校</p>
          <span class="review-reveal">Reveal answer</span>
          <div class="review-answer demo-step" style="--step-delay:900ms"><strong lang="ja">がっこう</strong><span>school</span></div>
          <div class="review-rating demo-step" style="--step-delay:1500ms"><span>Again</span><span>Hard</span><span class="rating-good">Good</span></div>
        </div>
      </div>
    </section>`;
}

function progressShowcase() {
  return `
    <section class="landing-section progress-section" aria-labelledby="progress-title" data-demo="progress">
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
    <section class="landing-section showcase-section" aria-labelledby="onboarding-title" data-demo="onboarding">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Quick placement</span><h2 id="onboarding-title">Start from where you are.</h2><p>A short, optional placement can help NippoTrack tailor your starting experience.</p></div>
        <div class="showcase-panel onboarding-demo" aria-hidden="true">
          <div class="placement-card placement-welcome"><span class="demo-label">Welcome</span><h3>Want to estimate your starting point?</h3><p>About 2 minutes</p><span class="demo-action">Start quick placement</span><span class="placement-skip">Skip for now</span></div>
          <div class="placement-card placement-question demo-step" style="--step-delay:1200ms"><span class="demo-label">Quick placement · 3 of 5</span><p lang="ja">毎朝、新聞を＿＿。</p><div><span>読みます</span><span>読んだ</span></div></div>
          <div class="placement-card placement-result demo-step" style="--step-delay:2800ms"><span class="demo-label">Starting estimate</span><strong>N4 <small>range</small></strong><p>This is a starting estimate, not an official JLPT assessment.</p></div>
        </div>
      </div>
    </section>`;
}

function firstUseDashboard() {
  return `
    <section class="landing-section showcase-section showcase-demo-first" aria-labelledby="first-use-title" data-demo="first-use">
      <div class="landing-container showcase-grid">
        <div class="showcase-copy"><span class="landing-eyebrow">Your first steps</span><h2 id="first-use-title">Know what to do next.</h2><p>NippoTrack guides your first steps, then gradually gets out of the way as your own study data takes over.</p></div>
        <div class="showcase-panel first-use-demo" aria-hidden="true">
          <div class="first-use-heading demo-step" style="--step-delay:0ms"><div><span class="demo-label">Dashboard</span><h3>Welcome <span>👋</span></h3></div><p><small>Starting estimate</small><strong>N4 range</strong></p></div>
          <div class="first-steps demo-step" style="--step-delay:300ms"><h4>Your first steps</h4><ul><li class="is-complete"><span>✓</span> Complete your placement</li><li><span>○</span> Add your first vocabulary</li><li><span>○</span> Analyze your first Japanese sentence</li><li><span>○</span> Log your first study session</li></ul></div>
        </div>
      </div>
    </section>`;
}

function existingTools() {
  return `
    <section class="landing-section tools-section" aria-labelledby="tools-title">
      <div class="landing-container">
        <div class="tools-heading"><h2 id="tools-title">Keep the tools you already love.</h2><p>NippoTrack is the layer that helps you organize what comes out of them.</p></div>
        <ul class="tools-list" role="list"><li>Genki</li><li>Anki</li><li>Bunpro</li><li>YouTube</li><li>Anime</li><li>Manga</li><li>Classes</li><li>Your own notes</li></ul>
      </div>
    </section>`;
}

function emotionalMoment() {
  return `
    <section class="emotional-section" aria-labelledby="emotional-title">
      <div class="landing-container"><h2 id="emotional-title">Your Japanese journey is already yours.</h2><p>NippoTrack just helps you see it clearly.</p></div>
    </section>`;
}

function finalCta() {
  return `
    <section class="final-cta" id="final-cta" aria-labelledby="final-cta-title">
      <div class="landing-container"><h2 id="final-cta-title">Ready to bring your Japanese study together?</h2><div><a class="landing-button landing-button-primary" href="/app?auth=sign-up">Start with NippoTrack</a><a class="landing-text-link" href="/app?auth=sign-in">Already have an account? Log in</a></div></div>
    </section>`;
}

function footer(wordmarkUrl) {
  return `
    <footer class="landing-footer" id="faq">
      <div class="landing-container footer-grid">
        <div class="footer-brand"><img src="${wordmarkUrl}" alt="NippoTrack" width="260" height="88"></div>
        <div><h2>Product</h2><a href="#features">Features</a><a href="#how-it-works">How it works</a></div>
        <div><h2>Resources</h2><span>About the data</span><span>Third-party notices</span></div>
        <div><h2>Legal</h2><span>Privacy</span><span>Terms</span></div>
      </div>
      <div class="landing-container footer-bottom"><p>JMdict/EDRDG and KanjiVG data are used within NippoTrack. See third-party notices in the project distribution.</p><p>© 2026 NippoTrack</p></div>
    </footer>`;
}

export function createLandingMarkup(wordmarkUrl) {
  return `
    <a class="landing-skip-link" href="#landing-main">Skip to main content</a>
    <div class="landing-page">
      ${navbar(wordmarkUrl)}
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
        ${existingTools()}
        ${emotionalMoment()}
        ${finalCta()}
      </main>
      ${footer(wordmarkUrl)}
    </div>`;
}
