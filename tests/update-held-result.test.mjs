// Audit 022 ج2: «التحقق» in Settings or About found a version and opened the
// update window — which then asked the server again, and that second check
// dropped the update Rust was holding for the install. The window now shows
// what was found, and asks again only when it was opened to check (the menu).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const updateHtml = readFileSync(path.join(here, '../src/update.html'), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opened with what Settings found, the update window shows it without checking again', async () => {
  const dom = new JSDOM(updateHtml, { url: 'http://localhost/update.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const calls = [];
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        calls.push(command);
        if (command === 'consume_update_intent') {
          return Promise.resolve({
            status: 'available',
            currentVersion: '6.0.1',
            version: '6.1.0',
            date: '2026-10-20',
            notes: 'ملاحظات',
          });
        }
        if (command === 'check_for_update') return Promise.resolve({ status: 'upToDate' });
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
    window: { getCurrentWindow: () => ({ close: () => Promise.resolve(), setSize: () => Promise.resolve() }) },
    dpi: { LogicalSize: class {} },
  };
  await import('../src/js/update.js');
  for (let i = 0; i < 5; i += 1) await flush();

  assert.equal(calls.filter((c) => c === 'check_for_update').length, 0, 'no second check');
  assert.match(dom.window.document.body.textContent, /٦\.١\.٠|6\.1\.0/u, 'the version found is shown');
  assert.equal(dom.window.document.getElementById('u-download').hidden, false, 'ready to install');
});
