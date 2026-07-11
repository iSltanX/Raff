// Applied before the stylesheet parses to prevent theme flash.
(function () {
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var apply = function () {
    document.documentElement.dataset.appearance = mq.matches ? 'dark' : 'light';
  };
  apply();
  mq.addEventListener('change', apply);
})();
