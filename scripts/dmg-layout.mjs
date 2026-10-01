// Gives the installer DMG its designed window: the background from
// src-tauri/dmg/background.tiff (see gen-dmg-background.mjs), Raff.app and the
// Applications link centred in the two dashed frames, no toolbar or status bar,
// and رفّ's icon on the volume.
//
// Used by build-candidate.mjs (local) and ci-fix-release-icon.mjs (release),
// on the read-write image they already create from the patched app, before it
// is compressed — so the app inside is untouched and the order guarantees of
// both pipelines stay as they are.
//
// Finder writes the layout into the volume's .DS_Store, the way create-dmg and
// Tauri's own bundler do it. The window is addressed by its mount path, never
// by the volume name: another «Raff» may already be mounted.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

export const BACKGROUND = path.join(project, 'src-tauri/dmg/background.tiff');
export const VOLUME_ICON = path.join(project, 'src-tauri/icons/icon.icns');
/** The background's size in points; the window shows exactly this. */
export const WINDOW = { width: 660, height: 420 };
/** Icon centres, matching the dashed frames in background.html. */
export const ICON_CENTRES = { 'Raff.app': [170, 187], Applications: [490, 187] };
export const ICON_SIZE = 128;
export const TEXT_SIZE = 14;
/** Finder's window bounds include its title bar: 32 pt on macOS 26 and 27
 *  (measured on the opened DMG). The path and status bars are hidden. */
const TITLE_BAR = 32;

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function layoutScript(mountPoint) {
  const [x, y] = [160, 120];
  const position = (name) => `set position of item "${name}" of theDisk to {${ICON_CENTRES[name].join(', ')}}`;
  return `
tell application "Finder"
  set theDisk to (POSIX file "${mountPoint}" as alias)
  open theDisk
  set cw to container window of theDisk
  set current view of cw to icon view
  set toolbar visible of cw to false
  set statusbar visible of cw to false
  set pathbar visible of cw to false
  set bounds of cw to {${x}, ${y}, ${x + WINDOW.width}, ${y + WINDOW.height + TITLE_BAR}}
  set vo to icon view options of cw
  set arrangement of vo to not arranged
  set icon size of vo to ${ICON_SIZE}
  set text size of vo to ${TEXT_SIZE}
  set label position of vo to bottom
  set shows item info of vo to false
  set shows icon preview of vo to true
  set background picture of vo to file ".background:background.tiff" of theDisk
  ${position('Raff.app')}
  ${position('Applications')}
  close cw
  open theDisk
  update theDisk without registering applications
  delay 2
  close container window of theDisk
end tell`;
}

/**
 * Styles a read-write DMG in place: grows it a little for the background and
 * the volume icon, mounts it, lays the window out, and detaches it.
 */
export function styleDmg(rwDmg) {
  for (const file of [BACKGROUND, VOLUME_ICON]) {
    if (!existsSync(file)) throw new Error(`dmg-layout: missing ${file}`);
  }
  // Room for background.tiff, .VolumeIcon.icns and Finder's .DS_Store.
  const limits = execFileSync('hdiutil', ['resize', '-limits', rwDmg], { encoding: 'utf8' }).trim().split(/\s+/);
  const currentSectors = Number(limits[1]);
  run('hdiutil', ['resize', '-sectors', String(currentSectors + 40960), rwDmg]); // +20 MB

  const mountPoint = mkdtempSync(path.join(tmpdir(), 'raff-dmg-mount-'));
  run('hdiutil', ['attach', rwDmg, '-readwrite', '-noverify', '-noautoopen', '-mountpoint', mountPoint]);
  try {
    const backgroundDir = path.join(mountPoint, '.background');
    mkdirSync(backgroundDir, { recursive: true });
    copyFileSync(BACKGROUND, path.join(backgroundDir, 'background.tiff'));

    run('osascript', ['-e', layoutScript(mountPoint)]);
    // Finder writes .DS_Store asynchronously; wait until it is on disk.
    for (let i = 0; i < 20 && !existsSync(path.join(mountPoint, '.DS_Store')); i += 1) {
      execFileSync('sleep', ['0.5']);
    }
    if (!existsSync(path.join(mountPoint, '.DS_Store'))) throw new Error('dmg-layout: Finder wrote no .DS_Store');

    // After Finder, not before: its layout pass deletes .VolumeIcon.icns and
    // clears the volume's custom-icon flag (seen on macOS 27).
    const volumeIcon = path.join(mountPoint, '.VolumeIcon.icns');
    copyFileSync(VOLUME_ICON, volumeIcon);
    run('SetFile', ['-c', 'icnC', volumeIcon]);
    run('SetFile', ['-a', 'C', mountPoint]);
    run('chmod', ['-Rf', 'go-w', mountPoint]);
    rmSync(path.join(mountPoint, '.fseventsd'), { recursive: true, force: true });
    run('sync', []);
  } finally {
    run('hdiutil', ['detach', mountPoint, '-force']);
    rmdirSync(mountPoint); // empty once detached; never a recursive delete here

  }
}
