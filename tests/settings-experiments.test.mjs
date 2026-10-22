// M10 experiments in Settings › الخصوصية › «ما لا يُحفظ», each off by default
// and said to be experimental:
//   - IMP-10 «لا تحفظ ما يشبه مفتاحًا سريًا» (`skipSecrets`).
//   - IMP-09 «اقرأ النص في الصور» (`ocrEnabled`), whose turning off forgets
//     what it read — said beside the switch.
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

  await import('../src/js/settings.js?experiments');
  await flush();
  return { dom, calls, current: () => structuredClone(settings) };
}

test('settings: the experiments are off by default and switch one setting each', async (t) => {
  const { dom, calls, current } = await mount();
  const doc = dom.window.document;
  const saves = () => calls.filter((c) => c.command === 'update_settings').map((c) => c.args.settings);

  await t.test('«لا تحفظ ما يشبه مفتاحًا سريًا»', async () => {
    const toggle = doc.getElementById('secrets-toggle');
    assert.ok(toggle, 'the switch exists');
    assert.equal(toggle.getAttribute('role'), 'checkbox');
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'off by default');
    assert.match(doc.getElementById(toggle.getAttribute('aria-labelledby')).textContent, /ما يشبه مفتاحًا سريًا/u);
    assert.match(doc.getElementById(toggle.getAttribute('aria-describedby')).textContent, /تجريبي/u);
    const before = saves().length;
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    assert.deepEqual(saves().slice(before), [{ skipSecrets: true }]);
    assert.equal(current().skipSecrets, true);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
  });

  await t.test('«اقرأ النص في الصور»', async () => {
    const toggle = doc.getElementById('ocr-toggle');
    assert.ok(toggle, 'the switch exists');
    assert.ok(toggle.closest('#settings-panel-privacy'), 'in the privacy tab, with what Raff keeps');
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'off by default');
    assert.match(doc.getElementById(toggle.getAttribute('aria-labelledby')).textContent, /النص في الصور/u);
    const sub = doc.getElementById(toggle.getAttribute('aria-describedby')).textContent;
    assert.match(sub, /تجريبي/u);
    assert.match(sub, /على جهازك/u);
    assert.match(sub, /إيقافه يمحو/u);
    const before = saves().length;
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    assert.deepEqual(saves().slice(before), [{ ocrEnabled: true }]);
    assert.equal(current().ocrEnabled, true);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
  });
});
