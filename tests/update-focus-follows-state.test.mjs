// IMP-08: each state of the update window hides the buttons of the last. The
// one a keyboard user just pressed — «تنزيل وتثبيت» — vanished with focus on
// it, and focus fell to <body>: Tab started over, and nothing was read. It
// now moves to what the new state offers, or to the status line saying what
// is happening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const updateHtml = readFileSync(path.join(here, '../src/update.html'), 'utf8');
const flush = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('focus follows the update window from state to state', async () => {
  const dom = new JSDOM(updateHtml, { url: 'http://localhost/update.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const listeners = new Map();
  let finishDownload;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'consume_update_intent') return Promise.resolve(true);
        if (command === 'check_for_update') {
          return Promise.resolve({ status: 'available', version: '6.1.0', currentVersion: '6.0.1' });
        }
        if (command === 'download_and_install_update') {
          return new Promise((resolve) => {
            finishDownload = resolve;
          });
        }
        return Promise.resolve(null);
      },
    },
    event: {
      listen(name, handler) {
        listeners.set(name, handler);
        return Promise.resolve(() => {});
      },
    },
    window: { getCurrentWindow: () => ({ close: () => Promise.resolve(), setSize: () => Promise.resolve() }) },
    dpi: { LogicalSize: class {} },
  };
  await import('../src/js/update.js');
  await flush();
  const doc = dom.window.document;
  const download = doc.getElementById('u-download');
  assert.equal(download.hidden, false);

  download.focus();
  download.click();
  await flush();
  assert.notEqual(doc.activeElement, doc.body, 'not dropped to <body> while it downloads');
  assert.equal(doc.activeElement.id, 'u-status', 'on the line saying what is happening');

  finishDownload(null);
  await flush();
  assert.equal(doc.activeElement.id, 'u-restart', 'on what the new state offers');
});
