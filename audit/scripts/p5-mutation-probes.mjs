// P5 — مجسّات طفرات يدوية لكود JS. تعمل في worktree مؤقت ولا تُلتزم أي طفرة.
// التشغيل: node audit/scripts/p5-mutation-probes.mjs [WORKTREE=/tmp/raff-mut]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const wt = process.argv[2] || '/tmp/raff-mut';

const mutations = [
  ['M1', 'src/js/logic.js', ".replace(/[أإآ]/g, 'ا') // alef forms", '', 'حذف طيّ الألف في normalizeArabic'],
  ['M2', 'src/js/logic.js', ".replace(/[\u064B-\u065F\u0670]/g, '') // tashkeel", '', 'حذف إزالة التشكيل في normalizeArabic'],
  ['M3', 'src/js/logic.js', ".replace(/ى/g, 'ي') // dotless ya", '', 'حذف طيّ الألف المقصورة'],
  ['M4', 'src/js/logic.js', 'alsoMatchIds?.has(item.id) ||', '', 'تجاهل alsoMatchIds في filterItems'],
  ['M5', 'src/js/panel.js', "return ERROR_MESSAGES[String(err)] ?? 'تعذّر إتمام العملية. حاول مرة أخرى.';", 'return String(err);', 'errorMessage يعيد String(err)'],
  ['M6', 'src/js/panel.js', "if (token !== refreshToken) return 'superseded'; // a newer refresh already won", '', 'حذف فحص الرمز القديم بعد getState في refresh'],
  ['M7', 'src/js/panel.js', 'if (token !== deepSearchToken) return;', '', 'حذف فحص deepSearchToken'],
  ['M8', 'src/js/panel.js', 'title.textContent = item.text; // clip content → textContent', 'title.innerHTML = item.text;', 'عرض نص المقطع عبر innerHTML'],
  ['M9', 'scripts/build-frontend.mjs', "  'js/logic.js',", "  'js/logic.js',\n  'js/mock.js',", 'إضافة mock.js إلى قائمة السماح في البناء'],
];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

if (fs.existsSync(wt)) sh('git', ['worktree', 'remove', '--force', wt]);
sh('git', ['worktree', 'add', '--detach', wt, 'HEAD']);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));

const tests = fs.readdirSync(path.join(wt, 'tests')).filter(f => f.endsWith('.test.mjs'));
const suites = {
  baseline: tests.filter(f => !f.startsWith('audit-')).map(f => 'tests/' + f),
  audit: tests.filter(f => f.startsWith('audit-')).map(f => 'tests/' + f),
};
const run = (files) => {
  const r = spawnSync('node', ['--test', '--test-force-exit', '--test-reporter=tap', ...files], { cwd: wt, encoding: 'utf8' });
  const fail = Number((r.stdout.match(/^# fail (\d+)/m) || [])[1] ?? NaN);
  const failing = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]).filter(t => !/# (TODO|SKIP)/.test(t)).slice(0, 4);
  return { code: r.status, fail, failing };
};

const rows = [];
try {
  const base = { baseline: run(suites.baseline), audit: run(suites.audit) };
  console.log(`clean: baseline fail=${base.baseline.fail} audit fail=${base.audit.fail}`);
  if (base.baseline.fail !== 0 || base.audit.fail !== 0) throw new Error('الشجرة النظيفة لا تنجح؛ أوقف');
  for (const [id, file, find, repl, desc] of mutations) {
    const p = path.join(wt, file);
    const orig = fs.readFileSync(p, 'utf8');
    if (orig.split(find).length !== 2) throw new Error(`${id}: نمط غير فريد أو غير موجود في ${file}`);
    fs.writeFileSync(p, orig.replace(find, repl));
    const b = run(suites.baseline);
    const a = run(suites.audit);
    fs.writeFileSync(p, orig);
    const status = b.fail > 0 ? 'KILLED' : a.fail > 0 ? 'KILLED-BY-AUDIT' : 'SURVIVED';
    rows.push({ id, file, desc, status, baselineFail: b.fail, auditFail: a.fail, baselineFailing: b.failing, auditFailing: a.failing });
    console.log(`${id} ${status} baseline_fail=${b.fail} audit_fail=${a.fail} — ${desc}`);
    for (const t of b.failing) console.log(`    baseline: ${t}`);
    for (const t of a.failing) console.log(`    audit:    ${t}`);
  }
  const dirty = sh('git', ['status', '--porcelain'], { cwd: wt }).split('\n').filter(l => l.trim() && !l.endsWith('node_modules')).join('\n');
  console.log(`worktree clean after restore: ${dirty === '' ? 'yes' : 'NO\n' + dirty}`);
} finally {
  fs.writeFileSync(path.join(repo, 'audit/evidence/p5/mutations.json'), JSON.stringify(rows, null, 2));
  sh('git', ['worktree', 'remove', '--force', wt]);
}
