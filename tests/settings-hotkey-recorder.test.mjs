// The hotkey recorder (live UI audit of 2026-10-20, issues 1 and 2).
//
// Recording used to end only on Escape or a valid combination. Leave it by
// another tab and the window kept swallowing every key — and ⌘V pressed to
// paste into a field became رفّ's global shortcut, taking paste from every
// app. ⇧ alone, and the editing and window shortcuts every app relies on, are
// refused. And a failed save never shows the backend's text: it carried a
// local path and an English system error.
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
  await import('../src/js/settings.js?settings-hotkey-recorder');
  await flush();
  await flush();
  return { dom, fake };
}

function press(dom, target, init) {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

test('settings: the hotkey recorder', async (t) => {
  const { dom, fake } = await mount();
  const doc = dom.window.document;
  const chip = doc.getElementById('hotkey-chip');
  const sub = doc.getElementById('hotkey-sub');
  const recording = () => chip.classList.contains('recording');
  const field = doc.getElementById('excluded-bundle');

  await t.test('leaving it by another tab ends it, and the keys go back to the fields', async () => {
    chip.click();
    assert.equal(recording(), true);

    doc.getElementById('settings-tab-capture').click();
    assert.equal(recording(), false, 'another tab ends recording');
    assert.equal(chip.textContent, '⇧⌘V');

    field.focus();
    assert.equal(press(dom, field, { key: 'c', code: 'KeyC' }).defaultPrevented, false, 'typing works');
    press(dom, field, { key: 'v', code: 'KeyV', metaKey: true });
    await flush();
    assert.deepEqual(fake.hotkeyWrites(), [], '⌘V into a field is a paste, not a shortcut');
    doc.getElementById('settings-tab-general').click();
  });

  await t.test('a click outside it, or the window losing focus, ends it', async () => {
    chip.click();
    doc.getElementById('launch-toggle').dispatchEvent(
      new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    );
    assert.equal(recording(), false, 'a click elsewhere');

    chip.click();
    dom.window.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(recording(), false, 'the window behind another');
  });

  await t.test('⇧ alone, and the shortcuts every app uses, are refused with a reason', async () => {
    chip.click();
    press(dom, dom.window, { key: 'A', code: 'KeyA', shiftKey: true });
    await flush();
    assert.deepEqual(fake.hotkeyWrites(), [], '⇧A would take a capital letter from all typing');
    assert.equal(recording(), false);
    assert.equal(sub.textContent, 'أضف ⌘ أو ⌥ أو ⌃ إلى الاختصار.');
    assert.ok(sub.classList.contains('error'));

    for (const key of ['C', 'V', 'X', 'A', 'Z', 'Q', 'W']) {
      chip.click();
      press(dom, dom.window, { key: key.toLowerCase(), code: `Key${key}`, metaKey: true });
      await flush();
      assert.deepEqual(fake.hotkeyWrites(), [], `⌘${key}`);
      assert.equal(sub.textContent, `كل التطبيقات تستعمل \u2066⌘${key}\u2069. اختر غيره.`);
    }

    chip.click();
    press(dom, dom.window, { key: 'k', code: 'KeyK', metaKey: true, shiftKey: true });
    await flush();
    assert.deepEqual(fake.hotkeyWrites(), [{ hotkey: 'shift+super+k' }], 'an ordinary one is saved');
  });

  await t.test('a new try clears the last reason', async () => {
    chip.click();
    press(dom, dom.window, { key: 'A', code: 'KeyA', shiftKey: true });
    await flush();
    assert.ok(sub.classList.contains('error'));

    chip.click();
    assert.equal(sub.textContent, 'انقر على الاختصار ثم اضغط التركيبة الجديدة');
    assert.equal(sub.classList.contains('error'), false, 'not the old reason, and not in red');
    assert.equal(chip.textContent, 'اضغط الاختصار…');
    press(dom, dom.window, { key: 'Escape', code: 'Escape' });
  });

  await t.test('a failed save says so in Arabic, with no path or system error', async () => {
    for (const reason of [
      'تعذّر حفظ /tmp/raff-ui-audit-data/settings.json: Is a directory (os error 21)',
      'raff/save-failed',
    ]) {
      fake.failSavesWith(reason);
      chip.click();
      press(dom, dom.window, { key: 'j', code: 'KeyJ', metaKey: true, shiftKey: true });
      await flush();
      await flush();
      assert.equal(sub.textContent, 'تعذّر حفظ الاختصار. حاول مرة أخرى.', reason);
    }
    fake.failSavesWith('raff/hotkey-unavailable');
    chip.click();
    press(dom, dom.window, { key: 'j', code: 'KeyJ', metaKey: true, shiftKey: true });
    await flush();
    await flush();
    assert.equal(sub.textContent, 'تعذّر تسجيل هذا الاختصار. اختر غيره.');
  });
});
