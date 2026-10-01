// Renders the DMG window background from its design source.
//
//   src-tauri/dmg/background.html  →  background.png (660×420, 1×)
//                                     background@2x.png (1320×840, Retina)
//                                     background.tiff (both, one file: Finder
//                                       picks the right one for the screen)
//
// The design source reads tokens.css, the fonts and the marks from src/, so a
// change to رفّ's identity reaches the installer by running this again:
//
//   npm run dmg:background
//
// It drives the Google Chrome already on the Mac, headless (no npm package),
// because the background mixes Arabic, Latin and quotes in one line and only a
// full text engine lays that out correctly. Set CHROME to use another binary.
// The outputs are committed; release builds only copy background.tiff.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src-tauri', 'dmg');
const source = pathToFileURL(path.join(dir, 'background.html')).href;
const [WIDTH, HEIGHT] = [660, 420];

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.error(`gen-dmg-background: Chrome not found at ${chrome} (set CHROME)`);
  process.exit(1);
}

function render(scale, out) {
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--allow-file-access-from-files', '--force-color-profile=srgb',
    `--force-device-scale-factor=${scale}`, `--window-size=${WIDTH},${HEIGHT}`,
    '--virtual-time-budget=3000', `--screenshot=${out}`, source,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out], { encoding: 'utf8' });
  const [w, h] = [...size.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]));
  if (w !== WIDTH * scale || h !== HEIGHT * scale) {
    console.error(`gen-dmg-background: ${out} is ${w}×${h}, expected ${WIDTH * scale}×${HEIGHT * scale}`);
    process.exit(1);
  }
  console.log(`wrote ${path.relative(process.cwd(), out)} (${w}×${h})`);
}

const png1 = path.join(dir, 'background.png');
const png2 = path.join(dir, 'background@2x.png');
render(1, png1);
render(2, png2);
// One TIFF with both resolutions, 72 and 144 dpi: Finder shows the sharp one on
// Retina and never scales the background.
execFileSync('tiffutil', ['-cathidpicheck', png1, png2, '-out', path.join(dir, 'background.tiff')], { stdio: 'inherit' });
console.log('wrote src-tauri/dmg/background.tiff');
