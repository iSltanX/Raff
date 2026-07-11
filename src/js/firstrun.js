// First-run permission screen: opens the Accessibility pane, then watches for
// the permission and closes itself once granted.

import { api } from './store.js';
import { ACCESSIBILITY_ICON, SHIELD_ICON } from './icons.js';

document.getElementById('figure').innerHTML = ACCESSIBILITY_ICON;
document.getElementById('shield').innerHTML = SHIELD_ICON;

let watcher = null;

document.getElementById('open-settings').addEventListener('click', async () => {
  await api.requestAccessibility(); // registers Raff in the list + system prompt
  await api.openAccessibilitySettings();
  if (!watcher) watcher = setInterval(checkGranted, 1500);
});

document.getElementById('later').addEventListener('click', () => api.firstrunDone());

async function checkGranted() {
  if (await api.axStatus()) {
    clearInterval(watcher);
    document.getElementById('granted').hidden = false;
    setTimeout(() => api.firstrunDone(), 1200);
  }
}
