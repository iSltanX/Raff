// Settings window: reads the store, writes back full Settings objects.
//
// View structure follows Figma «08 — Product Screens», screen ٥ (2:7983):
// one scrolling body of titled groups, every row built the same way — the
// control on the left, the Arabic label on the right — closed by the window's
// two actions. The window has no tabs.

import { api, on } from './store.js';
import { arabicDigits, metaLine, hotkeyDisplay, hotkeyFromEvent } from './logic.js';
import { CLEAR } from './icons.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

let settings = null;

const el = (id) => document.getElementById(id);
const hotkeyChip = el('hotkey-chip');
const hotkeySub = el('hotkey-sub');

/** The resting sub-line under the hotkey row; also what a flashed error
 *  reverts to once it clears. */
const HOTKEY_HINT = 'انقر على الاختصار ثم اضغط التركيبة الجديدة';

// ─── Window actions ───────────────────────────────────────────────────────
// The red traffic light and «تم» both close the window. Settings are saved as
// they change, so closing is never a commit point — there is nothing to lose.

function closeWindow() {
  const nativeWindow = window.__TAURI__?.window;
  if (!nativeWindow) return; // outside Tauri (design review) there is no window
  nativeWindow
    .getCurrentWindow()
    .close()
    .catch((err) => console.error('raff: closing the settings window failed', err));
}

el('window-close').addEventListener('click', closeWindow);
el('done-btn').addEventListener('click', closeWindow);
el('open-about').addEventListener('click', () => api.openAbout());

// ─── Load / sync ──────────────────────────────────────────────────────────

async function load() {
  const state = await api.getState();
  settings = state.settings;

  hotkeyChip.textContent = hotkeyDisplay(settings.hotkey);
  hotkeySub.textContent = HOTKEY_HINT;
  setChecked('launch-toggle', settings.launchAtLogin);
  setChecked('capture-toggle', settings.captureEnabled);
  setChecked('concealed-toggle', settings.respectConcealed);
  setChecked('learning-toggle', settings.learningEnabled);
  el('history-limit').value = String(settings.historyLimit);
  renderAppearance();
  renderExcluded();
}

/** Switches and the checkbox are ARIA-driven: aria-checked is the state, and
 *  the stylesheet draws from it. */
function setChecked(id, value) {
  el(id).setAttribute('aria-checked', String(Boolean(value)));
}

async function save(patch) {
  // update_settings takes a COMPLETE Settings object — a partial patch would
  // drop every field it omits.
  const next = { ...settings, ...patch };
  let failure = null;
  try {
    await api.updateSettings(next);
    settings = next;
  } catch (err) {
    console.error(err);
    failure = err;
  }
  await load(); // re-sync (reverts the UI when the backend refused the change)
  if (failure && 'hotkey' in patch) flashHotkeyError(String(failure));
}

// Surfaces the backend's Arabic error (e.g. «اختصار غير صالح») instead of
// silently reverting the badge.
let hotkeyErrorTimer = null;
function flashHotkeyError(message) {
  hotkeySub.textContent = message;
  hotkeySub.classList.add('error');
  clearTimeout(hotkeyErrorTimer);
  hotkeyErrorTimer = setTimeout(() => {
    hotkeySub.classList.remove('error');
    load();
  }, 4000);
}

// ─── Switches, checkbox, pop-up button ────────────────────────────────────

el('launch-toggle').addEventListener('click', () => save({ launchAtLogin: !settings.launchAtLogin }));
el('capture-toggle').addEventListener('click', () => save({ captureEnabled: !settings.captureEnabled }));
el('concealed-toggle').addEventListener('click', () => save({ respectConcealed: !settings.respectConcealed }));
el('learning-toggle').addEventListener('click', () => save({ learningEnabled: !settings.learningEnabled }));
el('history-limit').addEventListener('change', (e) => save({ historyLimit: Number(e.target.value) }));

// ─── المظهر — Segments-Container (2:8018) ─────────────────────────────────
// Three tabs over two settings: «تلقائي» is followSystem, the other two are an
// explicit appearance with followSystem off.

const appearanceTabs = document.querySelectorAll('#appearance-segments .seg-tab');

