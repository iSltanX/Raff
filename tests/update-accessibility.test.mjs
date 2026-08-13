// Accessibility semantics for the standalone update window. This drives the
// real renderer through its Tauri events so status urgency and determinate /
// indeterminate progress are verified as behavior, not just static markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const updateHtml = readFileSync(path.join(here, '../src/update.html'), 'utf8');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('update window announces state and exposes native progress semantics', async () => {
  const dom = new JSDOM(updateHtml, { url: 'http://localhost/update.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const listeners = new Map();
  const resizeCalls = [];
  let hasUpdateIntent = true;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'consume_update_intent') {
          const result = hasUpdateIntent;
          hasUpdateIntent = false;
          return Promise.resolve(result);
        }
        if (command === 'check_for_update') {
          return Promise.resolve({
            status: 'available',
            version: '4.1.0',
            date: '2026-08-12',
            notes: 'ملاحظات إصدار طويلة تبقى مرئية عند تعذّر التنزيل.',
          });
        }
        return Promise.resolve(null);
      },
    },
    event: {
      listen(name, handler) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handler);
        return Promise.resolve(() => listeners.get(name)?.delete(handler));
      },
    },
    window: {
      getCurrentWindow: () => ({
        close: () => Promise.resolve(),
        setSize: (size) => {
          resizeCalls.push([size.width, size.height]);
          return Promise.resolve();
        },
      }),
    },
    dpi: {
      LogicalSize: class LogicalSize {
        constructor(width, height) {
          this.width = width;
          this.height = height;
        }
      },
    },
  };

  await import('../src/js/update.js');
  await flush();

  const byId = (id) => dom.window.document.getElementById(id);
  const emit = (name, payload = null) => {
    for (const handler of listeners.get(name) ?? []) handler({ event: name, payload });
  };

  const windowEl = byId('update-window');
  const status = byId('u-status');
  const progress = byId('u-progress');
  const bar = byId('u-bar');

  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuemin'), '0');
  assert.equal(bar.getAttribute('aria-valuemax'), '100');
  assert.ok(bar.getAttribute('aria-label'));
  assert.ok(
    [...dom.window.document.querySelectorAll('.update-actions button')].every(
      (button) => button.type === 'button'
    )
  );

  assert.equal(byId('u-available').hidden, false, 'available release context is visible');
  assert.equal(byId('u-new-version').textContent, 'الإصدار ٤.١.٠');
  assert.equal(byId('u-notes').hidden, false);
  assert.deepEqual(resizeCalls, [[360, 430]], 'the release context selects the expanded tier');

  emit('raff://update/progress', { downloaded: 25, total: 100, percent: 25 });
  assert.equal(windowEl.getAttribute('aria-busy'), 'true');
  assert.equal(progress.hidden, false);
  assert.equal(bar.getAttribute('aria-valuenow'), '25');
  assert.equal(bar.getAttribute('aria-valuetext'), '٢٥٪');

  emit('raff://update/progress', { downloaded: 30, total: null, percent: null });
  assert.equal(bar.hasAttribute('aria-valuenow'), false);
  assert.equal(bar.getAttribute('aria-valuetext'), 'جارٍ التقدّم…');
  assert.equal(bar.classList.contains('indeterminate'), true);

  emit('raff://update/error', { message: 'تعذّر تنزيل التحديث.' });
  assert.equal(windowEl.getAttribute('aria-busy'), 'false');
  assert.equal(status.getAttribute('role'), 'alert');
  assert.equal(status.getAttribute('aria-live'), 'assertive');
  assert.equal(status.textContent, 'تعذّر تنزيل التحديث.');
  assert.equal(byId('u-available').hidden, false, 'version and notes remain visible for retry');
  assert.equal(byId('u-retry').hidden, false, 'the retry action remains visible');
  assert.deepEqual(
    resizeCalls,
    [[360, 430]],
    'a download error never collapses the release context into the clipping 280px tier'
  );

  emit('raff://update/installed');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, 'اكتمل التثبيت');
  assert.deepEqual(resizeCalls.at(-1), [360, 280], 'a context-free terminal state compacts again');
});
