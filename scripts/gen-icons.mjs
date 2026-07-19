// Builds the bundled icon assets from the OFFICIAL RAFF-Identity-System-v2
// sources vendored in src/assets/app-icon/. Nothing here redraws or restyles
// the identity: the light/default .icns is compiled straight from the shipped
// Raff.iconset rasters, and the dark variant + menu-bar template are rendered
// from their official master SVGs at the exact sizes macOS asks for.
//   npm i --no-save @resvg/resvg-js && node scripts/gen-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = 'src/assets/app-icon';

const render = (svgPath, size, outPath) => {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  writeFileSync(outPath, resvg.render().asPng());
  console.log(`${outPath} (${size}px)`);
};

// Compiles the official, already-rendered iconset — no re-rasterisation.
const icnsFromOfficialIconset = (iconsetDir, outIcns) => {
  const staging = join(tmpdir(), `raff-${Date.now()}.iconset`);
  cpSync(iconsetDir, staging, { recursive: true });
  // iconutil rejects the Xcode Contents.json sidecar.
  rmSync(join(staging, 'Contents.json'), { force: true });
  execFileSync('iconutil', ['-c', 'icns', staging, '-o', outIcns]);
  rmSync(staging, { recursive: true, force: true });
  console.log(`${outIcns} (from official Raff.iconset)`);
};

// The dark app-icon variant ships only as a master SVG, so render every size
// the .icns needs directly from the vector.
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
icnsFromOfficialIconset(`${SRC}/Raff.iconset`, 'src-tauri/icons/icon-light.icns');
icnsFromSvg(`${SRC}/raff-app-icon-dark-master.svg`, 'src-tauri/icons/icon-dark.icns');
copyFileSync('src-tauri/icons/icon-light.icns', 'src-tauri/icons/icon.icns');
console.log('src-tauri/icons/icon.icns (= light)');

// PNG sizes Tauri lists in bundle.icon — taken from the official iconset.
copyFileSync(`${SRC}/Raff.iconset/icon_32x32.png`, 'src-tauri/icons/32x32.png');
copyFileSync(`${SRC}/Raff.iconset/icon_128x128.png`, 'src-tauri/icons/128x128.png');
copyFileSync(`${SRC}/Raff.iconset/icon_128x128@2x.png`, 'src-tauri/icons/128x128@2x.png');
copyFileSync(`${SRC}/Raff.iconset/icon_32x32@2x.png`, 'src-tauri/icons/64x64.png');
copyFileSync(`${SRC}/raff-app-icon-1024.png`, 'src-tauri/icons/icon.png');
console.log('src-tauri/icons/*.png (from official iconset)');

// In-app previews for the أيقونة التطبيق setting cards.
copyFileSync(`${SRC}/Raff.iconset/icon_256x256.png`, 'src/assets/app-icon-light.png');
copyFileSync(`${SRC}/Raff.iconset/icon_256x256.png`, 'src/assets/app-icon.png');
render(`${SRC}/raff-app-icon-dark-master.svg`, 256, 'src/assets/app-icon-dark.png');

// Menu-bar template icon — monochrome + alpha; macOS recolors it for
// light/dark and for the highlighted state (NSImage.isTemplate = true).
// 36px = 18pt @2x, matching the 20×20pt minimum with a 16×16pt live area.
render(`${SRC}/raff-menubar-template.svg`, 36, 'src-tauri/icons/tray.png');
