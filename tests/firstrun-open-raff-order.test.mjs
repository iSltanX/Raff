// Audit 026 ج3: «افتح رفّ» on the last welcome step opened the panel first
// and marked the welcome done after. When marking it failed, the panel stood
// open over a welcome showing the error. Now one call asks Rust to finish
// the welcome and, only once that held, open the panel — not a second call
// from a page that finishing closes (`firstrun_done`, commands.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const firstrunHtml = readFileSync(path.join(here, '../src/firstrun.html'), 'utf8');
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function mount(query, { finishFails }) {
  const dom = new JSDOM(firstrunHtml, { url: 'http://localhost/firstrun.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const calls = [];
  dom.window.__TAURI__ = {
    core: {
      invoke(command, args) {
        calls.push(args?.openPanel ? `${command}+panel` : command);
        if (command === 'firstrun_done' && finishFails) return Promise.reject(new Error('disk'));
        if (command === 'ax_status') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  await import(`../src/js/firstrun.js?${query}`);
  await settle();
  return { dom, calls };
}

test('«افتح رفّ» asks Rust to finish the welcome and then open the panel', async () => {
  const { dom, calls } = await mount('open-raff-ok', { finishFails: false });
  dom.window.document.getElementById('open-raff').click();
  await settle();
  const order = calls.filter((c) => c.startsWith('firstrun_done') || c === 'show_panel');
  assert.deepEqual(order, ['firstrun_done+panel'], 'one call; no panel opened from the page');
});

test('in Rust the panel opens after the welcome is marked done, before it closes', () => {
  const rust = readFileSync(path.join(here, '../src-tauri/src/commands.rs'), 'utf8');
  const body = rust.slice(rust.indexOf('pub fn firstrun_done('), rust.indexOf('pub struct RunningApp'));
  const marked = body.indexOf('mark_first_run_shown_persisted()');
  const opened = body.indexOf('panel::show(&app)');
  const closed = body.indexOf('.close()');
  assert.ok(marked > 0 && marked < opened && opened < closed, `${marked} ${opened} ${closed}`);
});

test('a welcome that could not be finished opens no panel over its error', async () => {
  const { dom, calls } = await mount('open-raff-fails', { finishFails: true });
  dom.window.document.getElementById('open-raff').click();
  await settle();
  assert.equal(calls.filter((c) => c === 'show_panel').length, 0);
  assert.equal(dom.window.document.getElementById('finish-error').hidden, false);
});
