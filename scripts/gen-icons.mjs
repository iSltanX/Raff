// Renders the identity SVGs (from R/ visual identity) into the PNG assets the
// app bundles. Run once after changing the SVGs:
//   npm i --no-save @resvg/resvg-js && node scripts/gen-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const render = (svgPath, size, outPath) => {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  writeFileSync(outPath, resvg.render().asPng());
  console.log(`${outPath} (${size}px)`);
};

mkdirSync('src-tauri/icons', { recursive: true });
mkdirSync('src/assets', { recursive: true });

// Master app icon — `tauri icon` derives the .icns / all sizes from this.
render('scripts/app-icon.svg', 1024, 'scripts/app-icon-1024.png');
// In-app brand mark (settings "حول" tab).
render('scripts/app-icon.svg', 256, 'src/assets/app-icon.png');
// Menu-bar template icon (black, alpha; macOS recolors it).
render('scripts/tray-icon.svg', 36, 'src-tauri/icons/tray.png');
