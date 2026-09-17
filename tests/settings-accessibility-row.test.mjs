// The Accessibility permission had exactly two doors: a first-run window shown
// once, and a toast after a paste that had already failed. Whoever pressed
// «لاحقًا», or lost the permission later, had nowhere to find out why
// auto-paste stopped working. Settings now says so, and offers the way back.
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

const flush = async (times = 12) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function mount() {
  let axTrusted = false;
  const calls = [];
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
      invoke(command) {
        calls.push(command);
        if (command === 'get_settings') {
          return Promise.resolve({
            settings: structuredClone(SETTINGS),
            axTrusted,
            version: '5.0.1',
            captureAlive: true,
          });
        }
        if (command === 'request_accessibility') return Promise.resolve(false);
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

  await import('../src/js/settings.js?accessibility-row');
  await flush();

  return {
    dom,
    calls,
    grant: async () => {
      axTrusted = true;
      await listeners.get('raff://changed')?.({});
      await flush();
    },
  };
}

test('settings: the Accessibility permission has a door in Privacy', async (t) => {
  const { dom, calls, grant } = await mount();
  const doc = dom.window.document;
  const row = doc.getElementById('accessibility-status');
  const action = doc.getElementById('accessibility-action');

  await t.test('without the permission the row states it and offers an action', () => {
    assert.ok(row, 'the row lives in the Privacy page');
    assert.equal(
      row.closest('.settings-page').id,
      'settings-panel-privacy',
      'and nowhere else'
    );
    assert.equal(row.hidden, false);
    assert.match(row.textContent, /اللصق التلقائي معطّل/u);
    assert.ok(action, 'there is a way to act on it');
    assert.equal(action.hidden, false);
  });

  await t.test('the action asks macOS, then opens the right settings pane', async () => {
    calls.length = 0;
    action.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    assert.deepEqual(calls.filter((call) => call.startsWith('open_') || call.startsWith('request_')), [
      'request_accessibility',
      'open_accessibility_settings',
    ]);
  });

  await t.test('once granted the row says so and drops the action', async () => {
    await grant();
    assert.equal(row.hidden, false, 'the state stays visible — it is worth knowing');
    assert.match(row.textContent, /ممنوح/u);
    assert.equal(action.hidden, true, 'with nothing left to do');
  });
});
