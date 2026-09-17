// `captureEnabled` is a setting — what the user asked for. It cannot say
// whether capture is actually running, so a capture loop that died left the
// switch reading «مُفعَّل» with nothing being saved. The status row is the only
// place that tells the two apart.
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

const flush = async (times = 6) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function mount() {
  let captureAlive = false;
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
        if (command === 'get_state') {
          return Promise.resolve({
            pinned: [],
            history: [],
            settings: structuredClone(SETTINGS),
            axTrusted: true,
            version: '5.0.1',
            unreadableLayer: false,
            captureAlive,
          });
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

  await import('../src/js/settings.js?capture-alive');
  await flush(12);

  return {
    dom,
    reviveCapture: async () => {
      captureAlive = true;
      await listeners.get('raff://changed')?.({});
      await flush(12);
    },
  };
}

test('settings: a capture loop that died is stated, not left looking healthy', async (t) => {
  const { dom, reviveCapture } = await mount();
  const row = dom.window.document.getElementById('capture-status');

  await t.test('the row appears and says capture stopped', () => {
    assert.ok(row, 'the status row exists in the Capture page');
    assert.equal(row.hidden, false, 'it is shown while capture is down');
    assert.match(row.textContent, /توقّف/u);
    assert.equal(row.getAttribute('role'), 'status');
    assert.equal(row.getAttribute('aria-live'), 'polite');
  });

  await t.test('the toggle still reads on — which is exactly the trap', () => {
    assert.equal(
      dom.window.document.getElementById('capture-toggle').getAttribute('aria-checked'),
      'true',
      'the setting is untouched; only the running state changed'
    );
  });

  await t.test('and it disappears again once capture is alive', async () => {
    await reviveCapture();
    assert.equal(row.hidden, true);
  });
});
