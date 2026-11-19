// 在样式加载前就设好主题，避免打开时闪一下。默认暗色。
(function () {
  var theme = 'dark';
  try {
    theme = JSON.parse(localStorage.getItem('lh.settings') || '{}').theme || 'dark';
  } catch (e) {
    /* ignore */
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
