# P4 — فحوص الواجهة التقريبية

> **تقريب: WebKit عبر Playwright ≠ WKWebView داخل Tauri على macOS.** الصفحات تُقدَّم من `src/` عبر `127.0.0.1`، والبيانات من `mock.js` لغياب `__TAURI__`. الأمر `invoke` الحقيقي وحجم النافذة الأصلي وشفافية النافذة والخطوط عبر بروتوكول الأصول غير ممثلة.

## البيئة
- Playwright WebKit 27.2 (v2370) و`axe-core`، مثبّتان في `/tmp/raff-p4` خارج المستودع. لم يُعدَّل أي ملف manifest.
- السكربت: `NODE_PATH=/tmp/raff-p4/node_modules node audit/scripts/p4-ui-approx.mjs`
- المخرجات: `ui-approx.log` (ملخص)، و`ui-approx.json` (التفاصيل)، و`*-{light,dark}.png` (لقطات بالأحجام الحقيقية).
- شُغّلت 6 صفحات × فاتح/داكن = 12 تشغيلًا. كلها PASS في: `dir=rtl` و`lang=ar` (12/12)، ولا أخطاء console، ولا طلبات شبكة خارجية، ولا فيض أفقي على مستوى المستند.

## النتائج

| الصفحة | axe | ملاحظة |
|---|---|---|
| index (اللوحة) 460×540 | `page-has-heading-one` (moderate)؛ **داكن فقط:** `color-contrast` (serious×9) | في الوضع الداكن على خلفية الصف `#505050`: نسبة التباين 3.58 لـ`.preview-title.is-link`، و3.08 لـ`.row-time` بحجم 11px، و4.1 لنص 11px عريض. الحد المطلوب 4.5. |
| settings 560×440 | `heading-order` (moderate)، `label-content-name-mismatch` (serious) على `#hotkey-chip` | الاسم الوصولي لشريحة الاختصار لا يتضمن نصها الظاهر (WCAG 2.5.3). لوحة التبويب `section#settings-panel-general` قابلة للتركيز بلا مؤشر تركيز مرئي. |
| about 320×420 | 0 | — |
| report 460×600 | `page-has-heading-one` (moderate) | ترتيب Tab منطقي: زر، ثم `select#category`، ثم `textarea#description`. |
| firstrun 460×520 | 0 | — |
| update 360×280 | `page-has-heading-one` (moderate) | لا عناصر قابلة للتركيز في الحالة الافتراضية للمحاكاة. بعد Escape يعود التركيز إلى `body`. |

## لوحة المفاتيح
- على macOS يمرّ مفتاح Tab في WebKit على حقول النص فقط، ما لم يُفعَّل خيار «الوصول الكامل بلوحة المفاتيح». هذا سلوك WKWebView أيضًا، فقيس الترتيب مرتين: `Tab` ثم `Alt+Tab`.
  - مع `Tab` وحده تصل اللوحة إلى البحث وزر واحد فقط، وصفحتا about وfirstrun لا تصلان إلى أي عنصر.
  - الدليل التشغيلي يعتمد على الاختصارات (الأسهم وEnter وEscape)، لذا الأثر منخفض. لكنه بند يُتحقق منه يدويًا في `audit/macos/MANUAL-CHECKLIST.md`.
- حقل البحث `outline: none`، والتركيز يظهر عبر حلقة `box-shadow` على الحاوية `.search-field`. هذا مقبول، فهو إيجابية كاذبة في الكاشف التلقائي.
- Escape لا ينقل التركيز إلى `body` إلا في update. في بقية الصفحات يبقى على عنصر تفاعلي.

## الحالة
- P4: **PASS (تقريبي)** مع ملاحظات وصولية بلا أثر أمني:
  - تباين الوضع الداكن في صفوف اللوحة: متوسط.
  - `label-content-name-mismatch` في شريحة الاختصار: منخفض.
  - غياب `h1`: منخفض.
  - لوحة تبويب الإعدادات بلا مؤشر تركيز: منخفض.
- لم تُرقَّم هذه الملاحظات كعيوب RAFF-AUD لأنها تقريبية وتحتاج تأكيدًا في WKWebView الحقيقي.
