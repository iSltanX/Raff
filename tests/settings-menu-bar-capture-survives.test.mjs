// H6: Settings is open with capture on. The menu bar turns capture off; the
// window is told (raff://changed) but its reload has not landed yet when the
// user flips another switch. The window used to send a whole Settings object
// from its last view, so that save put capture back on behind the user's
// back. It now sends only what changed, and the backend — modelled here as
// the store does it — lays that over what it holds.
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

test('a menu-bar capture change survives a save from a Settings window that has not reloaded', async () => {
  let backend = {
    hotkey: 'shift+super+v',
    launchAtLogin: false,
    historyLimit: 500,
    captureEnabled: true,
    respectConcealed: true,
    excludedApps: ['com.bank'],
    learningEnabled: true,
    firstRunShown: true,
    appearance: 'light',
    followSystem: true,
    retentionDays: 0,
  };
  const saves = [];
  let heldReload = null;
  const listeners = new Map();

  const dom = new JSDOM(settingsHtml, { url: 'http://localhost/settings.html' });
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.__TAURI__ = {
    core: {
      invoke(command, args) {
        if (command === 'get_settings') {
          const snapshot = structuredClone(backend);
          const answer = () => ({
            settings: snapshot,
            axTrusted: true,
            version: '6.0.0',
            captureAlive: true,
            capturePause: { kind: 'off', minutesLeft: null },
          });
          return heldReload ? heldReload.then(answer) : Promise.resolve(answer());
        }
        if (command === 'update_settings') {
          saves.push(structuredClone(args.settings));
          backend = { ...backend, ...structuredClone(args.settings) };
          return Promise.resolve(null);
        }
        if (command === 'list_running_apps' || command === 'learning_summary') return Promise.resolve([]);
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
  await import('../src/js/settings.js?menu-bar-capture');
  await flush();
  const doc = dom.window.document;
  assert.equal(doc.getElementById('capture-toggle').getAttribute('aria-checked'), 'true');

  // «إيقاف الالتقاط» from the menu bar: the store changes and the window is
  // told, but its reload is still on the way...
  backend.captureEnabled = false;
  let release;
  heldReload = new Promise((resolve) => {
    release = resolve;
  });
  listeners.get('raff://changed')?.({});

  // ...when the user flips «التشغيل عند تسجيل الدخول».
  doc.getElementById('launch-toggle').click();
  await flush();
  release();
  heldReload = null;
  await flush();

  assert.deepEqual(saves, [{ launchAtLogin: true }], 'the window sends only what the user changed');
  assert.equal(backend.launchAtLogin, true);
  assert.equal(backend.captureEnabled, false, 'the menu bar turned capture off, and off it stays');
  assert.deepEqual(backend.excludedApps, ['com.bank']);
  assert.equal(doc.getElementById('capture-toggle').getAttribute('aria-checked'), 'false', 'and the window shows it');
});
