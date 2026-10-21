// «مسح بيانات التعلّم» said nothing when it worked with the summary folded,
// and each summary row read as one word run on into the next: the clip's
// last letter glued to «نسخ» (live UI audit of 2026-10-20, issue 7).
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
};

const flush = async (times = 8) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('settings: what رفّ learned reads cleanly, and clearing it is confirmed', async (t) => {
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
  let cleared = 0;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'get_settings') {
          return Promise.resolve({ settings: structuredClone(SETTINGS), axTrusted: true, version: '6.0.1' });
        }
        if (command === 'learning_summary') {
          return Promise.resolve(
            cleared
              ? []
              : [{ text: 'عنصر مثبّت قديم', type: 'text', copyCount: 5, pasteCount: 4, lastUsedAt: Date.now() }]
          );
        }
        if (command === 'clear_learning') {
          cleared += 1;
          return Promise.resolve(null);
        }
        if (command === 'check_for_update') return Promise.resolve({ status: 'upToDate' });
        if (command === 'consume_update_intent') return Promise.resolve(false);
        if (command === 'list_running_apps') return Promise.resolve([]);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  await import('../src/js/settings.js?settings-learning-cleared');
  await flush();
  const byId = (id) => dom.window.document.getElementById(id);

  await t.test('a summary row keeps the clip apart from its counts', async () => {
    byId('show-learning').click();
    await flush();
    const row = byId('learning-view').querySelector('.learn-row');
    assert.match(row.textContent, /^عنصر مثبّت قديم نسخ ٥ • لصق ٤ • /);
    byId('show-learning').click(); // folded again
    assert.equal(byId('learning-view').hidden, true);
  });

  await t.test('clearing with the summary folded is confirmed', async () => {
    byId('clear-learning').click();
    byId('clear-learning').click();
    await flush();
    assert.equal(cleared, 1);
    const status = byId('data-status');
    assert.equal(status.hidden, false, 'rendered: a live region');
    assert.equal(status.textContent, 'تم مسح بيانات التعلّم.');
    assert.equal(status.getAttribute('role'), 'status');
  });
});
