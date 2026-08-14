import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (relativePath) => readFileSync(path.join(project, relativePath), 'utf8');

test('context shortcut bar is semantic, RTL, tokenized, and bounded at panel width', () => {
  const html = read('src/index.html');
  const css = read('src/panel.css');

  assert.match(
    html,
    /<nav\b[^>]*class="footer-shortcuts"[^>]*id="footer-hint"[^>]*aria-label="اختصارات السياق الحالي"/u
  );
  assert.match(css, /\.footer-shortcuts\s*\{[\s\S]*?direction:\s*rtl;/u);
  assert.match(css, /\.footer-shortcuts\s*\{[\s\S]*?flex-wrap:\s*nowrap;/u);
  assert.match(css, /\.footer-shortcuts\s*\{[\s\S]*?width:\s*100%;/u);
  assert.match(css, /\.footer-shortcuts\s*\{[\s\S]*?min-width:\s*0;/u);
  assert.match(css, /\.footer-shortcuts\s*\{[\s\S]*?overflow:\s*hidden;/u);
  assert.match(css, /\.shortcut-hint\s*\{[\s\S]*?white-space:\s*nowrap;/u);
  assert.match(css, /\.shortcut-hint \+ \.shortcut-hint\s*\{[\s\S]*?var\(--color-border-divider\)/u);
  assert.match(html, /<link rel="stylesheet" href="controls\.css"/u, 'keycaps reuse shared control CSS');
});

test('panel chrome is fixed to the native viewport while only results scroll', () => {
  const css = read('src/panel.css');
  const js = read('src/js/panel.js');
  const executableJs = js.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

  assert.match(css, /\.panel\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/u);
  /* `scroll`, not `auto`. Reserving the scrollbar gutter unconditionally is
     what holds every row edge on the panel's single 18px content gutter in
     both the overflowing and the short-list state — with `auto`, a short list
     drops its rows 6px off the grid the moment the scrollbar disappears. The
     inline-end padding is short by exactly the scrollbar's width, and both
     read the same token so the pair cannot drift apart. */
  assert.match(css, /\.items-list\s*\{[\s\S]*?overflow-y:\s*scroll;/u);
  assert.match(
    css,
    /\.items-list\s*\{[\s\S]*?padding-inline-start:\s*var\(--metric-panel-inline\);\s*padding-inline-end:\s*calc\(var\(--metric-panel-inline\)\s*-\s*var\(--metric-list-scrollbar\)\);/u
  );
  assert.match(
    css,
    /\.items-list::-webkit-scrollbar\s*\{[\s\S]*?width:\s*var\(--metric-list-scrollbar\);/u
  );
  assert.doesNotMatch(executableJs, /\.scrollIntoView\(/u);
  assert.match(executableJs, /listEl\.scrollTop\s*[+-]=/u);
});

test('the row reserves visual space for copied content and one semantic type icon', () => {
  const css = read('src/panel.css');
  const js = read('src/js/panel.js');
  const logic = read('src/js/logic.js');

  assert.doesNotMatch(js, /sourceLabel|row-time|relativeTimeAr/u);
  assert.doesNotMatch(css, /\.source-name|\.row-time|\.time\s*\{/u);
  /* Two tracks, not three: v4.1 stopped reserving a column for the actions,
     so the row's whole flexible width belongs to the copied content. */
  assert.match(
    css,
    /\.row\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--metric-content-type-slot-inline\);/u
  );
  assert.match(css, /\.row-preview\s*\{[\s\S]*?min-width:\s*0;/u);
  assert.match(css, /\.row-kind\s*\{[\s\S]*?width:\s*var\(--metric-content-type-slot-inline\);/u);
  assert.match(js, /const presentation = contentTypeIcon\(item\.type\)/u);
  assert.match(js, /kind\.title = `\$\{presentation\.label\} • المصدر: \$\{sourceName\}`/u);
  assert.match(js, /`نوع المحتوى: \$\{presentation\.label\}\. المصدر: \$\{sourceName\}`/u);
  assert.match(
    logic,
    /normalizeArabic\(item\.sourceApp \|\| ''\)\.includes\(q\)/u,
    'source application metadata remains searchable'
  );
  assert.doesNotMatch(js, /source_app_icon|sourceAppIcon|NSWorkspace/u);
});
