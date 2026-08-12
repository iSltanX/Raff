// Builds the bundled icon assets from the v4.0.0 brand artwork vendored in
// src/assets/app-icon/. Nothing here redraws or restyles the identity — every
// size is rendered from the master SVGs, which are themselves a faithful port
// of the approved Figma file (j3EzLpDw4tIHQQSRQm8ZDM):
//   • the app-icon tile   ← «08 — Product Screens» Logo-Graphic (2:8066)
//   • the menu-bar glyph  ← «08 — Product Screens» bar-chart-horizontal (2:7922)
//
// NOTE: pre-flattened icon rasters exported onto an opaque white background
// (corner pixel #FFFFFF, alpha 255) produce a white square app icon in Finder,
// the Dock and the DMG, because macOS does not mask app icons. The masters are
// the ground truth: root is fill="none" and the tile is a rounded rect whose
// corners must stay transparent. So we always render from the vectors — same
// paths, same gradient, same geometry, correct alpha.
//
// The «رفّ» glyph inside the tile is outline path data, not a <text> element:
// resvg has no lookup for the bundled Cairo family and would silently fall back
// to a system face. See src/assets/app-icon/raff-app-icon.svg.
//
//   npm run icons
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
  const iconset = join(tmpdir(), `raff-icns-${Date.now()}.iconset`);
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

// App-icon variants — bundled as resources, applied at runtime via NSWorkspace
// (commands.rs `apply_icon_variant`). icon.icns is the bundle default = light.
//
// The dark master is intentionally the same artwork as the light one: Figma
// defines a single Logo-Graphic and no dark app icon, and macOS app icons do
// not adapt to appearance on their own. Both .icns are still built and shipped
// separately so a future dark tile only has to replace one SVG.
icnsFromSvg(`${SRC}/raff-app-icon.svg`, 'src-tauri/icons/icon-light.icns');
icnsFromSvg(`${SRC}/raff-app-icon-dark.svg`, 'src-tauri/icons/icon-dark.icns');
copyFileSync('src-tauri/icons/icon-light.icns', 'src-tauri/icons/icon.icns');
console.log('src-tauri/icons/icon.icns (= light)');

// PNG sizes Tauri lists in bundle.icon (tauri.conf.json). Nothing else is
// generated — an unreferenced size is dead weight in the repo and the bundle.
render(`${SRC}/raff-app-icon.svg`, 32, 'src-tauri/icons/32x32.png');
render(`${SRC}/raff-app-icon.svg`, 128, 'src-tauri/icons/128x128.png');
render(`${SRC}/raff-app-icon.svg`, 256, 'src-tauri/icons/128x128@2x.png');

// In-app previews for the أيقونة التطبيق setting cards + the update window.
render(`${SRC}/raff-app-icon.svg`, 256, 'src/assets/app-icon.png');

// Menu-bar template icon — monochrome + alpha; macOS recolors it for
// light/dark and for the highlighted state (tray.rs sets icon_as_template).
// 36px = 18pt @2x, matching the 20×20pt canvas with a 16×16pt live area.
render(`${SRC}/raff-menubar-template.svg`, 36, 'src-tauri/icons/tray.png');
