// The welcome window asks two independent things: whether رفّ may capture,
// and — optionally — whether it may paste for you. Neither answer may be taken
// as the other, and a failed answer may not be reported as a finished setup.
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
  retentionDays: 0,
};

const settle = async (times = 6) => {
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
    pending: () => scheduled.size,
    async drain(limit = 12) {
      for (let step = 0; step < limit && scheduled.size > 0; step += 1) {
        const [id, timer] = scheduled.entries().next().value;
        scheduled.delete(id);
        timer.callback();
        await settle();
      }
    },
  };
}

// `store.js` is evaluated once per test file and keeps the first window's
// `invoke`; every mount therefore routes through this one mutable handler.
let currentInvoke = () => Promise.resolve(null);

async function mount(query, { axGranted = false, saveFails = false, ax = () => axGranted } = {}) {
  const calls = [];
  const dom = new JSDOM(firstrunHtml, { url: 'http://localhost/firstrun.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const timers = fakeTimers(dom.window);
  currentInvoke = (command, args) => {
    calls.push({ command, args });
    if (command === 'ax_status') return Promise.resolve(ax());
    if (command === 'get_settings') {
      return Promise.resolve({
        settings: structuredClone(SETTINGS),
        axTrusted: axGranted,
        version: '5.1.0',
        captureAlive: true,
      });
    }
    if (command === 'update_settings' && saveFails) {
      return Promise.reject('raff/save-failed');
    }
    return Promise.resolve(null);
  };
  dom.window.__TAURI__ = {
    core: { invoke: (command, args) => currentInvoke(command, args) },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  await import(`../src/js/firstrun.js?${query}`);
  await settle();
  return { dom, calls, timers };
}

const finished = (calls) => calls.filter((call) => call.command === 'firstrun_done').length;

test('a permission granted before the welcome does not skip the capture decision', async () => {
  const { dom, calls, timers } = await mount('gap-pregranted', { axGranted: true });
  await timers.drain();

  assert.equal(finished(calls), 0, 'the window must not close itself before capture is answered');
  assert.equal(
    calls.filter((call) => call.command === 'update_settings').length,
    0,
    'and nothing answered the capture question for the user'
  );
  assert.equal(dom.window.document.getElementById('completion').hidden, true, 'nor jumped to «جاهز»');
});

test('granting the permission mid-welcome does not answer the capture question', async () => {
  let granted = false;
  const { dom, calls, timers } = await mount('gap-granted-later', { ax: () => granted });
  await timers.drain(2);
  assert.equal(finished(calls), 0, 'nothing granted yet');

  granted = true;
  await timers.drain();

  assert.equal(finished(calls), 0, 'a granted permission is not a capture decision');
  assert.equal(dom.window.document.getElementById('completion').hidden, true);
});

test('a failed «keep it stopped» does not announce that رفّ is ready', async () => {
  const { dom, calls } = await mount('gap-save-fails', { saveFails: true });
  const doc = dom.window.document;

  doc.getElementById('capture-decline').click();
  await settle(12);

  assert.equal(
    calls.filter((call) => call.command === 'update_settings').length,
    1,
    'the stop was attempted'
  );
  assert.equal(doc.getElementById('completion').hidden, true, '«رفّ جاهز» is not shown');
  assert.equal(doc.getElementById('capture-consent').hidden, false, 'the question stays answerable');
  assert.equal(doc.getElementById('capture-decline').disabled, false, 'and can be retried');
  const error = doc.getElementById('capture-error');
  assert.equal(error.hidden, false, 'the failure is said');
  assert.ok(/لم يتوقف الالتقاط/u.test(error.textContent), 'in the words of what did not happen');
  assert.ok(/ما زال يلتقط/u.test(error.textContent), 'and plainly: capture is still running');
});

test('the welcome does not present the optional permission as a requirement', () => {
  const doc = new JSDOM(firstrunHtml).window.document;
  const heading = doc.querySelector('h1')?.textContent ?? '';
  assert.ok(!/يحتاج إذنًا/u.test(heading), `heading: ${heading}`);
  assert.ok(/اختياري/u.test(doc.body.textContent), 'the permission is named optional');
});

test('changing your mind after «أوقفه» turns capture back on', async () => {
  const { dom, calls } = await mount('gap-change-mind');
  const doc = dom.window.document;
  const saves = () => calls.filter((call) => call.command === 'update_settings').map((call) => call.args.settings.captureEnabled);

  doc.getElementById('capture-decline').click();
  await settle(12);
  assert.deepEqual(saves(), [false], 'declining is saved');

  doc.getElementById('back').click();
  assert.equal(doc.getElementById('capture-consent').hidden, false, 'the question can be revisited');
  doc.getElementById('capture-accept').click();
  await settle(12);
  assert.deepEqual(saves(), [false, true], '«أبقِه يعمل» undoes the stop instead of leaving it saved');

  doc.getElementById('back').click();
  doc.getElementById('capture-accept').click();
  await settle(12);
  assert.deepEqual(saves(), [false, true], 'and agreeing to what is already saved writes nothing');
});

test('the summary follows a permission granted while it is on screen', async () => {
  let granted = false;
  const { dom, timers } = await mount('gap-summary-live', { ax: () => granted });
  const doc = dom.window.document;
  await timers.drain(1);

  doc.getElementById('capture-accept').click();
  await settle(12);
  doc.getElementById('later').click();
  const summary = () => doc.getElementById('completion-summary').textContent;
  assert.ok(/اللصق التلقائي: غير مفعّل/u.test(summary()), 'not granted yet');

  granted = true;
  await timers.drain(2);
  assert.ok(/اللصق التلقائي: مفعّل/u.test(summary()), 'the line updates without leaving the step');
});
