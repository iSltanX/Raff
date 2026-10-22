// Builds every رفّ brand asset and bundled icon from one construction,
// scripts/brand-geometry.mjs (Figma XCNmucSuAe007qWHnOXQpW, pages «01 — Brand
// & Logo Geometry» and «04 — App Store & Export Assets»):
//
//   src/assets/brand/mark*.svg            the mark, and its two halves as masks
//       for the panel (the large drawing, and the pixel-grid one for 16 px);
//   src/assets/brand/menubar*.svg         four 18 pt template states: capturing
//       (the card on the shelf), paused (‖ in its place), off (no card), fault
//       (! in its place). No alpha dimming;
//   src/assets/app-icon/raff-app-icon.svg the flat 1024 master: a sand plate, the
//       shelf in ink and the card in clay. No shadow of its own;
//   src/assets/brand/icon-layer-*.svg     Icon Composer masks for the macOS 26+
//       asset catalog (src-tauri/icon-composer/AppIcon.icon), which colours
//       them the light way in Light and Dark alike, and in one colour for
//       Tinted (ت٦٨).
//
// Every PNG is rendered from the vectors at its own size. 16 and 32 px use the
// pixel-grid drawing, because the 1024 drawing's gaps melt below 64 px.
//
//   npm run icons
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as brand from './brand-geometry.mjs';

const MASTER_SVG = 'src/assets/app-icon/raff-app-icon.svg';
const MASTER = 'src/assets/app-icon/raff-app-icon-1024.png';

const write = (path, text) => {
  writeFileSync(path, text);
  console.log(path);
};

const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();

const render = (svgPath, width, outPath) => {
  writeFileSync(outPath, png(readFileSync(svgPath, 'utf8'), width));
  console.log(`${outPath} (${width}px)`);
};

mkdirSync('src-tauri/icons', { recursive: true });

write('src/assets/brand/mark.svg', brand.markSvg());
write('src/assets/brand/mark-base.svg', brand.markBaseSvg());
write('src/assets/brand/mark-card.svg', brand.markCardSvg());
write('src/assets/brand/mark-micro-base.svg', brand.microBaseSvg());
write('src/assets/brand/mark-micro-card.svg', brand.microCardSvg());
for (const [state, file] of [
  ['capturing', 'menubar.svg'],
  ['paused', 'menubar-paused.svg'],
  ['off', 'menubar-off.svg'],
  ['fault', 'menubar-fault.svg'],
]) {
  write(`src/assets/brand/${file}`, brand.menubarSvg(state));
}
write(MASTER_SVG, brand.appIconSvg());
write('src/assets/brand/icon-layer-shelf.svg', brand.iconLayerSvg('shelf'));
write('src/assets/brand/icon-layer-recent.svg', brand.iconLayerSvg('recent'));

render(MASTER_SVG, 1024, MASTER);
render(MASTER_SVG, 128, 'src-tauri/icons/128x128.png');
render(MASTER_SVG, 256, 'src-tauri/icons/128x128@2x.png');
render(MASTER_SVG, 256, 'src/assets/app-icon.png');
writeFileSync('src-tauri/icons/32x32.png', png(brand.microAppIconSvg(32), 32));
console.log('src-tauri/icons/32x32.png (pixel grid)');

// The .icns carries every size macOS asks for; the two smallest are the
// pixel-grid drawing, the rest the master.
const iconset = join(mkdtempSync(join(tmpdir(), 'raff-icons-')), 'Raff.iconset');
mkdirSync(iconset);
try {
  const master = readFileSync(MASTER_SVG, 'utf8');
  const sizes = [
    ['icon_16x16.png', brand.microAppIconSvg(16), 16],
    ['icon_16x16@2x.png', brand.microAppIconSvg(32), 32],
    ['icon_32x32.png', brand.microAppIconSvg(32), 32],
    ['icon_32x32@2x.png', master, 64],
    ['icon_128x128.png', master, 128],
    ['icon_128x128@2x.png', master, 256],
    ['icon_256x256.png', master, 256],
    ['icon_256x256@2x.png', master, 512],
    ['icon_512x512.png', master, 512],
    ['icon_512x512@2x.png', master, 1024],
  ];
  for (const [name, svg, width] of sizes) writeFileSync(join(iconset, name), png(svg, width));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', 'src-tauri/icons/icon.icns']);
  console.log('src-tauri/icons/icon.icns');
} finally {
  rmSync(join(iconset, '..'), { recursive: true, force: true });
}

// AppKit derives every menu-bar appearance from these alpha masks (@2x).
for (const [svg, out] of [
  ['menubar.svg', 'tray.png'],
  ['menubar-paused.svg', 'tray-paused.png'],
  ['menubar-off.svg', 'tray-off.png'],
  ['menubar-fault.svg', 'tray-fault.png'],
]) {
  render(`src/assets/brand/${svg}`, 36, `src-tauri/icons/${out}`);
}

render('src/assets/brand/icon-layer-shelf.svg', 1024, 'src-tauri/icon-composer/AppIcon.icon/Assets/shelf.png');
render('src/assets/brand/icon-layer-recent.svg', 1024, 'src-tauri/icon-composer/AppIcon.icon/Assets/recent.png');
