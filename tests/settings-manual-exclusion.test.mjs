// The exclusion picker was built entirely from `runningApplications()` filtered
// to Regular activation policy — so it could not offer a closed app, nor one
// that lives in the menu bar, which is exactly where the apps worth excluding
// tend to live. A typed bundle id reaches both.
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
          settings = structuredClone(args.settings);
          return Promise.resolve(null);
        }
        if (command === 'list_running_apps') return Promise.resolve([]);
        if (command === 'learning_summary') return Promise.resolve([]);
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  await import('../src/js/settings.js?manual-exclusion');
  await flush();
  return { dom, calls, current: () => structuredClone(settings) };
}

test('settings: a bundle id can be typed in', async (t) => {
  const { dom, calls, current } = await mount();
  const doc = dom.window.document;
  const field = doc.getElementById('excluded-bundle');
  const add = doc.getElementById('add-excluded-manual');
  const error = doc.getElementById('excluded-manual-error');

  const type = (value) => {
    field.value = value;
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const submit = async () => {
    add.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
  };

  await t.test('the field sits beside the picker, which stays the main road', () => {
    assert.ok(field, 'there is a text field');
    assert.ok(doc.getElementById('running-apps'), 'and the list of running apps is still there');
    assert.equal(field.getAttribute('dir'), 'ltr', 'bundle ids are Latin identifiers');
  });

  await t.test('a well-formed id is saved', async () => {
    type('com.agilebits.onepassword7');
    await submit();

    const saved = calls.filter((call) => call.command === 'update_settings');
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].args.settings.excludedApps, [
      'com.apple.Notes',
      'com.agilebits.onepassword7',
    ]);
    assert.equal(error.hidden, true, 'nothing to complain about');
    assert.equal(field.value, '', 'and the field is ready for the next one');
  });

  await t.test('an id with a space is refused and changes nothing', async () => {
    const before = current().excludedApps;
    type('com.example bad id');
    await submit();

    assert.equal(error.hidden, false, 'the refusal is stated');
    assert.match(error.textContent, /غير صالح/u);
    assert.deepEqual(current().excludedApps, before, 'the list is untouched');
  });

  await t.test('and an id already on the list is not added twice', async () => {
    const before = calls.filter((call) => call.command === 'update_settings').length;
    type('com.apple.Notes');
    await submit();

    assert.equal(
      calls.filter((call) => call.command === 'update_settings').length,
      before,
      'no pointless round trip'
    );
  });
});
