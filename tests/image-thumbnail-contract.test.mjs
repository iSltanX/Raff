import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (file) => readFileSync(path.join(project, file), 'utf8');

test('native and CSS thumbnail contracts agree at 2x without cropping', () => {
  const monitor = read('src-tauri/src/monitor.rs');
  assert.match(monitor, /const THUMB_MAX_W: u32 = 272;/u);
  assert.match(monitor, /const THUMB_MAX_H: u32 = 144;/u);
  assert.match(monitor, /decoded\.thumbnail\(THUMB_MAX_W, THUMB_MAX_H\)/u);

  const css = read('src/panel.css');
  assert.match(css, /\.preview-thumb\s*\{[^}]*width:\s*136px;[^}]*height:\s*72px;/su);
  assert.match(css, /\.preview-thumb img\s*\{[^}]*object-fit:\s*contain;/su);
  assert.doesNotMatch(css, /\.preview-thumb img\s*\{[^}]*object-fit:\s*cover;/su);
});

test('image rows expose a designed loading/fallback surface', () => {
  const panel = read('src/js/panel.js');
  assert.match(panel, /placeholder\.append\(createIcon\(IMAGE, 'preview-thumb-icon'\)\)/u);
  assert.match(panel, /thumb\.dataset\.state = 'loading'/u);
  assert.match(panel, /thumb\.dataset\.state = 'ready'/u);
  assert.match(panel, /thumb\.dataset\.state = 'unavailable'/u);

  const css = read('src/panel.css');
  assert.match(css, /\.preview-thumb-placeholder\s*\{/u);
  assert.match(css, /\.preview-thumb\[data-state='ready'\] img\s*\{[^}]*opacity:\s*1;/su);
});
