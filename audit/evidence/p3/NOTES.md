# ملاحظات المرحلة P3 (Rust)

البيئة: macOS arm64، rustc/cargo 1.96.1 — تشغيل أصلي، فالحالات حقيقية لا PENDING-NATIVE.

## النتائج
- `cargo test` الكامل: 139 نجح، 0 فشل، 10 متجاهَلة (= 123 قائمًا + 16 تدقيقيًا). `cargo-test.log`.
- `cargo test audit_tests -- --ignored`: 8 إعادات إنتاج تفشل كما هو متوقع، ومجسّا أداء ينجحان. `cargo-test-ignored.log`.
- `node audit/scripts/check-cfg-test-hunks.mjs`: كل كتل Rust إضافة خالصة في نهاية الملف داخل `#[cfg(test)] mod audit_tests`.

## إعادات الإنتاج (#[ignore] — تفشل الآن)
| المعرّف | الاختبار | دليل الفشل |
|---|---|---|
| RAFF-AUD-001 | `storage::audit_tests::aud001_unpin_at_cap_keeps_item_or_refuses_without_side_effects` | يعيد Err والرف فارغ: العنصر لم يعد في أي طبقة |
| RAFF-AUD-002 | `storage::audit_tests::aud002_corrupt_settings_is_surfaced` | `unreadable_layer == false` مع settings.json تالف |
| RAFF-AUD-003 | `storage::audit_tests::aud003_every_recovery_copy_is_kept` | نسخة الفساد الأول غير موجودة بعد فساد ثانٍ |
| RAFF-AUD-004 | `commands::audit_tests::aud004_no_raw_unwrap_lock` | موضع واحد `store.lock().unwrap()` |
| RAFF-AUD-006 | `startup_trace::audit_tests::aud006_trace_is_debug_only` | `enabled()` بلا `debug_assertions` |
| RAFF-AUD-007 | `storage::audit_tests::aud007_normalize_parity_for_divergent_vectors` | `"ΟΔΟΣ"` → Rust `οδοσ` / JS `οδος` |
| RAFF-AUD-008 | `storage::audit_tests::aud008_trim_parity_with_js` | `"\u{feff}x".trim()` يبقى كما هو في Rust |
| RAFF-AUD-009 | `report::audit_tests::aud009_retry_after_zero_is_short` | `Retry-After: 0` → 3600 |

لكل إعادة إنتاج اختبار توصيف مرافق (`*_characterization_*`) ينجح ويثبت السلوك الحالي، فيكون الدليل أخضر في `cargo test` العادي.

## ما نجح (فرضيات لم تتأكد كعيوب)
- H1: مصفوفة فساد (فارغ، مبتور، نوع خاطئ، ثنائي، NUL، BOM + `[]`) لطبقتي history/pinned: العلامة تُرفع، والنسخة الجانبية مطابقة بايتًا ببايت، والأصل لا يُستبدل، والصور لا تُنظَّف.
- حقن الأعطال (مجلد مكان `*.json.tmp`): الالتقاط والإعدادات ويومية التثبيت تتراجع في الذاكرة والقرص.
- نموذج عشوائي: 5 بذور × 200 خطوة (التقاط/تثبيت/حذف/تراجع/تأكيد/إعادة ترتيب) — لا تكرار، علامات التثبيت متسقة، والحد محترم، وإعادة التحميل تطابق الذاكرة كل 10 خطوات. (الحد 1000 عمدًا لتجنب RAFF-AUD-001.)
- التزامن: 8 خيوط × 40 التقاطًا عبر `persist_capture` = 320 عنصرًا في الذاكرة والقرص بالترتيب ذاته (بوابة التذاكر تعمل).
- التكافؤ: 216 متجهًا غير متباين تطابق JS حرفيًا؛ والمتجهات الخمسة المتباينة تطابق نموذج per-char.
- حدود `validate_settings` وجدول `retry_after_seconds`.

## ملاحظات جانبية
- ملف JSON صالح مسبوق بـ BOM (`EF BB BF`) يُعامَل كتالف (serde_json لا يقبل BOM). أثره منخفض لأن رفّ يكتب الملفات بنفسه بلا BOM.
- `validate_settings` يقبل محارف الاتجاه مثل U+202E في معرّف الحزمة (ليست control ولا whitespace). ملاحظة فقط.
- `Retry-After` يتجاوز u64 يعود إلى 3600 لا إلى الحد الأقصى 86400.
- `startup_trace` يُلحق بـ `/tmp/raff-startup-trace.log` (مجلد قابل للكتابة للجميع) بلا `O_NOFOLLOW`؛ يتطلب تفعيلًا مسبقًا بملف العلامة. يُضاف إلى RAFF-AUD-006.
- RAFF-AUD-005 (فقد تحديث في `update_settings`) لا يُختبر وحدويًا لأنه أمر Tauri يحتاج `AppHandle`؛ الدليل مراجعة المصدر (commands.rs:317–385).

## الأداء
انظر `perf-release.log` (إصدار release، خيط واحد). أرقام debug المتوازية في `cargo-test-ignored.log` للمقارنة فقط.

نتائج release (macOS arm64، `--release --test-threads=1`): ملء 1000 عنصر = 237 مللي ثانية، وأسوأ التقاط عند الحد = 52 مللي ثانية مع سجل حجمه 33 ميغابايت، والتحميل = 33 مللي ثانية. الالتقاط يعيد كتابة الملف كاملًا في كل مرة، لكن الزمن مقبول على هذا الجهاز. هذا ليس عيبًا، بل خطر قابلية توسّع يُراقَب.
