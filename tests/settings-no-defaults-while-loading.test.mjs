// ت٤٠: until Settings has read the user's preferences, its controls hold the
// page's own defaults — capture on, appearance «تلقائي», 500 items. Shown
// while loading, or under a load that failed, they read as the user's
// settings. The body stays out of sight while the window is busy; the load
// line says what is happening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

test('the settings body is not shown while the window is busy', () => {
  const css = read('src/settings.css').replace(/\/\*[^]*?\*\//gu, '');
  const rule = css.match(
    /\.settings-window\[aria-busy=['"]true['"]\]\s+\.settings-body\s*\{([^}]*)\}/u
  );
  assert.ok(rule, 'a rule for the busy window’s body');
  assert.match(rule[1], /visibility:\s*hidden/u);
  // And the window starts busy, so the first paint is covered too.
  assert.match(read('src/settings.html'), /id="settings-window" aria-busy="true"/u);
});
