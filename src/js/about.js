// The «عن رفّ» window — Figma «07 — Product UI» About 270:596.
//
// Everything on this window is static except three things: the compact version
// label (read from the running app), the repository control (the URL
// lives in Rust — nothing but the command name crosses IPC), and the update
// check, which reports its outcome as one Arabic line under the button. The
// full download/install/restart cycle is deliberately NOT reimplemented here;
// that lives in the update window (js/update-flow.js).

import { api } from './store.js';
import { arabicDigits } from './logic.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

const el = (id) => document.getElementById(id);
const shellEl = el('about');
const versionEl = el('app-version');
const statusEl = el('update-status');
const updateBtn = el('update-btn');

// The outcome is always one of these three short lines. A raw message from the
// updater is never rendered: it can be long enough to upset the designed
// vertical rhythm, and it is not written in Arabic. Same rule as the panel's
// failure view.
const CHECKING = 'جارٍ التحقق…';
const UP_TO_DATE = 'أنت على أحدث إصدار من رفّ.';
const CHECK_FAILED = 'تعذّر التحقق من التحديث.';

// ─── Window chrome ────────────────────────────────────────────────────────

function closeWindow() {
  // Outside Tauri (design review in a browser) there is no native window.
  window.__TAURI__?.window.getCurrentWindow().close();
}

el('about-close').addEventListener('click', closeWindow);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeWindow();
});

// ─── Version (2:8070) ─────────────────────────────────────────────────────

async function loadVersion() {
  try {
    const state = await api.getState();
    const version = state?.version;
    if (!version) return; // no version, no line — never a fake number
    versionEl.textContent = `الإصدار \u2066${version}\u2069`;
  } catch {
    // A version we could not read is simply not shown.
  }
}

// ─── Repository (7:1610) ──────────────────────────────────────────────────

el('repo-link').addEventListener('click', (e) => {
  e.preventDefault();
  api.openRepository().catch(() => {});
});

el('privacy-link').addEventListener('click', () => {
  api.openPrivacyPolicy().catch(() => {});
});

el('report-btn').addEventListener('click', () => {
  api.openReport().catch(() => {});
});

// ─── Update check — Actions-Bottom (2:8072) ───────────────────────────────

// The line stays rendered (its room is reserved): a live region unhidden and
// filled in the same tick is often missed by VoiceOver.
function setStatus(text) {
  statusEl.textContent = text;
  shellEl.classList.toggle('has-status', Boolean(text));
}

let checking = false;

updateBtn.addEventListener('click', async () => {
  if (checking) return;
  checking = true;
  updateBtn.disabled = true;
  setStatus(CHECKING);
  try {
    const result = await api.checkForUpdate();
    if (result?.status === 'available' && result.version) {
      setStatus(`يتوفّر إصدار جديد: ${arabicDigits(result.version)}`);
      api.openUpdates?.().catch(() => {});
    } else if (result?.status === 'upToDate') {
      setStatus(UP_TO_DATE);
    } else {
      setStatus(CHECK_FAILED);
    }
  } catch {
    setStatus(CHECK_FAILED);
  } finally {
    checking = false;
    updateBtn.disabled = false;
  }
});

loadVersion();
