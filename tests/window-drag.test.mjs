// Every secondary window draws its own content under a native overlay title
// bar (commands.rs: TitleBarStyle::Overlay), so the webview covers the strip
// macOS would drag by. A window moves only where its page marks a drag region
// AND its capability allows starting a native drag. The welcome and the update
// windows had neither and could not be moved at all (live UI audit, 9.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const capabilities = readdirSync(path.join(root, 'src-tauri/capabilities'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(read(`src-tauri/capabilities/${file}`)));
const mayDrag = (label) =>
  capabilities.some((cap) => cap.windows.includes(label) && cap.permissions.includes('core:window:allow-start-dragging'));

for (const label of ['settings', 'about', 'report', 'firstrun', 'update']) {
  test(`${label}: the window can be dragged by its title bar`, () => {
    assert.match(read(`src/${label}.html`), /data-tauri-drag-region/u, 'the page marks a drag region');
    assert.ok(mayDrag(label), 'and may start a native drag');
  });
}

test('the welcome and update drag strip spans the title bar, above the splash', () => {
  for (const label of ['firstrun', 'update']) {
    assert.match(read(`src/${label}.html`), /<div class="title-drag" data-tauri-drag-region aria-hidden="true"><\/div>/u, label);
  }
  const strip = read('src/controls.css').match(/\.title-drag\s*\{([^}]*)\}/u)?.[1] ?? '';
  assert.match(strip, /position:\s*fixed;/u);
  assert.match(strip, /height:\s*28px;/u);
  const z = Number(strip.match(/z-index:\s*(\d+);/u)?.[1]);
  const splash = Number(read('src/firstrun.css').match(/\.splash\s*\{[^}]*z-index:\s*(\d+);/u)?.[1]);
  assert.ok(z > splash, 'the splash never covers it');
});

test('dragging is the only power the strip adds', () => {
  const strip = capabilities.find((cap) => cap.windows.includes('firstrun') && cap.permissions.includes('core:window:allow-start-dragging'));
  assert.deepEqual(strip.permissions, ['core:window:allow-start-dragging']);
});
