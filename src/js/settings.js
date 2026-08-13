// Settings window: reads the store, writes back full Settings objects.
//
// The visual language follows Figma «08 — Product Screens», screen ٥ (2:7983),
// translated into a compact macOS preferences toolbar. One tab panel is shown
// at a time so settings never become a long document or a two-column grid.

import { api, on } from './store.js';
import { arabicDigits, metaLine, hotkeyDisplay, hotkeyFromEvent } from './logic.js';
import { CLEAR, createIcon } from './icons.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

let settings = null;

const el = (id) => document.getElementById(id);
const hotkeyChip = el('hotkey-chip');
const hotkeySub = el('hotkey-sub');
const settingsWindow = el('settings-window');
const settingsBody = el('settings-body');
const settingsLoadState = el('settings-load-state');
const settingsLoadMessage = el('settings-load-message');
const settingsLoadRetry = el('settings-load-retry');
const clearHistoryBtn = el('clear-history');
const dataStatus = el('data-status');

/** The resting sub-line under the hotkey row; also what a flashed error
 *  reverts to once it clears. */
const HOTKEY_HINT = 'انقر على الاختصار ثم اضغط التركيبة الجديدة';

// ─── Preferences toolbar ─────────────────────────────────────────────────

const tablist = el('settings-tabs');
const settingsTabs = [...tablist.querySelectorAll('[role="tab"]')];
const settingsPanels = settingsTabs.map((tab) => el(tab.getAttribute('aria-controls')));
const ACTIVE_TAB_KEY = 'raff.settings.active-tab';

function rememberedTabId() {
  try {
    return window.localStorage.getItem(ACTIVE_TAB_KEY);
  } catch {
    return null;
  }
}

function rememberTabId(id) {
  try {
    window.localStorage.setItem(ACTIVE_TAB_KEY, id);
  } catch {
    // A private WKWebView may deny storage. Tab navigation still works.
  }
}

function activateSettingsTab(tab, { focus = false } = {}) {
  if (!settingsTabs.includes(tab)) return;

  for (let index = 0; index < settingsTabs.length; index += 1) {
    const candidate = settingsTabs[index];
    const active = candidate === tab;
    candidate.classList.toggle('is-active', active);
    candidate.setAttribute('aria-selected', String(active));
    candidate.tabIndex = active ? 0 : -1;
    settingsPanels[index].hidden = !active;
  }

  rememberTabId(tab.id);
  if (focus) tab.focus();
}

for (const tab of settingsTabs) {
  tab.addEventListener('click', () => activateSettingsTab(tab));
}

tablist.addEventListener('keydown', (event) => {
  const current = event.target.closest?.('[role="tab"]');
  const index = settingsTabs.indexOf(current);
  if (index < 0) return;

  let nextIndex = null;
  // The toolbar is RTL: ArrowLeft follows the visible sequence from عام toward
  // حول, while ArrowRight moves back toward the right edge.
  if (event.key === 'ArrowLeft') nextIndex = (index + 1) % settingsTabs.length;
  else if (event.key === 'ArrowRight') nextIndex = (index - 1 + settingsTabs.length) % settingsTabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = settingsTabs.length - 1;

  if (nextIndex === null) return;
  event.preventDefault();
  activateSettingsTab(settingsTabs[nextIndex], { focus: true });
});

const initialTab = settingsTabs.find((tab) => tab.id === rememberedTabId()) ?? settingsTabs[0];
activateSettingsTab(initialTab);

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
el('settings-repo').addEventListener('click', () => api.openRepository().catch(() => {}));

// ─── Load / sync ──────────────────────────────────────────────────────────

