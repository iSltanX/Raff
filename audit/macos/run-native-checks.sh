#!/usr/bin/env bash
# فحوص رفّ الأصلية على macOS — آمن لإعادة التشغيل.
# لا يلمس بيانات المستخدم الحقيقية، ولا يشغّل التطبيق المثبّت، ولا يقرأ الحافظة، ولا يرسل أحداث إدخال.
# الاستعمال: bash audit/macos/run-native-checks.sh [--mutants] [--audit-phase]
#   --mutants      يشغّل cargo mutants محصورًا (يسرد الطفرات أولًا ثم ينفّذها على ملفات مختارة بمهلة صريحة).
#   --audit-phase  يضيف فحص check-cfg-test-hunks، وهو لفرع التدقيق (#4) وحده قبل الإصلاحات.
set -euo pipefail

RUN_MUTANTS=0
AUDIT_PHASE=0
for arg in "$@"; do
  case "$arg" in
    --mutants) RUN_MUTANTS=1 ;;
    --audit-phase) AUDIT_PHASE=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "وسيط غير معروف: $arg" >&2; exit 2 ;;
  esac
done

# Node 24 فما فوق: على Node 20 يُسقط npm test (node --test --test-force-exit)
# اختبارات بصمت ويخرج بـ0، فيبدو الفحص ناجحًا وهو لم يشغّل الحزمة كاملة.
NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( NODE_MAJOR < 24 )); then
  echo "يلزم Node 24 أو أحدث (الحالي $(node --version))." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/audit/evidence/macos/$STAMP"
mkdir -p "$OUT"
SUMMARY="$OUT/SUMMARY.txt"
: > "$SUMMARY"

# يمنع أي اختبار من الوصول إلى بيانات المستخدم أو نقطة البلاغات الحقيقية.
export RAFF_DATA_DIR="$(mktemp -d -t raff-audit-data)"
export RAFF_DEV_ISOLATED=1
export RAFF_REPORT_ENDPOINT="http://127.0.0.1:9/v1/reports"
trap 'rm -rf "$RAFF_DATA_DIR"' EXIT

# step NAME EXPECTED_CODE CMD...  — يسجّل المخرجات ورمز الخروج، ولا يوقف السكربت عند الفشل.
step() {
  local name="$1" expected="$2"; shift 2
  local log="$OUT/$name.log" code=0
  echo "▶ $name: $*"
  { echo "\$ $*"; echo "# $(date -u +%FT%TZ)"; } > "$log"
  "$@" >> "$log" 2>&1 || code=$?
  echo "exit=$code" >> "$log"
  local verdict="PASS"
  [[ "$code" == "$expected" ]] || verdict="UNEXPECTED"
  printf '%-22s exit=%-4s expected=%-4s %s\n' "$name" "$code" "$expected" "$verdict" | tee -a "$SUMMARY"
}

{
  echo "# البيئة"
  sw_vers || true
  echo "arch: $(uname -m)"
  echo "xcode-select: $(xcode-select -p 2>&1 || true)"
  echo "node: $(node --version)"
  echo "npm: $(npm --version)"
  echo "rustc: $(rustc --version)"
  echo "cargo: $(cargo --version)"
  echo "HEAD: $(git rev-parse HEAD)"
  echo "RAFF_DATA_DIR (مؤقت): $RAFF_DATA_DIR"
} | tee "$OUT/env.txt"

step npm-ci            0   npm ci --no-audit --no-fund
step npm-test          0   npm test
step cargo-test        0   cargo test --manifest-path src-tauri/Cargo.toml
# المتوقع 0 بعد إصلاحات #5: لم يبقَ متجاهَلًا إلا مجسّا الأداء، وكلاهما ينجح.
# (على فرع التدقيق وحده، قبل الإصلاح، كان 101 لأن إعادات RAFF-AUD تفشل عمدًا.)
step cargo-test-ignored 0  cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --test-threads=1
step perf-release      0   cargo test --release --manifest-path src-tauri/Cargo.toml perf_probe -- --ignored --nocapture --test-threads=1
# check-cfg-test-hunks يحرس قاعدة مرحلة التدقيق (لا تعديل خارج mod audit_tests)،
# والإصلاحات تعدّل شيفرة المنتج عمدًا، فلا يُشغَّل إلا بـ‎--audit-phase على فرع #4.
if [[ "$AUDIT_PHASE" == 1 ]]; then
  step cfg-test-hunks  0   node audit/scripts/check-cfg-test-hunks.mjs origin/main
fi

if [[ "$RUN_MUTANTS" == 1 ]]; then
  if command -v cargo-mutants >/dev/null 2>&1; then
    MUT_FILES=(-f src/storage.rs -f src/report.rs)
    step mutants-list  0 cargo mutants -d src-tauri "${MUT_FILES[@]}" --list
    step mutants-run   0 cargo mutants -d src-tauri "${MUT_FILES[@]}" --timeout 180 --jobs 2 --output "$OUT"
  else
    echo "cargo-mutants غير مثبّت: cargo install --locked cargo-mutants" | tee -a "$SUMMARY"
  fi
fi

echo "السجلات: $OUT"
grep -q UNEXPECTED "$SUMMARY" && exit 1 || exit 0
