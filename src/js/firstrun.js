// First-run permission screen: opens the Accessibility pane, then watches for
// the permission and closes itself once granted.

import { api } from './store.js';
import { KEYBOARD, CHECK } from './icons.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Static, author-controlled SVG constants — safe as innerHTML.
document.getElementById('figure').innerHTML = KEYBOARD;
document.getElementById('shield').innerHTML = CHECK;

// Watch from the start: the user may grant the permission directly in System
// Settings without ever pressing the button below.
let watcher = setInterval(checkGranted, 1500);

document.getElementById('open-settings').addEventListener('click', async () => {
  await api.requestAccessibility(); // registers Raff in the list + system prompt
  await api.openAccessibilitySettings();
  if (!watcher) watcher = setInterval(checkGranted, 1500);
});

document.getElementById('later').addEventListener('click', () => api.firstrunDone());

async function checkGranted() {
  if (await api.axStatus()) {
    clearInterval(watcher);
    watcher = null;
    document.getElementById('granted').hidden = false;
    setTimeout(() => api.firstrunDone(), 1200);
  }
}