async function load() {
  const state = await api.getState();
  settings = state.settings;

  const version = state?.version;
  el('settings-version').textContent = version
    ? `الإصدار ${arabicDigits(version)} · \u2066Version ${version}\u2069`
    : '';

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

function setSettingsInteractive(ready) {
  tablist.toggleAttribute('inert', !ready);
  settingsBody.toggleAttribute('inert', !ready);
  clearHistoryBtn.disabled = !ready;
  settingsWindow.setAttribute('aria-busy', String(!ready));
}

function showSettingsLoadState({ error = false } = {}) {
  settingsLoadState.hidden = false;
  settingsLoadState.classList.toggle('is-error', error);
  settingsLoadState.setAttribute('role', error ? 'alert' : 'status');
  settingsLoadState.setAttribute('aria-live', error ? 'assertive' : 'polite');
  settingsLoadMessage.textContent = error
    ? 'تعذّر تحميل الإعدادات. لم تُطبّق أي قيم افتراضية.'
    : 'جارٍ تحميل الإعدادات…';
  settingsLoadRetry.hidden = !error;
  settingsLoadRetry.disabled = !error;
}

let settingsLoadInFlight = false;
async function loadWithRetries() {
  if (settingsLoadInFlight) return false;
  settingsLoadInFlight = true;
  setSettingsInteractive(false);
  showSettingsLoadState();

  let lastError = null;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await load();
        settingsLoadState.hidden = true;
        setSettingsInteractive(true);
        return true;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
    }
  } finally {
    settingsLoadInFlight = false;
  }

  console.error('raff: settings load failed', lastError);
  showSettingsLoadState({ error: true });
  settingsLoadRetry.focus();
  return false;
}

settingsLoadRetry.addEventListener('click', () => {
  void loadWithRetries();
});

// ─── About page update check ─────────────────────────────────────────────

const settingsUpdateBtn = el('settings-update');
const settingsUpdateStatus = el('settings-update-status');
let checkingForUpdate = false;

settingsUpdateBtn.addEventListener('click', async () => {
  if (checkingForUpdate) return;
  checkingForUpdate = true;
  settingsUpdateBtn.disabled = true;
  settingsUpdateStatus.textContent = 'جارٍ التحقق…';
  try {
    const result = await api.checkForUpdate();
    if (result?.status === 'available' && result.version) {
      settingsUpdateStatus.textContent = `يتوفّر إصدار جديد: ${arabicDigits(result.version)}`;
    } else if (result?.status === 'upToDate') {
      settingsUpdateStatus.textContent = 'أنت على أحدث إصدار من رفّ.';
    } else {
      settingsUpdateStatus.textContent = 'تعذّر التحقق من التحديث.';
    }
  } catch {
    settingsUpdateStatus.textContent = 'تعذّر التحقق من التحديث.';
  } finally {
    checkingForUpdate = false;
    settingsUpdateBtn.disabled = false;
  }
});

/** Switches and the checkbox are ARIA-driven: aria-checked is the state, and
 *  the stylesheet draws from it. */
function setChecked(id, value) {
  el(id).setAttribute('aria-checked', String(Boolean(value)));
}

// Settings are a complete-object IPC contract. Keep mutations strictly in
// order so a slower earlier write can never overwrite a newer control, and
// resolve functional patches only when their turn begins so rapid double
// toggles are based on the last committed state rather than a stale snapshot.
let saveTail = Promise.resolve();

async function commitSettingsPatch(patch) {
  // update_settings takes a COMPLETE Settings object — a partial patch would
  // drop every field it omits.
  const resolvedPatch = typeof patch === 'function' ? patch(settings) : patch;
  const next = { ...settings, ...resolvedPatch };
  let failure = null;
  try {
    await api.updateSettings(next);
    settings = next;
  } catch (err) {
    console.error('raff: settings save failed', err);
    failure = err;
  }

  try {
    await load(); // re-sync (reverts the UI when the backend refused the change)
  } catch (err) {
    console.error('raff: settings re-sync failed', err);
    showDataStatus('تعذّرت مزامنة الإعدادات. أعد فتح النافذة للمحاولة مرة أخرى.', {
      error: true,
      duration: 7000,
    });
    return false;
  }

  if (!failure) return true;
  if ('hotkey' in resolvedPatch) {
    flashHotkeyError(String(failure));
  } else {
    showDataStatus('تعذّر حفظ التغيير. حاول مرة أخرى.', { error: true, duration: 6000 });
  }
  return false;
}

function save(patch) {
  const queued = saveTail.then(() => commitSettingsPatch(patch));
  // A transient reload failure must not poison every later settings change.
  // The caller still receives its own rejection while the internal tail is
  // recovered for the next queued mutation.
  saveTail = queued.catch(() => {});
  return queued;
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
    void load().catch((err) => {
      console.error('raff: hotkey error re-sync failed', err);
      showDataStatus('تعذّرت مزامنة الإعدادات. أعد فتح النافذة للمحاولة مرة أخرى.', {
        error: true,
        duration: 7000,
      });
    });
  }, 4000);
}

// ─── Switches, checkbox, pop-up button ────────────────────────────────────

