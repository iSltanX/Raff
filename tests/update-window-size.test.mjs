// A failed check shows one line and a retry button, with no version box: it
// stays in the compact window. Only a failed download keeps the release it
// was for on screen, and with it the taller window (live UI audit of
// 2026-10-20, issue 6: the window grew to 430 for an empty space, and
// bounced between the two sizes on every retry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const updateHtml = readFileSync(path.join(here, '../src/update.html'), 'utf8');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('update window: a failed check stays compact, a failed download stays tall', async () => {
  const dom = new JSDOM(updateHtml, { url: 'http://localhost/update.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const heights = [];
  const checks = [
    { status: 'error', message: 'تعذّر التحقق من التحديثات. تحقّق من اتصالك ثم أعد المحاولة.' },
    { status: 'error', message: 'تعذّر التحقق من التحديثات. تحقّق من اتصالك ثم أعد المحاولة.' },
    { status: 'available', version: '6.1.0', date: '2026-10-21', notes: 'ملاحظات' },
  ];
  let hasUpdateIntent = true;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'consume_update_intent') {
          const result = hasUpdateIntent;
          hasUpdateIntent = false;
          return Promise.resolve(result);
        }
        if (command === 'check_for_update') return Promise.resolve(checks.shift());
        if (command === 'download_and_install_update') return Promise.reject('تعذّر تنزيل التحديث.');
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
    window: {
      getCurrentWindow: () => ({
        close: () => Promise.resolve(),
        setSize: (size) => {
          heights.push(size.height);
          return Promise.resolve();
        },
      }),
    },
    dpi: {
      LogicalSize: class {
        constructor(width, height) {
          this.width = width;
          this.height = height;
        }
      },
    },
  };

  await import('../src/js/update.js?update-window-size');
  await flush();
  await flush();
  const byId = (id) => dom.window.document.getElementById(id);

  assert.equal(byId('u-retry').hidden, false, 'the check failed');
  assert.equal(byId('u-available').hidden, true, 'and there is no version box');
  assert.deepEqual(heights, [], 'so the window keeps the size it was built with');

  byId('u-retry').click();
  await flush();
  await flush();
  assert.deepEqual(heights, [], 'a retry that fails again does not bounce it either');

  byId('u-retry').click();
  await flush();
  await flush();
  assert.deepEqual(heights, [430], 'an available release grows it once');

  byId('u-download').click();
  await flush();
  await flush();
  assert.equal(byId('u-available').hidden, false, 'a failed download keeps its release on screen');
  assert.deepEqual(heights, [430], 'and the window stays tall for it');
});
