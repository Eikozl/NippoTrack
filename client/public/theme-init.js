(() => {
  const theme = localStorage.getItem('jlt-theme') || 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#202428' : '#eef1f7'
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
