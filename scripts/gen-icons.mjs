// Renders the identity SVGs (from R/ visual identity) into the icon assets the
// app bundles. Every size is rendered from the vector directly (no bitmap
// downscaling) and the .icns files are assembled with Apple's iconutil.
// Run once after changing the SVGs:
//   npm i --no-save @resvg/resvg-js && node scripts/gen-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const render = (svgPath, size, outPath) => {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  writeFileSync(outPath, resvg.render().asPng());
  console.log(`${outPath} (${size}px)`);
};

// Builds a complete macOS .iconset from an SVG and compiles it to .icns.
const buildIcns = (svgPath, outIcns) => {
  const iconset = join(tmpdir(), `raff-${Date.now()}-${Math.random().toString(36).slice(2)}.iconset`);
  mkdirSync(iconset, { recursive: true });
  const entries = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, size] of entries) {
    const svg = readFileSync(svgPath, 'utf8');
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    writeFileSync(join(iconset, name), resvg.render().asPng());
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outIcns]);
  rmSync(iconset, { recursive: true, force: true });
  console.log(`${outIcns} (10 sizes via iconutil)`);
};

mkdirSync('src-tauri/icons', { recursive: true });
mkdirSync('src/assets', { recursive: true });

// Master app icon (light) — `tauri icon` derives the .ico / png set from this.
render('scripts/app-icon-light.svg', 1024, 'scripts/app-icon-1024.png');

// App-icon variants (أيقونة التطبيق) — bundled as resources and applied at
// runtime via NSWorkspace; icon.icns (the bundle default) is the light state.
buildIcns('scripts/app-icon-light.svg', 'src-tauri/icons/icon-light.icns');
buildIcns('scripts/app-icon-dark.svg', 'src-tauri/icons/icon-dark.icns');
copyFileSync('src-tauri/icons/icon-light.icns', 'src-tauri/icons/icon.icns');
console.log('src-tauri/icons/icon.icns (= light)');

// In-app brand mark (settings "حول" tab) + icon-setting card previews.
render('scripts/app-icon-light.svg', 256, 'src/assets/app-icon.png');
render('scripts/app-icon-light.svg', 256, 'src/assets/app-icon-light.png');
render('scripts/app-icon-dark.svg', 256, 'src/assets/app-icon-dark.png');

// Menu-bar template icon (black, alpha; macOS recolors it).
render('scripts/tray-icon.svg', 36, 'src-tauri/icons/tray.png');
