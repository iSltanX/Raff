import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

function read(relativePath) {
  return readFileSync(path.join(project, relativePath), 'utf8');
}

function filesUnder(directory, relative = '') {
  return readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(directory, child) : [child];
  });
}

test('every SVG wired through the production icon module exists and excludes Figma page backgrounds', () => {
  const iconModule = read('src/js/icons.js');
  const references = [...iconModule.matchAll(/asset\('([^']+)'\)/gu)].map((match) =>
    path.resolve(project, 'src/js', match[1])
  );

  assert.ok(references.length >= 10, 'the shared icon module must expose the complete production set');
  for (const absolutePath of references) {
    assert.ok(existsSync(absolutePath), `${absolutePath} must exist`);
    const svg = readFileSync(absolutePath, 'utf8');
    assert.match(svg, /^<svg\b/u, `${absolutePath} must remain an SVG asset`);
    assert.doesNotMatch(
      svg,
      /<rect\b[^>]*\bwidth="1440"|#F5F5F5|Raff-macOS-Clipboard-History-Showcase/iu,
      `${absolutePath} must not include an opaque Figma presentation frame`
    );
  }
});

test('the Product Screens empty shelf is composed from its three original line exports', () => {
  const iconModule = read('src/js/icons.js');
  assert.match(iconModule, /empty-shelf-line-1\.svg/u);
  assert.match(iconModule, /empty-shelf-line-2\.svg/u);
  assert.match(iconModule, /empty-shelf-line-3\.svg/u);
  for (const [index, width] of [160, 120, 80].entries()) {
    const svg = read(`src/assets/v4/empty-shelf-line-${index + 1}.svg`);
    assert.match(svg, new RegExp(`width="${width}"`));
    assert.doesNotMatch(svg, /#F5F5F5|Raff-macOS-Clipboard-History-Showcase/iu);
  }
});

test('About and Settings use the one canonical bundled app icon', () => {
  for (const htmlPath of ['src/about.html', 'src/settings.html']) {
    assert.match(read(htmlPath), /src="assets\/app-icon\.png"/u);
  }
  assert.equal(
    filesUnder(path.join(project, 'src/assets/v4')).some((file) => file.includes('about') && file.includes('logo')),
    false
  );
});

test('the v4 identity directory contains only active assets and approved export masters', () => {
  const assetRoot = path.join(project, 'src/assets/v4');
  const files = filesUnder(assetRoot).sort();
  const activeConsumers = [
    'scripts/build-frontend.mjs',
    'scripts/gen-icons.mjs',
    'src/js/icons.js',
    'src/about.html',
    'src/settings.html',
  ]
    .map(read)
    .join('\n');
  const approvedHandoffOnly = new Set(['menu-bar-raff-16.svg']);

  assert.ok(files.length >= 19, 'the complete production identity set must remain present');
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)\.DS_Store$|-figma(?:@\d+x)?\.|-product\./iu);
    if (!approvedHandoffOnly.has(file)) {
      assert.match(
        activeConsumers,
        new RegExp(`(?:^|[/'\"]|\\b)${path.basename(file).replaceAll('.', '\\.')}(?:$|[)'\"]|\\b)`, 'u'),
        `${file} must have an active production consumer`
      );
    }
  }

  assert.equal(existsSync(path.join(project, 'src/assets/.DS_Store')), false);
});

