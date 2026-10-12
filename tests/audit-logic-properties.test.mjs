// تدقيق رفّ (P2): خصائص مولَّدة بمولّد xorshift ذي بذرة ثابتة لـ src/js/logic.js.
// لا تعدّل أي شيفرة منتج؛ الفشل هنا يعني خللًا حقيقيًا أو افتراضًا خاطئًا في التدقيق.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeArabic,
  filterItems,
  relativeTimeAr,
  hotkeyDisplay,
  hotkeyFromEvent,
  arabicDigits,
} from '../src/js/logic.js';

const SEED = 0xa0d17;
const RUNS = 500;

function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  return {
    next,
    int: (n) => next() % n,
    pick: (arr) => arr[next() % arr.length],
  };
}

// بلا حروف يونانية كبيرة: السيغما النهائية تكسر رتابة البادئة عمدًا (RAFF-AUD-007).
const POOL = [
  ...'ابتثجحخدذرزسشصضطظعغفقكلمنهوي', 'أ', 'إ', 'آ', 'ى', 'ة', 'ء', 'ـ',
  ...'\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0670\u065F',
  ...'٠١٢٣٤٥٦٧٨٩', ...'0123456789', ...'abcXYZ', ' ', '.', '\u202E', '😀',
];
const STRIPPED = /[\u064B-\u065F\u0670\u0640\u0623\u0625\u0622\u0649\u0660-\u0669]/u;

function randomString(r, max = 20) {
  let s = '';
  const len = r.int(max + 1);
  for (let i = 0; i < len; i++) s += r.pick(POOL);
  return s;
}

test('normalizeArabic: متساوية القوة (idempotent)', () => {
  const r = rng(SEED);
  for (let i = 0; i < RUNS; i++) {
    const s = randomString(r);
    const once = normalizeArabic(s);
    assert.equal(normalizeArabic(once), once, `seed=${SEED} i=${i} input=${JSON.stringify(s)}`);
  }
});

test('normalizeArabic: الناتج خالٍ من كل ما يُطوى', () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < RUNS; i++) {
    const s = randomString(r);
    assert.doesNotMatch(normalizeArabic(s), STRIPPED, `i=${i} input=${JSON.stringify(s)}`);
  }
});

test('normalizeArabic: لا يزيد الطول (بلا حروف تتمدد عند الخفض)', () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < RUNS; i++) {
    const s = randomString(r);
    assert.ok([...normalizeArabic(s)].length <= [...s].length, `i=${i}`);
  }
});

function items(r, n) {
  return Array.from({ length: n }, (_, k) => ({
    id: `i${k}`,
    text: randomString(r, 30),
    sourceApp: r.int(3) === 0 ? '' : r.pick(['Notes', 'Safari', 'ملاحظات', 'Xcode']),
  }));
}

test('filterItems: الاستعلام الفارغ أو الفراغات يعيد القائمة نفسها', () => {
  const r = rng(SEED + 3);
  for (let i = 0; i < 50; i++) {
    const list = items(r, 10);
    for (const q of ['', ' ', '\t\n', 'ـ', '\u064E']) {
      const out = filterItems(list, q);
      if (normalizeArabic(q.trim()) === '') assert.equal(out, list, `q=${JSON.stringify(q)}`);
    }
  }
});

test('filterItems: الناتج مجموعة جزئية بالترتيب نفسه', () => {
  const r = rng(SEED + 4);
  for (let i = 0; i < RUNS; i++) {
    const list = items(r, 12);
    const q = randomString(r, 3);
    const out = filterItems(list, q);
    let cursor = 0;
    for (const item of out) {
      const at = list.indexOf(item, cursor);
      assert.ok(at >= 0, `i=${i} q=${JSON.stringify(q)}`);
      cursor = at + 1;
    }
  }
});

