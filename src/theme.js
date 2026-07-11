// Applied before the stylesheet parses to prevent theme flash.
// The media query reflects the window's effective appearance: the system
// theme, or the explicit نهاري/ليلي override the backend sets natively.
(function () {
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var apply = function () {
    document.documentElement.dataset.appearance = mq.matches ? 'dark' : 'light';
  };
  apply();
  mq.addEventListener('change', apply);
  // Hidden windows (the panel) can miss change events — repaint on focus.
  window.addEventListener('focus', apply);
})();
