// Builds every bundled icon from the رفّ brand masters.
//
//   src/assets/app-icon/raff-app-icon-1024.png  ← Figma «brand/app-icon»; one
//       artwork for every appearance (a floating shelf holding «المثبّت» upright
//       and «الأخير» leaning on it). Corners stay transparent.
//   src/assets/brand/menubar.svg                ← 18pt template glyph.
//   src/assets/brand/icon-layer-*.svg           ← Icon Composer masks for the
//       macOS 26+ asset catalog (src-tauri/icon-composer/AppIcon.icon), tinted
//       ink and sage identically in Light and Dark.
//
//   npm run icons
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER = 'src/assets/app-icon/raff-app-icon-1024.png';

const render = (svgPath, width, outPath) => {
  const svg = readFileSync(svgPath, 'utf8');
  writeFileSync(outPath, new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
  console.log(`${outPath} (${width}px)`);
};

mkdirSync('src-tauri/icons', { recursive: true });

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

// AppKit derives every menu-bar appearance from this one alpha mask (@2x).
render('src/assets/brand/menubar.svg', 36, 'src-tauri/icons/tray.png');

render('src/assets/brand/icon-layer-shelf.svg', 1024, 'src-tauri/icon-composer/AppIcon.icon/Assets/shelf.png');
render('src/assets/brand/icon-layer-recent.svg', 1024, 'src-tauri/icon-composer/AppIcon.icon/Assets/recent.png');
