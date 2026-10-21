// A hotkey saved before the refusals of ت٢٢ (⌘V, ⌘C, ⇧ alone…) keeps working
// and keeps taking that command from every app. رفّ says so plainly, with a
// way to change it — without changing it itself, and without stopping any
// other setting from being saved (ت٣١).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

const SETTINGS = {
  hotkey: 'super+v', // saved before ⌘V was refused (ت٢٢)
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

function createFakeTauri() {
  let settings = structuredClone(SETTINGS);
  const writes = [];
  let failWith = null;
  const tauri = {
    core: {
      invoke(cmd, args) {
        switch (cmd) {
          case 'get_settings':
            return Promise.resolve({ settings: structuredClone(settings), axTrusted: true, version: '6.0.1' });
          case 'update_settings':
            writes.push(structuredClone(args.settings));
            if (failWith) return Promise.reject(failWith);
            settings = { ...settings, ...structuredClone(args.settings) };
            return Promise.resolve(null);
          case 'list_running_apps':
          case 'learning_summary':
            return Promise.resolve([]);
          case 'check_for_update':
            return Promise.resolve({ status: 'upToDate' });
          case 'consume_update_intent':
            return Promise.resolve(false);
          default:
            return Promise.resolve(null);
        }
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  return {
    tauri,
    writes,
    hotkeyWrites: () => writes.filter((write) => 'hotkey' in write),
    failSavesWith(reason) {
      failWith = reason;
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
  const fake = createFakeTauri();
  dom.window.__TAURI__ = fake.tauri;
  await import('../src/js/settings.js?settings-stale-hotkey');
  await flush();
  await flush();
  return { dom, fake };
}

test('settings: a stale refused hotkey is called out, with a way to change it', async () => {
  try {
    globalThis.localStorage?.setItem?.('raff.settings.active-tab', 'settings-tab-about');
  } catch {}
  const { dom, fake } = await mount();
  const doc = dom.window.document;
  const warning = doc.getElementById('hotkey-warning');

  assert.equal(doc.getElementById('settings-tab-general').getAttribute('aria-selected'), 'true', 'opens where it is');
  assert.equal(warning.hidden, false, 'the warning is shown');
  assert.match(warning.textContent, /\u2066⌘V\u2069/u, 'naming the shortcut, isolated from the Arabic');
  assert.match(warning.textContent, /لم يُغيَّر تلقائيًا/u);
  assert.equal(doc.getElementById('hotkey-chip').textContent, '⌘V', 'still what it is');
  assert.deepEqual(fake.hotkeyWrites(), [], 'and not changed behind the user\'s back');

  doc.getElementById('launch-toggle').click();
  await flush();
  await flush();
  assert.deepEqual(fake.writes.at(-1), { launchAtLogin: true }, 'other settings save as before, without the hotkey');

  doc.getElementById('hotkey-warning-action').click();
  assert.ok(doc.getElementById('hotkey-chip').classList.contains('recording'), 'the way to change it starts the recorder');
});
