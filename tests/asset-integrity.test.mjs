import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
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

/**
 * Reads a PNG's dimensions, colour type and top-left pixel.
 *
 * Only the first pixel of the first scanline is needed, and that one is
 * filter-independent: every PNG filter resolves to the raw byte when there is
 * no left neighbour and no prior row, so no full unfilter pass is required.
 */
function pngProbe(relativePath) {
  const bytes = readFileSync(path.join(project, relativePath));
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      header = {
        width: bytes.readUInt32BE(offset + 8),
        height: bytes.readUInt32BE(offset + 12),
        bitDepth: bytes[offset + 16],
        colorType: bytes[offset + 17],
      };
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === 'IEND') break;
    offset += 12 + length;
  }
  assert.ok(header, `${relativePath} must have a PNG header`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  const raw = inflateSync(Buffer.concat(idat));
  return { ...header, channels, topLeft: [...raw.subarray(1, 1 + channels)] };
}

/**
 * The bug this locks out: Figma's SVG/PNG export renders a node IN CONTEXT,
 * so exporting the app-icon component silently prepended the section's opaque
 * #F5F5F5 background. Those exports were committed as the icon masters, and
 * because macOS does not mask app icons, every derived size shipped as a grey
 * square — visible as a border around the mark in About/Settings and as the
 * Finder, Dock and DMG icon. `gen-icons.mjs` documents this exact failure mode
 * and asserts the masters "preserve that alpha"; nothing enforced it, because
 * the existing presentation-frame guard only ever inspected SVGs.
 */
test('every app-icon raster keeps its corners transparent, master through derived', () => {
  const rasters = [
    'src/assets/app-icon/raff-app-icon-light-1024.png',
    'src/assets/app-icon/raff-app-icon-dark-1024.png',
    'src/assets/app-icon.png',
    'src-tauri/icons/32x32.png',
    'src-tauri/icons/128x128.png',
    'src-tauri/icons/128x128@2x.png',
  ];

  for (const relativePath of rasters) {
    assert.ok(existsSync(path.join(project, relativePath)), `${relativePath} must exist`);
    const png = pngProbe(relativePath);
    assert.equal(
      png.colorType,
      6,
      `${relativePath} must carry a real alpha channel (RGBA), not a flattened raster`
    );
    assert.equal(
      png.topLeft[3],
      0,
      `${relativePath} corner alpha is ${png.topLeft[3]} (rgba ${png.topLeft.join(',')}) — the tile is a rounded square, so its corners must be fully transparent. An opaque corner means a Figma presentation background was exported with the node.`
    );
  }
});

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

test('history content-type icons are byte-exact exports from Figma node 12:28', () => {
  const expected = new Map([
    ['content-types/text.svg', '7055677eaed42e016c56e63e693c2630224fd47e00a32603c3f786602a1419a4'],
    ['content-types/link.svg', '82016c8a51594ffd2d048218ff61e461d3b0b8a14f60cd4e918226932d0ff0cb'],
    ['content-types/code.svg', 'ba2c4f6fc414d767f772106e7d97bf34a36d8cca9db11583dd21ac2fcf926726'],
    ['content-types/image.svg', '3256e2b8215f75edd7bd4c02e54399b7087e2eac10f8ecc7374d6397a5508cf6'],
    ['content-types/unknown.svg', '3f16551fa7a94833b3892caa59770c3367af92b5a9d0a1a76be5b213c177fc17'],
  ]);

  for (const [relative, sha256] of expected) {
    const absolute = path.join(project, 'src/assets/v4', relative);
    assert.ok(existsSync(absolute), `${relative} must exist`);
    assert.equal(
      createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      sha256,
      `${relative} must remain the exact isolated Figma export`
    );
  }

  const iconModule = read('src/js/icons.js');
  const sourceAppDirectory = path.join(project, 'src/assets/v4/source-app');
  assert.deepEqual(
    existsSync(sourceAppDirectory) ? filesUnder(sourceAppDirectory) : [],
    [],
    'source-application icon assets must not ship'
  );
  assert.doesNotMatch(iconModule, /source-app\/|SOURCE_APP_ICONS|sourceAppAsset/u);
});

