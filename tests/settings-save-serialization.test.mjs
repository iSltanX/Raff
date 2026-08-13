// Complete-object Settings writes must be serialized. These interactions use
// manually deferred IPC promises so a regression cannot pass merely because
// the fake backend happens to resolve writes immediately and in order.
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferredSettingsBackend() {
  let settings = structuredClone(INITIAL_SETTINGS);
  const pending = [];
  const writes = [];

  const tauri = {
    core: {
      invoke(command, args) {
        if (command === 'get_state') {
          return Promise.resolve({
            pinned: [],
            history: [],
            settings: structuredClone(settings),
            axTrusted: true,
            version: '4.0.0',
          });
        }
        if (command === 'update_settings') {
          const next = structuredClone(args.settings);
          writes.push(next);
          return new Promise((resolve, reject) => pending.push({ next, resolve, reject }));
        }
        if (command === 'list_running_apps') return Promise.resolve([]);
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
    writes,
    pending,
    current: () => structuredClone(settings),
    resolveNext() {
      const request = pending.shift();
      assert.ok(request, 'a deferred settings write is waiting');
      settings = structuredClone(request.next);
      request.resolve(null);
    },
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

  const backend = deferredSettingsBackend();
  dom.window.__TAURI__ = backend.tauri;
  await import('../src/js/settings.js?settings-save-serialization');
  await flush();
  return { dom, backend };
}

test('settings complete-object saves are serialized and composed', async (t) => {
  const { dom, backend } = await mount();
  const byId = (id) => dom.window.document.getElementById(id);

  await t.test('rapid unrelated controls cannot clobber one another', async () => {
    byId('launch-toggle').click();
    byId('capture-toggle').click();
    await flush();

    assert.equal(backend.writes.length, 1, 'only the head mutation reaches IPC');
    assert.equal(backend.pending.length, 1);
    assert.equal(backend.writes[0].launchAtLogin, true);
    assert.equal(backend.writes[0].captureEnabled, true);

    backend.resolveNext();
    await flush();

    assert.equal(backend.writes.length, 2, 'the second mutation begins after the first commits');
    assert.equal(backend.writes[1].launchAtLogin, true, 'the first unrelated value is retained');
    assert.equal(backend.writes[1].captureEnabled, false, 'the second control applies its change');

    backend.resolveNext();
    await flush();
    assert.equal(backend.current().launchAtLogin, true);
    assert.equal(backend.current().captureEnabled, false);
  });

  await t.test('two rapid clicks deterministically toggle twice', async () => {
    const launch = byId('launch-toggle');
    launch.click();
    launch.click();
    await flush();

    assert.equal(backend.writes.length, 3, 'only the first click of the pair is in flight');
    assert.equal(backend.writes[2].launchAtLogin, false);

    backend.resolveNext();
    await flush();
    assert.equal(backend.writes.length, 4);
    assert.equal(
      backend.writes[3].launchAtLogin,
      true,
      'the second click resolves against the first click rather than the stale initial value'
    );

    backend.resolveNext();
    await flush();
    assert.equal(backend.current().launchAtLogin, true, 'two toggles return to the prior state');
    assert.equal(backend.current().captureEnabled, false, 'the unrelated mutation still survives');
  });
});
