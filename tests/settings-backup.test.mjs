// IMP-05: «تصدير…» and «استيراد…» in Settings › الالتقاط › النسخ الاحتياطي.
// Rust runs the native panels and reads or writes the file; Settings says what
// happened in words, and saves an imported file's settings through its own
// path — which refuses a bad shortcut as it always does.
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
  excludedApps: ['com.apple.Notes'],
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

/** Mirrors `validate_settings`: a bundle id may not be empty, over-long, or
 *  carry whitespace or control characters. */
const REJECTED = new RegExp('[\\s\\u0000-\\u001f]', 'u');

let nextExport = null;
let nextImport = null;

async function mount() {
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
          const bad = args.settings.excludedApps.some(
            (id) => !id || REJECTED.test(id) || id.length > 200
          );
          if (bad) return Promise.reject('قائمة التطبيقات المستثناة غير صالحة');
          settings = { ...settings, ...structuredClone(args.settings) };
          return Promise.resolve(null);
        }
        if (command === 'list_running_apps') return Promise.resolve([]);
        if (command === 'export_backup') return Promise.resolve(nextExport);
        if (command === 'import_backup') return Promise.resolve(nextImport);
        if (command === 'learning_summary') return Promise.resolve([]);
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  await import('../src/js/settings.js?backup');
  await flush();
  return { dom, calls, current: () => structuredClone(settings) };
}

test('settings: backup and restore say what they did', async (t) => {
  const { dom, calls, current } = await mount();
  const doc = dom.window.document;
  const status = doc.getElementById('backup-status');
  const click = async (id) => {
    doc.getElementById(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
  };

  await t.test('export: how many, and the pictures left out', async () => {
    nextExport = { saved: true, items: 12, pictures: 2 };
    await click('export-backup');
    assert.match(status.textContent, /صُدّر ١٢ عنصرًا مثبّتًا/u);
    assert.match(status.textContent, /الصور المثبّتة \(٢\)/u);
  });

  await t.test('a cancelled panel says nothing', async () => {
    status.textContent = '';
    nextExport = { saved: false, items: 0, pictures: 0 };
    await click('export-backup');
    assert.equal(status.textContent, '');
  });

  await t.test('import: what was added and skipped, and the settings saved', async () => {
    nextImport = {
      imported: true,
      added: 5,
      skipped: 3,
      settings: { ...SETTINGS, historyLimit: 1000, firstRunShown: false },
    };
    await click('import-backup');
    assert.match(status.textContent, /أُضيف ٥/u);
    assert.match(status.textContent, /تُرك ٣/u);
    const saved = calls.filter((c) => c.command === 'update_settings').at(-1);
    assert.equal(saved.args.settings.historyLimit, 1000);
    assert.equal('firstRunShown' in saved.args.settings, false, 'the welcome is not brought back');
    assert.equal(current().historyLimit, 1000);
  });

  await t.test('a file that is not a backup is said to be one', async () => {
    nextImport = null;
    const invoke = dom.window.__TAURI__.core.invoke;
    dom.window.__TAURI__.core.invoke = (command, args) =>
      command === 'import_backup' ? Promise.reject('raff/backup-invalid') : invoke(command, args);
    await click('import-backup');
    assert.match(status.textContent, /ليس ملف نسخة احتياطية من رفّ/u);
    dom.window.__TAURI__.core.invoke = invoke;
  });
});
