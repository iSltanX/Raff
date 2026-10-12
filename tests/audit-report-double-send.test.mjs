// تدقيق رفّ (P2): إرسال البلاغ مرتين بسرعة. send() لا يحرس busy بنفسه،
// ويعتمد على تعطيل الزر في setBusy(true). نتحقق أن النقر المزدوج لا ينتج نداءين.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportHtml = readFileSync(path.join(here, '../src/report.html'), 'utf8');

const PREVIEW = {
  kind: 'bug', category: 'search', description: 'وصف تجريبي للتدقيق',
  appVersion: '0.0.0', os: 'macos', osVersion: '15.0', arch: 'arm64', locale: 'ar', test: true,
  idempotencyKey: '00000000-0000-4000-8000-000000000000', diagnosticsJson: '{}', image: null,
  endpointHost: 'example.invalid',
};
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const calls = [];
let releaseSend = null;
const dom = new JSDOM(reportHtml, { url: 'http://localhost/report.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__TAURI__ = {
  core: {
    invoke(command, args) {
      calls.push({ command, args });
      if (command === 'report_prepare') return Promise.resolve(structuredClone(PREVIEW));
      if (command === 'report_send') return new Promise((r) => { releaseSend = r; });
      return Promise.resolve(null);
    },
  },
  event: { listen: () => Promise.resolve(() => {}) },
  window: { getCurrentWindow: () => ({ close: () => {} }) },
};
await import('../src/js/report.js?audit-double-send');
await flush();

const doc = dom.window.document;
const el = (id) => doc.getElementById(id);
const sends = () => calls.filter((c) => c.command === 'report_send').length;

doc.querySelector('.kind[data-kind="bug"]').click();
el('description').value = PREVIEW.description;
el('description').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
el('next').click();
await flush();

test('نقرتان متتاليتان على «إرسال» = نداء واحد (HTMLElement.click يحترم disabled)', async () => {
  assert.ok(!el('view-preview').hidden, 'وصلنا إلى المعاينة');
  el('send').click();
  el('send').click();
  await flush();
  assert.equal(sends(), 1);
  assert.equal(el('send').disabled, true);
  releaseSend({ status: 'sent', id: 42 });
  await flush();
  assert.equal(el('report-number').textContent, '#42');
});

test('بعد النجاح يُخفى «إرسال» فلا يصل إليه المستخدم', () => {
  // setBusy(false) يعيد تفعيله، لكنه مخفي: لا يُنقر ولا يأخذ التركيز.
  assert.equal(el('send').hidden, true);
  assert.ok(!el('done').hidden);
});

test('ملاحظة: send() بلا حارس busy خاص به (دفاع بطبقة واحدة)', async (t) => {
  // WebKit لا يستدعي مستمعي النقر على زر معطّل، أما JSDOM فيستدعيهم عند dispatchEvent.
  // لذلك يكشف هذا الاختبار أن send() يعتمد كليًا على disabled، ولا يثبت خللًا مرئيًا.
  const before = sends();
  el('retry').disabled = true;
  el('retry').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  t.diagnostic(`نداءات إضافية عبر dispatchEvent على زر معطّل: ${sends() - before}`);
  assert.ok(sends() - before <= 1);
  if (releaseSend) releaseSend({ status: 'sent', id: 43 });
  await flush();
});
