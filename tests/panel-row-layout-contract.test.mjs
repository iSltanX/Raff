import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { flush, minutesAgo, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (relativePath) => readFileSync(path.join(project, relativePath), 'utf8');
const css = read('src/panel.css');
const tokens = read('src/tokens.css');
const panelJs = read('src/js/panel.js');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'su'));
  assert.ok(match, `${selector} must have a CSS rule`);
  return match[1];
}

const tokenValues = new Map(
  [...tokens.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/giu)].map((match) => [match[1], match[2].trim()])
);

function pxToken(name, seen = new Set()) {
  assert.equal(seen.has(name), false, `${name} must not contain an alias cycle`);
  seen.add(name);
  const value = tokenValues.get(name);
  assert.ok(value, `${name} must exist`);
  const pixels = value.match(/^(\d+(?:\.\d+)?)px$/u);
  if (pixels) return Number(pixels[1]);
  const alias = value.match(/^var\((--[a-z0-9-]+)\)$/iu);
  assert.ok(alias, `${name} must resolve to a numeric px primitive`);
  return pxToken(alias[1], seen);
}

test('text rows resolve to the compact 56/32 two-track production grid', () => {
  assert.equal(pxToken('--metric-row-min-height'), 56);
  assert.equal(pxToken('--metric-row-inline'), 12);
  /* v4.1 — the slot carries real macOS app artwork rather than Figma's
     placeholder outline square, so it went 30→32 with a 20→24 glyph. */
  assert.equal(pxToken('--metric-source-slot-inline'), 32);
  assert.equal(pxToken('--metric-source-glyph'), 24);
  assert.equal(pxToken('--metric-row-action'), 32);
  assert.equal(pxToken('--metric-row-actions-gap'), 4);
  assert.equal(pxToken('--metric-row-actions-inline'), 68);

  const row = ruleBody('.row');
  assert.match(row, /direction:\s*ltr;/u, 'physical macOS row order remains text → source');
  assert.match(row, /display:\s*grid;/u);
  assert.match(
    row,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--metric-source-slot-inline\);/u,
    'exactly two tracks: content and the source slot'
  );
  assert.match(row, /column-gap:\s*var\(--space-md\);/u);
  assert.match(row, /min-height:\s*var\(--metric-row-min-height\);/u);

  const source = ruleBody('.source-icon');
  assert.match(source, /width:\s*var\(--metric-source-slot-inline\);/u);
  assert.match(source, /height:\s*var\(--metric-source-slot-inline\);/u);
  const sourceGlyph = ruleBody('.source-icon .figma-icon,\n.source-icon img');
  assert.match(sourceGlyph, /width:\s*var\(--metric-source-glyph\);/u);
  assert.match(sourceGlyph, /height:\s*var\(--metric-source-glyph\);/u);

  const actions = ruleBody('.row-actions');
  assert.match(actions, /gap:\s*var\(--metric-row-actions-gap\);/u);
  assert.match(actions, /width:\s*var\(--metric-row-actions-inline\);/u);
  assert.equal(
    2 * pxToken('--metric-row-action') + pxToken('--metric-row-actions-gap'),
    pxToken('--metric-row-actions-inline'),
    'the cluster is exactly as wide as the two 32pt buttons and their 4pt gap'
  );
  const action = ruleBody('.row-action');
  assert.match(action, /width:\s*var\(--metric-row-action\);/u);
  assert.match(action, /height:\s*var\(--metric-row-action\);/u);
  assert.match(ruleBody('.row-action .figma-icon'), /width:\s*16px;[\s\S]*height:\s*16px;/u);

  assert.doesNotMatch(row, /grid-template-columns:[^;]*(?:36px|88px)/u);
  assert.doesNotMatch(actions, /(?:width:\s*88px|gap:\s*0)/u);
  assert.doesNotMatch(action, /(?:width|height):\s*44px/u);
});

/* v4.1's central structural claim. The retired row reserved a permanent 68pt
   actions track, so an idle row drew a hole that the RTL eye — which enters
   from the inline-end — hit BEFORE the copied content. The reserve is gone:
   the cluster is an overlay, which is what makes the 68pt free. Nothing in the
   old suite could express that, because it asserted the reserve itself. */
