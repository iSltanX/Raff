// One application icon ships, drawn for each appearance by design.
//
// Until 2026-10-21 Raff's policy was that the macOS icon is ALWAYS the light
// artwork: macOS 26 restyled the light plate black in Dark Mode and the ink
// shelf vanished on it, so Icon Composer pinned Dark to the light values. The
// approved Najdi redesign (Figma XCNmucSuAe007qWHnOXQpW, page 04) draws a real
// Dark icon instead — a dark sand plate, a light shelf and a lighter clay card —
// and a one-colour Tinted one. What still holds from that policy: the `dark`
// entry must be PRESENT (without it macOS generates its own dark icon), the
// legacy .icns stays the light artwork, and nothing swaps icons at runtime.
//
// These assertions target the decision points a regression would actually pass
// through — what the bundle declares, what the generator writes, and what the
// runtime can reach — rather than the pixels of any one file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (file) => readFileSync(path.join(project, file), 'utf8');

test('the bundle declares exactly one icon set, and no dark variant', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const icons = config.bundle.icon;

  assert.ok(Array.isArray(icons) && icons.length > 0, 'bundle.icon must be an explicit list');
  // An explicit list is what keeps this controllable: Tauri would otherwise
  // sweep the icons directory, where any stray icon would be picked up.
  for (const entry of icons) {
    assert.doesNotMatch(
      entry,
      /dark/i,
      `bundle.icon must never reference a dark icon — found "${entry}"`
    );
  }
  assert.ok(
    icons.includes('icons/icon.icns'),
    'the canonical .icns must be the bundle icon'
  );
  assert.equal(
    config.bundle.iconPath ?? null,
    null,
    'no alternate icon path may override the declared set'
  );
});

test('the generator derives every shipped icon from the one brand construction', () => {
  const gen = read('scripts/gen-icons.mjs');
  assert.match(gen, /import \* as brand from '\.\/brand-geometry\.mjs';/u);
  assert.match(gen, /const MASTER = 'src\/assets\/app-icon\/raff-app-icon-1024\.png';/u);
  assert.match(gen, /execFileSync\('iconutil', \['-c', 'icns', iconset, '-o', 'src-tauri\/icons\/icon\.icns'\]\)/u);
  // Below 64 px the 1024 drawing's gaps melt; the two smallest sizes are drawn
  // on the pixel grid.
  assert.match(gen, /\['icon_16x16\.png', brand\.microAppIconSvg\(16\), 16\]/u);
  assert.match(gen, /\['icon_32x32\.png', brand\.microAppIconSvg\(32\), 32\]/u);
  assert.doesNotMatch(gen, /dark-1024|icon-dark/u, 'the dark icon lives in Icon Composer, not in a second .icns');
});

const srgb = (hex) => `srgb:${[1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(',')},1.00000`;

test('the Icon Composer asset draws the designed Light, Dark and Tinted icon', () => {
  const icon = JSON.parse(read('src-tauri/icon-composer/AppIcon.icon/icon.json'));
  const fill = (specs, appearance) => specs.find((s) => (s.appearance ?? null) === appearance)?.value.solid;

  const plate = icon['fill-specializations'] ?? [];
  assert.equal(fill(plate, null), srgb('#f5f1ea'), 'light plate: sand/50');
  assert.equal(fill(plate, 'dark'), srgb('#221e1b'), 'dark plate: sand/900 — present, so macOS does not invent one');

  const layers = Object.fromEntries((icon.groups ?? []).flatMap((g) => g.layers ?? []).map((l) => [l.name, l]));
  const designed = { shelf: ['#1f1915', '#f5f1ea'], recent: ['#c25a2f', '#ef9d79'] };
  assert.deepEqual(Object.keys(layers).sort(), Object.keys(designed).sort());
  for (const [name, [light, dark]] of Object.entries(designed)) {
    const specs = layers[name]['fill-specializations'] ?? [];
    assert.equal(fill(specs, null), srgb(light), `${name} in Light`);
    assert.equal(fill(specs, 'dark'), srgb(dark), `${name} in Dark`);
    // Tinted is one colour: the system tints by brightness, so the dark shelf
    // would fade to nothing next to the card.
    assert.equal(fill(specs, 'tinted'), srgb('#ffffff'), `${name} in Tinted`);
    assert.notEqual(layers[name].glass, true, `layer "${name}" must be solid, not glass`);
  }
  for (const group of icon.groups ?? []) {
    assert.equal(group.shadow?.opacity, 0, 'flat: the mark casts no shadow on the plate');
    assert.equal(group.specular, false);
    assert.notEqual(group.translucency?.enabled, true);
  }
});

test('no dark app icon is reachable from bundle metadata or runtime code', () => {
  // Nothing in the Rust runtime may read or swap application artwork. History
  // rows now use local semantic content icons, so there is no source-app icon
  // exception to this bundle-identity guard.
  const rust = readdirSync(path.join(project, 'src-tauri/src'))
    .filter((f) => f.endsWith('.rs'))
    .map((f) => ({ file: f, text: read(`src-tauri/src/${f}`) }));

  for (const { file, text } of rust) {
    assert.doesNotMatch(
      text,
      /setIcon[_:]?forFile|setApplicationIconImage/u,
      `${file} must not set the application icon at runtime`
    );
    assert.doesNotMatch(
      text,
      /icon-dark\.icns/u,
      `${file} must not reference a dark app icon`
    );
  }
});
