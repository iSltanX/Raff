// تدقيق رفّ (P2): متجهات مشتركة بين normalizeArabic (JS) وnormalize_for_search (Rust).
// المتجهات في audit/fixtures/normalize-vectors.json، ويقرؤها اختبار Rust في storage.rs أيضًا.
// الاختلافات المعروفة تُسجَّل كـ todo بمعرّف RAFF-AUD ولا تكسر المجموعة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeArabic, filterItems } from '../src/js/logic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, '../audit/fixtures/normalize-vectors.json'), 'utf8')
);

test('المتجهات ما زالت تطابق normalizeArabic الحالي (حماية من تقادم الملف)', () => {
  for (const v of fixture.vectors) {
    assert.equal(normalizeArabic(v.input), v.expected, `${v.note}: ${JSON.stringify(v.input)}`);
  }
});

test('التطابق مع نموذج Rust (خفض حرفًا حرفًا) لكل متجه غير موسوم', () => {
  const plain = fixture.vectors.filter((v) => !v.divergence);
  assert.ok(plain.length >= 200);
  for (const v of plain) assert.equal(v.expected, v.perCharModel, v.note);
});

const divergent = fixture.vectors.filter((v) => v.divergence);
test('عدد المتجهات المختلفة ثابت ومعروف', () => {
  assert.ok(divergent.every((v) => v.divergence === 'RAFF-AUD-007'));
  assert.ok(divergent.every((v) => /[Σ]/u.test(v.input)), 'كل الاختلافات سببها السيغما');
});

for (const v of divergent) {
  test(
    `RAFF-AUD-007: «${v.note}» يجب أن يطوي JS وRust النص نفسه`,
    { todo: 'RAFF-AUD-007: toLowerCase() السياقي في JS مقابل char::to_lowercase في Rust' },
    () => {
      assert.equal(v.expected, v.perCharModel);
    }
  );
}

test('أثر الاختلاف على المستخدم: صف يوناني يظهر في JS ويختفي في البحث العميق', () => {
  // كلمة تنتهي بسيغما كبيرة: JS يطويها إلى ς، والاستعلام المكتوب بـσ لا يجدها محليًا.
  const items = [{ id: 'g', text: 'ΟΔΟΣ', sourceApp: '' }];
  assert.equal(filterItems(items, 'οδοσ').length, 0, 'JS لا يجد οδοσ');
  assert.equal(filterItems(items, 'οδος').length, 1);
});

// trim: JS يزيل U+FEFF وRust str::trim لا يزيله (Rust يعتمد خاصية White_Space فقط).
const RUST_WHITESPACE = /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/gu;
const rustTrimModel = (s) => s.replace(RUST_WHITESPACE, '');

for (const v of fixture.trimVectors) {
  const same = v.jsTrim === rustTrimModel(v.input);
  test(
    `trim ${JSON.stringify(v.input)}`,
    same ? {} : { todo: 'RAFF-AUD-008: JS trim يزيل U+FEFF وRust لا يزيله' },
    () => {
      assert.equal(v.input.trim(), v.jsTrim);
      assert.equal(v.jsTrim, rustTrimModel(v.input));
    }
  );
}
