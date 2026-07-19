// Builds the bundled icon assets from the OFFICIAL RAFF-Identity-System-v2
// sources vendored in src/assets/app-icon/. Nothing here redraws or restyles
// the identity — every size is rendered from the official master SVGs.
//
// NOTE: the identity package also ships Raff.iconset / raff-app-icon-1024.png,
// but those rasters were exported flattened onto an opaque white background
// (corner pixel #FFFFFF, alpha 255, at every size). Using them produces a white
// square app icon in Finder, the Dock and the DMG, because macOS does not mask
// app icons. The masters are the ground truth: root is fill="none" and the
// artwork is an inset rounded rect (5/128 margin, rx 28) with a drop shadow
// that requires alpha. So we render from the vectors — same paths, same
// gradients, same geometry, correct transparency.
//   npm i --no-save @resvg/resvg-js && node scripts/gen-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = 'src/assets/app-icon';

const render = (svgPath, size, outPath) => {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  writeFileSync(outPath, resvg.render().asPng());
  console.log(`${outPath} (${size}px)`);
};

// Renders every size the .icns needs directly from the official master vector.
const icnsFromSvg = (svgPath, outIcns) => {
  const iconset = join(tmpdir(), `raff-dark-${Date.now()}.iconset`);
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
  console.log(`${outIcns} (10 sizes from official master SVG)`);
};

mkdirSync('src-tauri/icons', { recursive: true });

// App-icon variants — bundled as resources, applied at runtime via NSWorkspace.
// icon.icns (the bundle default) is the light state.
icnsFromSvg(`${SRC}/raff-app-icon-master.svg`, 'src-tauri/icons/icon-light.icns');
icnsFromSvg(`${SRC}/raff-app-icon-dark-master.svg`, 'src-tauri/icons/icon-dark.icns');
copyFileSync('src-tauri/icons/icon-light.icns', 'src-tauri/icons/icon.icns');
console.log('src-tauri/icons/icon.icns (= light)');

// PNG sizes Tauri lists in bundle.icon.
render(`${SRC}/raff-app-icon-master.svg`, 32, 'src-tauri/icons/32x32.png');
render(`${SRC}/raff-app-icon-master.svg`, 64, 'src-tauri/icons/64x64.png');
render(`${SRC}/raff-app-icon-master.svg`, 128, 'src-tauri/icons/128x128.png');
render(`${SRC}/raff-app-icon-master.svg`, 256, 'src-tauri/icons/128x128@2x.png');
render(`${SRC}/raff-app-icon-master.svg`, 1024, 'src-tauri/icons/icon.png');

// In-app previews for the أيقونة التطبيق setting cards.
render(`${SRC}/raff-app-icon-master.svg`, 256, 'src/assets/app-icon-light.png');
render(`${SRC}/raff-app-icon-master.svg`, 256, 'src/assets/app-icon.png');
render(`${SRC}/raff-app-icon-dark-master.svg`, 256, 'src/assets/app-icon-dark.png');

// Menu-bar template icon — monochrome + alpha; macOS recolors it for
// light/dark and for the highlighted state (NSImage.isTemplate = true).
// 36px = 18pt @2x, matching the 20×20pt minimum with a 16×16pt live area.
render(`${SRC}/raff-menubar-template.svg`, 36, 'src-tauri/icons/tray.png');
