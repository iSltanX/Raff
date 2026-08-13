#!/usr/bin/env node
// Runs in CI, immediately after tauri-action has built, signed, and
// uploaded the release. tauri-action's own build produces the SAME defect
// apply-app-icon.mjs/build-candidate.mjs exist to fix locally: an
// appearance-unaware `icon.icns` that macOS 26 renders black in Dark Mode.
// tauri-action has no post-build hook, so this step re-does, in CI, exactly
// what build-candidate.mjs proved locally: patch the icon, then regenerate
// the DMG and the updater archive FROM the patched app — never uploading a
// DMG built from one app and an update archive built from another.
//
// It replaces four assets in the draft release tauri-action already
// created: the DMG, the updater tar.gz, its .sig, and latest.json (whose
// `signature` field is the base64 of the WHOLE .sig file — verified against
// a real published latest.json, decoded, before writing this). Everything
// else about the release (title, draft state, the other Info.plist/version
// metadata) is left exactly as tauri-action set it.
//
// Required env: GH_TOKEN (gh CLI auth), TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]
// (same secrets already used by the tauri-action step), GITHUB_REPOSITORY.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

// tauri-action is invoked with `args: --target aarch64-apple-darwin` (see
// release.yml), and `cargo`/`tauri build` nest EVERY target-qualified build
// under `target/<triple>/release/...` — even when the triple matches the
// host natively — instead of the unqualified `target/release/...` a plain
// `tauri build` (no --target, what build-candidate.mjs runs locally) uses.
// Checking both, preferring the target-qualified one, keeps this script
// correct for however it's invoked rather than hardcoding one path and
// failing silently-until-it-doesn't when that assumption breaks.
const candidates = [
  path.join(project, 'src-tauri/target/aarch64-apple-darwin/release/bundle'),
  path.join(project, 'src-tauri/target/release/bundle'),
];
const bundleRoot = candidates.find((p) => existsSync(path.join(p, 'macos/Raff.app')));
if (!bundleRoot) {
  console.error(
    `ci-fix-release-icon: no Raff.app found in any of:\n${candidates.map((p) => `  ${path.join(p, 'macos/Raff.app')}`).join('\n')}\ntauri-action must run first.`
  );
  process.exit(1);
}
console.log(`ci-fix-release-icon: using bundle root ${bundleRoot}`);
const bundleMacos = path.join(bundleRoot, 'macos');
const bundleDmg = path.join(bundleRoot, 'dmg');
const appPath = path.join(bundleMacos, 'Raff.app');

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
}

const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('ci-fix-release-icon: GITHUB_REF_NAME is not set (expected a tag push)');
  process.exit(1);
}
const conf = JSON.parse(readFileSync(path.join(project, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;

// ── 1. Patch the icon — same script, same fix, as the local candidate. ──────
run('node', [path.join(here, 'apply-app-icon.mjs'), appPath]);

// ── 2. Regenerate the DMG from the patched app. ─────────────────────────
const dmgName = `Raff_${version}_aarch64.dmg`;
const dmgPath = path.join(bundleDmg, dmgName);
{
  const work = mkdtempSync(path.join(tmpdir(), 'raff-dmg-'));
  const staging = path.join(work, 'src');
  const rwDmg = path.join(work, 'rw.dmg');
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
}

// ── 3. Regenerate the updater archive from the same patched app, and sign
//      it — the OLD .sig is for different bytes and is now invalid. ────────
const tarAssetName = 'Raff_aarch64.app.tar.gz'; // the exact name already live in existing latest.json URLs
const tarPath = path.join(bundleMacos, tarAssetName);
if (existsSync(tarPath)) rmSync(tarPath, { force: true });
run('tar', ['-czf', tarPath, '-C', bundleMacos, 'Raff.app']);

run('npx', ['tauri', 'signer', 'sign', tarPath], {
  cwd: project,
  env: { ...process.env }, // TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] pass through
});
const sigPath = `${tarPath}.sig`;
if (!existsSync(sigPath)) {
  console.error(`ci-fix-release-icon: signing did not produce ${sigPath}`);
  process.exit(1);
}

// ── 4. Regenerate latest.json with the new signature. Same shape as the
//      one tauri-action already published (verified against v4.1.1's real,
//      live latest.json before writing this).
//
//      `tauri signer sign` writes the .sig file ALREADY base64-encoded — its
//      raw content on disk (trimmed) IS the exact string the updater expects
//      as `signature`, not something to base64-encode again. Re-encoding it
//      here was a real bug: it shipped on v4.2.1's first upload as a
//      double-encoded value that would have failed every real client's
//      minisign verification silently, caught only by downloading the live
//      asset and decoding it — decode-once must land on minisign's own
//      "untrusted comment: ..." text, never on more base64. ───────────────
const repo = process.env.GITHUB_REPOSITORY;
const assetUrl = `https://github.com/${repo}/releases/download/${tag}/${tarAssetName}`;
const signatureB64 = readFileSync(sigPath, 'utf8').trim();
let notes;
try {
  notes = capture('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body']);
} catch {
  notes = 'اكتب ملاحظات الإصدار بلغة المستخدم قبل النشر.';
}
const latestJson = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': { signature: signatureB64, url: assetUrl },
    'darwin-aarch64-app': { signature: signatureB64, url: assetUrl },
  },
};
const latestJsonPath = path.join(bundleMacos, 'latest.json');
writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2));

// ── 5. Replace the four stale-icon assets already on the draft release. ────
for (const file of [dmgPath, tarPath, sigPath, latestJsonPath]) {
  run('gh', ['release', 'upload', tag, file, '--clobber']);
}

console.log('\nci-fix-release-icon: done. Replaced on the release:');
console.log(`  ${dmgName}`);
console.log(`  ${tarAssetName}`);
console.log(`  ${tarAssetName}.sig`);
console.log('  latest.json');