test('the action cluster is an overlay and therefore costs the content nothing', () => {
  const row = ruleBody('.row');
  const actions = ruleBody('.row-actions');

  assert.doesNotMatch(
    row,
    /grid-template-columns:[^;]*--metric-row-actions-inline/u,
    'the row must never re-reserve a grid track for its actions'
  );
  assert.match(row, /position:\s*relative;/u, 'the row is the cluster’s containing block');
  assert.match(actions, /position:\s*absolute;/u);
  assert.match(
    actions,
    /inset-inline-start:\s*var\(--metric-row-inline\);/u,
    'the cluster sits on the row’s inline-start (physical left) edge, on the row padding'
  );

  /* The scrim MUST be painted from the row's live `--row-surface`, not from a
     fixed token. A literal here is how hover and selection end up with a
     mismatched rectangle parked over them. */
  const scrim = ruleBody('.row-actions::before');
  assert.match(scrim, /background:\s*linear-gradient\(/u);
  assert.ok(
    [...scrim.matchAll(/var\(--row-surface\)/gu)].length >= 2,
    'both opaque gradient stops read the row’s current surface'
  );
  /* The fade has to run PAST the cluster, or long content collides with the
     controls instead of dissolving under them. */
  assert.match(scrim, /inset-inline-end:\s*calc\(-1 \* var\(--metric-row-actions-scrim\)\);/u);
  assert.ok(pxToken('--metric-row-actions-scrim') > 0);
  assert.doesNotMatch(
    scrim,
    /background:[\s\S]*?var\(--color-bg-(?:row|hover|selected)\)/u,
    'the scrim must not hardcode one state’s surface'
  );
  assert.match(row, /--row-surface:\s*var\(--color-bg-row\);/u);
  assert.match(ruleBody('.row:hover:not(.selected)'), /--row-surface:\s*var\(--color-bg-hover\);/u);
  assert.match(ruleBody('.row.selected'), /--row-surface:\s*var\(--color-bg-selected\);/u);

  /* Progressive disclosure, and the accessibility floor under it: the cluster
     hides with opacity, never display/visibility, so the buttons stay in the
     tab order and `:focus-within` can bring them back. */
  assert.match(actions, /opacity:\s*0;/u);
  assert.doesNotMatch(actions, /display:\s*none|visibility:\s*hidden/u);
  for (const selector of ['.row:hover .row-actions', '.row.selected .row-actions', '.row:focus-within .row-actions']) {
    assert.ok(css.includes(selector), `${selector} must reveal the cluster`);
  }

  /* The skeleton mirrors the live row, so the list cannot jump on first data. */
  const skeleton = ruleBody('.skeleton-row');
  assert.match(
    skeleton,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--metric-source-slot-inline\);/u
  );
  assert.doesNotMatch(css, /\.skeleton-action\b/u, 'no placeholder for a column that never arrives');
  assert.doesNotMatch(panelJs, /skeleton-action/u);
});

/* v4.1 replaced the borderless row with tone + hairline + micro-lift, and
   turned "pinned" from a permanently-parked button into a row state. */
test('a resting row is a card: hairline, micro-lift, and pinned as a state', () => {
  const row = ruleBody('.row');
  assert.match(row, /border:\s*1px solid var\(--color-border-subtle\);/u);
  assert.match(row, /box-shadow:\s*var\(--elev-row\);/u);
  assert.match(row, /background:\s*var\(--row-surface\);/u);
  assert.match(row, /border-radius:\s*var\(--radius-lg\);/u);
  assert.match(tokens, /--elev-row:/u, '--elev-row must exist in both appearances');
  assert.equal(
    [...tokens.matchAll(/--elev-row:/gu)].length,
    2,
    'Dark needs its own weight for the lift to read at all'
  );

  assert.match(ruleBody('.row.is-pinned:not(.selected)'), /border-color:/u);
  assert.match(panelJs, /if\s*\(item\.isPinned\)\s*row\.classList\.add\('is-pinned'\);/u);
  assert.ok(css.includes('.row-pin-flag'), 'a pinned row states its condition at rest');
  for (const selector of ['.row:hover .row-pin-flag', '.row.selected .row-pin-flag', '.row:focus-within .row-pin-flag']) {
    assert.ok(css.includes(selector), `${selector} hands the space to the controls`);
  }
});

