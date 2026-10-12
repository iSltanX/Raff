#!/usr/bin/env node
// يثبت أن كل تعديل على ملفات Rust إضافة خالصة في نهاية الملف، داخل
// `#[cfg(test)] mod audit_tests`، وأن لا ملف منتج آخر تغيّر.
// الاستخدام: node audit/scripts/check-cfg-test-hunks.mjs [BASE]   (الافتراضي: origin/main)
import { execFileSync } from 'node:child_process';

const base = process.argv[2] || 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const mergeBase = git('merge-base', base, 'HEAD').trim();
const changed = git('diff', '--name-status', mergeBase).trim().split('\n').filter(Boolean);

const allowed = [/^audit\//, /^tests\/audit-[^/]+\.test\.mjs$/, /^src-tauri\/src\/[^/]+\.rs$/];
let failures = 0;
const fail = (msg) => { failures++; console.log(`✖ ${msg}`); };

for (const line of changed) {
  const [status, file] = line.split('\t');
  if (!allowed.some((re) => re.test(file))) { fail(`${file}: ملف خارج النطاق المسموح (${status})`); continue; }
  if (!file.endsWith('.rs')) continue;
  if (status !== 'M') { fail(`${file}: ملف Rust ${status} — المسموح تعديل ملف قائم فقط`); continue; }

  const diff = git('diff', '-U0', mergeBase, '--', file);
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
  const oldLen = git('show', `${mergeBase}:${file}`).split('\n').length - 1;
  const now = git('show', `HEAD:${file}`).split('\n');
  const marker = now.findIndex((l, i) => l.trim() === '#[cfg(test)]' && now[i + 1]?.trim() === 'mod audit_tests {');
  if (marker < 0) { fail(`${file}: لا يوجد #[cfg(test)] mod audit_tests`); continue; }
  for (const h of hunks) {
    const removed = h[2] === undefined ? 1 : Number(h[2]);
    const oldStart = Number(h[1]);
    if (removed !== 0) { fail(`${file}: الكتلة ${h[0]} تحذف أو تعدّل أسطرًا قائمة`); continue; }
    if (oldStart !== oldLen) { fail(`${file}: الكتلة ${h[0]} ليست في نهاية الملف (طول الأصل ${oldLen})`); continue; }
  }
  // كل ما أُضيف بعد نهاية الأصل: تعليقات/أسطر فارغة ثم الوسم ثم الوحدة حتى آخر الملف.
  const added = now.slice(oldLen);
  const preamble = added.slice(0, marker - oldLen);
  if (preamble.some((l) => l.trim() && !l.trim().startsWith('//'))) fail(`${file}: كود خارج وحدة الاختبار قبل الوسم`);
  let depth = 0, closedAt = -1;
  for (let i = marker + 1; i < now.length; i++) {
    for (const ch of now[i].replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '')) {
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0 && closedAt < 0) closedAt = i; }
    }
  }
  if (closedAt < 0 || now.slice(closedAt + 1).some((l) => l.trim())) fail(`${file}: محتوى بعد إغلاق mod audit_tests`);
  else console.log(`✔ ${file}: ${added.length} سطرًا مضافًا، كلها داخل #[cfg(test)] mod audit_tests (السطر ${marker + 1})`);
}
console.log(failures ? `\nفشل: ${failures}` : '\nكل كتل Rust داخل cfg(test) ولا ملفات منتج أخرى معدّلة.');
process.exit(failures ? 1 : 0);
