#!/usr/bin/env node
// Stamps the canonical Light app icon onto a built Raff.app.
//
// WHY THIS EXISTS
// ---------------
// macOS 26 does not simply display a legacy `.icns`. It decomposes the icon
// into a background "plate" and a foreground glyph and re-renders the plate
// with system material — which in Dark Mode, or with the Dark icon style,
// means a near-black plate. Raff's plate is part of the mark, so the app
// showed up black, no matter that the shipped `.icns` contained only light
// artwork. Verified by resolving the icon through
// `NSWorkspace.icon(forFile:)`: the same `.icns` rendered black, while a
// control app's legacy icns kept its colour because that app ships a modern
// icon asset.
//
// The only supported way to pin appearance is to ship an Icon Composer asset
// (`.icon` compiled to `Assets.car`, named by `CFBundleIconName`). Raff's
// declares the SAME light plate, ink and sage for the default and `dark`
// appearances. That `dark` entry is not a dark icon: it is what stops macOS
// generating one — without it, Icon Composer darkens the plate itself (checked
// with ictool's Dark rendition). So the application icon is the light one in
// Light, Dark and the Dark icon style alike. Raff's interior UI keeps
// following its own appearance setting.
//
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
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

const ICON_SOURCE = path.join(project, 'src-tauri/icon-composer/AppIcon.icon');
const ICON_NAME = 'AppIcon';
/** Matches `bundle.macOS.minimumSystemVersion`'s modern-icon requirement. */
const DEPLOYMENT_TARGET = '26.0';

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

  console.log(`apply-app-icon: canonical Light icon applied to ${appPath}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
