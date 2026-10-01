// What رفّ promises about the network has to stay true. Once a report can be
// sent — only after the user previews and confirms it — "local-only" and "the
// only connection is the update check" stop being accurate, wherever they are
// written. Clipboard content still never leaves the machine; that promise stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');
// Booleans, not `doesNotMatch(longText, …)`: a failed assertion carrying a whole
// README as `actual` stalls node 20's TAP reporter for minutes.
const absent = (text, pattern, where) => assert.ok(!pattern.test(text), `${where} still says ${pattern}`);
const present = (text, pattern, where) => assert.ok(pattern.test(text), `${where} no longer says ${pattern}`);

test('no surface claims رفّ never uses the network', () => {
  const readme = read('README.md');
  absent(readme, /الاتصال الوحيد هو التحقق من التحديثات/u, 'README privacy line');
  absent(readme, /badge\/local--only/u, 'README badge');

  absent(read('src/firstrun.html'), /لا يُغادر شيء من بياناتك جهازك/u, 'welcome');
  absent(read('src/js/diag.js'), /zero-network/u, 'diag.js comment');
  absent(read('src-tauri/src/main.rs'), /zero network/iu, 'main.rs header');

  absent(JSON.parse(read('package.json')).description, /local-only/u, 'package.json');
  const cargoDescription = read('src-tauri/Cargo.toml').match(/^description = "([^"]*)"/mu)?.[1] ?? '';
  absent(cargoDescription, /local-only/u, 'Cargo.toml');
});

test('the clipboard promise itself is still made', () => {
  present(read('README.md'), /ما تنسخه لا يغادر جهازك/u, 'README');
});
