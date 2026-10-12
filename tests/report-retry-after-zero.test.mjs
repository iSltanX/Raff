// `Retry-After: 0` means "send again now" (RFC 9110 §10.2.3), and since
// RAFF-AUD-009 Rust passes the 0 through instead of turning it into an hour.
// The countdown then ends on its first tick — so nothing after it may take
// the retry button back, or the window says «يمكنك الإرسال الآن» over a
// button that can never be pressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportHtml = readFileSync(path.join(here, '../src/report.html'), 'utf8');

const PREVIEW = {
  kind: 'bug',
  category: 'search',
  description: 'وصف',
  appVersion: '6.0.0',
  os: 'macos',
  osVersion: '15.4',
  arch: 'arm64',
  locale: 'ar',
  test: true,
  idempotencyKey: '7d1f9c2e-0000-4000-8000-000000000001',
  diagnosticsJson: '{\n  "schema": 1\n}',
  image: null,
  endpointHost: 'app-reports.isultantf.workers.dev',
};

const flush = async (times = 12) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

let answer = () => Promise.resolve(null);
const sends = [];
const dom = new JSDOM(reportHtml, { url: 'http://localhost/report.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = {
  core: {
    invoke(command, args) {
      if (command === 'report_send') sends.push(args);
      return answer(command, args);
    },
  },
  event: { listen: () => Promise.resolve(() => {}) },
  window: { getCurrentWindow: () => ({ close: () => {} }) },
};
await import('../src/js/report.js?retry-after-zero');
await flush();

const el = (id) => dom.window.document.getElementById(id);
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

test('a rate limit of zero seconds leaves the retry button usable', async () => {
  el('description').value = 'البحث لا يجد عنصرًا';
  el('description').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  answer = (command) => (command === 'report_prepare' ? Promise.resolve(structuredClone(PREVIEW)) : Promise.resolve(null));
  click(el('next'));
  await flush();

  answer = (command) =>
    command === 'report_send' ? Promise.resolve({ status: 'rateLimited', retryAfterS: 0 }) : Promise.resolve(null);
  click(el('send'));
  await flush();

  assert.match(el('result-problem-text').textContent, /يمكنك الإرسال الآن/u);
  assert.equal(el('retry').hidden, false);
  assert.equal(el('retry').disabled, false, 'the sentence and the button agree');

  answer = (command) => (command === 'report_send' ? Promise.resolve({ status: 'sent', id: 7 }) : Promise.resolve(null));
  click(el('retry'));
  await flush();
  assert.equal(sends.length, 2, 'and pressing it sends again');
});
