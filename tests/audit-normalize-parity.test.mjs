// تدقيق رفّ (P2): متجهات مشتركة بين normalizeArabic (JS) وnormalize_for_search (Rust).
// المتجهات في audit/fixtures/normalize-vectors.json، ويقرؤها اختبار Rust في storage.rs أيضًا.
// المتجهات الموسومة RAFF-AUD-007 هي حيث اختلف الطرفان قبل الإصلاح، وتبقى تحت الاختبار.
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

test('التطابق مع نموذج Rust (طيّ حرفًا حرفًا ثم خفض النص كاملًا) لكل متجه غير موسوم', () => {
  const plain = fixture.vectors.filter((v) => !v.divergence);
  assert.ok(plain.length >= 200);
  for (const v of plain) assert.equal(v.expected, v.perCharModel, v.note);
});

const divergent = fixture.vectors.filter((v) => v.divergence);
test('عدد المتجهات المختلفة ثابت ومعروف', () => {
  assert.equal(divergent.length, 5, 'المتجهات الخمسة التي اختلف فيها الطرفان قبل RAFF-AUD-007');
  assert.ok(divergent.every((v) => v.divergence === 'RAFF-AUD-007'));
  assert.ok(divergent.every((v) => /[Σ]/u.test(v.input)), 'كل الاختلافات سببها السيغما');
});

for (const v of divergent) {
  test(`RAFF-AUD-007: «${v.note}» يجب أن يطوي JS وRust النص نفسه`, () => {
    assert.equal(v.expected, v.perCharModel);
  });
}

test('السيغما النهائية في البحث الفوري: οδος يجد الصف وοδοσ لا يجده (والبحث العميق مثله)', () => {
  // كلمة تنتهي بسيغما كبيرة: JS يطويها إلى ς، والاستعلام المكتوب بـσ لا يجدها محليًا.
  // قبل RAFF-AUD-007 كان البحث العميق يعكس ذلك؛ المقابل في Rust:
  // commands::tests::a_final_sigma_is_found_by_the_same_query_on_both_sides.
  const items = [{ id: 'g', text: 'ΟΔΟΣ', sourceApp: '' }];
  assert.equal(filterItems(items, 'οδοσ').length, 0, 'JS لا يجد οδοσ');
  assert.equal(filterItems(items, 'οδος').length, 1);
});

// trim: نموذج storage::trim_query في Rust (RAFF-AUD-008). كان str::trim يعتمد خاصية
// White_Space فيترك U+FEFF ويقصّ U+0085؛ صار يقصّ قائمة JS نفسها: WhiteSpace
// (TAB وVT وFF وU+FEFF وكل Zs) وLineTerminator.
const RUST_TRIM_SET = '\\t\\v\\f\\uFEFF \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000\\n\\r\\u2028\\u2029';
const RUST_WHITESPACE = new RegExp(`^[${RUST_TRIM_SET}]+|[${RUST_TRIM_SET}]+$`, 'gu');
const rustTrimModel = (s) => s.replace(RUST_WHITESPACE, '');

for (const v of fixture.trimVectors) {
  test(`trim ${JSON.stringify(v.input)}`, () => {
    assert.equal(v.input.trim(), v.jsTrim);
    assert.equal(v.jsTrim, rustTrimModel(v.input));
  });
}