function renderAppearance() {
  const active = settings.followSystem ? 'auto' : settings.appearance;
  for (const tab of appearanceTabs) {
    const on = tab.dataset.appearance === active;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-checked', String(on));
  }
}

for (const tab of appearanceTabs) {
  tab.addEventListener('click', () => {
    const choice = tab.dataset.appearance;
    save(choice === 'auto' ? { followSystem: true } : { followSystem: false, appearance: choice });
  });
}

// ─── Hotkey recorder — Hotkey-Badge (2:8030) ──────────────────────────────

let recording = false;

hotkeyChip.addEventListener('click', () => {
  recording = true;
  hotkeyChip.classList.add('recording');
  hotkeyChip.textContent = 'اضغط الاختصار…';
});

window.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopRecording();
      return;
    }
    const accel = hotkeyFromEvent(e);
    if (!accel) return; // modifier-only press — keep waiting
    stopRecording();
    save({ hotkey: accel });
  },
  true
);

function stopRecording() {
  recording = false;
  hotkeyChip.classList.remove('recording');
  hotkeyChip.textContent = hotkeyDisplay(settings.hotkey);
}

// ─── Excluded apps (الالتقاط) ─────────────────────────────────────────────

const manageExcludedBtn = el('manage-excluded');

manageExcludedBtn.addEventListener('click', async () => {
  const manager = el('excluded-manager');
  manager.hidden = !manager.hidden;
  manageExcludedBtn.setAttribute('aria-expanded', String(!manager.hidden));
  if (!manager.hidden) await populateRunningApps();
});

function renderExcluded() {
  const list = el('excluded-list');
  list.replaceChildren();
  for (const bundleId of settings.excludedApps) {
    const li = document.createElement('li');
    li.className = 'excluded-item';
    const bundle = document.createElement('span');
    bundle.className = 'bundle';
    bundle.textContent = bundleId; // app-supplied string → textContent
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-excluded';
    remove.innerHTML = CLEAR; // static SVG constant
    remove.title = 'إزالة';
    remove.setAttribute('aria-label', `إزالة ${bundleId}`);
    remove.addEventListener('click', () =>
      save({ excludedApps: settings.excludedApps.filter((b) => b !== bundleId) })
    );
    li.append(bundle, remove);
    list.append(li);
  }
}

async function populateRunningApps() {
  const select = el('running-apps');
  select.replaceChildren();
  const apps = await api.listRunningApps();
  for (const app of apps) {
    if (settings.excludedApps.includes(app.bundleId)) continue;
    const option = document.createElement('option');
    option.value = app.bundleId;
    option.textContent = app.name; // app-supplied string → textContent
    select.append(option);
  }
}

el('add-excluded').addEventListener('click', async () => {
  const bundleId = el('running-apps').value;
  if (!bundleId || settings.excludedApps.includes(bundleId)) return;
  await save({ excludedApps: [...settings.excludedApps, bundleId] });
  await populateRunningApps();
});

// ─── Two-step destructive buttons ─────────────────────────────────────────

function confirmButton(id, action) {
  const button = el(id);
  let armed = false;
  let timer = null;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = button.dataset.confirm;
      timer = setTimeout(() => {
        armed = false;
        button.textContent = button.dataset.label;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    button.textContent = button.dataset.label;
    await action();
  });
}

confirmButton('clear-learning', async () => {
  await api.clearLearning();
  if (!el('learning-view').hidden) renderLearning();
});

// ─── Confirmation dialog ──────────────────────────────────────────────────
// Wiped clipboard content is unrecoverable, so «مسح سجل الحافظة» gets an
// explicit dialog that names the consequence — not the two-tap arming above,
// which is fine for the reversible-in-practice learning signals but too easy
// to trigger by accident for permanent deletion.

const confirmOverlay = el('confirm-overlay');
const confirmCancel = el('confirm-cancel');
const confirmAccept = el('confirm-accept');

let settleConfirm = null;

