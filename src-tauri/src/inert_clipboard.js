// رفّ in a test run (ت٤٨): injected into every page before its own scripts.
// The Rust gate keeps رفّ's own code off the system clipboard; this keeps
// WebKit's native copy, cut and paste off it too.
(() => {
  const CLIPBOARD_KEYS = new Set(['KeyC', 'KeyX', 'KeyV']);
  // ⌘C, ⌘X and ⌘V by key position, so on any layout. The page still hears
  // them: رفّ's own ⌘C asks Rust, which answers that the clipboard is off.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.metaKey && !e.altKey && !e.ctrlKey && CLIPBOARD_KEYS.has(e.code)) e.preventDefault();
    },
    true
  );
  // Before any page listener can read the event's clipboard data.
  const refuse = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of ['copy', 'cut', 'paste']) window.addEventListener(type, refuse, true);
  // No native menu offering Copy and Paste; رفّ's own right-click still runs.
  window.addEventListener('contextmenu', (e) => e.preventDefault(), true);
})();
