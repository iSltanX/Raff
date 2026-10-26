// «افتح رفّ عند تسجيل الدخول» is macOS's login item (login_item.rs). The
// switch shows what macOS will do — get_settings reads it back — and when
// macOS holds or refuses the change, the window says which, in Arabic, and
// the switch stays where macOS left it.
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

function fakeMac() {
  // What macOS has, which the backend reports as `launchAtLogin`.
  let loginItem = false;
  let refusal = null;
  const listeners = new Map();
  const tauri = {
    core: {
      invoke(command, args) {
        if (command === 'get_settings') {
          return Promise.resolve({
            settings: { ...structuredClone(INITIAL_SETTINGS), launchAtLogin: loginItem },
            axTrusted: true,
            version: '7.0.1',
            captureAlive: true,
          });
        }
        if (command === 'update_settings') {
          if ('launchAtLogin' in args.settings) {
            // The backend's error is its kind, as a string.
            if (refusal) return Promise.reject(refusal);
            loginItem = args.settings.launchAtLogin;
          }
          return Promise.resolve(null);
        }
        if (command === 'learning_summary') return Promise.resolve([]);
        if (command === 'list_running_apps') return Promise.resolve([]);
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: {
      listen(name, handler) {
        listeners.set(name, handler);
        return Promise.resolve(() => {});
      },
    },
  };
  return {
    tauri,
    refuseWith: (kind) => {
      refusal = kind;
    },
    systemSettings: (on) => {
      loginItem = on;
    },
    emit: (name) => listeners.get(name)?.({ payload: null }),
    loginItem: () => loginItem,
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
  const mac = fakeMac();
  dom.window.__TAURI__ = mac.tauri;
  await import('../src/js/settings.js?settings-login-item');
  await flush();
  return { dom, mac };
}

test('the login item switch says what macOS did, and why not', async (t) => {
  const { dom, mac } = await mount();
  const byId = (id) => dom.window.document.getElementById(id);
  const toggle = byId('launch-toggle');
  const status = byId('data-status');

  await t.test('turning it on registers it', async () => {
    toggle.click();
    await flush();
    assert.equal(mac.loginItem(), true);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(status.textContent, '');
  });

  await t.test('a change in System Settings shows on the next read', async () => {
    mac.systemSettings(false);
    mac.emit('raff://changed');
    await flush();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
  });

  await t.test('back from System Settings, the switch shows the change', async () => {
    mac.systemSettings(true);
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await flush();
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    mac.systemSettings(false);
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await flush();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
  });

  await t.test('held for approval: says where, and the switch stays off', async () => {
    mac.refuseWith('raff/login-item-needs-approval');
    toggle.click();
    await flush();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(status.getAttribute('role'), 'alert');
    assert.equal(
      status.textContent,
      'رفّ موقوف في إعدادات النظام. فعّله من عام ← عناصر تسجيل الدخول، ثم أعد المحاولة.'
    );
  });

  await t.test('refused: says so, and the switch stays off', async () => {
    mac.refuseWith('raff/login-item-failed');
    toggle.click();
    await flush();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(status.textContent, 'لم يقبل macOS فتح رفّ عند تسجيل الدخول. حاول مرة أخرى.');
  });

  await t.test('any other failure keeps the general message', async () => {
    mac.refuseWith('raff/save-failed');
    toggle.click();
    await flush();
    assert.equal(status.textContent, 'تعذّر حفظ التغيير. حاول مرة أخرى.');
  });
});
