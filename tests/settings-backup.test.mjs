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
          if (args.settings.hotkey === 'alt+super+space') return Promise.reject('raff/hotkey-unavailable');
          const bad = (args.settings.excludedApps ?? []).some(
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
  const saves = () => calls.filter((c) => c.command === 'update_settings').map((c) => c.args.settings);

  await t.test('the buttons say what they export and import', () => {
    assert.equal(doc.getElementById('export-backup').getAttribute('aria-label'), 'تصدير نسخة احتياطية…');
    assert.equal(doc.getElementById('import-backup').getAttribute('aria-label'), 'استيراد نسخة احتياطية…');
  });

  await t.test('export: how many, counted as Arabic counts, and the pictures left out', async () => {
    nextExport = { saved: true, items: 12, pictures: 2 };
    await click('export-backup');
    assert.match(status.textContent, /صُدّر ١٢ عنصرًا من المثبّتات/u);
    assert.match(status.textContent, /الصور المثبّتة \(٢\)/u);
    assert.equal(status.classList.contains('error'), false);
    for (const [items, said] of [
      [1, 'صُدّر عنصر واحد من المثبّتات'],
      [2, 'صُدّر عنصران من المثبّتات'],
      [3, 'صُدّر ٣ عناصر من المثبّتات'],
      [0, 'صُدّرت الإعدادات، ولا مثبّتات فيها'],
    ]) {
      nextExport = { saved: true, items, pictures: 0 };
      await click('export-backup');
      assert.match(status.textContent, new RegExp(said, 'u'));
      assert.doesNotMatch(status.textContent, /الصور/u);
    }
  });

  await t.test('a cancelled panel says nothing', async () => {
    status.textContent = '';
    nextExport = { saved: false, items: 0, pictures: 0 };
    await click('export-backup');
    assert.equal(status.textContent, '');
  });

  await t.test('import: what was added and skipped; preferences only, privacy kept', async () => {
    const before = saves().length;
    nextImport = {
      imported: true,
      added: 5,
      skipped: 3,
      settings: {
        ...SETTINGS,
        // Preferences: applied.
        appearance: 'dark',
        learningEnabled: false,
        // This device's: kept as they are here.
        historyLimit: 50,
        retentionDays: 1,
        captureEnabled: false,
        respectConcealed: false,
        firstRunShown: false,
        // Exclusions only ever grow.
        excludedApps: ['com.example.vault'],
      },
    };
    await click('import-backup');
    assert.match(status.textContent, /أُضيف ٥ عناصر/u);
    assert.match(status.textContent, /تُخطّي ما كان موجودًا من قبل \(٣\)/u);
    assert.match(status.textContent, /وطُبّقت تفضيلاته/u);
    const sent = saves().slice(before);
    assert.equal(sent.length, 1, 'one save, the hotkey being unchanged');
    assert.deepEqual(Object.keys(sent[0]).sort(), ['appearance', 'excludedApps', 'learningEnabled']);
    assert.deepEqual(sent[0].excludedApps, ['com.apple.Notes', 'com.example.vault'], 'added to, never replaced');
    const now = current();
    assert.equal(now.historyLimit, SETTINGS.historyLimit ?? now.historyLimit);
    assert.equal(now.captureEnabled, true);
    assert.equal(now.respectConcealed, true);
    assert.equal(now.appearance, 'dark');
  });

  await t.test('a hotkey this Mac refuses is left out, and only it', async () => {
    const before = saves().length;
    nextImport = {
      imported: true,
      added: 1,
      skipped: 0,
      settings: { ...SETTINGS, hotkey: 'alt+super+space', appearance: 'light', followSystem: false },
    };
    await click('import-backup');
    const sent = saves().slice(before);
    assert.equal(sent[0].hotkey, undefined, 'the preferences go first, without the hotkey');
    assert.equal(sent[0].followSystem, false);
    assert.equal(current().followSystem, false, 'applied although the hotkey is refused');
    assert.equal(sent[1].hotkey, 'alt+super+space', 'then the hotkey alone');
    assert.match(status.textContent, /أُضيف عنصر واحد/u);
    assert.match(status.textContent, /ولم يُطبَّق اختصاره/u);
  });

  await t.test('nothing added says so', async () => {
    nextImport = { imported: true, added: 0, skipped: 2, settings: { ...SETTINGS } };
    await click('import-backup');
    assert.match(status.textContent, /لم يُضف شيء/u);
  });

  await t.test('a file that is not a backup is said to be one, as an error', async () => {
    nextImport = null;
    const invoke = dom.window.__TAURI__.core.invoke;
    dom.window.__TAURI__.core.invoke = (command, args) =>
      command === 'import_backup' ? Promise.reject('raff/backup-invalid') : invoke(command, args);
    await click('import-backup');
    assert.equal(status.textContent, 'ليس ملف نسخة احتياطية من رفّ، أو أنه تالف. لم يُستورد شيء.');
    assert.equal(status.classList.contains('error'), true);
    dom.window.__TAURI__.core.invoke = (command, args) =>
      command === 'import_backup' ? Promise.reject('raff/backup-newer') : invoke(command, args);
    await click('import-backup');
    assert.match(status.textContent, /من إصدار أحدث من رفّ/u);
    dom.window.__TAURI__.core.invoke = invoke;
    nextExport = { saved: true, items: 1, pictures: 0 };
    await click('export-backup');
    assert.equal(status.classList.contains('error'), false, 'success clears the error look');
  });

  await t.test('while one runs, both wait', async () => {
    let release;
    const invoke = dom.window.__TAURI__.core.invoke;
    dom.window.__TAURI__.core.invoke = (command, args) =>
      command === 'export_backup'
        ? new Promise((resolve) => { release = () => resolve({ saved: false }); })
        : invoke(command, args);
    doc.getElementById('export-backup').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(3);
    const group = doc.getElementById('export-backup').parentElement;
    assert.equal(group.getAttribute('aria-busy'), 'true');
    const imports = calls.filter((c) => c.command === 'import_backup').length;
    doc.getElementById('import-backup').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(3);
    assert.equal(calls.filter((c) => c.command === 'import_backup').length, imports, 'the other waits');
    release();
    await flush();
    assert.equal(group.hasAttribute('aria-busy'), false);
    dom.window.__TAURI__.core.invoke = invoke;
  });
});
