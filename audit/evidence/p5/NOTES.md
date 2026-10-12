# P5 — مجسّات الطفرات

- السكربت: `node audit/scripts/p5-mutation-probes.mjs`. يعمل في worktree مؤقت `/tmp/raff-mut` (`--detach HEAD`)، ثم يحذفه تلقائيًا. لم تُلتزم أي طفرة.
- كل طفرة تُطبَّق منفردة باستبدال نصي فريد، يفشل السكربت إن لم يكن النمط فريدًا. تُشغَّل الحزمة الأساسية (`tests/*` عدا `audit-*`) وحزمة التدقيق كلٌّ على حدة، ثم يُستعاد الملف. تحقق السكربت في النهاية من نظافة الشجرة: `yes`.
- قبل الطفرات: الشجرة النظيفة بلا إخفاقات في الحزمتين.
- المخرجات: `mutations.log` و`mutations.json`.

| # | الطفرة | الملف | النتيجة | الأساسية | التدقيق |
|---|---|---|---|---|---|
| M1 | حذف طيّ الألف | logic.js | KILLED | 2 | 2 |
| M2 | حذف إزالة التشكيل | logic.js | KILLED | 2 | 2 |
| M3 | حذف طيّ الألف المقصورة | logic.js | KILLED | 2 | 2 |
| M4 | تجاهل `alsoMatchIds` | logic.js | KILLED | 2 | 2 |
| M5 | `errorMessage` يعيد `String(err)` | panel.js | KILLED | 3 | 0 |
| M6 | حذف فحص `refreshToken` بعد `getState` | panel.js | KILLED | 2 | 0 |
| M7 | حذف فحص `deepSearchToken` | panel.js | **KILLED-BY-AUDIT** | **0** | 2 |
| M8 | `textContent` ← `innerHTML` لنص المقطع | panel.js | KILLED | 1 | 3 |
| M9 | إضافة `mock.js` إلى قائمة السماح | build-frontend.mjs | KILLED | 1 | 0 |

## الاستنتاج
- 9/9 قُتلت، ولا ناجٍ.
- **فجوة تغطية سُدّت:** M7، أي سباق نتائج البحث العميق، كانت ستنجو من الحزمة الأساسية وحدها. اختبار `tests/audit-search-race.test.mjs` هو الذي قتلها. هذه فجوة تغطية وليست عيبًا في المنتج.
- M6 تقتلها الحزمة الأساسية عبر اختبار التحمّل `panel-endurance` فقط. التغطية هنا غير مباشرة، فيُستحسن اختبار مخصص لسباق `refresh`.
- M8 يقتلها في الحزمة الأساسية فحص ساكن للأيقونات وليس اختبار عرض. اختبارات `audit-render-safety` تقتلها سلوكيًا.

## Rust
لم تُجرَ طفرات على Rust هنا، التزامًا بالمواصفة. أمر `cargo mutants` المحصور مضمَّن خلف علم اختياري في `audit/macos/run-native-checks.sh` (P6).