test('production brand and menu-bar masters preserve their distinct approved geometry', () => {
  const brandMark = read('src/assets/v4/raff-logo-mark.svg');
  assert.match(brandMark, /<rect x="0" y="4" width="72" height="6" rx="3"\/>/u);
  assert.match(brandMark, /<rect x="0" y="21" width="61" height="6" rx="3"\/>/u);
  assert.match(brandMark, /<rect x="0" y="38" width="47" height="6" rx="3"\/>/u);

  const menu16 = read('src/assets/v4/menu-bar-raff-16.svg');
  const menu18 = read('src/assets/v4/menu-bar-raff-18.svg');
  assert.match(menu16, /width="16" height="16" viewBox="0 0 16 16"/u);
  assert.match(menu18, /width="18" height="18" viewBox="0 0 18 18"/u);
  const exactRaff18Geometry = [
    '<rect x="3" y="3" width="12" height="14" rx="2" stroke="black" stroke-opacity="0.88" stroke-width="2" stroke-linejoin="round"/>',
    '<rect x="7" y="1" width="5" height="2" rx="1" stroke="black" stroke-opacity="0.88" stroke-width="2" stroke-linejoin="round"/>',
    '<rect x="5" y="6" width="3" height="3" rx="1" fill="black" fill-opacity="0.88"/>',
    '<rect x="9" y="6" width="3" height="3" rx="1" stroke="black" stroke-opacity="0.44"/>',
    '<rect x="5" y="10" width="3" height="3" rx="1" fill="black" fill-opacity="0.88"/>',
    '<rect x="9" y="10" width="3" height="3" rx="1" fill="black" fill-opacity="0.88"/>',
  ];
  assert.deepEqual(menu18.match(/<rect\b[^>]*\/>/gu), exactRaff18Geometry);
  assert.doesNotMatch(menu16 + menu18, /#F5F5F5|width="1440"|<path\b/iu);

  const iconGenerator = read('scripts/gen-icons.mjs');
  assert.match(
    iconGenerator,
    /renderMenuBarTemplate\('src\/assets\/v4\/menu-bar-raff-18\.svg', 'src-tauri\/icons\/tray\.png'\)/u
  );
  assert.doesNotMatch(iconGenerator, /viewBox="-1 -1 18 18"/u);
  // raff-menubar-template.svg stays retired (superseded by the Figma-native
  // menu-bar masters above). icon-dark.icns is the one name that is back on
  // purpose — see the app-icon test below — so it is checked separately, not
  // in this blanket-retirement list.
  assert.equal(iconGenerator.includes('raff-menubar-' + 'template.svg'), false);
  assert.equal(iconGenerator.includes('icon-' + 'light.icns'), false);

  const expectedTray = new Resvg(menu18, {
    fitTo: { mode: 'width', value: 36 },
  })
    .render()
    .asPng();
  const committedTray = readFileSync(path.join(project, 'src-tauri/icons/tray.png'));
  assert.deepEqual(committedTray, expectedTray, 'the native tray PNG must preserve the exact 18pt Figma artwork');
  assert.equal(committedTray.readUInt32BE(16), 36);
  assert.equal(committedTray.readUInt32BE(20), 36);

  const trayRust = read('src-tauri/src/tray.rs');
  assert.match(trayRust, /\.icon_as_template\(true\)/u);
});

/* The app icon's canonical source is now a real macOS-style construction
   (continuous-corner squircle, inner bevel, edge stroke) promoted from
   Figma's own "LIVE • macOS App Icon System" proposal on 2026-08-12, after a
   real visual comparison against the previous flat single-appearance master
   (COMPONENT 48:26, archived — not deleted — on page 99; two historical
   instances there still resolve to it). That construction isn't practical to
   reproduce exactly by hand in SVG path math, so — unlike every other asset
   in this file — the source of truth is a PNG exported directly from the
   live Figma node, not text a regex can meaningfully match. What IS checked:
   the source is exactly the canvas Apple expects, and the committed bundle
   artifacts are byte-reproducible from it right now, not hand-edited out of
   sync with what `npm run icons` would actually produce. */
test('the app icon\'s PNG sources are real macOS-canvas masters and the bundled .icns is reproducible from them', () => {
  const iconGenerator = read('scripts/gen-icons.mjs');
  assert.doesNotMatch(
    iconGenerator,
    /raff-app-icon\.svg/u,
    'the retired flat SVG master must not be referenced — the canonical source is now a PNG'
  );
  assert.match(iconGenerator, /raff-app-icon-light-1024\.png/u);
  assert.match(iconGenerator, /raff-app-icon-dark-1024\.png/u);
  assert.doesNotMatch(
    read('src-tauri/tauri.conf.json'),
    /icon-dark\.icns/u,
    'the dark .icns is a prepared, approved asset, deliberately not wired into the shipping bundle yet'
  );

  // PNG signature (8 bytes) + chunk length/type (8 bytes) puts IHDR's width
  // at offset 16 and height at offset 20 — the exact technique the tray PNG
  // check above already uses for its own 36×36 assertion. Deliberately
  // in-process only: unlike the tray check (Resvg, an in-process renderer),
  // round-tripping through a spawned `tauri icon` subprocess here proved slow
  // and unreliable in a sandboxed test run, so bundle artifacts are checked
  // for validity and correct size rather than byte-reproduced from scratch —
  // consistent with every other check in this file being a pure, fast read.
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const assertPng = (rel, expectedSize, minBytes) => {
    const buf = readFileSync(path.join(project, rel));
    assert.deepEqual(buf.subarray(0, 8), pngSignature, `${rel} must be a real PNG`);
    assert.equal(buf.readUInt32BE(16), expectedSize, `${rel} width must be exactly ${expectedSize}`);
    assert.equal(buf.readUInt32BE(20), expectedSize, `${rel} height must be exactly ${expectedSize}`);
    assert.ok(buf.length > minBytes, `${rel} must not be a degenerate/near-empty render (${buf.length} bytes)`);
  };

  assertPng('src/assets/app-icon/raff-app-icon-light-1024.png', 1024, 20_000);
  assertPng('src/assets/app-icon/raff-app-icon-dark-1024.png', 1024, 20_000);
  assertPng('src-tauri/icons/32x32.png', 32, 300);
  assertPng('src-tauri/icons/128x128.png', 128, 2_000);
  assertPng('src-tauri/icons/128x128@2x.png', 256, 5_000);
  assertPng('src/assets/app-icon.png', 256, 5_000);
  assert.deepEqual(
    readFileSync(path.join(project, 'src-tauri/icons/128x128@2x.png')),
    readFileSync(path.join(project, 'src/assets/app-icon.png')),
    'the update-window preview must be the exact same 256px render as the bundled icon, not a separate re-render'
  );

  const icnsMagic = Buffer.from('icns', 'ascii');
  for (const rel of ['src-tauri/icons/icon.icns', 'src-tauri/icons/icon-dark.icns']) {
    const buf = readFileSync(path.join(project, rel));
    assert.deepEqual(buf.subarray(0, 4), icnsMagic, `${rel} must be a real .icns container`);
    assert.ok(buf.length > 100_000, `${rel} must contain real multi-size artwork (${buf.length} bytes)`);
  }
});

test('row actions use the exact approved 16px Figma component exports', () => {
  const pin = read('src/assets/v4/pin.svg');
  const unpin = read('src/assets/v4/icons/pin-off.svg');
  const trash = read('src/assets/v4/icons/trash.svg');

  for (const svg of [pin, unpin, trash]) {
    assert.match(svg, /width="16" height="16" viewBox="0 0 16 16"/u);
    /* 1.5 on a 16 canvas is the Row / Action Button ratio these three are
       sourced from (icons.js:21-30 → «06 — Components» 77:603). They shipped at
       2.66667 — the 24-grid stroke rescaled by the INVERSE of the geometry
       factor — which drew them at 2.67× the sanctioned weight and made the
       interactive controls the heaviest marks in the row. */
    assert.match(svg, /stroke-width="1\.5" stroke-linecap="round" stroke-linejoin="round"/u);
  }
  assert.match(pin, /id="Icon \/ Pin"/u);
  assert.match(unpin, /id="Icon \/ Unpin"/u);
  assert.match(trash, /id="Icon \/ Delete"/u);
  assert.match(unpin, /M1\.3328 1\.3328L14\.6672 14\.6672/u);
  assert.match(trash, /M2 3\.99968H14/u);
});

/* Optical weight is not the `stroke-width` literal — it is strokeWidth ÷
   viewBoxSize, because every icon reaches the screen through a CSS mask scaled
   to its control box. Each family is bound to the ratio of the Figma page that
   `src/js/icons.js` documents it as coming from, NOT to one global number:
   collapsing them would thin the interactive controls below the master they are
   exported from. What must never vary is the ratio WITHIN a family.

   The shipped assets had each kept a 24-grid stroke on a downscaled canvas, so
   the set spanned 1.33× to 2.67× overweight — the row actions drew a 2.67px
   stroke while the search magnifier 40px away in the same window drew 1.33px.
   That discontinuity, not thinness, was the defect. Pinning ratios per family
   is what stops it returning one asset at a time. */
const ICON_FAMILIES = [
  {
    name: 'row action — «06 — Components» Row / Action Button (77:603)',
    ratio: 1.5 / 16,
    files: ['pin.svg', 'icons/pin-off.svg', 'icons/trash.svg'],
  },
  {
    name: 'utility — «05 — Iconography» Product Core Icon Library',
    ratio: 2 / 24,
    files: [
      'icons/search.svg',
      'icons/x-circle.svg',
      'icons/alert-triangle.svg',
      'icons/image.svg',
      'icons/keyboard.svg',
      'icons/check-circle.svg',
      'panel-settings.svg',
    ],
  },
  {
    name: 'source app — «14 — App & Content Icons»',
    ratio: 2 / 32,
    files: [
      'source-app/app-window.svg',
      'source-app/chrome.svg',
      'source-app/figma.svg',
      'source-app/notes.svg',
      'source-app/safari.svg',
    ],
  },
];

test('every stroked production icon carries its family’s approved optical ratio', () => {
  const iconRoot = path.join(project, 'src/assets/v4');
  /* Filled artwork rather than stroked icons: the macOS-tinted menu-bar
     template, the brand mark, and the decorative shelf rules whose stroke is
     itself the shape. */
  const filledArtwork = /^(menu-bar-raff-|raff-logo-mark\.svg$|empty-shelf-line-)/;

  const classified = new Set(ICON_FAMILIES.flatMap((f) => f.files));
  const onDisk = filesUnder(iconRoot)
    .filter((relative) => relative.endsWith('.svg'))
    .filter((relative) => !filledArtwork.test(path.basename(relative)));

  /* A new stroked icon that belongs to no family would otherwise inherit no
     ratio at all and ship unguarded. */
  assert.deepEqual(
    onDisk.filter((relative) => !classified.has(relative)),
    [],
    'every stroked icon must be assigned to a family with a declared ratio'
  );
  assert.equal(onDisk.length, 15, 'the stroked icon family set must stay accounted for');

  for (const family of ICON_FAMILIES) {
    const expected = Number(family.ratio.toFixed(4));
    for (const relative of family.files) {
      const svg = readFileSync(path.join(iconRoot, relative), 'utf8');
      const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/u.exec(svg);
      assert.ok(viewBox, `${relative} must declare a viewBox`);
      const grid = Number(viewBox[1]);

      const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/gu)].map((m) => Number(m[1]));
      assert.ok(widths.length > 0, `${relative} must declare a stroke width`);
      for (const width of widths) {
        assert.equal(
          Number((width / grid).toFixed(4)),
          expected,
          `${relative}: stroke ${width} on a ${grid} grid is ratio ${(width / grid).toFixed(4)}, not the ${family.name} ratio ${expected}`
        );
        /* A stroke is centred on the path, so half of it sits outside the
           geometry. Several of these files carry a <clipPath> rect locked to
           the original canvas, which would silently shave the glyph. */
        assert.ok(
          width / 2 < grid * 0.06,
          `${relative}: half-stroke ${width / 2} risks the ${grid} canvas edge`
        );
      }

      assert.match(svg, /stroke-linecap="round"/u, `${relative} must use a round cap`);
      assert.match(svg, /stroke-linejoin="round"/u, `${relative} must use a round join`);
      assert.doesNotMatch(svg, /stroke="#/u, `${relative} must inherit colour, not bake a hex`);
      assert.doesNotMatch(
        svg,
        /preserveAspectRatio="none"/u,
        `${relative} must not distort inside a non-square control`
      );
    }
  }
});

