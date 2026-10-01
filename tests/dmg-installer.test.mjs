// The installer DMG is designed, not left to Finder's defaults: a background
// rendered from src-tauri/dmg/background.html, and Raff.app and the
// Applications link placed in its two dashed frames. Both release paths
// (local candidate and CI) must style the image they build from the patched
// app, before compressing it — never a separately built DMG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ICON_CENTRES, WINDOW } from '../scripts/dmg-layout.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const pngSize = (file) => {
  const bytes = readFileSync(path.join(root, file));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test('the background exists at 1× and Retina 2×, at the window size', () => {
  assert.deepEqual(pngSize('src-tauri/dmg/background.png'), [WINDOW.width, WINDOW.height]);
  assert.deepEqual(pngSize('src-tauri/dmg/background@2x.png'), [WINDOW.width * 2, WINDOW.height * 2]);
  const tiff = readFileSync(path.join(root, 'src-tauri/dmg/background.tiff'));
  assert.ok(tiff.length > 0 && (tiff.subarray(0, 2).toString() === 'MM' || tiff.subarray(0, 2).toString() === 'II'), 'background.tiff is a TIFF');
});

test('Finder places each icon at the centre of its dashed frame', () => {
  const html = read('src-tauri/dmg/background.html');
  const frame = (cls) => {
    const left = Number(html.match(new RegExp(`\\.frame\\.${cls} \\{ left: (\\d+)px;`, 'u'))[1]);
    const top = Number(html.match(/\.frame \{[^}]*top: (\d+)px;/su)[1]);
    const size = Number(html.match(/\.frame \{[^}]*width: (\d+)px;/su)[1]);
    return [left + size / 2, top + size / 2];
  };
  for (const [name, cls] of [['Raff.app', 'app'], ['Applications', 'apps']]) {
    const [cx, cy] = frame(cls);
    const [x, y] = ICON_CENTRES[name];
    assert.ok(Math.abs(cx - x) <= 1 && Math.abs(cy - y) <= 2, `${name} at ${x},${y}; its frame is centred at ${cx},${cy}`);
  }
});

test('the design takes its identity from the app, not from copied values', () => {
  const html = read('src-tauri/dmg/background.html');
  assert.match(html, /href="\.\.\/\.\.\/src\/tokens\.css"/u, 'colours and fonts come from tokens.css');
  assert.match(html, /src\/assets\/app-icon\/raff-app-icon-1024\.png/u, 'the current app icon');
  assert.match(html, /src\/assets\/brand\/mark\.svg/u, 'the current mark');
  const hexes = html.replace(/<!--[\s\S]*?-->/gu, '').match(/#[0-9a-f]{3,8}\b/giu) ?? [];
  assert.deepEqual(hexes, [], 'no colour is written into the design source');
});

test('both release paths style the DMG between creating and compressing it', () => {
  for (const file of ['scripts/build-candidate.mjs', 'scripts/ci-fix-release-icon.mjs']) {
    const script = read(file);
    assert.match(script, /import \{ styleDmg \} from '\.\/dmg-layout\.mjs';/u, `${file} uses the shared layout`);
    const created = script.search(/hdiutil['"],\s*\[\s*\n?\s*['"]create['"]/u);
    const styled = script.indexOf('styleDmg(rwDmg)');
    const compressed = script.search(/hdiutil['"],\s*\[['"]convert['"],\s*rwDmg/u);
    assert.ok(created > 0 && created < styled && styled < compressed, `${file}: create → style → convert`);
  }
});

test('the layout addresses its own mount, and the window shows the background unscaled', () => {
  const layout = read('scripts/dmg-layout.mjs');
  assert.match(layout, /'-mountpoint', mountPoint/u, 'mounted at a path of its own, so another «Raff» volume cannot be styled instead');
  assert.match(layout, /POSIX file "\$\{mountPoint\}"/u, 'Finder is pointed at that path, not at a volume name');
  assert.match(layout, /background picture of vo to file "\.background:background\.tiff"/u);
  assert.match(layout, /WINDOW\.width\}, \$\{y \+ WINDOW\.height \+ TITLE_BAR\}/u, 'bounds are the background size plus the title bar');
  assert.doesNotMatch(layout, /rmSync\(mountPoint/u, 'a mount point is never deleted recursively');
});
