// Standalone update window: no tabs, no settings — just the update cycle.
// All state/API logic lives in the shared `update-flow.js` module (also used
// by the Settings «حول» tab); this file only owns this window's rendering
// and the tray menu's consume-once intent.

import { api, on } from './store.js';
import { arabicDigits } from './logic.js';
import { createUpdateFlow } from './update-flow.js';

const el = (id) => document.getElementById(id);
const statusEl = el('u-status');
const availableEl = el('u-available');
const newVersionEl = el('u-new-version');
const dateEl = el('u-date');
const notesEl = el('u-notes');
const progressEl = el('u-progress');
const barEl = el('u-bar');
const barFillEl = el('u-bar-fill');
const okBtn = el('u-ok');
const downloadBtn = el('u-download');
const restartBtn = el('u-restart');
const retryBtn = el('u-retry');

let lastErrorFrom = 'check';

// ─── Window sizing ─────────────────────────────────────────────────────────
// Two fixed heights, never a continuous per-pixel resize: the "compact" tier
// (checking/uptodate/installed/error — no version box) fits Rust's initial
// 280px build size exactly, so opening the window never jumps. "Expanded"
// only kicks in for available/downloading/installing, where the version +
// notes box actually need the room (measured up to ~415px with a maxed-out,
// internally-scrolling notes box). A resize only fires when the tier
// actually changes, so a run through available→downloading→installing is
// one single grow, not a resize per state.
const COMPACT_HEIGHT = 280;
const EXPANDED_HEIGHT = 430;
const EXPANDED_STATES = new Set(['available', 'downloading', 'installing']);
let currentTier = 'compact'; // matches the window's built size — see commands.rs

function resizeForState(state) {
  const tier = EXPANDED_STATES.has(state) ? 'expanded' : 'compact';
  if (tier === currentTier) return;
  currentTier = tier;
  const tauriWindow = window.__TAURI__?.window;
  const dpi = window.__TAURI__?.dpi;
  if (!tauriWindow || !dpi) return; // browser mock — no native window to resize
  const height = tier === 'expanded' ? EXPANDED_HEIGHT : COMPACT_HEIGHT;
  tauriWindow
    .getCurrentWindow()
    .setSize(new dpi.LogicalSize(360, height))
    .catch((err) => console.error('raff: update window resize failed', err));
}

function setProgress(percent) {
  if (percent == null) {
    barEl.classList.add('indeterminate');
    barFillEl.style.width = '';
  } else {
    barEl.classList.remove('indeterminate');
    barFillEl.style.width = `${percent}%`;
  }
}

function render(state, data = {}) {
  resizeForState(state);
  availableEl.hidden = true;
  progressEl.hidden = true;
  barEl.classList.remove('indeterminate');
  okBtn.hidden = true;
  downloadBtn.hidden = true;
  restartBtn.hidden = true;
  retryBtn.hidden = true;
  statusEl.classList.remove('error');

  switch (state) {
    case 'checking':
      statusEl.textContent = 'جارٍ التحقق من وجود تحديثات…';
      break;

    case 'uptodate':
      statusEl.textContent = data.currentVersion
        ? `لا توجد تحديثات — الإصدار الحالي ${arabicDigits(data.currentVersion)}`
        : 'لا توجد تحديثات';
      okBtn.hidden = false;
      break;

    case 'available':
      statusEl.textContent = '';
      availableEl.hidden = false;
      newVersionEl.textContent = `الإصدار الجديد ${arabicDigits(data.version)}`;
      dateEl.hidden = !data.date;
      if (data.date) dateEl.textContent = `تاريخ النشر: ${arabicDigits(data.date)}`;
      notesEl.hidden = !data.notes;
      notesEl.textContent = data.notes || ''; // textContent → untrusted-safe
      downloadBtn.hidden = false;
      break;

    case 'downloading':
      availableEl.hidden = false; // keep the version context visible
      progressEl.hidden = false;
      setProgress(data.percent ?? null);
      statusEl.textContent = 'جارٍ تنزيل التحديث…';
      break;

    case 'installing':
      availableEl.hidden = false;
      progressEl.hidden = false;
      barEl.classList.add('indeterminate'); // install has no byte progress
      statusEl.textContent = 'جارٍ تثبيت التحديث…';
      break;

    case 'installed':
      statusEl.textContent = 'اكتمل التثبيت';
      restartBtn.hidden = false;
      break;

    case 'error':
      statusEl.classList.add('error');
      statusEl.textContent = data.message || 'حدث خطأ';
      lastErrorFrom = data.from || 'check';
      if (lastErrorFrom === 'restart') {
        // The appropriate retry for a failed restart is the restart button
        // itself — the update is still staged, Rust just refused/failed it.
        restartBtn.hidden = false;
      } else {
        if (lastErrorFrom === 'download') availableEl.hidden = false; // keep version visible while retrying
        retryBtn.hidden = false;
      }
      break;

    default:
      statusEl.textContent = 'جارٍ التحقق من وجود تحديثات…';
  }
}

const flow = createUpdateFlow({ onChange: render });

okBtn.addEventListener('click', () => window.__TAURI__?.window.getCurrentWindow().close());
downloadBtn.addEventListener('click', () => flow.download());
restartBtn.addEventListener('click', () => flow.restart());
retryBtn.addEventListener('click', () => {
  if (lastErrorFrom === 'download') flow.download();
  else flow.check();
});

// ─── Menu entry point «التحقق من وجود تحديثات…» ─────────────────────────────
// The tray item opens/focuses this window (never Settings) and asks it to run
// the shared manual-check flow. The Rust intent flag is claimed by whichever
// path arrives first for a given menu click — this on-load poll (freshly
// created window) or the event below (already-open window) — so the request
// is never lost and the check never runs twice. If an operation is already
// running, or an update is staged awaiting restart, the current state is
// simply left on screen instead of starting a new check.
async function claimMenuIntent() {
  try {
    if (await api.consumeUpdateIntent()) flow.checkIfIdle();
  } catch (err) {
    console.error('raff: update-intent claim failed', err);
  }
}
on('raff://open-updates', claimMenuIntent);
claimMenuIntent();
