// Settings window: reads the store, writes back full Settings objects.

import { api, on } from './store.js';
import { arabicDigits, metaLine, hotkeyDisplay, hotkeyFromEvent } from './logic.js';
import { SUN_ICON, MOON_ICON } from './icons.js';

let settings = null;

const el = (id) => document.getElementById(id);
const hotkeyChip = el('hotkey-chip');
const hotkeySub = el('hotkey-sub');

// ─── Tabs ─────────────────────────────────────────────────────────────────

el('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document
    .querySelectorAll('.tab-panel')
    .forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
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