el('launch-toggle').addEventListener('click', () =>
  save((current) => ({ launchAtLogin: !current.launchAtLogin }))
);
el('capture-toggle').addEventListener('click', () =>
  save((current) => ({ captureEnabled: !current.captureEnabled }))
);
el('concealed-toggle').addEventListener('click', () =>
  save((current) => ({ respectConcealed: !current.respectConcealed }))
);
el('learning-toggle').addEventListener('click', () =>
  save((current) => ({ learningEnabled: !current.learningEnabled }))
);
el('history-limit').addEventListener('change', (e) => save({ historyLimit: Number(e.target.value) }));

// ─── المظهر — Segments-Container (2:8018) ─────────────────────────────────
// Three tabs over two settings: «تلقائي» is followSystem, the other two are an
// explicit appearance with followSystem off.

const appearanceGroup = el('appearance-segments');
const appearanceTabs = [...appearanceGroup.querySelectorAll('.seg-tab')];

function renderAppearance() {
  const active = settings.followSystem ? 'auto' : settings.appearance;
  for (const tab of appearanceTabs) {
    const on = tab.dataset.appearance === active;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-checked', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
}

function chooseAppearance(tab) {
  const choice = tab.dataset.appearance;
  return save(choice === 'auto' ? { followSystem: true } : { followSystem: false, appearance: choice });
}

for (const tab of appearanceTabs) {
  tab.addEventListener('click', () => chooseAppearance(tab));
}

appearanceGroup.addEventListener('keydown', (event) => {
  const current = event.target.closest?.('[role="radio"]');
  const index = appearanceTabs.indexOf(current);
  if (index < 0) return;

  let nextIndex = null;
  // DOM and visual order are RTL: ArrowLeft advances visually left.
  if (event.key === 'ArrowLeft') nextIndex = (index + 1) % appearanceTabs.length;
  else if (event.key === 'ArrowRight') {
    nextIndex = (index - 1 + appearanceTabs.length) % appearanceTabs.length;
  } else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = appearanceTabs.length - 1;

  if (nextIndex === null) return;
  event.preventDefault();
  const next = appearanceTabs[nextIndex];
  next.focus();
  next.click();
});

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
const excludedAdd = el('excluded-add');
const runningAppsSelect = el('running-apps');
const addExcludedBtn = el('add-excluded');
const runningAppsError = el('running-apps-error');
const retryRunningApps = el('retry-running-apps');

manageExcludedBtn.addEventListener('click', async () => {
  const manager = el('excluded-manager');
  manager.hidden = !manager.hidden;
  manageExcludedBtn.setAttribute('aria-expanded', String(!manager.hidden));
  manageExcludedBtn.textContent = manager.hidden ? 'إدارة…' : 'إخفاء';
  manageExcludedBtn.setAttribute(
    'aria-label',
    manager.hidden ? 'إدارة التطبيقات المستبعَدة' : 'إخفاء التطبيقات المستبعَدة'
  );
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
    remove.replaceChildren(createIcon(CLEAR));
    remove.title = 'إزالة';
    remove.setAttribute('aria-label', `إزالة ${bundleId}`);
    remove.addEventListener('click', () =>
      save((current) => ({
        excludedApps: current.excludedApps.filter((candidate) => candidate !== bundleId),
      }))
    );
    li.append(bundle, remove);
    list.append(li);
  }
}

async function populateRunningApps() {
  runningAppsSelect.replaceChildren();
  runningAppsSelect.disabled = true;
  addExcludedBtn.disabled = true;
  retryRunningApps.disabled = true;
  runningAppsError.hidden = true;
  excludedAdd.hidden = false;

  try {
    const apps = await api.listRunningApps();
    for (const app of apps) {
      if (settings.excludedApps.includes(app.bundleId)) continue;
      const option = document.createElement('option');
      option.value = app.bundleId;
      option.textContent = app.name; // app-supplied string → textContent
      runningAppsSelect.append(option);
    }

    if (!runningAppsSelect.options.length) {
      const empty = document.createElement('option');
      empty.textContent = 'لا توجد تطبيقات متاحة';
      empty.disabled = true;
      runningAppsSelect.append(empty);
      return true;
    }

    runningAppsSelect.disabled = false;
    addExcludedBtn.disabled = false;
    return true;
  } catch (err) {
    console.error('raff: running apps load failed', err);
    excludedAdd.hidden = true;
    runningAppsError.hidden = false;
    retryRunningApps.disabled = false;
    retryRunningApps.focus();
    return false;
  }
}

retryRunningApps.addEventListener('click', () => {
  void populateRunningApps();
});

addExcludedBtn.addEventListener('click', async () => {
  const bundleId = runningAppsSelect.value;
  if (!bundleId || settings.excludedApps.includes(bundleId)) return;
  const saved = await save((current) => ({
    excludedApps: current.excludedApps.includes(bundleId)
      ? current.excludedApps
      : [...current.excludedApps, bundleId],
  }));
  if (saved) await populateRunningApps();
});

// ─── Two-step destructive buttons ─────────────────────────────────────────

function confirmButton(id, action, errorMessage) {
  const button = el(id);
  let armed = false;
  let timer = null;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = button.dataset.confirm;
      button.setAttribute('aria-label', button.dataset.confirm);
      timer = setTimeout(() => {
        armed = false;
        button.textContent = button.dataset.label;
        button.setAttribute('aria-label', button.dataset.label);
      }, 3000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    button.textContent = button.dataset.label;
    button.setAttribute('aria-label', button.dataset.label);
    button.disabled = true;
    try {
      await action();
    } catch (err) {
      console.error(`raff: ${id} failed`, err);
      showDataStatus(errorMessage, { error: true, duration: 6000 });
    } finally {
      button.disabled = false;
    }
  });
}

