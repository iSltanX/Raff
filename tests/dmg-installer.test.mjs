// The installer DMG is designed, not left to Finder's defaults: a background
// rendered from src-tauri/dmg/background.html, in which رفّ's mark is a shelf
// and Finder sets the real Raff.app on it (ت٦٩, Figma XCNmucSuAe007qWHnOXQpW
// «05 — DMG & README»). Both release paths (local candidate and CI) must style
// the image they build from the patched app, before compressing it — never a
// separately built DMG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ICON_CENTRES, ICON_SIZE, WINDOW } from '../scripts/dmg-layout.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const pngSize = (file) => {
  const bytes = readFileSync(path.join(root, file));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

/** Width × height of every image in a TIFF, read from its IFD chain. */
function tiffSizes(file) {
  const bytes = readFileSync(path.join(root, file));
  const order = bytes.subarray(0, 2).toString();
  assert.ok(order === 'MM' || order === 'II', `${file} is a TIFF`);
  const u16 = (at) => (order === 'II' ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at) => (order === 'II' ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const sizes = [];
  for (let ifd = u32(4); ifd !== 0 && sizes.length < 8; ) {
    const count = u16(ifd);
    const size = {};
    for (let i = 0; i < count; i += 1) {
      const entry = ifd + 2 + i * 12;
      const [tag, type] = [u16(entry), u16(entry + 2)];
      const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
      if (tag === 256) size.width = value;
      if (tag === 257) size.height = value;
    }
    sizes.push([size.width, size.height]);
    ifd = u32(ifd + 2 + count * 12);
  }
  return sizes;
}

/** The declarations of one rule in the design source, whatever its layout. */
function rule(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const body = html.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`, 'u'))?.[1];
  assert.ok(body, `background.html has a ${selector} rule`);
  return Object.fromEntries(
    body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const at = d.indexOf(':');
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    })
  );
}
const px = (value) => Number(String(value).replace(/px$/u, ''));

/** A light token's value from tokens.css, and its contrast with a dark label. */
function tokenHex(name) {
  const light = read('src/tokens.css').match(/:root\s*\{([\s\S]*?)\n\}/u)[1];
  return light.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'iu'))[1];
}
function contrastWithBlack(hex) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05) / 0.05;
}

test('the background exists at 1× and Retina 2×, at the window size, and so does the TIFF Finder reads', () => {
  assert.deepEqual(pngSize('src-tauri/dmg/background.png'), [WINDOW.width, WINDOW.height]);
  assert.deepEqual(pngSize('src-tauri/dmg/background@2x.png'), [WINDOW.width * 2, WINDOW.height * 2]);
  // dmg-layout.mjs copies only the TIFF into the image: both resolutions in it.
  assert.deepEqual(tiffSizes('src-tauri/dmg/background.tiff'), [[WINDOW.width, WINDOW.height], [WINDOW.width * 2, WINDOW.height * 2]]);
  const page = rule(read('src-tauri/dmg/background.html'), 'html, body');
  assert.deepEqual([px(page.width), px(page.height)], [WINDOW.width, WINDOW.height], 'the design source is drawn at the window size');
});

test('the approved window: 660 × 400, icons at 144, Raff on the right and Applications on the left', () => {
  assert.deepEqual(WINDOW, { width: 660, height: 400 });
  assert.equal(ICON_SIZE, 144);
  assert.deepEqual(ICON_CENTRES, { 'Raff.app': [358, 190], Applications: [150, 190] });
});

test('Raff.app rests on the shelf: its plate fills the 233 × 233 square of the mark', () => {
  const html = read('src-tauri/dmg/background.html');
  const shelf = rule(html, '.shelf');
  const [left, top, width, height] = [shelf.left, shelf.top, shelf.width, shelf.height].map(px);
  // The plate of a Finder icon is 824 of its 1024 (the macOS icon grid).
  const plate = (ICON_SIZE * 824) / 1024;
  const scale = plate / 233;
  assert.ok(Math.abs(width - 610 * scale) < 0.05 && Math.abs(height - 377 * scale) < 0.05, 'the mark keeps its 610 × 377 proportions, at the scale of the plate');
  const [x, y] = ICON_CENTRES['Raff.app'];
  assert.ok(Math.abs(left + plate / 2 - x) < 0.1 && Math.abs(top + plate / 2 - y) < 0.1, 'the plate fills the square, so it rests on the shelf');
  assert.ok(left + width <= WINDOW.width - 16 && top + height <= WINDOW.height, 'the shelf stays inside the window');
  const [ax, ay] = ICON_CENTRES.Applications;
  assert.equal(ay, y, 'both icons, and their names, on one line');
  assert.ok(ax + ICON_SIZE <= x, 'Applications is to the left: the drag runs right to left, away from the curve of «ر»');
  assert.match(html, /اسحب رفّ إلى التطبيقات/u);
  // Where the plate meets the shelf: under Raff.app, on the shelf's top edge.
  const contact = rule(html, '.contact');
  assert.ok(Math.abs(px(contact.left) + px(contact.width) / 2 - x) < 0.5, 'the contact line is centred under the icon');
  assert.ok(Math.abs(px(contact.top) - (top + 233 * scale)) < 0.1, 'the contact line sits on the top edge of the shelf');
});

test('a dark Finder label reads on the shelf and on the window', () => {
  // Finder writes the icon names in dark type over a background picture
  // (see background.html); both tones under a name must carry it.
  const html = read('src-tauri/dmg/background.html');
  const token = (value) => value.match(/var\((--[a-z0-9-]+)\)/u)?.[1];
  for (const [where, value] of [['shelf', rule(html, '.shelf').background], ['window', rule(html, 'body').background]]) {
    const name = token(value);
    assert.ok(name, `the ${where} takes its tone from a token`);
    const ratio = contrastWithBlack(tokenHex(name));
    assert.ok(ratio >= 7, `a black label on the ${where} (${name}) reads at ${ratio.toFixed(1)}:1, at least 7:1`);
  }
});

test('the design takes its identity from the app, not from copied values', () => {
  const html = read('src-tauri/dmg/background.html');
  assert.match(html, /href="\.\.\/\.\.\/src\/tokens\.css"/u, 'colours and fonts come from tokens.css');
  assert.match(html, /src\/assets\/brand\/mark-base\.svg/u, 'the shelf is the mark itself, without its card');
  assert.doesNotMatch(html, /app-icon/u, 'the icon is the real one Finder draws, never a picture of it');
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
