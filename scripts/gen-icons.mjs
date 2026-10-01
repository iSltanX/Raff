// Builds every bundled icon from the رفّ brand masters, all exported from the
// Figma file (j3EzLpDw4tIHQQSRQm8ZDM, page «03 — Identity»):
//
//   src/assets/app-icon/raff-app-icon.svg       ← «Brand/App Icon v5 (flat)»
//       252:3987; one artwork for every appearance: a solid plate, «المثبّت»
//       upright in ink and «الأخير» leaning on it in sage. The only shadow is
//       the standard macOS icon shadow. Rendered to the 1024 PNG master.
//   src/assets/brand/menubar*.svg               ← «Menu Bar/Glyph 18» 252:51,
//       four template states: capturing (the leaning card), paused (‖ in its
//       place), off (no card), fault (! in its place). No alpha dimming.
//   src/assets/brand/icon-layer-*.svg           ← Icon Composer masks for the
//       macOS 26+ asset catalog (src-tauri/icon-composer/AppIcon.icon), tinted
//       by icon.json identically in Light and Dark.
//
//   npm run icons
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER_SVG = 'src/assets/app-icon/raff-app-icon.svg';
const MASTER = 'src/assets/app-icon/raff-app-icon-1024.png';

const render = (svgPath, width, outPath) => {
  const svg = readFileSync(svgPath, 'utf8');
  writeFileSync(outPath, new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
  console.log(`${outPath} (${width}px)`);
};

mkdirSync('src-tauri/icons', { recursive: true });

render(MASTER_SVG, 1024, MASTER);

// Tauri's own generator derives the .icns and every PNG size from the master.
const generated = mkdtempSync(join(tmpdir(), 'raff-tauri-icons-'));
try {
  execFileSync(join('node_modules', '.bin', 'tauri'), ['icon', MASTER, '--output', generated], {
    stdio: 'ignore',
  });
  copyFileSync(join(generated, 'icon.icns'), 'src-tauri/icons/icon.icns');
  copyFileSync(join(generated, '32x32.png'), 'src-tauri/icons/32x32.png');
  copyFileSync(join(generated, '128x128.png'), 'src-tauri/icons/128x128.png');
  copyFileSync(join(generated, '128x128@2x.png'), 'src-tauri/icons/128x128@2x.png');
  copyFileSync(join(generated, '128x128@2x.png'), 'src/assets/app-icon.png');
  console.log('src-tauri/icons/{icon.icns,32x32,128x128,128x128@2x}.png, src/assets/app-icon.png');
} finally {
  rmSync(generated, { recursive: true, force: true });
}

// AppKit derives every menu-bar appearance from these alpha masks (@2x).
for (const [svg, png] of [
  ['menubar.svg', 'tray.png'],
  ['menubar-paused.svg', 'tray-paused.png'],
  ['menubar-off.svg', 'tray-off.png'],
  ['menubar-fault.svg', 'tray-fault.png'],
]) {
  render(`src/assets/brand/${svg}`, 36, `src-tauri/icons/${png}`);
}

render('src/assets/brand/icon-layer-shelf.svg', 1024, 'src-tauri/icon-composer/AppIcon.icon/Assets/shelf.png');
render('src/assets/brand/icon-layer-recent.svg', 1024, 'src-tauri/icon-composer/AppIcon.icon/Assets/recent.png');
