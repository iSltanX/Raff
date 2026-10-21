// Standalone update window: no tabs, no settings — just the update cycle.
// All state/API logic lives in the shared `update-flow.js` module (also used
// by the Settings «حول» tab); this file only owns this window's rendering
// and the tray menu's consume-once intent.

import { api, on } from './store.js';
import { arabicDigits } from './logic.js';
import { createUpdateFlow } from './update-flow.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

const el = (id) => document.getElementById(id);
const updateWindowEl = el('update-window');
const statusEl = el('u-status');
const subEl = el('u-sub');
const availableEl = el('u-available');
const newVersionEl = el('u-new-version');
const dateEl = el('u-date');
const notesEl = el('u-notes');
const progressEl = el('u-progress');
const barEl = el('u-bar');
const barFillEl = el('u-bar-fill');
const okBtn = el('u-ok');
const laterBtn = el('u-later');
const downloadBtn = el('u-download');
const restartBtn = el('u-restart');
const retryBtn = el('u-retry');

let lastErrorFrom = 'check';
const CHECKING_SUB = 'يتصل رفّ بإصدارات المستودع فقط.';

// ─── Window sizing ─────────────────────────────────────────────────────────
// Two fixed heights, never a continuous per-pixel resize: the "compact" tier
// (checking/uptodate/installed — no version box) fits Rust's initial
// 280px build size exactly, so opening the window never jumps. "Expanded"
// kicks in whenever the version/notes region is present. This includes a
// download/install error: that state deliberately keeps the release context
// visible above its error and retry action, so shrinking it back to 280px
// would clip the bottom controls. A failed check or restart has no version
// box — one line and a button — and stays compact. A resize only fires when
// the tier actually changes, so available→downloading→error remains one
// single grow.
const COMPACT_HEIGHT = 280;
const EXPANDED_HEIGHT = 430;
const EXPANDED_STATES = new Set(['available', 'downloading', 'installing']);
let currentTier = 'compact'; // matches the window's built size — see commands.rs

function resizeForState(state, data) {
  const showsRelease = EXPANDED_STATES.has(state) || (state === 'error' && data.from === 'download');
  const tier = showsRelease ? 'expanded' : 'compact';
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
    barEl.removeAttribute('aria-valuenow');
    barEl.setAttribute('aria-valuetext', 'جارٍ التقدّم…');
  } else {
    const numeric = Number(percent);
    if (!Number.isFinite(numeric)) {
      setProgress(null);
      return;
    }
    const normalized = Math.max(0, Math.min(100, numeric));
    barEl.classList.remove('indeterminate');
    barFillEl.style.width = `${normalized}%`;
    barEl.setAttribute('aria-valuenow', String(normalized));
    barEl.setAttribute('aria-valuetext', `${arabicDigits(normalized)}٪`);
  }
}

function render(state, data = {}) {
  resizeForState(state, data);
  updateWindowEl.setAttribute(
    'aria-busy',
    String(state === 'checking' || state === 'downloading' || state === 'installing')
  );
  availableEl.hidden = true;
  progressEl.hidden = true;
  barEl.classList.remove('indeterminate');
  barEl.removeAttribute('aria-valuenow');
  barEl.removeAttribute('aria-valuetext');
  okBtn.hidden = true;
  laterBtn.hidden = true;
  subEl.textContent = '';
  downloadBtn.hidden = true;
  restartBtn.hidden = true;
  retryBtn.hidden = true;
  statusEl.classList.remove('error');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  switch (state) {
    case 'checking':
      statusEl.textContent = 'جارٍ التحقق من وجود تحديثات…';
      subEl.textContent = CHECKING_SUB;
      break;

    case 'uptodate':
      statusEl.textContent = data.currentVersion
        ? `لا توجد تحديثات — الإصدار الحالي ${arabicDigits(data.currentVersion)}`
        : 'لا توجد تحديثات';
      okBtn.hidden = false;
      break;

    case 'available':
      statusEl.textContent = 'إصدار جديد متاح';
      subEl.textContent = 'الحزمة موقّعة، ويرفض رفّ ما لا يطابق توقيعه.';
      availableEl.hidden = false;
      newVersionEl.textContent = `الإصدار ${arabicDigits(data.version)}`;
      dateEl.hidden = !data.date;
      if (data.date) dateEl.textContent = `تاريخ النشر: ${arabicDigits(data.date)}`;
      notesEl.hidden = !data.notes;
      notesEl.textContent = data.notes || ''; // textContent → untrusted-safe
      downloadBtn.hidden = false;
      laterBtn.hidden = false;
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
      setProgress(null); // install has no byte progress
      statusEl.textContent = 'جارٍ تثبيت التحديث…';
      break;

    case 'installed':
      statusEl.textContent = 'اكتمل التثبيت';
      subEl.textContent = 'أعد تشغيل رفّ لإكمال التثبيت. لا يُفقد شيء من سجلّك.';
      restartBtn.hidden = false;
      laterBtn.hidden = false;
      break;

    case 'error':
      statusEl.classList.add('error');
      statusEl.setAttribute('role', 'alert');
      statusEl.setAttribute('aria-live', 'assertive');
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
      subEl.textContent = CHECKING_SUB;
  }
}

const flow = createUpdateFlow({ onChange: render });

const closeWindow = () => window.__TAURI__?.window.getCurrentWindow().close();
okBtn.addEventListener('click', closeWindow);
laterBtn.addEventListener('click', closeWindow);
// Escape leaves as the buttons do. Closing only hides this window (main.rs),
// so a download or a staged restart is still there when it is reopened.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  e.preventDefault();
  closeWindow();
});
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
