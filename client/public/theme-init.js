(() => {
  // Canonical app theme (pre-paint): stored `nippotrack-theme` (light|dark)
  // wins; else stored legacy `jlt-theme` is accepted AND migrated forward to
  // the canonical key (legacy left intact); else OS prefers-color-scheme;
  // else light. Arbitrary strings are rejected at every step.
  const allowed = (value) => value === 'light' || value === 'dark';
  let theme = 'light';
  try {
    const canonical = localStorage.getItem('nippotrack-theme');
    const legacy = localStorage.getItem('jlt-theme');
    if (allowed(canonical)) {
      theme = canonical;
    } else if (allowed(legacy)) {
      theme = legacy;
      try {
        localStorage.setItem('nippotrack-theme', legacy);
      } catch {
        // Migration is best-effort; the resolved theme above still applies.
      }
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
  } catch {
    theme = 'light';
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#1C1A18' : '#F5F0E8'
  );
  // NippoTrack landing theme (pre-paint): stored `nippotrack-theme`
  // allowlisted to light|dark, else OS preference, else light.
  try {
    const stored = localStorage.getItem('nippotrack-theme');
    const landingTheme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.dataset.nippotrackTheme = landingTheme;
    document.documentElement.style.colorScheme = landingTheme;
  } catch {
    // Landing theme is progressive enhancement; app jlt-theme above stands.
  }
})();
