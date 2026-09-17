// A count answers «كم أحتفظ». It cannot answer «كم يعيش ما نسختُه على قرصي»,
// which for a privacy tool is the only one of the two the user can hold Raff
// to. And the wording has to say «غير المثبّت» out loud, or «يُحذف بعد أسبوع»
// is a promise that is partly false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

const SETTINGS = {
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
  retentionDays: 0,
};

const flush = async (times = 14) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test('settings: retention is a choice, and its wording is honest', async (t) => {
  let settings = structuredClone(SETTINGS);
  const calls = [];
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
        calls.push({ command, args });
        if (command === 'get_settings') {
          return Promise.resolve({
            settings: structuredClone(settings),
            axTrusted: true,
            version: '5.0.1',
            captureAlive: true,
          });
        }
        if (command === 'update_settings') {
          settings = structuredClone(args.settings);
          return Promise.resolve(null);
        }
        if (command === 'list_running_apps') return Promise.resolve([]);
        if (command === 'learning_summary') return Promise.resolve([]);
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  await import('../src/js/settings.js?retention');
  await flush();

  const doc = dom.window.document;
  const select = doc.getElementById('retention');

  await t.test('the control exists and reflects the saved value', () => {
    assert.ok(select, 'retention is offered');
    assert.equal(select.value, '0', 'and starts where the settings say');
    assert.deepEqual(
      [...select.options].map((option) => option.value),
      ['0', '7', '30', '90'],
      'the same four values validate_settings accepts'
    );
  });

  await t.test('the wording says which items it does not touch', () => {
    const row = select.closest('.row');
    assert.match(row.textContent, /غير المثبّت/u, 'or «يُحذف بعد أسبوع» is partly a lie');
  });

  await t.test('choosing a window saves it', async () => {
    select.value = '7';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();

    const saved = calls.filter((call) => call.command === 'update_settings');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].args.settings.retentionDays, 7);
    assert.equal(
      saved[0].args.settings.historyLimit,
      SETTINGS.historyLimit,
      'and leaves the count where it was — the two limits coexist'
    );
  });
});
