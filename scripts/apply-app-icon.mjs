#!/usr/bin/env node
// Stamps the Icon Composer app icon (light in Light and Dark, one colour in
// Tinted) onto a built Raff.app.
//
// WHY THIS EXISTS
// ---------------
// macOS 26 does not simply display a legacy `.icns`. It decomposes the icon
// into a background "plate" and a foreground glyph and re-renders the plate
// with system material — which in Dark Mode, or with the Dark icon style,
// means a near-black plate on which an ink mark vanishes. Verified by
// resolving the icon through `NSWorkspace.icon(forFile:)`.
//
// The only supported way to decide those appearances is to ship an Icon
// Composer asset (`.icon` compiled to `Assets.car`, named by
// `CFBundleIconName`). Raff's icon is the light artwork in every appearance
// (Sultan, 2026-10-22, ت٦٨): a sand plate with the ink shelf and clay card in
// Light, and the same in Dark; one colour in Tinted, which the system tints.
// The `dark` entry must stay present, with the light values — without it,
// Icon Composer darkens the plate itself (checked with ictool's Dark
// rendition). The legacy `.icns` remains the Light artwork for systems before
// macOS 26.

// WHY IT IS A POST-BUILD STEP
// ---------------------------
// Listing the `.icon` in tauri.conf.json makes `tauri build` drive `actool`
// through `ibtoold`, which crashes reproducibly on this toolchain.
// Invoking `actool` directly, outside the Tauri
// build, does not go through that daemon and works. So the bundle is built
// first and the compiled catalogue is injected afterwards.
//
// Re-signing at the end is mandatory: adding files to Resources invalidates
// the existing signature.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

const ICON_SOURCE = path.join(project, 'src-tauri/icon-composer/AppIcon.icon');
const ICON_NAME = 'AppIcon';
/** The catalogue is stamped with the system it is built for: the app's own
 * minimum, read from `bundle.macOS.minimumSystemVersion`, not a newer one
 * (026 ج1). Compiled for 12.0 or 26.0 the catalogue holds the same renditions
 * — the legacy sizes and the Icon Composer layers alike — and differs only in
 * that stamp (evidence/2026-10-22-m7/actool-26-vs-12.diff). */
const DEPLOYMENT_TARGET = JSON.parse(
  readFileSync(path.join(project, 'src-tauri/tauri.conf.json'), 'utf8')
).bundle.macOS.minimumSystemVersion;

const appPath = process.argv[2]
  ?? path.join(project, 'src-tauri/target/release/bundle/macos/Raff.app');

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function plist(args) {
  return run('/usr/libexec/PlistBuddy', args);
}

if (!existsSync(appPath)) {
  console.error(`apply-app-icon: no bundle at ${appPath}`);
  process.exit(1);
}
if (!existsSync(ICON_SOURCE)) {
  console.error(`apply-app-icon: missing icon source at ${ICON_SOURCE}`);
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), 'raff-appicon-'));
try {
  run('xcrun', [
    'actool',
    '--output-format', 'human-readable-text',
    '--app-icon', ICON_NAME,
    '--output-partial-info-plist', path.join(work, 'partial.plist'),
    '--platform', 'macosx',
    '--minimum-deployment-target', DEPLOYMENT_TARGET,
    '--target-device', 'mac',
    '--compile', work,
    ICON_SOURCE,
  ]);

  const resources = path.join(appPath, 'Contents/Resources');
  copyFileSync(path.join(work, 'Assets.car'), path.join(resources, 'Assets.car'));
  copyFileSync(path.join(work, `${ICON_NAME}.icns`), path.join(resources, `${ICON_NAME}.icns`));

  // `CFBundleIconName` is what opts the bundle into the asset catalogue;
  // `CFBundleIconFile` keeps a plain .icns fallback for anything that predates
  // it. PlistBuddy has no upsert, so Set-then-Add covers both states.
  const info = path.join(appPath, 'Contents/Info.plist');
  for (const [key, value] of [['CFBundleIconName', ICON_NAME], ['CFBundleIconFile', ICON_NAME]]) {
    try {
      plist(['-c', `Set :${key} ${value}`, info]);
    } catch {
      plist(['-c', `Add :${key} string ${value}`, info]);
    }
  }

  // Adding resources invalidates the signature the bundler applied.
  run('codesign', ['--force', '--sign', '-', '--options', 'runtime', appPath]);

  // macOS caches a bundle's icon by path. The bundle was just built without
  // the catalogue, so Finder and the Dock would keep showing the pre-patch
  // (darkened) icon for this path; re-registering makes them read the new one.
  // Local convenience only — a copy installed from the DMG is a new path.
  try {
    run('touch', [appPath]);
    run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', appPath]);
  } catch {
    // Not fatal: the shipped artefacts are already correct.
  }

  console.log(`apply-app-icon: Icon Composer icon (light in Light and Dark, Tinted) applied to ${appPath}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
