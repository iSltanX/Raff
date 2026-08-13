#!/usr/bin/env node
// Produces ONE candidate: Raff.app, its DMG, and its updater archive, all
// generated from the SAME icon-patched app bundle — never a DMG built from
// one .app and a separately-patched .app installed by hand.
//
// WHY THIS EXISTS, NOT JUST `tauri build` + apply-app-icon.mjs
// --------------------------------------------------------------
// `apply-app-icon.mjs` alone patches `target/release/bundle/macos/Raff.app`
// in place, but `tauri build` had ALREADY produced the DMG and the updater
// tar.gz from the pre-patch app by the time that script runs — so the app
// tested locally and the app inside those two artifacts disagreed on the one
// thing this exists to fix. This script closes that gap: `tauri build` still
// has to run first (Tauri owns compiling, code-signing and the base bundle
// layout, and driving Icon Composer through Tauri's own bundler crashes via
// ibtoold — see apply-app-icon.mjs and docs/APP_ICON_DARK_MODE.md), but its
// DMG and tar.gz are discarded, and this script regenerates BOTH of them
// directly from the patched `.app` — the same bytes, not a rebuild.
//
// Result: `Raff.app`, the copy inside the `.dmg`, and the copy inside the
// updater `.tar.gz` are byte-identical in every icon-related resource,
// because all three trace back to one patch of one directory.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const bundleMacos = path.join(project, 'src-tauri/target/release/bundle/macos');
const bundleDmg = path.join(project, 'src-tauri/target/release/bundle/dmg');
const appPath = path.join(bundleMacos, 'Raff.app');

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function readVersion() {
  const conf = JSON.parse(readFileSync(path.join(project, 'src-tauri/tauri.conf.json'), 'utf8'));
  return conf.version;
}

// ── 1. tauri build — compiles, code-signs, produces the base .app (and a
//      DMG + tar.gz this script immediately discards and regenerates). ──────
try {
  run('npm', ['run', 'tauri', 'build'], { cwd: project });
} catch {
  // `tauri build` fails at its very last step locally: signing the updater
  // artifact needs TAURI_SIGNING_PRIVATE_KEY, which intentionally lives only
  // in CI (see docs/RAFF_COMPLETE_AUDIT_2026-08-12_AR.md), never on a dev
  // machine. Everything this script needs — the .app built and signed, an
  // unsigned tar.gz already on disk — exists by that point regardless, so
  // the failure itself is not fatal here. What IS fatal is checked next:
  // whether the app actually got built.
}

if (!existsSync(appPath)) {
  console.error(`build-candidate: tauri build did not produce ${appPath}`);
  process.exit(1);
}
console.log('tauri build: app produced (its own DMG/tar.gz will be discarded and regenerated below)');

// ── 2. Patch the app icon BEFORE anything downstream is generated from it. ──
run('node', [path.join(here, 'apply-app-icon.mjs'), appPath]);

// ── 3. Regenerate the DMG from the now-patched app. ──────────────────────
const version = readVersion();
const dmgName = `Raff_${version}_aarch64.dmg`;
const dmgPath = path.join(bundleDmg, dmgName);
const work = mkdtempSync(path.join(tmpdir(), 'raff-dmg-'));
const staging = path.join(work, 'src'); // hdiutil's -srcfolder: content only
const rwDmg = path.join(work, 'rw.dmg'); // sibling, NOT inside -srcfolder
try {
  run('mkdir', ['-p', staging]);
  run('cp', ['-R', appPath, path.join(staging, 'Raff.app')]);
  symlinkSync('/Applications', path.join(staging, 'Applications'));

  run('hdiutil', [
    'create', '-ov', '-fs', 'HFS+', '-volname', 'Raff',
    '-srcfolder', staging, '-format', 'UDRW', rwDmg,
  ]);
  if (existsSync(dmgPath)) rmSync(dmgPath, { force: true });
  run('hdiutil', ['convert', rwDmg, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', dmgPath]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ── 4. Regenerate the updater archive from the same patched app. ────────
const tarPath = path.join(bundleMacos, 'Raff.app.tar.gz');
if (existsSync(tarPath)) rmSync(tarPath, { force: true });
run('tar', ['-czf', tarPath, '-C', bundleMacos, 'Raff.app']);

console.log('\nbuild-candidate: done.');
console.log(`  app: ${appPath}`);
console.log(`  dmg: ${dmgPath}`);
console.log(`  tar: ${tarPath} (unsigned locally — CI signs this with the real key)`);
