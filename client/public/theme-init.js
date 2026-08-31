(() => {
  const theme = localStorage.getItem('jlt-theme') || 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#202428' : '#eef1f7'
  );
})();