test('560pt panel arithmetic leaves at least 400pt for text and cannot overflow horizontally', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const panelWidth = config.app.windows.find((window) => window.label === 'panel')?.width;
  assert.equal(panelWidth, 560);

  /* Derived from the real rules, not from remembered numbers.
     .items-list gutters the panel at 18pt and shortens the inline-end side by
     the classic scrollbar's own width, which it reserves unconditionally. */
  const panelBorders = 2;
  const listPadding =
    pxToken('--metric-panel-inline') +
    (pxToken('--metric-panel-inline') - pxToken('--metric-list-scrollbar'));
  const list = ruleBody('.items-list');
  assert.match(list, /padding-inline-start:\s*var\(--metric-panel-inline\);/u);
  assert.match(
    list,
    /padding-inline-end:\s*calc\(var\(--metric-panel-inline\)\s*-\s*var\(--metric-list-scrollbar\)\);/u
  );
  /* v4.1 gave the row a resting 1px hairline, which is real layout width. */
  const rowBorders = 2;
  const rowPadding = 2 * pxToken('--metric-row-inline');
  /* ONE gap now: the row has two tracks, not three. */
  const columnGaps = 1 * pxToken('--space-md');
  const fixedColumns = pxToken('--metric-source-slot-inline');
  const textWidth =
    panelWidth - panelBorders - listPadding - rowBorders - rowPadding - columnGaps - fixedColumns;

  /* The retired v4.0 row, measured the same way: a 30pt source slot PLUS a
     reserved 68pt actions track and the second 8pt gap that fed it, and no
     row hairline. That reserve is what v4.1 returned to copied content. */
  const retiredReservedColumnWidth =
    panelWidth -
    panelBorders -
    listPadding -
    rowPadding -
    2 * pxToken('--space-md') -
    (pxToken('--size-30') + pxToken('--metric-row-actions-inline'));

  assert.equal(textWidth, 462, 'the real 560pt panel gives copied text 462pt before scrolling');
  assert.equal(
    textWidth - retiredReservedColumnWidth,
    72,
    'dropping the reserved actions track returns 72pt to copied content'
  );
  assert.ok(textWidth >= 400, 'copied content keeps the room the design promises it');
  assert.ok(textWidth > 0, 'the minmax track can shrink without forcing horizontal overflow');
  assert.match(list, /overflow-x:\s*hidden;/u);
  assert.match(ruleBody('.row-preview'), /min-width:\s*0;/u);
});

test('text truncation and bidi roles cover Arabic, Latin, and mixed content', () => {
  const title = ruleBody('.preview-title');
  assert.match(title, /width:\s*100%;/u);
  assert.match(title, /display:\s*-webkit-box;/u);
  assert.match(title, /-webkit-line-clamp:\s*2;/u);
  assert.match(title, /-webkit-box-orient:\s*vertical;/u);
  assert.match(title, /overflow:\s*hidden;/u);
  assert.match(title, /overflow-wrap:\s*anywhere;/u);
  assert.match(ruleBody('.preview-title.is-latin,\n.preview-title.is-code'), /direction:\s*ltr;/u);
  assert.match(ruleBody('.preview-title.is-mixed'), /unicode-bidi:\s*plaintext;/u);
  assert.match(panelJs, /title\.dir\s*=\s*'auto';/u);
});

