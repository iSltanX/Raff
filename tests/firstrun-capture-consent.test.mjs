// Capture is on by default and the monitor starts before this window opens, so
// the first launch was already recording before it said anything. And رفّ is an
// accessory app — no Dock icon, no ⌘Tab — so a window that closes without
// naming ⇧⌘V leaves the user with no way back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const firstrunHtml = readFileSync(path.join(here, '../src/firstrun.html'), 'utf8');

const SETTINGS = {
  hotkey: 'shift+super+v',
  launchAtLogin: false,
  historyLimit: 500,
  captureEnabled: true,
  respectConcealed: true,
  excludedApps: [],
  learningEnabled: true,
  firstRunShown: false,
  appearance: 'light',
  followSystem: true,
};

const flush = async (times = 12) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function mount(query) {
  const calls = [];
  const dom = new JSDOM(firstrunHtml, { url: 'http://localhost/firstrun.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.__TAURI__ = {
    core: {
      invoke(command, args) {
        calls.push({ command, args });
        if (command === 'get_settings') {
          return Promise.resolve({
            settings: structuredClone(SETTINGS),
            axTrusted: false,
            version: '5.0.1',
            captureAlive: true,
          });
        }
        if (command === 'ax_status') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  await import(`../src/js/firstrun.js?${query}`);
  await flush();
  return { dom, calls };
}

const click = (dom, el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

test('first run: «أبقِه متوقفًا» actually stops capture', async (t) => {
  const { dom, calls } = await mount('consent-off');
  const doc = dom.window.document;

  await t.test('the window says capture is already running', () => {
    assert.match(doc.body.textContent, /يلتقط رفّ ما تنسخه الآن/u);
  });

  await t.test('declining saves captureEnabled: false', async () => {
    const decline = doc.getElementById('capture-decline');
    assert.ok(decline, 'there is a way to say no');
    click(dom, decline);
    await flush();

    const saved = calls.filter((call) => call.command === 'update_settings');
    assert.equal(saved.length, 1, 'exactly one save');
    assert.equal(saved[0].args.settings.captureEnabled, false);
    assert.equal(
      saved[0].args.settings.hotkey,
      SETTINGS.hotkey,
      'and nothing else was invented on the way'
    );
  });

  await t.test('then it teaches the way back in', () => {
    const done = doc.getElementById('completion');
    assert.equal(done.hidden, false);
    assert.match(done.textContent, /⇧⌘V/u);
    assert.match(done.textContent, /شريط القوائم/u);
    assert.ok(doc.getElementById('open-raff'), 'and offers to open رفّ right now');
    assert.notEqual(
      done.closest('.privacy-note'),
      done,
      'kept clear of the permission explanation, which it is not about'
    );
  });
});

test('first run: accepting capture also lands on the completion state', async (t) => {
  const { dom, calls } = await mount('consent-on');
  const doc = dom.window.document;

  click(dom, doc.getElementById('capture-accept'));
  await flush();

  await t.test('accepting saves nothing — capture is already the default', () => {
    assert.equal(
      calls.filter((call) => call.command === 'update_settings').length,
      0,
      'the default needs no write'
    );
  });

  await t.test('and the same completion text is shown', () => {
    const done = doc.getElementById('completion');
    assert.equal(done.hidden, false);
    assert.match(done.textContent, /⇧⌘V/u);
  });
});
