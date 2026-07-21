// Settings window: reads the store, writes back full Settings objects.

import { api, on } from './store.js';
import { arabicDigits, metaLine, hotkeyDisplay, hotkeyFromEvent } from './logic.js';
import { SUN_ICON, MOON_ICON } from './icons.js';
import { createUpdateFlow } from './update-flow.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

let settings = null;

const el = (id) => document.getElementById(id);
const hotkeyChip = el('hotkey-chip');
const hotkeySub = el('hotkey-sub');

// ─── Tabs ─────────────────────────────────────────────────────────────────

function activateTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document
    .querySelectorAll('.tab-panel')
    .forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

el('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  activateTab(tab.dataset.tab);
});

// ─── Load / sync ──────────────────────────────────────────────────────────

async function load() {
  const state = await api.getState();
  settings = state.settings;

  const display = hotkeyDisplay(settings.hotkey);
  hotkeyChip.textContent = display;
  // LRI/PDI isolate the shortcut so RTL text doesn't reorder its symbols.
  hotkeySub.textContent = `⁦${display}⁩ — يمكن تغييره`;
  setToggle('launch-toggle', settings.launchAtLogin);
  setToggle('concealed-toggle', settings.respectConcealed);
  setToggle('learning-toggle', settings.learningEnabled);
  el('history-limit').value = String(settings.historyLimit);
  el('about-version').textContent = `الإصدار ${arabicDigits(state.version)}`;
  renderAppearance();
  renderAppIcon();
  renderExcluded();
}

function setToggle(id, value) {
  el(id).setAttribute('aria-checked', String(Boolean(value)));
}

