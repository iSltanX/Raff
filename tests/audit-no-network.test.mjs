// تدقيق رفّ (P2): الواجهة لا تصل إلى الشبكة بنفسها؛ كل اتصال يمر عبر Rust.
// فحص ساكن لكل ملفات src/ ثم فحص تشغيلي للوحة الحقيقية مع واجهات شبكة مزيّفة تسجّل كل نداء.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mountPanel, sampleItem, emptyState, minutesAgo, flush } from './helpers/panel-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '../src');
const files = [
  ...readdirSync(src).filter((f) => /\.(html|js)$/.test(f)).map((f) => path.join(src, f)),
  ...readdirSync(path.join(src, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join(src, 'js', f)),
];

// يُركَّب كل شيء قبل تسجيل أي اختبار: مع --test-force-exit لا يُسجَّل اختبار بعد await.
// ─── تشغيلي ───────────────────────────────────────────────────────────────
const attempts = [];
const state = emptyState();
state.history = [
  sampleItem('a', { text: 'https://example.com/path', createdAt: minutesAgo(1) }),
  sampleItem('b', { text: 'نص عادي', createdAt: minutesAgo(2) }),
];

// تُثبَّت قبل تحميل الوحدة حتى تلتقط أي استخدام مبكر.
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { attempts.push(['fetch', String(args[0])]); return Promise.reject(new Error('blocked')); };
const { dom, fake } = await mountPanel(state);
const w = dom.window;
w.fetch = globalThis.fetch;
w.XMLHttpRequest = class { open(...a) { attempts.push(['xhr', String(a[1])]); } send() {} setRequestHeader() {} };
w.WebSocket = class { constructor(u) { attempts.push(['ws', String(u)]); } };
w.EventSource = class { constructor(u) { attempts.push(['es', String(u)]); } };
w.navigator.sendBeacon = (u) => { attempts.push(['beacon', String(u)]); return false; };

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('فحص ساكن: لا واجهات شبكة في شيفرة الواجهة', () => {
  assert.ok(files.length >= 15);
  const banned = [
    /\bfetch\s*\(/u, /XMLHttpRequest/u, /\bWebSocket\b/u, /\bEventSource\b/u,
    /sendBeacon/u, /\bimport\s*\(\s*['"]https?:/u, /\.innerHTML\s*=/u, /\beval\s*\(/u,
    /new\s+Function\s*\(/u, /document\.write\s*\(/u,
  ];
  const hits = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const re of banned) if (re.test(code)) hits.push(`${path.relative(src, f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('فحص ساكن: لا موارد خارجية في HTML', () => {
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    assert.doesNotMatch(html, /<(script|link|img|iframe)[^>]+(src|href)=["']https?:/iu, f);
  }
});

test('فحص ساكن: CSP يمنع الاتصال بغير الأصل', () => {
  const conf = JSON.parse(readFileSync(path.join(here, '../src-tauri/tauri.conf.json'), 'utf8'));
  const csp = conf.app.security.csp;
  assert.match(csp, /default-src 'self'/u);
  assert.doesNotMatch(csp, /connect-src/u, 'لا استثناء لـ connect-src؛ يرث default-src');
  assert.doesNotMatch(csp, /https?:|\*/u);
});

test('تشغيلي: تفاعلات اللوحة لا تحاول أي اتصال', async () => {
  const doc = w.document;
  const search = doc.getElementById('search');
  for (const q of ['https', 'نص', '']) {
    search.value = q;
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
  }
  const row = doc.querySelector('.row[data-id="a"]');
  row.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await flush();
  fake.emit('raff://changed');
  await flush();
  assert.deepEqual(attempts, []);
  // صورة الرابط لا تُجلب من الويب: لا عناصر img بمصدر خارجي.
  assert.equal(doc.querySelectorAll('img[src^="http"]').length, 0);
});

test.after(() => { globalThis.fetch = realFetch; });
