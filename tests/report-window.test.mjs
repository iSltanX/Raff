// The problem-report window (Figma «10» 276:8 · 277:146 · 278:243). The
// webview only shows what Rust hands back: it never builds the payload, never
// reaches the network, never holds the image and never writes the clipboard.
// A send is never retried by building a new payload — that would mint a new
// Idempotency-Key and could file the same report twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportHtml = readFileSync(path.join(here, '../src/report.html'), 'utf8');
const reportJs = readFileSync(path.join(here, '../src/js/report.js'), 'utf8');

const PREVIEW = {
  kind: 'bug',
  category: 'search',
  description: 'البحث لا يجد عنصرًا نسخته للتو',
  appVersion: '5.1.0',
  os: 'macos',
  osVersion: '15.4',
  arch: 'arm64',
  locale: 'ar',
  test: true,
  idempotencyKey: '7d1f9c2e-0000-4000-8000-000000000000',
  diagnosticsJson: '{\n  "schema": 1\n}',
  image: null,
  endpointHost: 'app-reports.isultantf.workers.dev',
};

const flush = async (times = 12) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// store.js binds the invoke of the first mount, so one window serves every
// subtest and each answer is swapped in through this handler.
const calls = [];
let answer = () => Promise.resolve(null);

const dom = new JSDOM(reportHtml, { url: 'http://localhost/report.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = {
  core: {
    invoke(command, args) {
      calls.push({ command, args });
      return answer(command, args);
    },
  },
  event: { listen: () => Promise.resolve(() => {}) },
  window: { getCurrentWindow: () => ({ close: () => calls.push({ command: 'close' }) }) },
};
await import('../src/js/report.js?report-window');
await flush();

const doc = dom.window.document;
const el = (id) => doc.getElementById(id);
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const type = (text) => {
  el('description').value = text;
  el('description').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const visible = (id) => !el(id).hidden;
const called = (command) => calls.filter((call) => call.command === command);

async function toPreview() {
  answer = (command) => (command === 'report_prepare' ? Promise.resolve(structuredClone(PREVIEW)) : Promise.resolve(null));
  click(el('next'));
  await flush();
}

async function sendWith(outcome) {
  answer = (command) => (command === 'report_send' ? Promise.resolve(outcome) : Promise.resolve(null));
  click(el('send'));
  await flush();
}

function backToCompose() {
  click(el('back'));
}

test('the report window never reaches past Rust', () => {
  assert.ok(!/\bfetch\s*\(/u.test(reportJs), 'no fetch');
  assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon/u.test(reportJs), 'no other network API');
  assert.ok(!/navigator\.clipboard/u.test(reportJs), 'copies go through Rust, which skips its own write');
});

test('compose: a kind and a description, within the limit, are needed', () => {
  assert.equal(el('next').disabled, true, 'nothing chosen yet');
  click(doc.querySelector('.kind[data-kind="bug"]'));
  assert.equal(doc.querySelector('.kind[data-kind="bug"]').getAttribute('aria-checked'), 'true');
  assert.equal(el('next').disabled, true, 'a kind alone is not a report');

  type('   ');
  assert.equal(el('next').disabled, true, 'whitespace is not a description');

  type('س'.repeat(1001));
  assert.equal(el('next').disabled, true, 'over the limit');
  assert.ok(visible('description-error'), 'and it says so');
  assert.equal(el('description').getAttribute('aria-invalid'), 'true');

  type(PREVIEW.description);
  assert.equal(el('next').disabled, false);
  assert.ok(!visible('description-error'));
});

test('preview: Rust freezes the payload and the window shows all of it', async () => {
  el('category').value = 'search';
  await toPreview();

  const [prepare] = called('report_prepare');
  assert.deepEqual(prepare.args, { kind: 'bug', category: 'search', description: PREVIEW.description });
  assert.ok(visible('view-preview') && !visible('view-compose'));
  assert.equal(doc.activeElement, el('view-preview'), 'the preview is focused, never «إرسال»');
  const footer = [...el('footer').children].filter((b) => !b.hidden).map((b) => b.id);
  assert.equal(footer.at(-1), 'send', 'the primary ends the row, in DOM and Tab order');
  assert.equal(el('preview-description').textContent, PREVIEW.description);
  assert.equal(el('preview-diagnostics').textContent, PREVIEW.diagnosticsJson, 'the diagnostics exactly as sent');
  assert.ok(el('preview-envelope').textContent.includes(PREVIEW.idempotencyKey), 'the key is shown, not hidden');
  assert.ok(el('preview-destination').textContent.includes(PREVIEW.endpointHost), 'where it goes is named');
  assert.ok(visible('preview-test'), 'a debug build says the report is a test');
  assert.ok(visible('send') && visible('back') && visible('copy-report'));
});

test('a failed send retries the same frozen payload', async () => {
  await sendWith({ status: 'failed', reason: 'network' });
  assert.ok(visible('result-problem'));
  assert.match(el('result-problem-text').textContent, /لا اتصال بالخادم/u);
  assert.match(el('result-problem-text').textContent, /فلن يتكرر/u, 'a retry is promised not to duplicate');
  assert.ok(visible('retry'));

  const prepared = called('report_prepare').length;
  answer = (command) => (command === 'report_send' ? Promise.resolve({ status: 'failed', reason: 'timeout' }) : Promise.resolve(null));
  click(el('retry'));
  await flush();
  assert.equal(called('report_send').length, 2, 'sent again');
  assert.equal(called('report_prepare').length, prepared, 'without building a new payload (and a new key)');
  assert.match(el('result-problem-text').textContent, /انتهت المهلة/u);
});

test('a rate limit counts down instead of offering a retry that cannot work', async () => {
  answer = (command) => (command === 'report_send' ? Promise.resolve({ status: 'rateLimited', retryAfterS: 600 }) : Promise.resolve(null));
  click(el('retry'));
  await flush();
  assert.equal(el('result-problem').dataset.tone, 'warning');
  assert.equal(el('retry').disabled, true);
  assert.match(el('result-problem-text').textContent, /بعد ١٠ دقائق/u, 'the wait is in the sentence, with the count agreeing');
  assert.equal(doc.activeElement, el('result-problem-title'), 'focus moves to what just appeared');
});

test('a rejection names the field, isolated from the Arabic around it', async () => {
  backToCompose();
  assert.ok(visible('view-compose'));
  await toPreview();
  await sendWith({ status: 'rejected', code: 400, error: 'invalid_field', field: 'os_version' });
  assert.match(el('result-problem-text').textContent, /⁦os_version⁩/u);
  assert.match(el('result-problem-text').textContent, /لن تغيّر النتيجة/u, 'and does not invite a pointless resend');
  assert.ok(visible('back') && !visible('retry'), 'editing leads, sending again is not offered');
});

test('Escape keeps what the user wrote', async () => {
  const closes = () => calls.filter((call) => call.command === 'close').length;
  const before = closes();
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(closes(), before, 'a failed report on screen is not discarded by Escape');
});

test('sent: the number is the reference, copied through Rust', async () => {
  backToCompose();
  await toPreview();
  await sendWith({ status: 'sent', id: 42 });
  assert.ok(visible('result-success'));
  assert.equal(el('report-number').textContent, '#42');
  assert.ok(visible('done') && !visible('send') && !visible('retry'));

  answer = () => Promise.resolve(null);
  click(el('copy-number'));
  await flush();
  assert.deepEqual(called('report_copy_number').at(-1).args, { id: 42 });
  assert.equal(el('copy-number').textContent, 'نُسخ الرقم');
  assert.equal(doc.activeElement, el('result-title'), 'the success heading is read first');
});

test('«التالي» waits for an image still being prepared', async () => {
  backToCompose();
  let finish;
  answer = (command) =>
    command === 'report_pick_image' ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(null);
  click(el('attach-choose'));
  await flush();
  assert.equal(el('attachment').dataset.state, 'processing');
  assert.equal(el('next').disabled, true, 'freezing now would leave the image out');

  finish({ mime: 'image/png', bytes: 2048, width: 10, height: 10, thumb: 'data:image/png;base64,' });
  await flush();
  assert.equal(el('attachment').dataset.state, 'attached');
  assert.equal(el('next').disabled, false);

  answer = () => Promise.resolve(null); // the picker was cancelled
  click(el('attach-choose'));
  await flush();
  assert.equal(el('attachment').dataset.state, 'attached', 'cancelling the picker keeps the image');

  click(el('attach-remove'));
  await flush();
  assert.equal(el('attachment').dataset.state, 'empty');
  assert.ok(called('report_remove_image').length >= 1);
});

test('a pasted Finder file is refused with a way forward, not attached as its icon', async () => {
  backToCompose();
  answer = (command) =>
    command === 'report_paste_image' ? Promise.reject('raff/image-pasted-file') : Promise.resolve(null);
  const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  paste.clipboardData = { types: ['Files'] };
  dom.window.dispatchEvent(paste);
  await flush();
  assert.equal(called('report_paste_image').length, 1, 'the pasteboard is read by Rust, at the paste');
  assert.equal(el('attachment').dataset.state, 'error');
  assert.match(el('attachment-detail').textContent, /اختر صورة…/u);
});

test('a text paste is left to the description', async () => {
  const before = called('report_paste_image').length;
  const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  paste.clipboardData = { types: ['text/plain'] };
  dom.window.dispatchEvent(paste);
  await flush();
  assert.equal(called('report_paste_image').length, before);
  assert.equal(paste.defaultPrevented, false);
});
