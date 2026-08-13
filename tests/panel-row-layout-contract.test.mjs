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

test('text rows resolve to the compact 56/30/68 production grid', () => {
  assert.equal(pxToken('--metric-row-min-height'), 56);
  assert.equal(pxToken('--metric-row-inline'), 12);
  assert.equal(pxToken('--metric-source-slot-inline'), 30);
  assert.equal(pxToken('--metric-source-glyph'), 20);
  assert.equal(pxToken('--metric-row-action'), 32);
  assert.equal(pxToken('--metric-row-actions-gap'), 4);
  assert.equal(pxToken('--metric-row-actions-inline'), 68);

  const row = ruleBody('.row');
  assert.match(row, /direction:\s*ltr;/u, 'physical macOS row order remains text → source → actions');
  assert.match(row, /display:\s*grid;/u);
  assert.match(
    row,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--metric-source-slot-inline\)\s+var\(--metric-row-actions-inline\);/u
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
    'the two 32pt buttons sit directly together in one 68pt group'
  );
  const action = ruleBody('.row-action');
  assert.match(action, /width:\s*var\(--metric-row-action\);/u);
  assert.match(action, /height:\s*var\(--metric-row-action\);/u);
  assert.match(ruleBody('.row-action .figma-icon'), /width:\s*16px;[\s\S]*height:\s*16px;/u);

  assert.doesNotMatch(row, /grid-template-columns:[^;]*(?:36px|88px)/u);
  assert.doesNotMatch(actions, /(?:width:\s*88px|gap:\s*0)/u);
  assert.doesNotMatch(action, /(?:width|height):\s*44px/u);
});

test('560pt panel arithmetic leaves at least 400pt for text and cannot overflow horizontally', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const panelWidth = config.app.windows.find((window) => window.label === 'panel')?.width;
  assert.equal(panelWidth, 560);

  const panelBorders = 2;
  const listPadding = 2 * pxToken('--space-md');
  const rowPadding = 2 * pxToken('--metric-row-inline');
  const columnGaps = 2 * pxToken('--space-md');
  const fixedColumns =
    pxToken('--metric-source-slot-inline') + pxToken('--metric-row-actions-inline');
  const textWidth = panelWidth - panelBorders - listPadding - rowPadding - columnGaps - fixedColumns;

  const rejectedTextWidth =
    panelWidth - panelBorders - listPadding - 2 * 16 - 2 * 10 - 36 - 88;
  assert.equal(textWidth, 404, 'the real 560pt panel gives copied text 404pt before scrolling');
  assert.equal(textWidth - rejectedTextWidth, 38, 'the redesign returns 38pt to copied content');
  assert.ok(textWidth > 0, 'the minmax track can shrink without forcing horizontal overflow');
  assert.match(ruleBody('.items-list'), /overflow-x:\s*hidden;/u);
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
    assert.equal(img.width, 20);
    assert.equal(img.height, 20);
    assert.equal(icon.querySelector('.source-app-glyph'), null, 'Figma is not painted over native art');
  }

  const claudeFallback = dom.window.document.querySelector(
    '.row[data-id="claude-null"] .source-app-glyph'
  );
  assert.ok(claudeFallback, 'a null native lookup uses the approved Figma fallback');
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
