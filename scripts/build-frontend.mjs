// Build the Tauri web payload from an explicit production allowlist. The
// source tree also contains browser-only mock data and Figma audit exports;
// copying `src/` wholesale would silently ship both classes of reference file.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src');
const distRoot = path.join(projectRoot, 'dist');

const productionFiles = Object.freeze([
  'about.css',
  'about.html',
  'controls.css',
  'firstrun.css',
  'firstrun.html',
  'index.html',
  'panel.css',
  'settings.css',
  'settings.html',
  'theme.js',
  'tokens.css',
  'update.css',
  'update.html',
  'js/about.js',
  'js/diag.js',
  'js/firstrun.js',
  'js/icons.js',
  'js/logic.js',
  'js/panel.js',
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
  'assets/app-icon.png',
  'assets/brand/mark-base.svg',
  'assets/brand/mark-card.svg',
  'assets/icons/about.svg',
  'assets/icons/alert.svg',
  'assets/icons/capture.svg',
  'assets/icons/check.svg',
  'assets/icons/clear.svg',
  'assets/icons/close.svg',
  'assets/icons/code.svg',
  'assets/icons/general.svg',
  'assets/icons/image.svg',
  'assets/icons/keyboard.svg',
  'assets/icons/learning.svg',
  'assets/icons/link.svg',
  'assets/icons/pin-off.svg',
  'assets/icons/pin.svg',
  'assets/icons/privacy.svg',
  'assets/icons/search.svg',
  'assets/icons/settings.svg',
  'assets/icons/shield.svg',
  'assets/icons/text.svg',
  'assets/icons/trash.svg',
  'assets/icons/unknown.svg',
]);

await rm(distRoot, { recursive: true, force: true });

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
