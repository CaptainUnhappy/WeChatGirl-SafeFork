// Apply the theme before styles and the first paint, including native controls.
(() => {
  let stored,style;
  try { stored = localStorage.getItem('wechatagent-console-theme'); style=localStorage.getItem('wechatgirl-console-ui'); } catch {}
  const theme = window.desktop?.initialTheme ?? (['light','dark'].includes(stored) ? stored : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.uiMode=['tech','aurora','simple'].includes(style)?style:'tech';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