test('rows prefer distinct native macOS icons and use Figma only after a null lookup', async () => {
  const nativeIcons = {
    'com.apple.Notes': 'data:image/png;base64,Tk9URVM=',
    'com.google.Chrome': 'data:image/png;base64,Q0hST01F',
    'com.openai.chat': 'data:image/png;base64,Q0hBVEdQVA==',
    'ai.anthropic.claude': null,
  };
  const { dom, fake, uncaught } = await mountPanel(
    {
      pinned: [],
      history: [
        sampleItem('arabic', {
          text: 'نص عربي قصير ثم امتداد لاختبار السطرين',
          sourceApp: 'Notes',
          sourceAppBundleId: 'com.apple.Notes',
          createdAt: minutesAgo(1),
        }),
        sampleItem('latin', {
          text: 'A long English clipboard value that remains readable across two compact lines',
          sourceApp: 'Google Chrome',
          sourceAppBundleId: 'com.google.Chrome',
          createdAt: minutesAgo(2),
        }),
        sampleItem('mixed', {
          text: 'نتيجة build 2026 جاهزة في production',
          sourceApp: 'ChatGPT',
          sourceAppBundleId: 'com.openai.chat',
          createdAt: minutesAgo(3),
        }),
        sampleItem('claude-null', {
          text: 'Native icon unavailable',
          sourceApp: 'Claude',
          sourceAppBundleId: 'ai.anthropic.claude',
          createdAt: minutesAgo(4),
        }),
      ],
      settings: null,
      axTrusted: true,
    },
    { sourceAppIcons: nativeIcons }
  );
  await flush(8);

  assert.deepEqual(
    new Set(fake.invocationArgs('source_app_icon').map(({ bundleId }) => bundleId)),
    new Set(Object.keys(nativeIcons)),
    'every row asks macOS for its original icon, including catalogued Notes/Chrome'
  );

  for (const [id, appName] of [
    ['arabic', 'Notes'],
    ['latin', 'Google Chrome'],
    ['mixed', 'ChatGPT'],
    ['claude-null', 'Claude'],
  ]) {
    const row = dom.window.document.querySelector(`.row[data-id="${id}"]`);
    const source = row.querySelector('.row-source');
    assert.equal(source.title, appName);
    assert.equal(source.getAttribute('aria-label'), `المصدر: ${appName}`);
    assert.equal(row.querySelector('.source-name, .row-time, .time'), null);
    assert.equal(row.textContent.includes(appName), false, 'source name is tooltip/AX text, not visible text');
  }

  for (const id of ['arabic', 'latin', 'mixed']) {
    const icon = dom.window.document.querySelector(`.row[data-id="${id}"] .source-icon`);
    const img = icon.querySelector('img');
    assert.ok(img, `${id} displays the native macOS image`);
    /* Intrinsic size must match --metric-source-glyph or WebKit resamples the
       artwork soft. v4.1 raised both from 20 to 24. */
    assert.equal(img.width, 24);
    assert.equal(img.height, 24);
    assert.equal(icon.querySelector('.source-app-glyph'), null, 'Figma is not painted over native art');
    assert.equal(
      icon.classList.contains('is-fallback'),
      false,
      'real full-colour app artwork is self-contained and gets no chip behind it'
    );
  }

  const claudeFallback = dom.window.document.querySelector(
    '.row[data-id="claude-null"] .source-app-glyph'
  );
  assert.ok(claudeFallback, 'a null native lookup uses the approved Figma fallback');
  assert.ok(
    claudeFallback.closest('.source-icon').classList.contains('is-fallback'),
    'a flat monochrome glyph is the one case that still needs a ground under it'
  );
  assert.match(
    claudeFallback.style.getPropertyValue('--figma-icon'),
    /source-app\/app-window\.svg/u
  );
  assert.doesNotMatch(
    claudeFallback.style.getPropertyValue('--figma-icon'),
    /source-app\/ai\.svg/u,
    'Claude is never replaced by the repeated CPU glyph'
  );

  const arabic = dom.window.document.querySelector('.row[data-id="arabic"] .preview-title');
  const latin = dom.window.document.querySelector('.row[data-id="latin"] .preview-title');
  const mixed = dom.window.document.querySelector('.row[data-id="mixed"] .preview-title');
  assert.equal(arabic.dir, 'auto');
  assert.ok(arabic.classList.contains('is-arabic'));
  assert.equal(latin.dir, 'auto');
  assert.ok(latin.classList.contains('is-latin'));
  assert.equal(mixed.dir, 'auto');
  assert.ok(mixed.classList.contains('is-mixed'));
  assert.deepEqual(uncaught, []);
});

test('icon loading has no catalogue early-return or AI-to-CPU substitution', () => {
  const icons = read('src/js/icons.js');
  assert.doesNotMatch(panelJs, /if\s*\(approvedAsset\)\s*return/u);
  assert.match(panelJs, /api\s*\.sourceAppIcon\(bundleId\)/u);
  assert.match(panelJs, /if\s*\(url\)\s*paintAppIcon\(host,\s*url\);[\s\S]*else\s+paintFigmaAppIcon\(host,\s*fallbackAsset\);/u);
  assert.doesNotMatch(
    icons,
    /(?:chatgpt|openai|claude|anthropic)[\s\S]{0,240}SOURCE_APP_ICONS\.ai/u
  );
});
