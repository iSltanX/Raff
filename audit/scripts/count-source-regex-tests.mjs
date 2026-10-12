// H11 — يصنّف ملفات الاختبار الأساسية: سلوكية (تشغّل كود الواجهة أو السكربتات) أم مصدرية فقط
// (تقرأ نص المصدر بـ readFileSync وتطابقه بتعبير نمطي دون تنفيذ).
// التشغيل: node audit/scripts/count-source-regex-tests.mjs
import fs from 'node:fs';
const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.mjs') && !f.startsWith('audit-')).sort();
const rows = files.map(f => {
  const s = fs.readFileSync('tests/' + f, 'utf8');
  const tests = (s.match(/^\s*(test|it)\s*\(/gm) || []).length + (s.match(/\bt\.test\s*\(/g) || []).length;
  const reads = [...s.matchAll(/['"`]([^'"`]*\.(rs|html|css|yml|yaml|json|plist|toml|md|js|mjs))['"`]/g)].map(m => m[1])
    .filter(p => /src-tauri|\.github|src\/|scripts\/|\.html|\.css|\.rs|\.yml|\.md/.test(p));
  const behavioural = /panel-harness|jsdom|JSDOM|await import\(|from '\.\.\/(src|scripts)\/|spawnSync|execFileSync|execSync/.test(s);
  const regex = /readFileSync/.test(s) && /\.(match|test)\(|assert\.(match|doesNotMatch)/.test(s);
  const rustOrCfg = reads.filter(p => /\.rs|\.yml|\.yaml|\.toml|\.plist|tauri\.conf/.test(p));
  return { file: f, tests, kind: behavioural ? (regex ? 'mixed' : 'behavioural') : regex ? 'source-only' : 'other', rustOrCfg: [...new Set(rustOrCfg)] };
});
const by = k => rows.filter(r => r.kind === k);
for (const k of ['source-only', 'mixed', 'behavioural', 'other']) {
  const rs = by(k);
  console.log(`${k}: ${rs.length} ملفات، ${rs.reduce((a, r) => a + r.tests, 0)} اختبارًا`);
  for (const r of rs) console.log(`  ${r.file} (${r.tests})${r.rustOrCfg.length ? ' ← ' + r.rustOrCfg.join(', ') : ''}`);
}
