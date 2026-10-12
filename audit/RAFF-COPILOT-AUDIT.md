<div dir="rtl">

# تقرير تدقيق جودة رفّ

## 1. الملخص التنفيذي

- **الحالات:** في سجل الفحوص 24 فحصًا: 16 PASS، و4 FAIL (فحصان لاعتمادات أمنية، وفحص تنسيق، وفحص إعادات الإنتاج الذي يُتوقَّع فشله)، و1 SKIPPED، و3 PENDING-NATIVE، و0 BLOCKED-ENV.
- **العيوب:** أُعيد إنتاج 8 عيوب في المنتج (S1×2، S2×1، S3×2، S4×3)، وبقيت 4 ملاحظات CODE-READ، ولم يظهر أي TEST-DEFECT.
- **أهم ثلاثة عيوب:**
  1. **RAFF-AUD-001 (S1):** إلغاء تثبيت عنصر قديم والسجل ممتلئ يحذفه من الذاكرة ثم من القرص.
  2. **RAFF-AUD-002 (S1، خصوصية):** تلف `settings.json` يعيد الالتقاط بصمت ويُفرغ قائمة التطبيقات المستبعَدة.
  3. **RAFF-AUD-003 (S2):** نسخة الاسترداد `*.json.corrupt` يمحوها التلف التالي.
- **الاعتمادات:** `cargo audit` وجد ثغرة في `rustls 0.23.42` (RUSTSEC-2026-0285) على مسار الشبكة الفعلي (التحديث والبلاغ).
- **الضمانات:** لا أثر لاتصال شبكي من الواجهة، ولا حقن HTML، ولا سباق في البحث. سباق البحث العميق كانت تحرسه اختبارات التدقيق وحدها (M7).

## 2. بيانات التشغيل