confirmButton('clear-learning', async () => {
  await api.clearLearning();
  if (!el('learning-view').hidden) {
    try {
      await renderLearning();
    } catch (err) {
      console.error('raff: learning summary refresh failed', err);
      showDataStatus('تم مسح بيانات التعلّم، لكن تعذّر تحديث العرض.', {
        error: true,
        duration: 6000,
      });
    }
  }
}, 'تعذّر مسح بيانات التعلّم. لم تُحذف البيانات.');

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
      settingsWindow.removeAttribute('inert');
      settingsWindow.removeAttribute('aria-hidden');
      restoreFocus?.focus?.();
      resolve(result);
    };
    document.addEventListener('keydown', onKeydown, true);
    settingsWindow.setAttribute('inert', '');
    settingsWindow.setAttribute('aria-hidden', 'true');
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

let dataStatusTimer = null;

function showDataStatus(message, { error = false, duration = 4000 } = {}) {
  dataStatus.textContent = message;
  dataStatus.hidden = false;
  dataStatus.classList.toggle('is-error', error);
  dataStatus.setAttribute('role', error ? 'alert' : 'status');
  dataStatus.setAttribute('aria-live', error ? 'assertive' : 'polite');
  clearTimeout(dataStatusTimer);
  dataStatusTimer = setTimeout(() => {
    dataStatus.hidden = true;
  }, duration);
}

clearHistoryBtn.addEventListener('click', async () => {
  if (!(await askConfirm())) return;
  clearHistoryBtn.disabled = true;
  try {
    await api.clearHistory();
  } catch (err) {
    console.error('raff: clearing history failed', err);
    showDataStatus('تعذّر مسح سجل الحافظة. لم يُحذف أي عنصر.', {
      error: true,
      duration: 6000,
    });
    clearHistoryBtn.disabled = false;
    return;
  }

  // The learning summary is drawn from the same items, so a visible one would
  // otherwise keep showing rows that no longer exist.
  if (!el('learning-view').hidden) {
    try {
      await renderLearning();
    } catch (err) {
      console.error('raff: learning summary refresh failed', err);
    }
  }
  showDataStatus('تم مسح سجل الحافظة.');
  clearHistoryBtn.disabled = false;
});

// ─── «ما تعلّمه رفّ حتى الآن» ─────────────────────────────────────────────

const showLearningBtn = el('show-learning');

showLearningBtn.addEventListener('click', async () => {
  const view = el('learning-view');
  view.hidden = !view.hidden;
  showLearningBtn.setAttribute('aria-expanded', String(!view.hidden));
  showLearningBtn.textContent = view.hidden ? 'عرض' : 'إخفاء';
  showLearningBtn.setAttribute('aria-label', view.hidden ? 'عرض ما تعلّمه رفّ' : 'إخفاء ما تعلّمه رفّ');
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

on('raff://changed', () => {
  void load().catch((err) => {
    console.error('raff: settings refresh failed', err);
    showDataStatus('تعذّر تحديث الإعدادات المعروضة.', { error: true, duration: 6000 });
  });
});

// First load: retry briefly (IPC can lag right after window creation) so a
// transient failure never leaves the window showing default values.
void loadWithRetries();