/* The families above only hold together if their production boxes stay put: a
   ratio is weight per unit of box, so a box change silently re-weights a whole
   family. These three are the boxes the hierarchy is calibrated against. */
test('icon families keep their intended weight hierarchy at production size', () => {
  const tokens = read('src/tokens.css');
  const panel = read('src/panel.css');

  assert.match(tokens, /--metric-source-glyph:\s*var\(--size-20\)/u);
  assert.match(panel, /\.row-action\s+\.figma-icon[\s\S]*?width:\s*16px/u);

  const rendered = (ratio, box) => Number((ratio * box).toFixed(3));
  const rowAction = rendered(1.5 / 16, 16);
  const utility = rendered(2 / 24, 16);
  const sourceApp = rendered(2 / 32, 20);

  assert.ok(
    rowAction > utility && utility > sourceApp,
    `interactive controls must outweigh utility marks, which must outweigh the subordinate source glyph — got ${rowAction} / ${utility} / ${sourceApp}`
  );
  assert.ok(rowAction <= 1.5, `row actions must not exceed 1.5px rendered, got ${rowAction}`);
});

test('ChatGPT and Claude are not collapsed into the repeated CPU fallback', () => {
  const iconModule = read('src/js/icons.js');
  const retiredCpuAsset = path.join(project, 'src/assets/v4/source-app/ai.svg');

  assert.equal(existsSync(retiredCpuAsset), false, 'the repeated CPU fallback must not ship');
  assert.doesNotMatch(iconModule, /source-app\/ai\.svg|SOURCE_APP_ICONS\.ai|\bai:\s*asset\(/u);
  assert.doesNotMatch(
    iconModule,
    /(?:chatgpt|openai|claude|anthropic)[\s\S]{0,240}SOURCE_APP_ICONS\.ai/u,
    'AI applications must keep their distinct native macOS icons when available'
  );
  assert.doesNotMatch(
    iconModule,
    /if\s*\([^)]*(?:chatgpt|openai|claude|anthropic)[^)]*\)\s*\{?\s*return\s+SOURCE_APP_ICONS\.ai/u
  );
});

test('asset consumers do not inject SVG or URL markup through innerHTML', () => {
  for (const sourcePath of ['src/js/icons.js', 'src/js/firstrun.js', 'src/js/settings.js']) {
    assert.doesNotMatch(read(sourcePath), /\b(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/u);
  }
  assert.match(read('src/js/firstrun.js'), /replaceChildren\(createIcon\(/u);
  assert.match(read('src/js/settings.js'), /replaceChildren\(createIcon\(CLEAR\)\)/u);
});
