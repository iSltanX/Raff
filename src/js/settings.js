// Settings window: reads the store, writes back full Settings objects.

import { api, on } from './store.js';
import { arabicDigits, metaLine, hotkeyDisplay, hotkeyFromEvent } from './logic.js';
import { SUN_ICON, MOON_ICON } from './icons.js';

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

confirmButton('clear-history', () => api.clearHistory());
confirmButton('clear-learning', async () => {
  await api.clearLearning();
  if (!el('learning-view').hidden) renderLearning();
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
// Drives the three audited Rust commands (check → download+install → restart)
// through the invoke bridge — never the updater plugin's JS API directly.
// `renderUpdate` is the single source of truth for what the section shows, so
// event-driven and click-driven transitions can never leave it inconsistent.

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

// Re-entry guard: blocks repeated clicks while a check/download/restart runs.
let updateBusy = false;
// Current update-section phase, so the menu entry point can tell whether an
// operation is already underway (or an install is staged) and avoid a re-check.
let updatePhase = 'idle';

function renderUpdate(state, data = {}) {
  updatePhase = state;
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
    case 'idle':
      updateStatus.textContent = 'لم يتم التحقق بعد';
      break;

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
  }
}

function setProgress(percent) {
  if (percent == null) {
    updateBar.classList.add('indeterminate');
    updateBarFill.style.width = '';
  } else {
    updateBar.classList.remove('indeterminate');
    updateBarFill.style.width = `${percent}%`;
  }
}

const errMessage = (err, fallback) => (typeof err === 'string' && err ? err : fallback);

// The one manual-check flow, shared by the About button and the tray menu.
async function runUpdateCheck() {
  if (updateBusy) return;
  updateBusy = true;
  renderUpdate('checking');
  try {
    const result = await api.checkForUpdate();
    if (result?.status === 'available') {
      renderUpdate('available', { version: result.version, date: result.date, notes: result.notes });
    } else if (result?.status === 'upToDate') {
      renderUpdate('uptodate');
    } else {
      renderUpdate('error', { from: 'check', message: result?.message || 'تعذّر التحقق من التحديث.' });
    }
  } catch (err) {
    renderUpdate('error', { from: 'check', message: errMessage(err, 'تعذّر التحقق من التحديث.') });
  } finally {
    updateBusy = false;
  }
}

updateCheckBtn.addEventListener('click', runUpdateCheck);

updateDownloadBtn.addEventListener('click', async () => {
  if (updateBusy) return;
  updateBusy = true;
  setProgress(0);
  renderUpdate('downloading');
  try {
    await api.downloadAndInstallUpdate();
    // Resolves only after install completes; the `installed` event usually
    // rendered this already — rendering again is idempotent and covers a
    // missed event.
    renderUpdate('installed');
  } catch (err) {
    renderUpdate('error', { from: 'download', message: errMessage(err, 'تعذّر تنزيل التحديث أو تثبيته.') });
  } finally {
    updateBusy = false;
  }
});

updateRestartBtn.addEventListener('click', async () => {
  if (updateBusy) return;
  updateBusy = true;
  try {
    // On success the process relaunches and this webview is torn down — the
    // promise never resolves. Only a refused/failed restart returns here.
    await api.restartToUpdate();
  } catch (err) {
    renderUpdate('error', { from: 'restart', message: errMessage(err, 'تعذّر إعادة التشغيل.') });
    updateBusy = false;
  }
});

// Progress + lifecycle events from Rust. Registered once at module load (a tab
// switch never re-runs this; a reopened window is a fresh document with fresh
// listeners), so handlers cannot accumulate.
on('raff://update/started', (event) => {
  updateProgress.hidden = false;
  setProgress(event?.payload?.total == null ? null : 0);
});
on('raff://update/progress', (event) => {
  setProgress(event?.payload?.percent ?? null);
});
on('raff://update/installing', () => renderUpdate('installing'));
on('raff://update/installed', () => renderUpdate('installed'));
on('raff://update/error', (event) =>
  renderUpdate('error', { from: 'download', message: event?.payload?.message || 'تعذّر تنزيل التحديث أو تثبيته.' })
);

// ─── Menu entry point «التحقق من وجود تحديثات…» ─────────────────────────────
// The tray item routes here (via a consume-once Rust intent) instead of running
// its own check. Always surface the About tab; only start a check when nothing
// is already running and no install is staged awaiting restart.
function goToAboutAndCheck() {
  activateTab('about');
  if (updateBusy || updatePhase === 'installing' || updatePhase === 'installed') return;
  runUpdateCheck();
}

// The Rust flag is claimed by whichever path arrives first for a given menu
// click — the fresh window's load poll (below) or this event on an already-open
// window — so the check runs exactly once and is never lost.
async function claimMenuIntent() {
  try {
    if (await api.consumeUpdateIntent()) goToAboutAndCheck();
  } catch (err) {
    console.error('raff: update-intent claim failed', err);
  }
}
on('raff://open-updates', claimMenuIntent);
claimMenuIntent();

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
