import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { flush, minutesAgo, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (relativePath) => readFileSync(path.join(project, relativePath), 'utf8');

function semanticAsset(dom, id) {
  const row = dom.window.document.querySelector(`.row[data-id="${id}"]`);
  assert.ok(row, `row ${id} must render`);
  const kind = row.querySelector('.row-kind');
  assert.ok(kind, `row ${id} must have one semantic type cell`);
  const glyph = kind.querySelector('.content-type-icon > .content-type-glyph');
  assert.ok(glyph, `row ${id} must paint one local Figma glyph`);
  return glyph.style.getPropertyValue('--figma-icon');
}

test('history rows use synchronous semantic icons and never resolve source-app artwork', async () => {
  const history = [
    sampleItem('text-notes', {
      type: 'text',
      text: 'نص من الملاحظات',
      sourceApp: 'Notes',
      sourceAppBundleId: 'com.apple.Notes',
      createdAt: minutesAgo(1),
    }),
    sampleItem('link-notes', {
      type: 'link',
      text: 'https://raff.example/design',
      sourceApp: 'Notes',
      sourceAppBundleId: 'com.apple.Notes',
      createdAt: minutesAgo(2),
    }),
    sampleItem('text-browser', {
      type: 'text',
      text: 'The same content kind from another application',
      sourceApp: 'Safari',
      sourceAppBundleId: 'com.apple.Safari',
      createdAt: minutesAgo(3),
    }),
    sampleItem('code-terminal', {
      type: 'code',
      text: 'cargo test --locked',
      sourceApp: 'Terminal',
      sourceAppBundleId: 'com.apple.Terminal',
      createdAt: minutesAgo(4),
    }),
    sampleItem('image-preview', {
      type: 'image',
      text: 'صورة 1200 × 800',
      sourceApp: 'Preview',
      sourceAppBundleId: 'com.apple.Preview',
      hasImage: true,
      createdAt: minutesAgo(5),
    }),
    sampleItem('future-kind', {
      type: 'future-kind',
      text: 'نوع غير معروف للإصدار الحالي',
      sourceApp: 'Finder',
      sourceAppBundleId: 'com.apple.finder',
      createdAt: minutesAgo(6),
    }),
  ];

  const { dom, fake, uncaught } = await mountPanel({
    pinned: [],
    history,
    settings: null,
    axTrusted: true,
  });
  await flush();

  const expected = new Map([
    ['text-notes', /content-types\/text\.svg/u],
    ['link-notes', /content-types\/link\.svg/u],
    ['text-browser', /content-types\/text\.svg/u],
    ['code-terminal', /content-types\/code\.svg/u],
    ['image-preview', /content-types\/image\.svg/u],
    ['future-kind', /content-types\/unknown\.svg/u],
  ]);
  for (const [id, asset] of expected) assert.match(semanticAsset(dom, id), asset);

  assert.equal(
    semanticAsset(dom, 'text-notes'),
    semanticAsset(dom, 'text-browser'),
    'one content type keeps one icon across unrelated source applications'
  );
  assert.notEqual(
    semanticAsset(dom, 'text-notes'),
    semanticAsset(dom, 'link-notes'),
    'two content types from the same source application remain visually distinct'
  );

  const kindCells = [...dom.window.document.querySelectorAll('.row-kind')];
  assert.equal(kindCells.length, history.length);
  for (const cell of kindCells) {
    assert.equal(cell.querySelectorAll('.content-type-glyph').length, 1);
    assert.equal(cell.querySelector('img'), null, 'the semantic slot has no deferred image element');
  }
  assert.equal(fake.invokeCount('source_app_icon'), 0);

  const firstAsset = semanticAsset(dom, 'text-notes');
  const refreshed = history.map((item) => ({ ...item }));
  refreshed[0].sourceApp = 'Completely Different App';
  refreshed[0].sourceAppBundleId = 'example.changed.source';
  fake.setState({ pinned: [], history: refreshed, settings: null, axTrusted: true });
  fake.emit('raff://changed');
  await flush(6);
  assert.equal(
    semanticAsset(dom, 'text-notes'),
    firstAsset,
    'changing only source metadata cannot alter the semantic icon'
  );
  assert.equal(fake.invokeCount('source_app_icon'), 0, 'ordinary refresh performs zero icon IPC');

  const types = ['text', 'link', 'code', 'image', 'future-kind'];
  const largeHistory = Array.from({ length: 300 }, (_, index) => {
    const type = types[index % types.length];
    return sampleItem(`bulk-${index}`, {
      type,
      text: type === 'link' ? `https://example.test/${index}` : `bulk item ${index}`,
      sourceApp: `Source ${index}`,
      sourceAppBundleId: `example.source.${index}`,
      hasImage: type === 'image',
      createdAt: Date.now() - index,
    });
  });
  const stateCallsBefore = fake.getStateCallCount();
  fake.setState({ pinned: [], history: largeHistory, settings: null, axTrusted: true });
  fake.emit('raff://changed');
  await flush(8);

  assert.equal(fake.getStateCallCount(), stateCallsBefore + 1, 'the event performs one authoritative refresh');
  assert.equal(dom.window.document.querySelectorAll('.row').length, largeHistory.length);
  assert.equal(dom.window.document.querySelectorAll('.row-kind .content-type-glyph').length, largeHistory.length);
  assert.equal(dom.window.document.querySelectorAll('.row-kind img').length, 0);
  assert.equal(
    fake.invokeCount('source_app_icon'),
    0,
    'a 300-row mixed history still sends no source_app_icon command'
  );
  assert.deepEqual(uncaught, []);
});

test('skeleton and live semantic slots have identical fixed geometry', () => {
  const css = read('src/panel.css');
  const tokens = read('src/tokens.css');
  const panel = read('src/js/panel.js');
  const icons = read('src/js/icons.js');
  const twoTrack =
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--metric-content-type-slot-inline\);/gu;

  assert.equal([...css.matchAll(twoTrack)].length, 2, 'live and skeleton rows reserve the same type slot');
  assert.match(tokens, /--metric-content-type-slot-inline:\s*var\(--size-32\);/u);
  assert.match(tokens, /--metric-content-type-glyph:\s*var\(--size-20\);/u);
  assert.match(panel, /icon\.replaceChildren\(createIcon\(presentation\.asset, 'content-type-glyph'\)\);/u);
  assert.match(
    icons,
    /Object\.prototype\.hasOwnProperty\.call\(CONTENT_TYPE_ICONS, type\)/u,
    'the resolver remains compatible with the WebKit version shipped by macOS 12.0'
  );
  assert.doesNotMatch(icons, /Object\.hasOwn\(/u);
  assert.doesNotMatch(panel, /sourceAppIcon|source_app_icon|new Image\(|\.createElement\('img'\)[\s\S]{0,240}content-type/u);
  assert.doesNotMatch(icons, /SOURCE_APP_ICONS|source-app\//u);
});

test('production history code has no native source-app icon bridge', () => {
  const production = [
    'src/js/panel.js',
    'src/js/store.js',
    'src-tauri/src/commands.rs',
    'src-tauri/src/macos.rs',
    'src-tauri/src/main.rs',
  ]
    .map(read)
    .join('\n');

  assert.doesNotMatch(
    production,
    /source_app_icon|sourceAppIcon|app_icon_png|URLForApplicationWithBundleIdentifier|iconForFile|TIFFRepresentation/u
  );
  assert.match(read('src-tauri/src/commands.rs'), /source_app_bundle_id:/u);
  assert.match(read('src/js/logic.js'), /item\.sourceApp/u);
});
