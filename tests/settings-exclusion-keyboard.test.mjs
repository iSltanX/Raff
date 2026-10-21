// Audit 020 ج3 / IMP-08: the manual exclusion field answers Enter like its
// button, marks itself invalid with the error it was refused for, and a
// removal gives the app back to the running-apps picker and keeps focus in
// the list instead of dropping it with the removed row.
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
  excludedApps: ['com.apple.Notes', 'com.apple.Terminal'],
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
          settings = { ...settings, ...structuredClone(args.settings) };
          return Promise.resolve(null);
        }
        if (command === 'list_running_apps') {
          return Promise.resolve(
            [
              { name: 'Notes', bundleId: 'com.apple.Notes' },
              { name: 'Safari', bundleId: 'com.apple.Safari' },
            ]
          );
        }
        if (command === 'learning_summary') return Promise.resolve([]);
        if (command === 'consume_update_intent') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  await import('../src/js/settings.js?exclusion-keyboard');
  await flush();
  return { dom, calls, current: () => structuredClone(settings) };
}

test('settings: the exclusion list works from the keyboard', async (t) => {
  const { dom, calls, current } = await mount();
  const doc = dom.window.document;
  const field = doc.getElementById('excluded-bundle');
  const error = doc.getElementById('excluded-manual-error');
  const press = (key) =>
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const type = (value) => {
    field.value = value;
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  doc.getElementById('manage-excluded').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();

  await t.test('Enter in the field adds the id, as the button does', async () => {
    type('com.agilebits.onepassword7');
    press('Enter');
    await flush();
    assert.deepEqual(current().excludedApps, [
      'com.apple.Notes',
      'com.apple.Terminal',
      'com.agilebits.onepassword7',
    ]);
    assert.equal(field.value, '');
  });

  await t.test('a refused id marks the field invalid, and typing clears it', async () => {
    type('com.bad id');
    press('Enter');
    await flush();
    assert.equal(error.hidden, false);
    assert.equal(field.getAttribute('aria-invalid'), 'true');
    assert.ok(field.getAttribute('aria-describedby').split(' ').includes('excluded-manual-error'));
    type('com.good.id');
    assert.equal(field.hasAttribute('aria-invalid'), false);
  });

  await t.test('removing an app gives it back to the picker and keeps focus in the list', async () => {
    const picker = () => [...doc.getElementById('running-apps').options].map((o) => o.value);
    assert.deepEqual(picker(), ['com.apple.Safari'], 'Notes is excluded, so not offered');
    const listed = () => [...doc.querySelectorAll('#excluded-list .bundle')].map((b) => b.textContent);
    const removeOf = (id) =>
      [...doc.querySelectorAll('#excluded-list .remove-excluded')].find(
        (b) => b.getAttribute('aria-label') === `إزالة ${id}`
      );
    const before = calls.filter((c) => c.command === 'list_running_apps').length;
    const notes = removeOf('com.apple.Notes');
    notes.focus();
    notes.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    assert.deepEqual(listed(), ['com.apple.Terminal', 'com.agilebits.onepassword7']);
    assert.ok(calls.filter((c) => c.command === 'list_running_apps').length > before, 'picker refreshed');
    assert.deepEqual(picker(), ['com.apple.Notes', 'com.apple.Safari']);
    assert.equal(doc.activeElement, removeOf('com.apple.Terminal'), 'on the row that took its place');
  });
});
