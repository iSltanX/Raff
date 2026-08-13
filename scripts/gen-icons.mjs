// Builds the bundled icon assets from the approved Figma file
// (j3EzLpDw4tIHQQSRQm8ZDM):
//   • the app-icon tile   ← «11 — Brand Applications», SECTION "LIBRARY •
//                            Approved App Icon (Light + Dark)", COMPONENT_SET
//                            "Brand / App Icon" (157:102) — variants
//                            Mode=Light (157:92) / Mode=Dark (157:97).
//                            Promoted 2026-08-12 from the file's own
//                            "LIVE • macOS App Icon System" proposal after a
//                            real visual comparison against the previous
//                            single-appearance master (COMPONENT 48:26,
//                            archived on page 99 — superseded, not deleted:
//                            two historical "• About 80" instances on that
//                            page still resolve to it).
//   • the menu-bar glyph  ← «11 — Brand Applications», COMPONENT_SET
//                            "Icon / Menu Bar / Raff" (51:41), variant
//                            Size=18 (51:23).
//
// The app-icon source is now a PNG, not hand-authored SVG: the new master has
// real macOS-style construction (continuous-corner squircle, inner bevel,
// edge stroke) that isn't practical to reproduce exactly by hand in SVG path
// math, so the production asset is rendered directly from the live Figma node
// — `tauri icon` accepts a 1024×1024 PNG source natively (Tauri's own
// recommended source format) and derives every bundle size from it. The
// export was taken with the icon's own authored drop-shadow removed (kept:
// the inner highlight/shadow bevel and edge stroke, which don't bleed past
// the frame) — macOS/Dock still supplies its own cast shadow, exactly as the
// previous flat asset relied on; baking in both would double it.
//
// NOTE: pre-flattened icon rasters exported onto an opaque white background
// (corner pixel #FFFFFF, alpha 255) produce a white square app icon in Finder,
// the Dock and the DMG, because macOS does not mask app icons. The masters are
// the ground truth: the tile is a rounded square whose corners must stay
// transparent, and the source PNGs preserve that alpha.
//
// macOS Light/Dark App Icon (src-tauri/icon-composer/AppIcon.icon) — BUILT,
// VALIDATED, NOT WIRED IN. macOS 26 can read a genuinely appearance-aware app
// icon from an Asset Catalog (`Assets.car` + `CFBundleIconName`) built from an
// Icon Composer `.icon` document — a real, static, OS-native mechanism, not a
// relaunch/runtime-polling workaround — and Tauri CLI ≥2.11 compiles one
// automatically via `actool` whenever a path ending `.icon` is listed in
// tauri.conf.json's `bundle.icon` array. The document at
// src-tauri/icon-composer/AppIcon.icon IS that real, working asset: its
// `fill-specializations` carry the exact canonical Figma gradient stops for
// both modes, `Assets/mark.png` is the canonical Light mark exported as a
// plain white alpha mask (Icon Composer tints one mask per appearance, the
// same convention HandBrake/Sparkle/Chromium use in their own committed
// `icon.json`), and `xcrun actool ... --compile` on it produces a real
// Assets.car with both `NSAppearanceNameAqua` and `NSAppearanceNameDarkAqua`
// renditions registered — verified directly, more than once.
//
// It is deliberately NOT listed in tauri.conf.json today: wiring it in
// reproducibly broke real `tauri build` runs on this machine. The `.icon`
// content is not at fault — the same document compiles cleanly on a fresh
// invocation — the cause is `ibtoold`, the actool-adjacent background
// compiler daemon shipped with Xcode 26.6, entering a crashing state
// (`NSPlaceholderArray … nil object`) after repeated invocations; `pkill
// ibtoold` restores it every time. Unlike the `actool < 26` case (which
// tauri-bundler skips silently), this crash propagates as a hard build
// failure with no fallback — see `create_assets_car_file` in
// tauri-bundler's macos/icon.rs. Shipping that non-determinism was judged
// worse than staying Light-only. Full investigation, evidence, and the
// reproduction steps: docs/APP_ICON_DARK_MODE.md. Re-add
// `"icon-composer/AppIcon.icon"` to tauri.conf.json's `bundle.icon` once
// Apple/Tauri tooling around this is more stable — `icons/icon.icns`
// (Light, generated above) is the `CFBundleIconFile` fallback either way, so
// macOS 12–25 is unaffected regardless of when/whether that happens.
//
//   npm run icons
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = 'src/assets/app-icon';