/** Opens the modal and resolves true only when the user confirms. */
function askConfirm() {
  if (settleConfirm) return Promise.resolve(false); // already open
  return new Promise((resolve) => {
    const restoreFocus = document.activeElement;
    settleConfirm = (result) => {
      settleConfirm = null;
      confirmOverlay.hidden = true;
      document.removeEventListener('keydown', onKeydown, true);
      restoreFocus?.focus?.();
      resolve(result);
    };
    document.addEventListener('keydown', onKeydown, true);
    confirmOverlay.hidden = false;
    // Cancel is focused first: the destructive button must never be the
    // default target of a stray Return.
    confirmCancel.focus();
  });
}

// Escape cancels; Tab cycles between the two buttons so focus cannot reach
// the settings behind the overlay while it is open.
function onKeydown(e) {
  if (!settleConfirm) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    settleConfirm(false);
    return;
  }
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const next = document.activeElement === confirmCancel ? confirmAccept : confirmCancel;
  next.focus();
}

confirmCancel.addEventListener('click', () => settleConfirm?.(false));
confirmAccept.addEventListener('click', () => settleConfirm?.(true));
// A click on the backdrop (never on the dialog itself) cancels.
confirmOverlay.addEventListener('mousedown', (e) => {
  if (e.target === confirmOverlay) settleConfirm?.(false);
});

// ─── «مسح سجل الحافظة» — Bottom-Row (2:8042), left ────────────────────────

const dataStatus = el('data-status');
let dataStatusTimer = null;

function showDataStatus(message) {
  dataStatus.textContent = message;
  dataStatus.hidden = false;
  clearTimeout(dataStatusTimer);
  dataStatusTimer = setTimeout(() => {
    dataStatus.hidden = true;
  }, 4000);
}

el('clear-history').addEventListener('click', async () => {
  if (!(await askConfirm())) return;
  await api.clearHistory();
  // The learning summary is drawn from the same items, so a visible one would
  // otherwise keep showing rows that no longer exist.
  if (!el('learning-view').hidden) await renderLearning();
  showDataStatus('تم مسح سجل الحافظة.');
});

// ─── «ما تعلّمه رفّ حتى الآن» ─────────────────────────────────────────────

const showLearningBtn = el('show-learning');

showLearningBtn.addEventListener('click', async () => {
  const view = el('learning-view');
  view.hidden = !view.hidden;
  showLearningBtn.setAttribute('aria-expanded', String(!view.hidden));
  showLearningBtn.textContent = view.hidden ? 'عرض' : 'إخفاء';
  if (!view.hidden) await renderLearning();
});

async function renderLearning() {
  const view = el('learning-view');
  const items = await api.learningSummary();
  view.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'learning-empty';
    empty.textContent = 'لا إشارات كافية بعد — استخدم رفّ لبضعة أيام';
    view.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'learn-row';
    const text = document.createElement('span');
    text.className = 'learn-text';
    text.dir = 'auto';
    text.textContent = item.text; // clip content → textContent
    const counts = document.createElement('span');
    counts.className = 'learn-counts';
    counts.textContent = `نسخ ${arabicDigits(item.copyCount)} • لصق ${arabicDigits(item.pasteCount)} • ${metaLine({ createdAt: item.lastUsedAt, sourceApp: '' })}`;
    row.append(text, counts);
    view.append(row);
  }
}

on('raff://changed', () => load().catch(console.error));

// ─── Controlled relaunch notice ───────────────────────────────────────────
// The backend announces it right before quitting-and-relaunching to apply a
// new app icon. The overlay also blocks further clicks during the short
// grace period, so no second change can race the relaunch.

on('raff://relaunching', showRelaunchNotice);

function showRelaunchNotice() {
  if (document.getElementById('relaunch-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'relaunch-overlay';
  overlay.className = 'relaunch-overlay';
  const message = document.createElement('div');
  message.className = 'relaunch-message';
  message.textContent = 'سيُعاد تشغيل رفّ لتطبيق التغيير.';
  overlay.append(message);
  document.body.append(overlay);
}

// First load: retry briefly (IPC can lag right after window creation) so a
// transient failure never leaves the window showing default values.
(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await load();
      return;
    } catch (err) {
      if (attempt === 2) console.error('raff: settings load failed', err);
      else await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
})();
