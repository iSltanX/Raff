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
  'fonts/Cairo-ExtraBold.ttf',
  'fonts/Cairo-Medium.ttf',
  'fonts/Cairo-Regular.ttf',
  'fonts/Cairo-SemiBold.ttf',
  'assets/app-icon.png',
  'assets/v4/empty-shelf-line-1.svg',
  'assets/v4/empty-shelf-line-2.svg',
  'assets/v4/empty-shelf-line-3.svg',
  'assets/v4/panel-settings.svg',
  'assets/v4/pin.svg',
  'assets/v4/raff-logo-mark.svg',
  'assets/v4/icons/alert-triangle.svg',
  'assets/v4/icons/check-circle.svg',
  'assets/v4/icons/image.svg',
  'assets/v4/icons/keyboard.svg',
  'assets/v4/icons/pin-off.svg',
  'assets/v4/icons/search.svg',
  'assets/v4/icons/trash.svg',
  'assets/v4/icons/x-circle.svg',
  'assets/v4/content-types/code.svg',
  'assets/v4/content-types/image.svg',
  'assets/v4/content-types/link.svg',
  'assets/v4/content-types/text.svg',
  'assets/v4/content-types/unknown.svg',
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