| البند | القيمة |
|---|---|
| المستودع / الفرع | `iSltanX/Raff` / `isltanx-raff-quality-audit` (المسودة [#4](https://github.com/iSltanX/Raff/pull/4)) |
| SHA القاعدة | `ce946faadb9e21876175ecc99358781012fc72d8` (`docs: update contact email`) |
| HEAD | آخر التزام على الفرع بعد P7، ويحمل الرسالة `docs(audit): التقرير النهائي للمرحلة P7`. التزامات المراحل: P0 `c1caaf7`، وP1 `558ac75`، وP2 `dd4709e`، وP3 `bc2f0a6`، وP4 `c8a658a`، وP5 `d077242`، وP6 `95fcc69` |
| `git status` عند البدء | نظيفة، عدا `?? audit/` (`audit/evidence/p0/env.txt`) |
| نظام التشغيل | macOS 27.0.1 (26A434)، arm64، بذاكرة 16 GB و8 أنوية |
| الأدوات | Node v24.18.1، وnpm 11.16.0، وrustc/cargo 1.96.1، وcargo-audit 0.22.2، وcargo-mutants 27.1.0، وPlaywright WebKit 27.2 مع axe-core (مثبّتان خارج المستودع في `/tmp/raff-p4`) |
| التاريخ (UTC) | 2026-10-12، من 19:13Z (P0) حتى P7 |
| الجلسات | جلسة وكيل واحدة متصلة، مع تشغيل محلي لـ`audit/macos/run-native-checks.sh` في `20261012T194453Z` |

**انحرافات البيئة عن المواصفة:**
- **نظام التشغيل:** افترضت المواصفة Ubuntu، لكن الجهاز macOS arm64. لذا شُغّلت فحوص Rust أصليًا وحالاتها حقيقية، وليست PENDING-NATIVE.
- **Node:** أُجري التشغيل على Node 24، بينما يستخدم CI الإصدار Node 20 (`ci.yml:28`). لم يظهر فرق سلوكي، لكن تشغيل CI على الطلب لم يُعتمد بعد (انظر §12).
- **`timeout`:** أداة GNU `timeout` غير متوفرة على macOS، فشُغّلت الأوامر بلا حدّ زمني خارجي.

## 3. ما فُحص وما لم يُفحص

**فُحص:**
- **JS:** الحزمة كاملة ثلاث مرات للتحقق من التذبذب، ومعها التغطية.
- **اختبارات تدقيق JS:** 44 اختبارًا جديدًا تغطي:
  - خصائص `logic.js`؛
  - تطابق التطبيع مع Rust عبر 221 متجهًا؛
  - أمان العرض من حقن HTML؛
  - غياب الشبكة؛
  - سباق البحث العميق؛
  - الإرسال المزدوج للبلاغ.
- **Rust:** `cargo check` و`cargo test`، و`fmt --check`، و`cargo audit`.
- **اختبارات تدقيق Rust:** 26 اختبارًا جديدًا، منها 8 إعادات إنتاج و2 مجسّا أداء. تغطي:
  - مصفوفة التلف لطبقتي history/pinned؛
  - حقن الأعطال؛
  - نموذج عشوائي (5 بذور × 200 خطوة)؛
  - التزامن (8 خيوط × 40 التقاطًا)؛
  - حدود الإعدادات و`Retry-After`؛
  - قياس الأداء بإصدار release.
- **الواجهة (تقريبي):** فحص في WebKit لست صفحات بوضعَيها الفاتح والداكن: RTL، وconsole، والشبكة، والفيض، وaxe، ولوحة المفاتيح.
- **الطفرات:** 9 طفرات يدوية في JS.
- **الفرضيات:** حُسمت الفرضيات H1–H12 كلها، وجدول حالتها في §6.
- **الفحص الأصلي:** سكربت تحقق أصلي شُغّل فعلًا.

**لم يُفحص، والأسباب:**

| البند | السبب |
|---|---|
| WKWebView الحقيقي داخل Tauri (النافذة العائمة، الشفافية، بروتوكول الأصول، الاختصار العام) | يحتاج تشغيل التطبيق وتفاعلًا بشريًا. سُلّم كقائمة يدوية في `audit/macos/MANUAL-CHECKLIST.md` (PENDING-NATIVE) |
| `NSPasteboard` واللصق بمحاكاة ⌘V وإذن تسهيل الوصول | لا يوجد حدّ قابل للاختبار في الشيفرة (`poll_once` يحتاج `AppHandle`). القائمة اليدوية تغطي ذلك |
| `Pause` عبر سكون النظام (H10) | يحتاج سكونًا حقيقيًا للجهاز |
| فقد التحديث في `update_settings` (H6) | أمر Tauri يحتاج `AppHandle` و`State`، ولا توجد دالة نقية مكافئة. قراءة فقط |
| الكتابة دون `fsync` (H3) | انقطاع الطاقة لا يُحاكى. قراءة فقط بحسب المواصفة |
| `cargo mutants` على Rust | خارج نطاق المواصفة في P5. هو خلف العلم `--mutants` في سكربت P6، والقائمة تعدّ 329 طفرة لـ`storage.rs` و`report.rs` |
| `cargo clippy` | غير مطلوب في CI وغير مذكور في المواصفة، ولم يُشغَّل |
| التحديث الموقَّع الفعلي، وبناء DMG، والتوقيع والتوثيق | يحتاج مفاتيح الإصدار والشبكة. تكفي اختبارات `release-*` المصدرية القائمة |
| خادم البلاغات الحقيقي | ممنوع، فلا شبكة خارجية. وُجّه `RAFF_REPORT_ENDPOINT` إلى `127.0.0.1:9` |
| تشغيل CI على الطلب [#4](https://github.com/iSltanX/Raff/pull/4) | ينتظر «Approve and run workflows» من المشرف |

## 4. خريطة المخاطر

نُسخت من `audit/evidence/p1/risk-map.md`، وحالة كل فرضية بعد الفحص في عمود «الحكم».

| السطح | الملف | سبب الخطورة | الحكم |
|---|---|---|---|
| تحميل الطبقات والتعافي من التلف | `storage.rs` (`load_json_with_status`، `Store::load`، `cleanup_orphan_images`) | البيانات الوحيدة للمستخدم، وحذف الصور لا رجعة فيه | AUD-002، وAUD-003. مصفوفة التلف PASS |
| التثبيت وإلغاؤه | `storage.rs` (`set_pin_persisted`، `toggle_pin`) | ينقل العنصر بين طبقتين ويقصّ السجل في الخطوة نفسها | **AUD-001** |
| الحذف القابل للتراجع | `storage.rs` (`delete_reversible`، `undo_delete`) | معاملة من ثلاث كتابات | PASS (نموذج عشوائي وحقن أعطال) |
| الكتابة الذرّية | `storage.rs` (`write_layer_bytes`، `LayerWrite::commit`) | الكتابة خارج القفل وترتيبها بتذاكر | PASS في التزامن. `fsync` يبقى CODE-READ |
| حلقة الالتقاط | `monitor.rs` (`poll_once`، `capture_reading`) | الخصوصية والأداء تحت القفل | CODE-READ (H7، H8)، وPENDING-NATIVE |
| الإعدادات | `commands.rs` (`update_settings`، `validate_settings`) | آثار جانبية على النظام | AUD-004، وCODE-READ (H6). الحدود PASS |
| البحث المزدوج | `logic.js::normalizeArabic` و`storage.rs::normalize_for_search` | تعليق الشيفرة يعد بالتطابق «تمامًا» | AUD-007، وAUD-008 |
| البلاغ | `report.rs` و`report.js` | طريق شبكة | AUD-009. ملاحظة AUD-010 |
| تتبّع الإقلاع | `startup_trace.rs` | يكتب في `/tmp` في الإصدار | AUD-006 |

## 5. سجل الفحوص

مسارات الأدلة نسبية إلى `audit/evidence/`. المدد مأخوذة من السجلات، و«—» تعني أن المدة لم تُسجَّل.

| id | الأمر | أين | الحالة | المدة | الدليل |
|---|---|---|---|---|---|
| C01 | `npm ci` | macOS محلي | PASS | — | `p0/npm-ci.log` |
| C02 | `npm run build:frontend` | macOS محلي | PASS | <1s | `p0/build-frontend.log`، `p0/dist-files.txt` |
| C03 | `npm test` (القاعدة: 280 اختبارًا) | macOS محلي | PASS | 9s | `p0/npm-test.log`، `p0/npm-test.junit.xml` |
| C04 | `npm test` ×3 بمُبلِّغ JUnit (للتذبذب) | macOS محلي | PASS (0 متذبذب) | 13/12/15s | `p0/flaky-runs.txt`، `p0/run{1,2,3}.junit.xml` |
| C05 | `node --test --experimental-test-coverage tests/*.test.mjs` | macOS محلي | PASS (الأسطر 65.74%) | 21s | `p0/coverage.log` |
| C06 | `cargo check --manifest-path src-tauri/Cargo.toml` | macOS محلي | PASS | 47s | `p0/cargo-check.log` |
| C07 | `cargo test --manifest-path src-tauri/Cargo.toml` (القاعدة: 123 اختبارًا) | macOS محلي | PASS | 120s (مع البناء) | `p0/cargo-test-baseline.log` |
| C08 | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | macOS محلي | FAIL (81 فرقًا، وCI لا يشغّله) | 1s | `p0/cargo-fmt.log` |
| C09 | `cargo audit` (في `src-tauri/`) | macOS محلي | FAIL (ثغرة واحدة + 8 تحذيرات) | 4s | `p0/cargo-audit.log` |
| C10 | `npm audit` | macOS محلي | FAIL (2 high، اعتمادات تطوير فقط) | 1s | `p0/npm-audit.log` |
| C11 | `npm test` (مع اختبارات التدقيق: 324 = 317 نجح + 7 todo) | macOS محلي | PASS | 11s | `p2/npm-test.log` |
| C12 | `node --test --test-force-exit tests/audit-*.test.mjs` | macOS محلي | PASS (37 نجح + 7 todo) | 1s | `p2/audit-tests.log` |
| C13 | `cargo test --manifest-path src-tauri/Cargo.toml` (139 نجح، 10 متجاهَلة) | macOS محلي | PASS | 28s | `p3/cargo-test.log` |
| C14 | `cargo test --manifest-path src-tauri/Cargo.toml audit_tests -- --ignored` | macOS محلي | FAIL (متوقَّع: 8 إعادات إنتاج تفشل، ومجسّا أداء ينجحان) | 35s | `p3/cargo-test-ignored.log` |
| C15 | `cargo test --release --manifest-path src-tauri/Cargo.toml perf_probe -- --ignored --nocapture --test-threads=1` | macOS محلي | PASS | 1s | `p3/perf-release.log` |
| C16 | `node audit/scripts/check-cfg-test-hunks.mjs` | macOS محلي | PASS | <1s | `p3/cfg-check.log` |
| C17 | `NODE_PATH=/tmp/raff-p4/node_modules node audit/scripts/p4-ui-approx.mjs` | macOS محلي (WebKit/Playwright) | PASS (تقريبي، مع ملاحظات وصولية) | — | `p4/ui-approx.{log,json}`، `p4/*.png` |
| C18 | `node audit/scripts/p5-mutation-probes.mjs` | macOS محلي (worktree مؤقت) | PASS (9/9 قُتلت) | — | `p5/mutations.{log,json}` |
| C19 | `bash audit/macos/run-native-checks.sh` | macOS محلي | PASS (6/6 كما هو متوقع) | — | `macos/20261012T194453Z/SUMMARY.txt` |
| C20 | `node audit/scripts/count-source-regex-tests.mjs` | macOS محلي | PASS (قياس) | <1s | `p7/h11-source-regex.log` |
| C21 | `bash audit/macos/run-native-checks.sh --mutants` (`cargo mutants`) | — | SKIPPED (خارج نطاق P5، والأمر جاهز) | — | `audit/macos/run-native-checks.sh` |
| C22 | قائمة التحقق اليدوية (29 سيناريو) في WKWebView/Tauri | جهاز المشرف | PENDING-NATIVE | — | `audit/macos/MANUAL-CHECKLIST.md` |
| C23 | H10: الإيقاف المؤقت عبر سكون النظام (السيناريو 10) | جهاز المشرف | PENDING-NATIVE | — | `audit/macos/MANUAL-CHECKLIST.md` |
| C24 | CI على [#4](https://github.com/iSltanX/Raff/pull/4) (Ubuntu أو macOS بحسب `ci.yml`، Node 20) | GitHub Actions | PENDING-NATIVE (ينتظر موافقة المشرف) | — | `gh pr checks 4` |

**تفاصيل الإخفاقات غير المتعلقة بالمنتج:**
- **C08:** يقع الفرق في تنسيق الشيفرة الأساسية، وليس في كتل التدقيق وحدها، لأن القاعدة تفشل أيضًا. يُصنَّف ملاحظة صيانة، فـ`ci.yml` لا يشغّل `fmt`.
- **C09:** الثغرة هي `rustls 0.23.42` (RUSTSEC-2026-0285، «TLS 1.3 handshake messages incorrectly accepted across encryption level boundaries»)، والحل الترقية إلى `>=0.23.45`.
  - **المسار:** `reqwest 0.13.4` ثم `tauri-plugin-updater` و`raff` مباشرة. أي أنها على مساري التحديث والبلاغ الفعليين.
  - **التحذيرات الثمانية:** `proc-macro-error` ووحدات `unic-*` غير مُصانة، و`event-listener` و`glib` غير سليمتين (unsound).
- **C10:** ثغرتا `undici 7.28.0` و`source-map-js 1.2.1` تأتيان عبر `jsdom` (اعتماد تطوير للاختبارات)، ولا تدخلان الحزمة المشحونة.

## 6. العيوب المعاد إنتاجها (`PRODUCT-DEFECT`)

**حالة الفرضيات:**

| H | الحكم | المرجع |
|---|---|---|
| H1 | مؤكَّدة | RAFF-AUD-003 |
| H2 | مؤكَّدة | RAFF-AUD-002 |
| H3 | CODE-READ | §7 |
| H4 | مؤكَّدة بصيغة أخطر | RAFF-AUD-001. شقّ «الحدّ بالعدد فقط» CODE-READ في §7 |
| H5 | مؤكَّدة | RAFF-AUD-004 |
| H6 | CODE-READ | §7 (أُدرجت كـRAFF-AUD-005 في التخطيط، ولم يُعَد إنتاجها) |
| H7 | CODE-READ | §7 |
| H8 | CODE-READ | §7، مع قياس |
| H9 | مؤكَّدة | RAFF-AUD-006 |
| H10 | PENDING-NATIVE | §10 |
| H11 | مقيسة | §9 |
| H12 | ملاحظة صيانة | §11 RAFF-IDEA-07 |

**طريقة التشغيل العامة:**
- إعادات إنتاج Rust معلَّمة بـ`#[ignore = "RAFF-AUD-NNN: …"]`، وتفشل الآن عبر:
  `cargo test --manifest-path src-tauri/Cargo.toml <اسم_الاختبار> -- --ignored`
- لكل منها اختبار `*_characterization_*` ينجح في `cargo test` العادي ويثبت السلوك الحالي.
- إعادات إنتاج JS معلَّمة بـ`{ todo: 'RAFF-AUD-NNN' }`.

### RAFF-AUD-001: إلغاء تثبيت عنصر أقدم من كل السجل والسجل ممتلئ يُفقده
- **الخطورة: S1 (فقد بيانات).** الخطوات:
  1. تُرجع العملية خطأ.
  2. يكون العنصر قد اختفى من الطبقتين في الذاكرة.
  3. أول كتابة لاحقة لطبقة المثبّتات تجعل الفقد دائمًا على القرص.
  
  المستخدم يرى رسالة فشل ويظن أن العنصر باقٍ.
- **الموضع:** `src-tauri/src/storage.rs:1267-1292`، `Store::set_pin_persisted`.
  - `toggle_pin` يُدرج العنصر في `history` بحسب `created_at`.
  - ثم يقصّ `history.split_off(limit)` الذيل.
  - فيفشل `self.find(id)` ويعود بـ`Err` عبر `?` قبل استرجاع `old_history` و`old_pinned`.
- **المتوقَّع:** يقول تعليق الدالة نفسها (`storage.rs:1262-1266`) إنها «لا تُبلغ أبدًا بنجاح تغيير في الذاكرة فقط… وأي فشل يستعيد المتجهين». والمتوقَّع إما أن يبقى العنصر، أو أن يُرفض الطلب بلا أثر جانبي.
- **الفعلي:** تعيد الدالة `Err("العنصر غير موجود")`، وتبقى `pinned` و`history` بلا العنصر.
- **إعادة الإنتاج:** تُضبط `history_limit = N` ويُملأ السجل بـ`N` عنصرًا. ثم يُثبَّت عنصر `created_at` الخاص به أقدم من الجميع، ويُلغى تثبيته.
  `cargo test --manifest-path src-tauri/Cargo.toml aud001_unpin_at_cap_keeps_item_or_refuses_without_side_effects -- --ignored`
- **الدليل:** `p3/cargo-test-ignored.log`، وفيه «يعيد Err والرف فارغ».
- **حدود التحقق:**
  - الفقد في الذاكرة مثبَت.
  - ديمومة الفقد على القرص مستنتجة من مسار الكتابة التالي، ولم تُشغَّل عبر الواجهة الحقيقية. يغطيها السيناريو 27 في القائمة اليدوية.
  - الحالة شائعة لمن يثبّت عناصر قديمة ويستخدم حدّ 200.
- **اختبار الانحدار المقترح:** `aud001_unpin_at_cap_keeps_item_or_refuses_without_side_effects`. يؤكد أنه بعد الاستدعاء يوجد العنصر في إحدى الطبقتين، أو أن الحالتين مطابقتان لما قبل الاستدعاء.
- **مُلتزَم:** نعم، `#[ignore]` في `storage.rs` مع `aud001_characterization_unpin_at_cap_returns_err_and_drops_item_from_memory`.

### RAFF-AUD-002: تلف `settings.json` يعيد الالتقاط بصمت ويُفرغ الاستثناءات
- **الخطورة: S1 (خصوصية).**
  - من عطّل الالتقاط أو استبعد تطبيقات (مثل مدير كلمات مرور) يُعاد له الالتقاط الكامل دون إشعار.
  - تُلتقط عندها نصوص كان قد قرّر ألّا تُحفظ.
- **الموضع:** `src-tauri/src/storage.rs:480-505`.
  - تُحمَّل الإعدادات بـ`load_json`، الذي يُسقط القيمة المنطقية التي يعيدها `load_json_with_status`.
  - لا يُرفع `unreadable_layer`، ولا تُبلَّغ الواجهة.
- **المتوقَّع:** الإعدادات طبقة بيانات كسواها، وطبقتا history وpinned تُرفع لهما علامة `unreadable_layer` (مصفوفة P3). ويعد `PRIVACY.md` بأنه «ما يُنسخ من التطبيقات المستبعَدة… وما تنسخه والالتقاط معطّل» لا يُحفظ.
- **الفعلي:** `Settings::default()` يعيد `capture_enabled = true` و`excluded_apps = []`، وتبقى `unreadable_layer == false`.
- **إعادة الإنتاج:** يُكتب `{` في `settings.json` بعد حفظ إعدادات مخصّصة، ثم يُستدعى `Store::load`.
  `cargo test --manifest-path src-tauri/Cargo.toml aud002_corrupt_settings_is_surfaced -- --ignored`
- **الدليل:** `p3/cargo-test-ignored.log`.
- **حدود التحقق:**
  - مثبَت على مستوى `Store`.
  - لم يُلاحَظ عبر الواجهة. يغطيه السيناريو 26 في القائمة اليدوية.
  - تُحفظ نسخة `settings.json.corrupt` فعلًا.
- **اختبار الانحدار المقترح:** `aud002_corrupt_settings_is_surfaced`. يؤكد أن تلف الإعدادات يرفع علامة مرئية. ويُقترح إضافة شرط: ألّا يُعاد تفعيل الالتقاط قبل تأكيد المستخدم.
- **مُلتزَم:** نعم، `#[ignore]` مع `aud002_characterization_corrupt_settings_silently_reverts_to_defaults`.

### RAFF-AUD-003: نسخة الاسترداد ذات اسم ثابت ويمحوها التلف التالي
- **الخطورة: S2.**
  - النسخة `history.json.corrupt` قد تكون المرجع الوحيد المتبقي لأسماء صور المستخدم.
  - التلف الثاني يستبدلها بصمت.
  - ولا يحسب `cleanup_orphan_images` (`storage.rs:438`) إلا مراجع النسخة الباقية.
- **الموضع:** `src-tauri/src/storage.rs:491-492`، حيث `path.with_extension("json.corrupt")` ثم `fs::copy`.
- **المتوقَّع:** تعليق الشيفرة في `storage.rs:490`: «Never destroy user data silently: keep the unreadable file aside.»
- **الفعلي:** محتوى الفساد الأول يختفي بعد الفساد الثاني.
- **إعادة الإنتاج:** تلف، ثم تحميل، ثم كتابة سليمة، ثم تلف بمحتوى مختلف، ثم تحميل.
  `cargo test --manifest-path src-tauri/Cargo.toml aud003_every_recovery_copy_is_kept -- --ignored`
- **الدليل:** `p3/cargo-test-ignored.log`.
- **حدود التحقق:**
  - مثبَت لطبقة history.
  - الأثر على حذف الصور اليتيمة مستنتج من القراءة، ولم يُشغَّل حتى الحذف.
- **اختبار الانحدار المقترح:** `aud003_every_recovery_copy_is_kept`. يؤكد وجود نسختين متمايزتين بمحتوى الفسادين.
- **مُلتزَم:** نعم، `#[ignore]` مع `aud003_characterization_second_corruption_overwrites_first_recovery_copy`.

### RAFF-AUD-004: `lock().unwrap()` خارج سياسة الأقفال المسمومة
- **الخطورة: S3.**
  - ذعر واحد في أي خيط يحمل القفل يحوّل كل استدعاء لاحق لـ`update_settings` إلى ذعر.
  - ينطبق الأمر نفسه على اللصق والتحديث.
  - التطبيق لا يفقد بيانات، لكن الإعدادات واللصق يتوقفان.
- **الموضع:**
  - `src-tauri/src/commands.rs:361` (`state.store.lock().unwrap()` في `update_settings`)؛
  - `paste.rs:83`؛
  - `panel.rs:199` و`panel.rs:222`؛
  - `updater.rs:237` و`257` و`291` و`342` و`379`.
- **المتوقَّع:** يوجد المساعد `lock_store` الذي يتعافى من التسميم، وتعليقات `main.rs` تقرّر هذه السياسة.
- **الفعلي:** يبقى موضع واحد لقفل المخزن، وثمانية لأقفال أخرى.
- **إعادة الإنتاج:**
  `cargo test --manifest-path src-tauri/Cargo.toml aud004_no_raw_unwrap_lock -- --ignored`
  
  هذا فحص مصدري لمواضع `store.lock().unwrap()`. ويثبت اختبار التوصيف أن القفل المسموم يُذعر مع `unwrap` ويتعافى مع `lock_store`.
- **الدليل:** `p3/cargo-test-ignored.log`.
- **حدود التحقق:**
  - لم يُشغَّل ذعر حقيقي داخل `update_settings`، فالأمر يحتاج `AppHandle`.
  - مواضع `paste`/`panel`/`updater` مُثبتة بالقراءة فقط.
- **اختبار الانحدار المقترح:** `aud004_no_raw_unwrap_lock`. يؤكد خلو الشيفرة الإنتاجية من `store.lock().unwrap()`، ويُقترح توسيعه ليشمل `previous_app` و`UpdaterState`.
- **مُلتزَم:** نعم، `#[ignore]` في `commands.rs` مع `aud004_characterization_one_raw_unwrap_lock_remains`.

### RAFF-AUD-006: تتبّع الإقلاع يُفعَّل في نسخة الإصدار بملف في `/tmp`
- **الخطورة: S3.** المخاطرة خصوصية محلية وكتابة عبر رابط رمزي:
  - وجود `/tmp/raff-trace-on`، أو متغير البيئة `RAFF_STARTUP_TRACE`، يكفي لتفعيل التتبّع في الإصدار.
  - يُلحَق السجل بالمسار المتوقَّع `/tmp/raff-startup-trace.log` دون `O_NOFOLLOW`.
  - يسجّل السجل:
    - معرّفات العناصر (`paste.rs:67`)؛
    - `pid` التطبيق الأمامي ومعرّف حزمته (`paste.rs:84-121`)؛
    - وسيطات `argv` للنسخة الثانية (`main.rs:179`).
  - لا يسجّل محتوى الحافظة.
- **الموضع:** `src-tauri/src/startup_trace.rs:26-36` (`enabled()` بلا `cfg(debug_assertions)`) و`:86-89` (`OpenOptions::new().create(true).append(true)`).
- **المتوقَّع:** `PRIVACY.md` «ما يحفظه رفّ، وأين» يحصر ما يُحفظ في `~/Library/Application Support/com.raff.app/`، وتعليق الوحدة يصفها أداة تشخيص.
- **الفعلي:** التتبّع مفعَّل في الإصدار متى وُجد الملف.
- **إعادة الإنتاج:**
  `cargo test --manifest-path src-tauri/Cargo.toml aud006_trace_is_debug_only -- --ignored`
  
  هذا فحص مصدري، ويثبت اختبار التوصيف ثابت المسار.
- **الدليل:** `p3/cargo-test-ignored.log`.
- **حدود التحقق:**
  - لم يُبنَ إصدار موقَّع لاختبار ذلك عمليًا.
  - لم يُجرَّب اتباع رابط رمزي.
  - يتطلب الاستغلال قدرة مسبقة على الكتابة في `/tmp` على الجهاز نفسه، لذا الخطورة S3 لا S1.
- **اختبار الانحدار المقترح:** `aud006_trace_is_debug_only`. يؤكد أن `enabled()` محصورة بـ`debug_assertions`، أو بتبديل صريح في الإعدادات.
- **مُلتزَم:** نعم، `#[ignore]` في `startup_trace.rs` مع `aud006_characterization_trace_arming_is_not_debug_gated`.

### RAFF-AUD-007: السيغما النهائية تجعل بحث JS وRust يختلفان
- **الخطورة: S4.** يجد البحث العميق (Rust) والبحث الفوري (JS) نتائج مختلفة لنصوص يونانية بالحروف الكبيرة. الأثر نادر.
- **الموضع:**
  - `src/js/logic.js` (`normalizeArabic`، `toLowerCase()` السياقي)؛
  - `src-tauri/src/storage.rs:299` (`normalize_for_search`، `char::to_lowercase` حرفًا حرفًا).
- **المتوقَّع:** تعليق `normalize_for_search` يعد بمطابقة `logic.js` «تمامًا».
- **الفعلي:** 5 من 221 متجهًا تختلف، منها `"ΟΔΟΣ"`: يعطي Rust `οδοσ` ويعطي JS `οδος`. المتجهات الـ216 الباقية تتطابق.
- **إعادة الإنتاج:**
  - `cargo test --manifest-path src-tauri/Cargo.toml aud007_normalize_parity_for_divergent_vectors -- --ignored`
  - `node --test tests/audit-normalize-parity.test.mjs`، وفيه 5 todo.
- **الدليل:** `p3/cargo-test-ignored.log`، و`p2/audit-tests.log`، و`audit/fixtures/normalize-vectors.json` (المولِّد `audit/scripts/gen-normalize-vectors.mjs`).
- **حدود التحقق:** لم تُختبر كل نصوص يونيكود، بل المتجهات المولَّدة فقط.
- **اختبار الانحدار المقترح:** `aud007_normalize_parity_for_divergent_vectors` مع اختبار JS المقابل. يؤكدان التطابق على كل المتجهات المشتركة.
- **مُلتزَم:** نعم، `#[ignore]` في Rust و`todo` في JS.

### RAFF-AUD-008: `trim` يختلف في U+FEFF بين JS وRust
- **الخطورة: S4.** نص يبدأ بـBOM يُطبَّع بشكلين مختلفين.
- **الموضع:** `src-tauri/src/storage.rs` (`normalize_for_search`، `trim()` في Rust لا يزيل U+FEFF)، مقابل `String.prototype.trim` في JS الذي يزيله.
- **المتوقَّع:** وعد التطابق نفسه في AUD-007.
- **الفعلي:** `"\u{feff}x"` يبقى كما هو في Rust، ويصبح `"x"` في JS.
- **إعادة الإنتاج:**
  - `cargo test --manifest-path src-tauri/Cargo.toml aud008_trim_parity_with_js -- --ignored`
  - و2 todo في `tests/audit-normalize-parity.test.mjs`.
- **الدليل:** `p3/cargo-test-ignored.log`، و`p2/audit-tests.log`.
- **حدود التحقق:** لم يُقَس الأثر على نتائج البحث الظاهرة.
- **اختبار الانحدار المقترح:** `aud008_trim_parity_with_js`.
- **مُلتزَم:** نعم.

### RAFF-AUD-009: `Retry-After: 0` يتحوّل إلى ساعة كاملة
- **الخطورة: S4.** حين يطلب الخادم إعادة المحاولة فورًا، يمنع رفّ إرسال البلاغ ساعة.
- **الموضع:**
  - `src-tauri/src/report.rs:271` (`retry_after_seconds`)؛
  - `:29` (`DEFAULT_RETRY_AFTER_S = 3600`)، فالقيمة 0 تُعامَل كغائبة.
- **المتوقَّع:** RFC 9110 §10.2.3، حيث `Retry-After` بالثواني و0 قيمة صالحة. وتعليق `report.rs:27` يحصر القيمة الافتراضية في غياب الترويسة أو كونها تاريخًا.
- **الفعلي:** تعيد الدالة 3600.
- **إعادة الإنتاج:**
  `cargo test --manifest-path src-tauri/Cargo.toml aud009_retry_after_zero_is_short -- --ignored`
- **الدليل:** `p3/cargo-test-ignored.log`.
- **حدود التحقق:** لم يُختبر خادم حقيقي. ولاحظنا أيضًا أن القيمة التي تتجاوز u64 تعود إلى 3600 بدل الحد الأقصى 86400.
- **اختبار الانحدار المقترح:** `aud009_retry_after_zero_is_short`.
- **مُلتزَم:** نعم، `#[ignore]` في `report.rs` مع `aud009_characterization_retry_after_zero_becomes_an_hour`.

**ملاحظة بلا خطورة مرقّمة: RAFF-AUD-010**
- `send()` في `src/js/report.js:443` بلا حارس `busy` داخلي، ويعتمد على `disabled` وحده.
- لم يظهر إرسال مزدوج في WebKit، ومفتاح idempotency واحد يحمي الخادم.
- مسجَّل في `tests/audit-report-double-send.test.mjs`.

## 7. ملاحظات من قراءة الكود (`CODE-READ`)

| # | الملاحظة | الموضع | ما سيؤكدها |
|---|---|---|---|
| H3 | تُكتب `*.json.tmp` ثم تُعاد تسميتها دون `sync_all` للملف أو للمجلد، فانقطاع الطاقة قد يُبقي ملفًا فارغًا بعد إعادة التسمية | `storage.rs` (`write_layer_bytes`) | اختبار انقطاع طاقة على APFS، أو مراجعة ضمانات APFS |
| H4 (الشق الأصلي) | `set_pin_persisted` يقصّ بالعدد فقط، دون ميزانية `MAX_HISTORY_BYTES` أو `retention_days` اللتين يطبّقهما `prune_history` (`storage.rs:930-955`). يتداركه أول التقاط لاحق، فالأثر مؤقت | `storage.rs:1282-1287` | اختبار يُلغي تثبيت عنصر أقدم من مدة الاحتفاظ، ويتحقق من `history` قبل أي التقاط |
| H6 (RAFF-AUD-005) | `update_settings` تقرأ `old` تحت القفل ثم تحرّره، وتكتب كائن الواجهة كاملًا. زر الالتقاط في شريط القوائم بين الخطوتين يُستبدل | `commands.rs:317-385` | استخراج النواة إلى دالة نقية تأخذ `&Mutex<Store>`، أو تجربة يدوية سريعة (القائمة، السيناريو 28) |
| H7 | `skip_change_count` قيمة `AtomicI64` واحدة تُستبدل بـ`swap(-1)`، فكتابتان سريعتان من رفّ قبل استطلاع واحد قد تجعلان الأولى تُلتقط | `monitor.rs` | لصق عنصرين متتاليين بسرعة (القائمة، السيناريو 29)، ثم مراقبة تكرار في السجل |
| H8 | كتابة PNG وتصغيره وترميزه داخل كتلة `lock_store`. القياس: أسوأ التقاط نصي عند الحد 52ms بإصدار release، أما مسار الصور فلم يُقَس | `monitor.rs:263-305` | قياس `get_state` أثناء التقاط صورة كبيرة (5K) على جهاز حقيقي |

## 8. أخطاء الاختبارات (`TEST-DEFECT`) وعوائق البيئة (`ENV-BLOCKER`)

**TEST-DEFECT:** لا توجد. توضيحان لشكوك ظهرت أثناء العمل:

- **تباين P0 بين TAP وJUnit:** TAP يعدّ 280 اختبارًا وJUnit يعدّ 252 `<testcase>`. ليس اختبارًا مفقودًا: مُبلِّغ JUnit يكتب 28 اختبارًا ذا اختبارات فرعية كـ`<testsuite>`، و252 + 28 = 280 (`p2/NOTES.md`).
- **مأزق في المشغّل، وليس في الحزمة:** `node --test --test-force-exit` يُسقط بصمت الاختبارات المسجَّلة بعد `await` علوي إذا سُجّلت اختبارات قبله.
  - فُحصت الحزمة الأساسية آليًا، ولا ملف فيها بهذا النمط.
  - تجنّبته اختبارات التدقيق.

**ENV-BLOCKER:** لا عائق مانع.

**قيود بيئية موثَّقة:**
- لا GNU `timeout`.
- Playwright وaxe ثُبّتا خارج المستودع.
- Tab على macOS لا يمرّ على الأزرار بلا «الوصول الكامل بلوحة المفاتيح»، فقيس الترتيب أيضًا بـ`Alt+Tab`.

## 9. فجوات التغطية

**الطفرات (P5):** قُتلت الطفرات التسع كلها، ولكن:
- **M7:** حذف فحص `deepSearchToken` في `panel.js` لا تقتله الحزمة الأساسية، وتقتله فقط `tests/audit-search-race.test.mjs`.
- **M6:** فحص `refreshToken` محمي بشكل غير مباشر، عبر اختبار التحمّل `panel-endurance` وحده.
- **M8:** استبدال `textContent` بـ`innerHTML` يقتله في الأساسية فحص ساكن للأيقونات. أما الحماية السلوكية فهي في `audit-render-safety`.

**تغطية الأسطر (C05، حزمة JS الأساسية):** الإجمالي 65.74% للأسطر، و72.60% للفروع، و49.42% للدوال. الأضعف:

| الملف | الأسطر |
|---|---|
| `settings.js` | 49.53% |
| `update-flow.js` | 66.67% |
| `scripts/dmg-layout.mjs` | 37.17% |
| `firstrun.js` | 80.44% |

ومعدّل الدوال في `about.js` 36.36%، وفي `update.js` 45.45%. لا تغطية لـRust، فلم يُشغَّل `cargo llvm-cov`.

**اختبارات مصدرية فقط (H11، C20):** من 52 ملف اختبار أساسي:
- **10 ملفات (36 اختبارًا) مصدرية فقط:** تقرأ النص وتطابقه بتعبير نمطي دون تنفيذ.
- **17 ملفًا (98 اختبارًا) مختلطة.**
- **25 ملفًا (143 اختبارًا) سلوكية.**

**سلوكيات لا يحرسها إلا اختبار مصدري، ولا يوجد لها اختبار سلوكي في أي مكان:**

| السلوك | الاختبار المصدري | الشيفرة |
|---|---|---|
| بقاء العنصر الملصوق على الحافظة | `paste-clipboard-contract` | `paste.rs`، `monitor.rs` |
| عدم تكرار كتابة رفّ لنفسه | `paste-clipboard-contract` | `paste.rs`، `monitor.rs` |
| استعادة الحمولة الكاملة للحافظة | `paste-clipboard-contract` | `paste.rs`، `monitor.rs` |
| أيقونة شريط القوائم تعكس تعطيل الالتقاط | `native-state-contract` | `tray.rs` |
| فتح الترحيب في أول تشغيل | `native-state-contract` | `main.rs` |
| تطابق أبعاد المصغّر بين Rust وCSS | `image-thumbnail-contract` | `monitor.rs` |
| هوية التطبيق ومعرّف الحزمة | `identity-contract` (13 اختبارًا) | — |

يضاف إلى ذلك وعود `privacy-promises`، واختبارات خط الإصدار (`release-*`، `ci-fix-*`، `build-candidate-pipeline`، `latest-json-signature-encoding`).

أعداد اختبارات Rust في الوحدات المعنية: `paste.rs` 4، و`monitor.rs` 9، و`tray.rs` 5، ولا يختبر أيٌّ منها مسار `NSPasteboard` الفعلي. هذه هي أكبر فجوة سلوكية، وتعالجها RAFF-IDEA-04 والقائمة اليدوية.

## 10. ما يحتاج تجربة أصلية على macOS

محتوى `audit/macos/`:
- **`run-native-checks.sh`:** يعمل بـ`set -euo pipefail`، ويشغّل ستة فحوص ويقارن رمز خروج كلٍّ منها بالمتوقَّع:
  1. `npm ci`
  2. `npm test`
  3. `cargo test`
  4. `cargo test -- --ignored` (المتوقَّع 101 ما دامت العيوب قائمة)
  5. الأداء بإصدار release
  6. فحص كتل `cfg(test)`
  
  يكتب `audit/evidence/macos/<UTC>/SUMMARY.txt`. والعلم الاختياري `--mutants` يشغّل `cargo mutants` المحصور. شُغّل محليًا وأعطى 6/6 PASS.
- **`MANUAL-CHECKLIST.md`:** 29 سيناريو عربيًا تُنفَّذ على `npm run tauri dev` معزول:
  - الإعداد: `npm run build:frontend` أولًا، مع `RAFF_DEV_ISOLATED=1` و`RAFF_DATA_DIR=$(mktemp -d)` و`RAFF_REPORT_ENDPOINT=http://127.0.0.1:9/v1/reports`.
  - تغطي: الالتقاط، والاستبعاد، والمحتوى السري، والإيقاف المؤقت بأنواعه الأربعة عبر السكون (H10)، واللصق بإذن تسهيل الوصول وبدونه، وتعارض الاختصار ⇧⌘V، والتلف (AUD-002 وAUD-003)، وإلغاء التثبيت عند الحد (AUD-001)، وسباق الإعدادات (H6)، واللصق المتتالي (H7)، والتباين الداكن، ولوحة المفاتيح، وVoiceOver.

**المطلوب من المشرف:**
1. على Mac حقيقي، داخل الفرع: `bash audit/macos/run-native-checks.sh`. ثم الصق محتوى `audit/evidence/macos/<UTC>/SUMMARY.txt` في تعليق على [#4](https://github.com/iSltanX/Raff/pull/4).
2. نفّذ `audit/macos/MANUAL-CHECKLIST.md`، وضع ✅ أو ❌ مع ملاحظة لكل سيناريو، ثم الصقه كاملًا في التعليق نفسه. الأهم السيناريو 10 (H10) والسيناريوهات 26 (AUD-002 وAUD-003) و27 (AUD-001) و28 (H6) و29 (H7).
3. اختياري: `bash audit/macos/run-native-checks.sh --mutants`.

**نتائج WebKit التقريبية (P4) التي تحتاج تأكيدًا في WKWebView قبل ترقيمها:**
- **تباين الوضع الداكن في صفوف اللوحة:** axe `color-contrast` serious ×9 على الخلفية `#505050`. النسب 3.58 لـ`.preview-title.is-link`، و3.08 لـ`.row-time` بحجم 11px، و4.1 لنص 11px عريض.
- **`label-content-name-mismatch`** على `#hotkey-chip`.
- **`heading-order`** في الإعدادات.
- **غياب `h1`** في index وreport وupdate.
- **لوحة تبويب الإعدادات** قابلة للتركيز بلا مؤشر مرئي.

## 11. أفكار إضافية لتطوير رفّ

مرتّبة بحسب القيمة. هذه أفكار وليست عيوبًا، ولم يُنفَّذ أيٌّ منها.

| ID | المشكلة والدليل | الموضع | الكلفة | المخاطر والمقايضات | الاتساق مع الوعود |
|---|---|---|---|---|---|
| RAFF-IDEA-01 | تلف الإعدادات يعيد الالتقاط بصمت (AUD-002). الفكرة: علامة «الإعدادات غير مقروءة» في الواجهة، وإبقاء الالتقاط معطّلًا حتى يؤكد المستخدم | `storage.rs` (`Store::load`)، `commands.rs` (`get_state`)، `panel.js` و`settings.js` | S | خطوة إضافية للمستخدم بعد التلف، وهي نادرة | يقوّي «حالة التقاط صادقة» و«ما يُستبعد لا يُحفظ» |
| RAFF-IDEA-02 | نسخ الاسترداد تُمحى (AUD-003). الفكرة: اسم بطابع زمني `history.json.corrupt-<ts>` مع حد أقصى للعدد، وحساب مراجع الصور من كل النسخ | `storage.rs` (`load_json_with_status`، `cleanup_orphan_images`) | S | تراكم ملفات، يُعالَج بحدّ وتنظيف بعد مدة | «ما تنسخه يبقى على جهازك»، وعدم إتلاف البيانات |
| RAFF-IDEA-03 | `set_pin_persisted` يعيد الحساب داخل الدالة (AUD-001، والشق الأصلي من H4). الفكرة: تمرير أي إعادة قصّ عبر `prune_history`، وألّا يُقَصّ العنصر المنقول نفسه | `storage.rs` | S | قد يتجاوز السجل حدّه بعنصر واحد مؤقتًا | سلامة البيانات |
| RAFF-IDEA-04 | السلوك الأهم (اللصق والحافظة) محمي باختبارات مصدرية فقط (H11). الفكرة: سمة `Pasteboard` يمرّرها `monitor` و`paste` مع تنفيذ وهمي، فتصبح `poll_once` وعدّ التخطي (H7) قابلة للاختبار | `monitor.rs`، `paste.rs`، `macos.rs` | M | إعادة هيكلة لكود حساس على الخيط الرئيسي | لا تغيير سلوكي. تزيد الثقة بوعد «لا يُلتقط المستبعد» |
| RAFF-IDEA-05 | `lock().unwrap()` متفرّق (AUD-004) وفقد التحديث في الإعدادات (H6). الفكرة: `lock_store` في كل مكان، و`update_settings` بأمر رقعة (patch) بدل الكائن الكامل أو بمقارنة إصدار | `commands.rs`، `paste.rs`، `panel.rs`، `updater.rs` | S–M | تغيير عقد الأمر مع الواجهة | حالة التقاط صادقة: زر القائمة لا يُستبدل |
| RAFF-IDEA-06 | ثغرة `rustls` (C09). الفكرة: `cargo update -p rustls` إلى `>=0.23.45`، وإضافة `cargo audit` و`npm audit --omit=dev` إلى CI | `Cargo.lock`، `.github/workflows/ci.yml` | S | فشل CI عند كل إعلان جديد، يُخفَّف بقائمة استثناءات موثَّقة | أمان مساري التحديث والبلاغ |
| RAFF-IDEA-07 | Node 20 منتهي الدعم منذ 2026-04-30 (H12). الفكرة: ترقية `ci.yml:28` و`release.yml:46` إلى LTS الحالي، مع `engines` في `package.json` | `.github/workflows/*`، `package.json` | S | اختلاف بسيط في سلوك `node:test` بين الإصدارات (الحزمة نجحت على Node 24) | صيانة خط الإصدار |
| RAFF-IDEA-08 | M7 نجت من الحزمة الأساسية، وتغطية `settings.js` 49.5%. الفكرة: بوابة تغطية دنيا في CI، وتشغيل دوري لـ`cargo mutants` على `storage.rs` | `package.json` (سكربت)، `ci.yml` | M | زمن CI، وضجيج من الطفرات المكافئة | جودة عامة |
| RAFF-IDEA-09 | تتبّع الإقلاع في الإصدار (AUD-006). الفكرة: حصره بـ`debug_assertions` أو تبديل في التشخيص، وكتابته في مجلد التطبيق مع `O_NOFOLLOW` و`0600`، وإزالة معرّفات العناصر وأسماء الحزم من الرسائل | `startup_trace.rs`، `paste.rs`، `main.rs` | S | فقدان أداة تشخيص سريعة لدى المستخدمين | «بلا تتبّع»، وحصر البيانات في مجلد التطبيق |
| RAFF-IDEA-10 | تباين الوضع الداكن (P4) والإيقاف بساعة `Instant` (H10). الفكرة: رفع رموز ألوان `.row-time` و`.preview-title` في الوضع الداكن إلى 4.5:1، وحساب `Pause::Until` بساعة الحائط `SystemTime` | CSS اللوحة، `monitor.rs` (`Pause`) | S | تغيّر طفيف في المظهر. ساعة الحائط تتأثر بتغيير الوقت يدويًا | العربية أولًا وإمكانية الوصول، و«15 دقيقة» تعني 15 دقيقة فعلًا |

## 12. العمل المتبقي

النطاق المطلوب اكتمل: لكل سطح في P1 حالة، والمخرجات في §6 كلها موجودة. المتبقي يحتاج المشرف أو جهازه:
1. **اعتماد CI:** زر «Approve and run workflows» على [#4](https://github.com/iSltanX/Raff/pull/4) (C24) للتأكد من نجاح الحزمة على Node 20 في CI. المتوقَّع: `npm test` و`cargo test` أخضران، لأن الإعادات متجاهَلة أو todo.
2. **الفحوص الأصلية:** تشغيل `bash audit/macos/run-native-checks.sh` وتنفيذ `audit/macos/MANUAL-CHECKLIST.md`، ثم لصق `SUMMARY.txt` والقائمة المعبّأة (C22، C23).
3. **ترقيم نتائج P4:** بعد التأكيد في WKWebView تُرقَّم كعيوب S3.
4. **إصلاح العيوب:** يُصلَح كل عيب، ثم يُزال `#[ignore]` أو `todo` من إعادة إنتاجه، ويُحذف اختبار التوصيف المقابل لأنه سيفشل بعد الإصلاح.
5. **اختياري:**
   - `cargo mutants` (C21)؛
   - `cargo llvm-cov` لتغطية Rust؛
   - استخراج نواة `update_settings` لاختبار H6.

</div>