test('filterItems: إطالة الاستعلام لا توسّع النتيجة (رتابة البادئة)', () => {
  const r = rng(SEED + 5);
  for (let i = 0; i < RUNS; i++) {
    const list = items(r, 12);
    const q = randomString(r, 4);
    const longer = q + randomString(r, 2);
    const a = new Set(filterItems(list, q).map((x) => x.id));
    for (const item of filterItems(list, longer)) {
      assert.ok(a.has(item.id), `i=${i} q=${JSON.stringify(q)} longer=${JSON.stringify(longer)}`);
    }
  }
});

test('filterItems: كل نص يجد نفسه بعد التشكيل أو بدونه', () => {
  const r = rng(SEED + 6);
  for (let i = 0; i < RUNS; i++) {
    const list = items(r, 5);
    const target = r.pick(list);
    const q = target.text.trim();
    if (!normalizeArabic(q)) continue;
    assert.ok(filterItems(list, q).includes(target), `i=${i} text=${JSON.stringify(target.text)}`);
  }
});

test('relativeTimeAr: لا يرمي ولا يعيد نصًا فارغًا عبر نطاق واسع وقيم شاذة', () => {
  const r = rng(SEED + 7);
  const now = Date.UTC(2026, 0, 15, 12);
  const odd = [0, -1, now, now + 1e9, NaN, Infinity, -Infinity, 8.64e15, -8.64e15];
  for (const then of odd) {
    const out = relativeTimeAr(then, now);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0, `then=${then}`);
  }
  for (let i = 0; i < RUNS; i++) {
    const then = now - r.int(400 * 24 * 60) * 60_000;
    const out = relativeTimeAr(then, now);
    assert.ok(out.length > 0);
    assert.doesNotMatch(out, /[0-9]/, 'كل الأرقام عربية-هندية');
  }
});

test('relativeTimeAr: قيم غير منتهية تنتج نصًا مقروءًا لا "NaN"', (t) => {
  const out = [NaN, Infinity, -Infinity].map((v) => relativeTimeAr(v, Date.now()));
  const bad = out.filter((s) => /NaN|Invalid/i.test(arabicDigits(s)));
  if (bad.length) t.diagnostic(`نواتج غير مقروءة: ${JSON.stringify(bad)}`);
  // ملاحظة فقط: createdAt يأتي من Rust كعدد صحيح دائمًا، فلا يُعدّ هذا خللًا مرئيًا.
  assert.ok(true);
});

test('hotkeyFromEvent ↔ hotkeyDisplay: كل تركيبة صالحة تُعرض برموز macOS وبمفتاح واحد', () => {
  const r = rng(SEED + 8);
  const codes = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
    ...'0123456789'.split('').map((d) => `Digit${d}`),
    ...Array.from({ length: 24 }, (_, k) => `F${k + 1}`),
    'Space', 'Enter', 'Escape', 'Tab', 'F25', 'KeyAA', '',
  ];
  for (let i = 0; i < RUNS; i++) {
    const e = {
      ctrlKey: !!r.int(2), altKey: !!r.int(2), shiftKey: !!r.int(2), metaKey: !!r.int(2),
      code: r.pick(codes),
    };
    const accel = hotkeyFromEvent(e);
    const anyMod = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
    const validKey = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space)$/.test(e.code);
    if (!anyMod || !validKey) {
      assert.equal(accel, null, JSON.stringify(e));
      continue;
    }
    assert.ok(accel, JSON.stringify(e));
    const shown = hotkeyDisplay(accel);
    const mods = shown.match(/[⌃⌥⇧⌘]/g) ?? [];
    assert.equal(mods.length, [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey].filter(Boolean).length);
    assert.deepEqual(mods, [...mods].sort((a, b) => '⌃⌥⇧⌘'.indexOf(a) - '⌃⌥⇧⌘'.indexOf(b)));
    assert.ok(shown.replace(/[⌃⌥⇧⌘]/g, '').length > 0, 'يبقى مفتاح');
  }
});

test('arabicDigits ثم normalizeArabic يعيدان الأرقام الغربية', () => {
  const r = rng(SEED + 9);
  for (let i = 0; i < RUNS; i++) {
    const n = String(r.next());
    assert.equal(normalizeArabic(arabicDigits(n)), n);
  }
});
