// تدقيق رفّ (P2): سباق البحث العميق. الردود تصل بغير ترتيب الطلب؛
// الرد القديم يجب ألا يوسّع نتيجة الاستعلام الأحدث.
// تركيب خاص لأن store.js يلتقط invoke عند التحميل، فيجب تغليفه قبل استيراد panel.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createFakeTauri, sampleItem, emptyState, minutesAgo, flush, rowIds } from './helpers/panel-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(here, '../src/index.html'), 'utf8');

const state = emptyState();
state.history = [
  sampleItem('local', { text: 'abc ظاهر', createdAt: minutesAgo(1) }),
  sampleItem('tailA', { text: 'لا شيء هنا 1', createdAt: minutesAgo(2) }),
  sampleItem('tailAB', { text: 'لا شيء هنا 2', createdAt: minutesAgo(3) }),
];

const dom = new JSDOM(indexHtml, { url: 'http://localhost/index.html', virtualConsole: new VirtualConsole() });
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
delete globalThis.IntersectionObserver;

const fake = createFakeTauri(state);
const pending = [];
const baseInvoke = fake.tauri.core.invoke;
fake.tauri.core.invoke = (cmd, args) => {
  if (cmd !== 'search_items') return baseInvoke(cmd, args);
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  pending.push({ query: args.query, resolve });
  return p;
};
dom.window.__TAURI__ = fake.tauri;
const uncaught = [];
dom.window.addEventListener('error', (e) => uncaught.push(String(e.error ?? e.message)));
dom.window.addEventListener('unhandledrejection', (e) => uncaught.push(String(e.reason)));
await import('../src/js/panel.js?audit-race');
await flush();

const search = dom.window.document.getElementById('search');
const type = async (q) => {
  search.value = q;
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await flush();
};

test('رد قديم يصل بعد الأحدث لا يُطبَّق', async () => {
  await type('a');
  await type('ab');
  assert.deepEqual(pending.map((p) => p.query), ['a', 'ab']);
  pending[1].resolve(['tailAB']);
  await flush();
  assert.deepEqual(rowIds(dom).sort(), ['local', 'tailAB']);
  pending[0].resolve(['tailA']);
  await flush();
  assert.deepEqual(rowIds(dom).sort(), ['local', 'tailAB'], 'tailA من الاستعلام القديم لا يظهر');
});

test('مسح الاستعلام ثم وصول رد متأخر لا يضيق أو يوسع القائمة الكاملة', async () => {
  await type('zz');
  const late = pending.at(-1);
  await type('');
  assert.equal(pending.at(-1), late, 'الاستعلام الفارغ لا يسأل Rust');
  late.resolve(['tailA']);
  await flush();
  assert.deepEqual(rowIds(dom).sort(), ['local', 'tailA', 'tailAB']);
});

test('العودة إلى استعلام سابق لا تستعمل نتيجة قديمة له', async () => {
  await type('q1');
  const first = pending.at(-1);
  await type('q2');
  await type('q1');
  const third = pending.at(-1);
  first.resolve(['tailA']);
  await flush();
  assert.ok(!rowIds(dom).includes('tailA'), 'رد الطلب الأول للاستعلام نفسه مُتجاهَل لأن رمزه أقدم');
  third.resolve(['tailAB']);
  await flush();
  assert.deepEqual(rowIds(dom), ['tailAB']);
});

test('لا أخطاء غير ملتقطة', () => {
  assert.deepEqual(uncaught, []);
});
