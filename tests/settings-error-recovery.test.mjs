// Error-state recovery for the Settings window. The fake bridge deliberately
// fails each audited IPC path so the real UI must keep untrusted defaults
// inert, announce the problem, and expose a deterministic retry path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

const INITIAL_SETTINGS = {
  hotkey: 'shift+super+v',
  launchAtLogin: false,
  historyLimit: 500,
  captureEnabled: true,
  respectConcealed: true,
  excludedApps: [],
  learningEnabled: true,
  firstRunShown: true,
  appearance: 'light',
  followSystem: true,
};

const flush = async (times = 4) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function fakeBackend() {
  let settings = structuredClone(INITIAL_SETTINGS);
  let getStateFailures = 3;
  let runningAppsFail = false;
  let saveFail = false;
  let clearFail = false;
  let clearLearningFail = false;
  const calls = [];

  const tauri = {
    core: {
      invoke(command, args) {
        calls.push(command);
        if (command === 'get_state') {
          if (getStateFailures > 0) {
            getStateFailures -= 1;
            return Promise.reject(new Error('state unavailable'));
          }
          return Promise.resolve({
            pinned: [],
            history: [],
            settings: structuredClone(settings),
            axTrusted: true,
            version: '4.0.0',
          });
        }
        if (command === 'list_running_apps') {
          if (runningAppsFail) return Promise.reject(new Error('app list unavailable'));
          return Promise.resolve([{ name: 'Notes', bundleId: 'com.apple.Notes' }]);
        }
        if (command === 'update_settings') {
          if (saveFail) return Promise.reject(new Error('save refused'));
          settings = structuredClone(args.settings);
          return Promise.resolve(null);
        }
        if (command === 'clear_history') {
          if (clearFail) return Promise.reject(new Error('clear refused'));
          return Promise.resolve(null);
        }
        if (command === 'clear_learning') {
          if (clearLearningFail) return Promise.reject(new Error('learning clear refused'));
          return Promise.resolve(null);
        }
        if (command === 'learning_summary') return Promise.resolve([]);
        if (command === 'check_for_update') return Promise.resolve({ status: 'upToDate' });
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  return {
    tauri,
    calls,
    allowState: () => {
      getStateFailures = 0;
    },
    failRunningApps: (value) => {
      runningAppsFail = value;
    },
    failSave: (value) => {
      saveFail = value;
    },
    failClear: (value) => {
      clearFail = value;
    },
    failClearLearning: (value) => {
      clearLearningFail = value;
    },
    currentSettings: () => structuredClone(settings),
  };
}

async function mount() {
  const dom = new JSDOM(settingsHtml, { url: 'http://localhost/settings.html' });
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const backend = fakeBackend();
  dom.window.__TAURI__ = backend.tauri;
  const uncaught = [];
  dom.window.addEventListener('error', (event) =>
    uncaught.push(String(event.error ?? event.message))
  );
  dom.window.addEventListener('unhandledrejection', (event) =>
    uncaught.push(String(event.reason))
  );

  await import('../src/js/settings.js?settings-error-recovery');
  return { dom, backend, uncaught };
}

test('Settings exposes recoverable, announced IPC failures', async (t) => {
  const { dom, backend, uncaught } = await mount();
  const byId = (id) => dom.window.document.getElementById(id);

  await t.test('initial defaults remain inert through retries and failure', async () => {
    assert.equal(byId('settings-window').getAttribute('aria-busy'), 'true');
    assert.equal(byId('settings-tabs').hasAttribute('inert'), true);
    assert.equal(byId('settings-body').hasAttribute('inert'), true);
    assert.equal(byId('clear-history').disabled, true);

    await new Promise((resolve) => setTimeout(resolve, 520));
    await flush();

    const state = byId('settings-load-state');
    const retry = byId('settings-load-retry');
    assert.equal(state.hidden, false);
    assert.equal(state.getAttribute('role'), 'alert');
    assert.equal(state.getAttribute('aria-live'), 'assertive');
    assert.match(byId('settings-load-message').textContent, /تعذّر تحميل الإعدادات/u);
    assert.equal(retry.hidden, false);
    assert.equal(dom.window.document.activeElement, retry, 'the recovery action receives focus');
    assert.equal(byId('settings-tabs').hasAttribute('inert'), true);
    assert.equal(byId('settings-body').hasAttribute('inert'), true);
  });

  await t.test('explicit retry restores the real settings and interactions', async () => {
    backend.allowState();
    byId('settings-load-retry').click();
    await flush();

    assert.equal(byId('settings-load-state').hidden, true);
    assert.equal(byId('settings-window').getAttribute('aria-busy'), 'false');
    assert.equal(byId('settings-tabs').hasAttribute('inert'), false);
    assert.equal(byId('settings-body').hasAttribute('inert'), false);
    assert.equal(byId('clear-history').disabled, false);
    assert.equal(byId('launch-toggle').getAttribute('aria-checked'), 'false');
  });

  await t.test('running-app failure replaces the add controls with an alert and retry', async () => {
    byId('settings-tab-privacy').click();
    backend.failRunningApps(true);
    byId('manage-excluded').click();
    await flush();

    const error = byId('running-apps-error');
    const retry = byId('retry-running-apps');
    assert.equal(error.hidden, false);
    assert.equal(error.getAttribute('role'), 'alert');
    assert.equal(byId('excluded-add').hidden, true);
    assert.equal(dom.window.document.activeElement, retry);

    backend.failRunningApps(false);
    retry.click();
    await flush();
    assert.equal(error.hidden, true);
    assert.equal(byId('excluded-add').hidden, false);
    assert.equal(byId('running-apps').disabled, false);
    assert.equal(byId('running-apps').value, 'com.apple.Notes');
  });

  await t.test('a non-hotkey save failure is visible, assertive, and reverts', async () => {
    backend.failSave(true);
    byId('launch-toggle').click();
    await flush();

    const status = byId('data-status');
    assert.equal(status.hidden, false);
    assert.equal(status.getAttribute('role'), 'alert');
    assert.equal(status.getAttribute('aria-live'), 'assertive');
    assert.match(status.textContent, /تعذّر حفظ التغيير/u);
    assert.equal(byId('launch-toggle').getAttribute('aria-checked'), 'false');
    assert.equal(backend.currentSettings().launchAtLogin, false);
    backend.failSave(false);
  });

  await t.test('clear-history failure reports that nothing was deleted', async () => {
    backend.failClear(true);
    byId('clear-history').click();
    byId('confirm-accept').click();
    await flush();

    const status = byId('data-status');
    assert.equal(status.hidden, false);
    assert.equal(status.getAttribute('role'), 'alert');
    assert.equal(status.getAttribute('aria-live'), 'assertive');
    assert.equal(status.textContent, 'تعذّر مسح سجل الحافظة. لم يُحذف أي عنصر.');
    assert.equal(byId('clear-history').disabled, false, 'the original action remains retryable');
    backend.failClear(false);
  });

  await t.test('clear-learning failure is handled, announced, and retryable', async () => {
    byId('settings-tab-learning').click();
    backend.failClearLearning(true);
    const clearLearning = byId('clear-learning');
    clearLearning.click();
    clearLearning.click();
    assert.equal(clearLearning.disabled, true, 'duplicate activation is blocked while IPC is pending');
    await flush();

    const status = byId('data-status');
    assert.equal(status.hidden, false);
    assert.equal(status.getAttribute('role'), 'alert');
    assert.equal(status.getAttribute('aria-live'), 'assertive');
    assert.equal(status.textContent, 'تعذّر مسح بيانات التعلّم. لم تُحذف البيانات.');
    assert.equal(clearLearning.disabled, false, 'the action is available for an explicit retry');
    backend.failClearLearning(false);
  });

  assert.deepEqual(uncaught, [], 'all exercised promise failures are handled');
});