async function save(patch) {
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
// silently reverting the chip.
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

// ─── Toggles / select ─────────────────────────────────────────────────────

el('launch-toggle').addEventListener('click', () => save({ launchAtLogin: !settings.launchAtLogin }));
el('concealed-toggle').addEventListener('click', () => save({ respectConcealed: !settings.respectConcealed }));
el('learning-toggle').addEventListener('click', () => save({ learningEnabled: !settings.learningEnabled }));
el('history-limit').addEventListener('change', (e) => save({ historyLimit: Number(e.target.value) }));

// ─── Appearance (المظهر) ──────────────────────────────────────────────────

document.getElementById('icon-light').innerHTML = SUN_ICON; // static SVG constant
document.getElementById('icon-dark').innerHTML = MOON_ICON; // static SVG constant

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/** The appearance currently in effect (explicit choice, or the system's). */
function effectiveAppearance() {
  return settings.followSystem ? (systemDark.matches ? 'dark' : 'light') : settings.appearance;
}

function renderAppearance() {
  const effective = effectiveAppearance();
  document.querySelectorAll('.appearance-card').forEach((card) => {
    const selected = card.dataset.appearance === effective;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-checked', String(selected));
  });
  setToggle('follow-system-toggle', settings.followSystem);
}

document.querySelectorAll('.appearance-card').forEach((card) => {
  card.addEventListener('click', () =>
    save({ appearance: card.dataset.appearance, followSystem: false })
  );
});

// ─── App icon (أيقونة التطبيق) — independent from the theme ───────────────

function renderAppIcon() {
  document.querySelectorAll('.icon-card').forEach((card) => {
    const selected = card.dataset.appIcon === settings.appIcon;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-checked', String(selected));
  });
}

document.querySelectorAll('.icon-card').forEach((card) => {
  card.addEventListener('click', () => save({ appIcon: card.dataset.appIcon }));
});

el('follow-system-toggle').addEventListener('click', () => {
  if (settings.followSystem) {
    // Turning follow-off keeps what is on screen right now.
    save({ followSystem: false, appearance: effectiveAppearance() });
  } else {
    save({ followSystem: true });
  }
});

// While following the system, the selected card tracks macOS live.
systemDark.addEventListener('change', () => {
  if (settings?.followSystem) renderAppearance();
});

// ─── Hotkey recorder ──────────────────────────────────────────────────────

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

// ─── Excluded apps ────────────────────────────────────────────────────────

el('manage-excluded').addEventListener('click', async () => {
  const manager = el('excluded-manager');
  manager.hidden = !manager.hidden;
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
    bundle.textContent = bundleId;
    const remove = document.createElement('button');
    remove.className = 'remove-excluded';
    remove.textContent = '✕';
    remove.title = 'إزالة';
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
    option.textContent = app.name;
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

// ─── «مسح سجل الحافظة» ────────────────────────────────────────────────────

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

// ─── "عرض ما تعلّمه رفّ" ─────────────────────────────────────────────────

el('show-learning').addEventListener('click', async () => {
  const view = el('learning-view');
  view.hidden = !view.hidden;
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

// ─── Updates (تبويب «حول») ────────────────────────────────────────────────
// The manual check/download/restart flow is the shared `update-flow.js`
// module (also used by the standalone update window) — this file only owns
// the About-tab-specific rendering. The tray's «التحقق من وجود تحديثات…» no
// longer targets this window at all (it opens its own small update window),
// so there is no menu-intent handling here.

const updateCheckBtn = el('update-check');
const updateAvailable = el('update-available');
const updateNewVersion = el('update-new-version');
const updateDate = el('update-date');
const updateNotes = el('update-notes');
const updateDownloadBtn = el('update-download');
const updateProgress = el('update-progress');
const updateBar = el('update-bar');
const updateBarFill = el('update-bar-fill');
const updateRestartBtn = el('update-restart');
const updateStatus = el('update-status');

function setProgress(percent) {
  if (percent == null) {
    updateBar.classList.add('indeterminate');
    updateBarFill.style.width = '';
  } else {
    updateBar.classList.remove('indeterminate');
    updateBarFill.style.width = `${percent}%`;
  }
}

function renderUpdate(state, data = {}) {
  // Safe defaults; each state overrides only what it needs.
  updateCheckBtn.hidden = false;
  updateCheckBtn.disabled = false;
  updateAvailable.hidden = true;
  updateDownloadBtn.hidden = false;
  updateDownloadBtn.disabled = false;
  updateProgress.hidden = true;
  updateBar.classList.remove('indeterminate');
  updateRestartBtn.hidden = true;
  updateRestartBtn.disabled = false;
  updateStatus.classList.remove('error');

  switch (state) {
    case 'checking':
      updateCheckBtn.disabled = true;
      updateStatus.textContent = 'جارٍ التحقق من وجود تحديثات…';
      break;

    case 'uptodate':
      updateStatus.textContent = 'لا توجد تحديثات';
      break;

    case 'available':
      updateCheckBtn.hidden = true;
      updateAvailable.hidden = false;
      updateNewVersion.textContent = `الإصدار الجديد ${arabicDigits(data.version)}`;
      updateDate.hidden = !data.date;
      if (data.date) updateDate.textContent = `تاريخ النشر: ${arabicDigits(data.date)}`;
      updateNotes.hidden = !data.notes;
      updateNotes.textContent = data.notes || ''; // textContent → untrusted-safe
      updateStatus.textContent = '';
      break;

    case 'downloading':
      updateCheckBtn.hidden = true;
      updateAvailable.hidden = false;
      updateDownloadBtn.hidden = true;
      updateProgress.hidden = false;
      setProgress(data.percent ?? null);
      updateStatus.textContent = 'جارٍ تنزيل التحديث…';
      break;

    case 'installing':
      updateCheckBtn.hidden = true;
      updateAvailable.hidden = false;
      updateDownloadBtn.hidden = true;
      updateProgress.hidden = false;
      updateBar.classList.add('indeterminate'); // install has no byte progress
      updateStatus.textContent = 'جارٍ تثبيت التحديث…';
      break;

    case 'installed':
      updateCheckBtn.hidden = true;
      updateRestartBtn.hidden = false;
      updateStatus.textContent = 'اكتمل التثبيت، التطبيق جاهز لإعادة التشغيل';
      break;

    case 'error':
      updateStatus.classList.add('error');
      updateStatus.textContent = data.message || 'حدث خطأ';
      if (data.from === 'download') {
        // Rust keeps the update pending → the download can simply be retried.
        updateCheckBtn.hidden = true;
        updateAvailable.hidden = false;
      } else if (data.from === 'restart') {
        updateCheckBtn.hidden = true;
        updateRestartBtn.hidden = false;
      }
      // from 'check' (or unset): the check button is already visible + enabled.
      break;

    default:
      updateStatus.textContent = 'لم يتم التحقق بعد';
  }
}

const updateFlow = createUpdateFlow({ onChange: renderUpdate });

updateCheckBtn.addEventListener('click', () => updateFlow.check());
updateDownloadBtn.addEventListener('click', () => updateFlow.download());
updateRestartBtn.addEventListener('click', () => updateFlow.restart());

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