test('the Product Screens empty shelf is composed from its three original line exports', () => {
  const iconModule = read('src/js/icons.js');
  assert.match(iconModule, /empty-shelf-line-1\.svg/u);
  assert.match(iconModule, /empty-shelf-line-2\.svg/u);
  assert.match(iconModule, /empty-shelf-line-3\.svg/u);
  /* v4.1 — the three lines are the descending-bar Raff motif at identity
     scale (92/72/50 × 6, r3), not the 2px grey hairlines v4.0 had degraded
     them to, which read as an incidental divider rather than the product's
     own mark. The widths must stay in step with the `.state-art` rule that
     draws them, so the composition cannot silently stretch. */
  const panelCss = read('src/panel.css');
  for (const [index, width] of [92, 72, 50].entries()) {
    const svg = read(`src/assets/v4/empty-shelf-line-${index + 1}.svg`);
    assert.match(svg, new RegExp(`width="${width}"`));
    assert.match(svg, new RegExp(`viewBox="0 0 ${width} 6"`), 'a 6pt bar, not a hairline');
    assert.match(svg, /rx="3"/u, 'the mark’s bars are pill-capped');
    assert.match(
      panelCss,
      new RegExp(
        `\\.state-art\\.shelf-illustration \\.figma-icon:nth-child\\(${index + 1}\\)\\s*\\{[^}]*width:\\s*${width}px;`,
        'u'
      ),
      `the shelf illustration must draw line ${index + 1} at its exported width`
    );
    assert.doesNotMatch(svg, /#F5F5F5|Raff-macOS-Clipboard-History-Showcase/iu);
  }
  assert.match(
    panelCss,
    /\.state-art\.shelf-illustration \.figma-icon\s*\{[^}]*height:\s*6px;/u,
    'a stretched bar height would distort the mark'
  );
  /* Consumed as CSS masks, so the exported fill is shape-only and the live
     semantic colour comes from the component. */
  assert.match(
    panelCss,
    /\.state-art\.shelf-illustration\s*\{[\s\S]*?color:\s*var\(--color-icon-brand\);/u
  );
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
    name: 'content type — «14 — App & Content Icons» Content Icons (12:28)',
    ratio: 1.5 / 20,
    exactFigmaExport: true,
    files: [
      'content-types/code.svg',
      'content-types/image.svg',
      'content-types/link.svg',
      'content-types/text.svg',
      'content-types/unknown.svg',
    ],
  },
];

test('every stroked production icon carries its family’s approved optical ratio', () => {
  const iconRoot = path.join(project, 'src/assets/v4');
  /* Filled artwork rather than stroked icons: the macOS-tinted menu-bar
     template, the brand mark, and the empty-shelf bars — which are filled
     rounded rects (the shape IS the mark), not stroked glyphs. */
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
      if (family.exactFigmaExport) {
        assert.match(svg, /stroke="#4D443A"/u, `${relative} keeps Figma's exact Light master stroke`);
      } else {
        assert.match(svg, /stroke-linejoin="round"/u, `${relative} must use a round join`);
        assert.doesNotMatch(svg, /stroke="#/u, `${relative} must inherit colour, not bake a hex`);
        assert.doesNotMatch(
          svg,
          /preserveAspectRatio="none"/u,
          `${relative} must not distort inside a non-square control`
        );
      }
    }
  }
});

/* The families above only hold together if their production boxes stay put: a
   ratio is weight per unit of box, so a box change silently re-weights a whole
   family. These three are the boxes the hierarchy is calibrated against. */
test('icon families keep their approved production boxes and weights', () => {
  const tokens = read('src/tokens.css');
  const panel = read('src/panel.css');

  /* «14» specifies a 24px component canvas around 20px optical artwork. The
     row retains its existing 32px alignment slot while the exported glyph is
     never enlarged beyond that sanctioned 20px box. */
  assert.match(tokens, /--size-20:\s*20px/u);
  assert.match(tokens, /--metric-content-type-slot-inline:\s*var\(--size-32\)/u);
  assert.match(tokens, /--metric-content-type-glyph:\s*var\(--size-20\)/u);
  assert.match(
    panel,
    /\.content-type-icon \.figma-icon\s*\{[^}]*width:\s*var\(--metric-content-type-glyph\);[^}]*height:\s*var\(--metric-content-type-glyph\);/u,
    'the semantic glyph keeps the exact 20px optical box from Figma'
  );
  assert.match(panel, /\.row-action\s+\.figma-icon[\s\S]*?width:\s*16px/u);

  const rendered = (ratio, box) => Number((ratio * box).toFixed(3));
  const rowAction = rendered(1.5 / 16, 16);
  const utility = rendered(2 / 24, 16);
  const contentType = rendered(1.5 / 20, 20);

  assert.equal(contentType, 1.5, 'the semantic icon must render at Figma\'s exact 1.5px stroke');
  assert.ok(rowAction > utility, `row action ${rowAction} must outweigh utility ${utility}`);
  assert.ok(rowAction <= 1.5, `row actions must not exceed 1.5px rendered, got ${rowAction}`);
});

test('history icon assets carry content semantics only, never application identity', () => {
  const iconModule = read('src/js/icons.js');
  assert.match(iconModule, /export const CONTENT_TYPE_ICONS/u);
  assert.match(iconModule, /export function contentTypeIcon/u);
  assert.doesNotMatch(iconModule, /source-app\/|SOURCE_APP_ICONS|sourceAppAsset/u);
  assert.doesNotMatch(iconModule, /\b(?:safari|chrome|notes|vscode|chatgpt|claude)\s*:/iu);
});

test('asset consumers do not inject SVG or URL markup through innerHTML', () => {
  for (const sourcePath of ['src/js/icons.js', 'src/js/firstrun.js', 'src/js/settings.js']) {
    assert.doesNotMatch(read(sourcePath), /\b(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/u);
  }
  assert.match(read('src/js/firstrun.js'), /replaceChildren\(createIcon\(/u);
  assert.match(read('src/js/settings.js'), /replaceChildren\(createIcon\(CLEAR\)\)/u);
});
