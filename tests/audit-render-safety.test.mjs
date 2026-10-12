// تدقيق رفّ (P2): نصوص عدائية في اللوحة الحقيقية (JSDOM + src/js/panel.js).
// الحمولة تُعرض نصًا حرفيًا ولا تولّد عناصر، ولا تُحدث أخطاء غير ملتقطة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, sampleItem, emptyState, minutesAgo, flush, rowIds } from './helpers/panel-harness.mjs';

const PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=2</script>',
  '"><svg onload="window.__pwned=3">',
  '<a href="javascript:window.__pwned=4">انقر</a>',
  '\u202Egnp.exe',
  '{{constructor.constructor("window.__pwned=5")()}}',
  '&lt;b&gt;مُرمَّز&lt;/b&gt;',
];

const state = emptyState();
state.history = PAYLOADS.map((text, i) =>
  sampleItem(`p${i}`, { text, sourceApp: i === 0 ? '<b>App</b>' : 'Notes', createdAt: minutesAgo(i + 1) })
);
state.history.push(sampleItem('huge', { text: 'س'.repeat(100_000), createdAt: minutesAgo(30) }));
state.history.push(sampleItem('nul', { text: 'a\u0000b\uFFFDc\uD800', createdAt: minutesAgo(31) }));

const { dom, uncaught } = await mountPanel(state);
const doc = dom.window.document;

test('كل الصفوف تُعرض', () => {
  assert.equal(rowIds(dom).length, PAYLOADS.length + 2);
});

test('لا عناصر محقونة داخل القائمة', () => {
  const list = doc.getElementById('list');
  assert.equal(list.querySelectorAll('script, iframe, object, embed').length, 0);
  assert.equal(list.querySelectorAll('img[src="x"], svg[onload], a[href^="javascript:"]').length, 0);
  assert.equal(list.querySelectorAll('[onerror], [onload], [onclick]').length, 0);
  assert.equal(list.querySelector('b'), null, 'وسم <b> في اسم المصدر يبقى نصًا');
  assert.equal(dom.window.__pwned, undefined);
});

test('الحمولة تظهر حرفيًا كنص', () => {
  PAYLOADS.forEach((p, i) => {
    const title = doc.querySelector(`.row[data-id="p${i}"] .preview-title`);
    assert.equal(title?.textContent, p, `p${i}`);
  });
  const kind = doc.querySelector('.row[data-id="p0"] .row-kind');
  assert.match(kind.getAttribute('title'), /<b>App<\/b>/u, 'اسم المصدر في السمة حرفيًا');
});

test('النص الطويل جدًا لا يُعلّق اللوحة ولا يُدرج كاملًا مرات عديدة', async () => {
  const row = doc.querySelector('.row[data-id="huge"]');
  assert.ok(row);
  assert.ok(row.textContent.length <= 100_100, `طول الصف ${row.textContent.length}`);
  const search = doc.getElementById('search');
  const t0 = performance.now();
  search.value = 'سسس';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await flush();
  const ms = performance.now() - t0;
  assert.ok(rowIds(dom).includes('huge'));
  assert.ok(ms < 2000, `البحث استغرق ${ms.toFixed(0)}ms`);
});

test('لا أخطاء غير ملتقطة', () => {
  assert.deepEqual(uncaught, []);
});
