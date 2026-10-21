// About's update line says how the check ended in its tone, as Figma «08 ·
// نوافذ أخرى» 45:6180 draws it: «أحدث إصدار» in success, a failed check in
// danger, «جارٍ التحقق…» plain. Words carry the meaning; the tone repeats it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('About: the update line takes the tone of its outcome', async () => {
  const html = readFileSync(path.join(here, '../src/about.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/about.html' });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const checks = [{ status: 'upToDate' }, Promise.reject(new Error('offline'))];
  checks[1].catch(() => {});
  let release;
  dom.window.__TAURI__ = {
    core: {
      invoke(cmd) {
        if (cmd === 'check_for_update') return checks.length ? Promise.resolve(checks.shift()) : new Promise((r) => (release = r));
        if (cmd === 'get_settings') return Promise.resolve({ settings: {}, version: '6.0.1' });
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  await import('../src/js/about.js?about-update-tone');
  await flush();
  const doc = dom.window.document;
  const line = doc.getElementById('update-status');
  const button = doc.getElementById('update-btn');

  button.click();
  await flush();
  assert.match(line.textContent, /أحدث إصدار/u);
  assert.equal(line.dataset.tone, 'success');

  button.click();
  await flush();
  assert.match(line.textContent, /تعذّر/u);
  assert.equal(line.dataset.tone, 'danger');

  button.click();
  await flush(2);
  assert.equal(line.textContent, 'جارٍ التحقق…');
  assert.equal(line.dataset.tone ?? '', '', 'a check in progress is neither');
  release({ status: 'upToDate' });
  await flush();
});
