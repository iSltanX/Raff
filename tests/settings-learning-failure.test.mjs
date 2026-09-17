// «عرض ما تعلّمه رفّ» awaited `learningSummary()` with no catch, unlike every
// other Settings path. A refusal left an unhandled rejection and a blank panel
// that gave the user nothing to do about it.
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

const flush = async (times = 14) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test('settings: a refused learning summary is stated and retryable', async (t) => {
  let summaryFails = true;
  const unhandled = [];
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
  dom.window.addEventListener('unhandledrejection', (event) =>
    unhandled.push(String(event.reason))
  );

  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'get_settings') {
          return Promise.resolve({
            settings: structuredClone(SETTINGS),
            axTrusted: true,
            version: '5.0.1',
            captureAlive: true,
          });
        }
        if (command === 'learning_summary') {
          return summaryFails
            ? Promise.reject('raff/save-failed')
            : Promise.resolve([
                { text: 'عنصر', copyCount: 3, pasteCount: 1, lastUsedAt: Date.now() },
              ]);
        }
        if (command === 'list_running_apps') return Promise.resolve([]);
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  await import('../src/js/settings.js?learning-failure');
  await flush();

  const doc = dom.window.document;
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  click(doc.getElementById('show-learning'));
  await flush();

  await t.test('the refusal is shown, not swallowed', () => {
    const view = doc.getElementById('learning-view');
    assert.match(view.textContent, /تعذّر عرض/u);
    assert.deepEqual(unhandled, [], 'and no rejected promise is left behind');
  });

  await t.test('a retry button is offered, and it works', async () => {
    const retry = doc.getElementById('retry-learning');
    assert.ok(retry, 'there is something to press');

    summaryFails = false;
    click(retry);
    await flush();

    const view = doc.getElementById('learning-view');
    assert.doesNotMatch(view.textContent, /تعذّر عرض/u);
    assert.match(view.textContent, /عنصر/u);
  });
});
