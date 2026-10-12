// When settings.json could not be read, the switch shows «معطّل» and the
// exclusions list is empty — which, without a word, reads as choices the user
// made (RAFF-AUD-002). The status row under the switch says what happened and
// what was lost, and turning capture back on is the confirmation that clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

const DEFAULTS_HELD_OFF = {
  hotkey: 'shift+super+v',
  launchAtLogin: false,
  historyLimit: 500,
  captureEnabled: false,
  respectConcealed: true,
  excludedApps: [],
  learningEnabled: true,
  firstRunShown: false,
  appearance: 'light',
  followSystem: true,
  retentionDays: 0,
};

const flush = async (times = 6) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function mount() {
  let settings = structuredClone(DEFAULTS_HELD_OFF);
  let unreadableSettings = true;
  const updates = [];
  const listeners = new Map();

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

  dom.window.__TAURI__ = {
    core: {
      invoke(command, args) {
        if (command === 'get_settings') {
          return Promise.resolve({
            settings: structuredClone(settings),
            axTrusted: true,
            version: '6.0.0',
            unreadableSettings,
            captureAlive: true,
            capturePause: { kind: 'off', minutesLeft: null },
          });
        }
        if (command === 'update_settings') {
          updates.push(structuredClone(args.settings));
          settings = structuredClone(args.settings);
          // As the store does: turning capture on is the confirmation.
          if (settings.captureEnabled) unreadableSettings = false;
          queueMicrotask(() => listeners.get('raff://changed')?.({}));
          return Promise.resolve(null);
        }
        if (command === 'list_running_apps') return Promise.resolve([]);
        if (command === 'learning_summary') return Promise.resolve([]);
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (name, handler) => {
        listeners.set(name, handler);
        return Promise.resolve(() => {});
      },
    },
  };

  await import('../src/js/settings.js?unreadable-settings');
  await flush(12);
  return { dom, updates };
}

test('settings: unreadable settings are explained under the capture switch', async (t) => {
  const { dom, updates } = await mount();
  const doc = dom.window.document;
  const row = doc.getElementById('capture-status');
  const toggle = doc.getElementById('capture-toggle');

  await t.test('the row names the unreadable file, the lost exclusions and the held-off capture', () => {
    assert.equal(row.hidden, false);
    assert.equal(row.dataset.tone, 'danger');
    assert.match(row.textContent, /تعذّرت قراءة إعداداتك/u);
    assert.match(row.textContent, /قائمة الاستبعاد/u);
    assert.match(row.textContent, /الالتقاط معطّل/u);
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'capture is held off');
  });

  await t.test('the window opens on the page that explains it', () => {
    assert.equal(doc.getElementById('settings-tab-capture').getAttribute('aria-selected'), 'true');
    assert.equal(doc.getElementById('settings-panel-capture').hidden, false);
  });

  await t.test('nothing is written until the user acts', () => {
    assert.deepEqual(updates, []);
  });

  await t.test('turning capture on is the confirmation, and the row clears', async () => {
    toggle.click();
    await flush(12);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].captureEnabled, true);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(row.hidden, true);
  });
});
