# فهرس الأدلة — تدقيق رفّ

يربط هذا الفهرس كل فحص في §5 من `audit/RAFF-COPILOT-AUDIT.md` بملفات الدليل. المسارات نسبية إلى `audit/evidence/` ما لم يُذكر غير ذلك.

ملاحظة: `.gitignore` في المستودع يتجاهل `*.log`، لذلك أُضيفت السجلات بـ`git add -f`.

## الفحوص وأدلتها

| id | الحالة | الدليل |
|---|---|---|
| C01 | PASS | `p0/npm-ci.log` |
| C02 | PASS | `p0/build-frontend.log`، `p0/dist-files.txt` |
| C03 | PASS | `p0/npm-test.log`، `p0/npm-test-spec.log`، `p0/npm-test.junit.xml` |
| C04 | PASS | `p0/flaky-runs.txt`، `p0/run1.junit.xml`، `p0/run2.junit.xml`، `p0/run3.junit.xml` |
| C05 | PASS | `p0/coverage.log` |
| C06 | PASS | `p0/cargo-check.log` |
| C07 | PASS | `p0/cargo-test-baseline.log` |
| C08 | FAIL | `p0/cargo-fmt.log` |
| C09 | FAIL | `p0/cargo-audit.log` |
| C10 | FAIL | `p0/npm-audit.log` |
| C11 | PASS | `p2/npm-test.log`، `p2/NOTES.md` |
| C12 | PASS | `p2/audit-tests.log` |
| C13 | PASS | `p3/cargo-test.log`، `p3/NOTES.md` |
| C14 | FAIL (متوقَّع) | `p3/cargo-test-ignored.log` |
| C15 | PASS | `p3/perf-release.log` |
| C16 | PASS | `p3/cfg-check.log` |
| C17 | PASS (تقريبي) | `p4/ui-approx.log`، `p4/ui-approx.json`، `p4/*-light.png`، `p4/*-dark.png`، `p4/NOTES.md` |
| C18 | PASS | `p5/mutations.log`، `p5/mutations.json`، `p5/NOTES.md` |
| C19 | PASS | `macos/20261012T194453Z/SUMMARY.txt` وبقية ملفات المجلد نفسه |
| C20 | PASS (قياس) | `p7/h11-source-regex.log` |
| C21 | SKIPPED | الأمر جاهز في `audit/macos/run-native-checks.sh --mutants` |
| C22 | PENDING-NATIVE | `audit/macos/MANUAL-CHECKLIST.md` (29 سيناريو) |
| C23 | PENDING-NATIVE | `audit/macos/MANUAL-CHECKLIST.md` (السيناريو 10) |
| C24 | PENDING-NATIVE | `gh pr checks 4` بعد موافقة المشرف على تشغيل سير العمل |

## بيانات البيئة والسياق

- `p0/base-sha.txt`: الالتزام الذي بُني عليه التدقيق.
- `p0/env.txt` و`macos/20261012T194453Z/env.txt`: إصدارات النظام وNode وRust.
- `p0/macos-tool-tests.txt`: الأدوات المتاحة على الجهاز.
- `p1/loc.txt` و`p1/risk-map.md`: حجم الكود وخريطة المخاطر.

## العيوب وأماكن إعادة إنتاجها

| العيب | الاختبار | الدليل |
|---|---|---|
| RAFF-AUD-001 | `storage.rs` → `aud001_*` (`#[ignore]`) | `p3/cargo-test-ignored.log` |
| RAFF-AUD-002 | `storage.rs` → `aud002_*` | `p3/cargo-test-ignored.log` |
| RAFF-AUD-003 | `storage.rs` → `aud003_*` | `p3/cargo-test-ignored.log` |
| RAFF-AUD-004 | `commands.rs` → `aud004_*` | `p3/cargo-test-ignored.log` |
| RAFF-AUD-006 | `startup_trace.rs` → `aud006_*` | `p3/cargo-test-ignored.log` |
| RAFF-AUD-007 | `storage.rs` → `aud007_*`، و`tests/audit-normalize-parity.test.mjs` (todo) | `p3/cargo-test-ignored.log`، `p2/audit-tests.log` |
| RAFF-AUD-008 | `storage.rs` → `aud008_*`، و`tests/audit-normalize-parity.test.mjs` (todo) | `p3/cargo-test-ignored.log`، `p2/audit-tests.log` |
| RAFF-AUD-009 | `report.rs` → `aud009_*` | `p3/cargo-test-ignored.log` |

## الأدوات والبيانات الثابتة

| الملف | الغرض |
|---|---|
| `audit/fixtures/normalize-vectors.json` | متجهات تطبيع البحث المشتركة بين JS وRust |
| `audit/scripts/gen-normalize-vectors.mjs` | يولّد المتجهات من `logic.js` |
| `audit/scripts/check-cfg-test-hunks.mjs` | يتحقق من أن تعديلات Rust كلها داخل `#[cfg(test)]` |
| `audit/scripts/p4-ui-approx.mjs` | الفحص التقريبي للواجهة بـWebKit وaxe |
| `audit/scripts/p5-mutation-probes.mjs` | مجسّات الطفرات في worktree مؤقت |
| `audit/scripts/count-source-regex-tests.mjs` | يقيس H11 (اختبارات تفحص نص المصدر) |
| `audit/macos/run-native-checks.sh` | الفحوص الأصلية على جهاز المشرف |
| `audit/macos/MANUAL-CHECKLIST.md` | قائمة التحقق اليدوية |
| `tests/audit-*.test.mjs` | ستة ملفات اختبارات JS أُضيفت للتدقيق |
