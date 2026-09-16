// Exactly one application icon may ship, and it must be the canonical Light one.
//
// Raff's release policy is that the macOS application icon is ALWAYS the
// canonical Light (terracotta) mark, independent of the system appearance —
// only Raff's own interior UI follows Light/Dark. A dark app-icon master is
// kept on disk as approved design material and is deliberately NOT shippable.
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
  // sweep the icons directory, which is exactly where icon-dark.icns lives.
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

test('the generator derives every shipped icon from the one brand master', () => {
  const gen = read('scripts/gen-icons.mjs');
  assert.match(gen, /const MASTER = 'src\/assets\/app-icon\/raff-app-icon-1024\.png';/u);
  assert.match(gen, /copyFileSync\(join\(generated, 'icon\.icns'\), 'src-tauri\/icons\/icon\.icns'\)/u);
  assert.doesNotMatch(gen, /dark-1024|icon-dark/u, 'there is no dark app icon to generate');
});

test('the Icon Composer asset pins every appearance to the SAME light artwork', () => {
  // macOS 26 does not just draw a legacy .icns. It splits the icon into a
  // background plate and a foreground glyph and restyles the plate per
  // appearance — which turned Raff's terracotta plate black in Dark Mode.
  // Shipping an Icon Composer asset is what takes that decision back, and it
  // only helps if its dark appearance is IDENTICAL to its light one.
  const icon = JSON.parse(read('src-tauri/icon-composer/AppIcon.icon/icon.json'));

  const fills = icon['fill-specializations'] ?? [];
  assert.ok(fills.length > 0, 'the icon must declare its background fill');
  const [first, ...rest] = fills;
  for (const spec of rest) {
    assert.deepEqual(
      spec.value,
      first.value,
      `appearance "${spec.appearance}" must reuse the canonical light fill`
    );
  }

  for (const group of icon.groups ?? []) {
    for (const layer of group.layers ?? []) {
      const layerFills = layer['fill-specializations'] ?? [];
      const [base, ...others] = layerFills;
      for (const spec of others) {
        assert.deepEqual(
          spec.value,
          base.value,
          `layer "${layer.name}" must not vary by appearance`
        );
      }
      // A translucent "glass" mark disappears against the light plate.
      assert.notEqual(layer.glass, true, `layer "${layer.name}" must be solid, not glass`);
    }
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
      `${file} must not reference the parked dark icon`
    );
  }
});
