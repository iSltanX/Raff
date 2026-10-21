// Audit 020 ج4 / IMP-08: Escape leaves the update window as its own buttons
// do. Closing it only hides it (`main.rs`), so a download or a staged restart
// survives, and the tray reopens it where it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const updateHtml = readFileSync(path.join(here, '../src/update.html'), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Escape closes the update window, and nothing else does it unasked', async () => {
  const dom = new JSDOM(updateHtml, { url: 'http://localhost/update.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  let closes = 0;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'consume_update_intent') return Promise.resolve(false);
        if (command === 'check_for_update') return Promise.resolve({ status: 'upToDate' });
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
    window: {
      getCurrentWindow: () => ({
        close: () => {
          closes += 1;
          return Promise.resolve();
        },
        setSize: () => Promise.resolve(),
      }),
    },
    dpi: { LogicalSize: class {} },
  };
  await import('../src/js/update.js');
  await flush();

  const key = (init) =>
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    );
  key({ key: 'a' });
  key({ key: 'Escape', metaKey: true });
  assert.equal(closes, 0, 'only a plain Escape');
  key({ key: 'Escape' });
  assert.equal(closes, 1);
});
