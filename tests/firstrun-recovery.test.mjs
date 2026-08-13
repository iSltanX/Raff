// The Accessibility permission watcher must never overlap or leak rejected
// promises. Fake window timers make the three-failure backoff deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const firstrunHtml = readFileSync(path.join(here, '../src/firstrun.html'), 'utf8');

const flush = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

function fakeTimers(window) {
  let nextId = 1;
  const scheduled = new Map();
  window.setTimeout = (callback, delay = 0) => {
    const id = nextId;
    nextId += 1;
    scheduled.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => scheduled.delete(id);

  return {
    snapshot: () => [...scheduled.entries()].map(([id, timer]) => ({ id, delay: timer.delay })),
    async runNext() {
      const entry = scheduled.entries().next().value;
      assert.ok(entry, 'a timer is scheduled');
      const [id, timer] = entry;
      scheduled.delete(id);
      timer.callback();
      await flush();
    },
  };
}

test('first-run permission polling backs off and recovers without unhandled rejection', async () => {
  const dom = new JSDOM(firstrunHtml, { url: 'http://localhost/firstrun.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const timers = fakeTimers(dom.window);

  let mode = 'reject';
  let checks = 0;
  let finished = 0;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'ax_status') {
          checks += 1;
          if (mode === 'reject') return Promise.reject(new Error('AX bridge unavailable'));
          return Promise.resolve(mode === 'granted');
        }
        if (command === 'firstrun_done') {
          finished += 1;
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  const uncaught = [];
  dom.window.addEventListener('error', (event) =>
    uncaught.push(String(event.error ?? event.message))
  );
  dom.window.addEventListener('unhandledrejection', (event) =>
    uncaught.push(String(event.reason))
  );

  await import('../src/js/firstrun.js?firstrun-recovery');

  assert.deepEqual(timers.snapshot().map((timer) => timer.delay), [0]);
  await timers.runNext();
  assert.equal(checks, 1);
  assert.deepEqual(timers.snapshot().map((timer) => timer.delay), [1500]);

  await timers.runNext();
  assert.equal(checks, 2);
  assert.deepEqual(timers.snapshot().map((timer) => timer.delay), [3000]);

  await timers.runNext();
  assert.equal(checks, 3);
  assert.deepEqual(timers.snapshot(), [], 'polling stops after the bounded failure count');

  const status = dom.window.document.getElementById('permission-status');
  const retry = dom.window.document.getElementById('permission-retry');
  assert.equal(status.hidden, false);
  assert.equal(status.getAttribute('role'), 'alert');
  assert.equal(status.getAttribute('aria-live'), 'assertive');
  assert.match(status.textContent, /تعذّر التحقق/u);
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, false);

  mode = 'denied';
  retry.click();
  await flush();
  assert.equal(checks, 4);
  assert.equal(status.getAttribute('role'), 'status');
  assert.match(status.textContent, /لم يُمنح الإذن بعد/u);
  assert.deepEqual(timers.snapshot().map((timer) => timer.delay), [1500]);

  mode = 'granted';
  await timers.runNext();
  assert.equal(checks, 5);
  assert.match(status.textContent, /تم منح الإذن/u);
  assert.equal(dom.window.document.getElementById('open-settings').disabled, true);
  assert.equal(dom.window.document.getElementById('later').disabled, true);
  assert.deepEqual(timers.snapshot().map((timer) => timer.delay), [1200]);

  await timers.runNext();
  assert.equal(finished, 1);
  assert.deepEqual(uncaught, []);

  const source = readFileSync(path.join(here, '../src/js/firstrun.js'), 'utf8');
  assert.doesNotMatch(source, /setInterval/u, 'the watcher self-schedules only after settling');
  assert.match(source, /MAX_CONSECUTIVE_FAILURES\s*=\s*3/u);
});
