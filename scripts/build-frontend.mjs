// Build the Tauri web payload from an explicit production allowlist. The
// source tree also contains browser-only mock data and Figma audit exports;
// copying `src/` wholesale would silently ship both classes of reference file.
//
// `--out=<dir>` builds somewhere else (the test suite's own temporary
// directory), so a test run never rewrites the `dist/` that `tauri build`
// packages. A flag and not an environment variable: a variable left set in a
// shell would quietly send a release build's payload elsewhere while Tauri
// packaged a stale `dist/`. That directory is written into, never emptied,
// and must hold nothing yet: a mistyped path must not become a deletion.

import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src');
const args = process.argv.slice(2);
// `--out dir` (a space) or a stray word must not fall back to `dist/`, which
// the default build empties first.
const unknown = args.filter((arg) => !arg.startsWith('--out='));
if (unknown.length > 0 || args.length > 1) {
  console.error(`raff: build-frontend takes only --out=<dir>; got ${args.join(' ')}`);
  process.exit(1);
}
const outFlag = args[0];
const distRoot = outFlag ? path.resolve(outFlag.slice('--out='.length)) : path.join(projectRoot, 'dist');

const productionFiles = Object.freeze([
  'about.css',
  'about.html',
  'controls.css',
  'firstrun.css',
  'firstrun.html',
  'index.html',
  'panel.css',
  'report.css',
  'report.html',
  'settings.css',
  'settings.html',
  'theme.js',
  'tokens.css',
  'update.css',
  'update.html',
  'js/about.js',
  'js/diag.js',
  'js/firstrun.js',
  'js/hover-intent.js',
  'js/icons.js',
  'js/logic.js',
  'js/panel.js',
  'js/report.js',
  'js/settings.js',
  'js/store.js',
  'js/update-flow.js',
  'js/update.js',
  'fonts/Almarai-Bold.ttf',
  'fonts/Almarai-Regular.ttf',
  'fonts/Cairo-Bold.ttf',
  'fonts/Cairo-Medium.ttf',
  'fonts/Cairo-Regular.ttf',
  'fonts/Cairo-SemiBold.ttf',
  'fonts/Inter-Medium.ttf',
  'fonts/Inter-Regular.ttf',
  'fonts/Inter-SemiBold.ttf',
  'fonts/JetBrainsMono-Medium.ttf',
  'fonts/JetBrainsMono-Regular.ttf',
  'assets/app-icon.png',
  'assets/brand/mark-base.svg',
  'assets/brand/mark-card.svg',
  'assets/brand/mark-micro-base.svg',
  'assets/brand/mark-micro-card.svg',
  'assets/brand/menubar.svg',
  'assets/icons/about.svg',
  'assets/icons/accessibility.svg',
  'assets/icons/alert.svg',
  'assets/icons/attach-image.svg',
  'assets/icons/capture.svg',
  'assets/icons/capture-off.svg',
  'assets/icons/check.svg',
  'assets/icons/chevron-down.svg',
  'assets/icons/clear.svg',
  'assets/icons/clock.svg',
  'assets/icons/close.svg',
  'assets/icons/code.svg',
  'assets/icons/copy.svg',
  'assets/icons/general.svg',
  'assets/icons/image.svg',
  'assets/icons/keyboard.svg',
  'assets/icons/learning.svg',
  'assets/icons/link.svg',
  'assets/icons/move-down.svg',
  'assets/icons/move-up.svg',
  'assets/icons/pause.svg',
  'assets/icons/pin-off.svg',
  'assets/icons/pin.svg',
  'assets/icons/privacy.svg',
  'assets/icons/search.svg',
  'assets/icons/settings.svg',
  'assets/icons/text.svg',
  'assets/icons/trash.svg',
  'assets/icons/unknown.svg',
]);

if (outFlag) {
  const present = await readdir(distRoot).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  if (present.length > 0) {
    console.error(`raff: ${distRoot} is not empty; --out only writes into an empty directory`);
    process.exit(1);
  }
} else {
  await rm(distRoot, { recursive: true, force: true });
}

for (const relativePath of productionFiles) {
  const source = path.join(sourceRoot, relativePath);
  const destination = path.join(distRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

const manifest = {
  schemaVersion: 1,
  files: [...productionFiles].sort(),
};
await writeFile(
  path.join(distRoot, 'asset-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
);

console.log(`raff: built ${productionFiles.length} allowlisted frontend files`);