const render = (svgPath, size, outPath) => {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  writeFileSync(outPath, resvg.render().asPng());
  console.log(`${outPath} (${size}px)`);
};

const renderMenuBarTemplate = (svgPath, outPath) => {
  const source = readFileSync(svgPath, 'utf8');
  // Tauri/AppKit consumes a 36px @2x backing for the 18pt menu-bar slot.
  // Figma now provides that 18pt master directly; no canvas expansion, tint,
  // or geometric rewrite is permitted here.
  if (!source.includes('width="18" height="18" viewBox="0 0 18 18"')) {
    throw new Error('unexpected Figma Raff menu-bar SVG geometry');
  }
  const resvg = new Resvg(source, { fitTo: { mode: 'width', value: 36 } });
  writeFileSync(outPath, resvg.render().asPng());
  console.log(`${outPath} (36px @2x; exact 18pt Figma artwork)`);
};

mkdirSync('src-tauri/icons', { recursive: true });

// Bundled artwork is single-appearance, matching the v4.0.0 decision to ship
// one canonical .icns with no appearance-triggered relaunch — the LIVE→canon
// promotion changed the icon's CONSTRUCTION (squircle, bevel, real dark
// treatment now exists as an approved Figma master), not that architecture.
// A genuine dark .icns is generated below and kept on disk, ready for the day
// macOS-level dark-icon switching is a deliberate, separately-scoped decision
// — it is intentionally NOT referenced by tauri.conf.json today.
//
// Tauri's official icon generator is used for .icns because current iconutil
// releases can reject otherwise valid hand-built iconsets; it also derives
// every PNG size Tauri needs directly from the source, so a single generation
// pass replaces the old separate Resvg re-rasterization step (that existed
// only because the previous source was an SVG, not a raster master).
function generateIconSet(sourcePng, icnsDest) {
  const generated = mkdtempSync(join(tmpdir(), 'raff-tauri-icons-'));
  try {
    execFileSync(
      join('node_modules', '.bin', 'tauri'),
      ['icon', sourcePng, '--output', generated],
      { stdio: 'ignore' }
    );
    copyFileSync(join(generated, 'icon.icns'), icnsDest);
    console.log(`${icnsDest} (from ${sourcePng})`);
    return generated;
  } catch (error) {
    rmSync(generated, { recursive: true, force: true });
    throw error;
  }
}

const lightGenerated = generateIconSet(
  `${SRC}/raff-app-icon-light-1024.png`,
  'src-tauri/icons/icon.icns'
);
try {
  // PNG sizes Tauri lists in bundle.icon (tauri.conf.json). Nothing else is
  // copied out — an unreferenced size is dead weight in the repo and bundle.
  copyFileSync(join(lightGenerated, '32x32.png'), 'src-tauri/icons/32x32.png');
  copyFileSync(join(lightGenerated, '128x128.png'), 'src-tauri/icons/128x128.png');
  copyFileSync(join(lightGenerated, '128x128@2x.png'), 'src-tauri/icons/128x128@2x.png');
  console.log('src-tauri/icons/{32x32,128x128,128x128@2x}.png');

  // In-app preview used by the update window — reuse the already-generated
  // 256px (128x128@2x) rather than a separate render pass.
  copyFileSync(join(lightGenerated, '128x128@2x.png'), 'src/assets/app-icon.png');
  console.log('src/assets/app-icon.png (256px, update-window preview)');
} finally {
  rmSync(lightGenerated, { recursive: true, force: true });
}

// Dark counterpart — real, approved artwork; prepared and available, not yet
// wired into the bundle (see the architecture note above).
const darkGenerated = generateIconSet(
  `${SRC}/raff-app-icon-dark-1024.png`,
  'src-tauri/icons/icon-dark.icns'
);
rmSync(darkGenerated, { recursive: true, force: true });

// Exact Direction 3 Raff Identity Mark selected in Figma. It is black template
// artwork at 88% opacity (one negative-space cell at 44%); AppKit derives the
// dark-menu-bar, active and inactive appearances from this single alpha mask.
renderMenuBarTemplate('src/assets/v4/menu-bar-raff-18.svg', 'src-tauri/icons/tray.png');
