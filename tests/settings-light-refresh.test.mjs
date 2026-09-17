// The Settings window refetched the whole shelf — up to 1000 rows — on every
// capture, to keep five switches in sync. It reads its own payload now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

const flush = async (times = 12) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test('settings: refreshing costs the preferences, not the whole shelf', async (t) => {
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
            settings: {
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
            },
            axTrusted: true,
            version: '5.0.1',
            captureAlive: true,
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

  await import('../src/js/settings.js?light-refresh');
  await flush();

  await t.test('the first load asks for the settings payload only', () => {
    assert.ok(calls.includes('get_settings'));
    assert.ok(
      !calls.includes('get_state'),
      'the shelf is never fetched by the window that does not show it'
    );
  });

  await t.test('and so does every capture that follows', async () => {
    calls.length = 0;
    await listeners.get('raff://changed')?.({});
    await flush();

    assert.deepEqual(
      calls.filter((call) => call.startsWith('get_')),
      ['get_settings'],
      'a capture costs one small read, not the entire history'
    );
  });
});
