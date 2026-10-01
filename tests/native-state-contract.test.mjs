// Native decisions the webview cannot observe, held at the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');
// Booleans keep a failure's output short (see privacy-promises.test.mjs).
const has = (text, pattern) => pattern.test(text);

test('the welcome opens on first run whether or not Accessibility is already granted', () => {
  // The capture decision is independent of the paste permission. Gating the
  // window on a missing permission meant a reinstall with the permission still
  // granted never asked whether to capture at all.
  assert.ok(!has(read('src-tauri/src/main.rs'), /first_run_pending\s*&&\s*!macos::ax_trusted\(\)/u), 'main.rs gates the welcome on a missing permission');
});

test('the menu-bar icon reflects capture the user turned off', () => {
  const tray = read('src-tauri/src/tray.rs');
  assert.ok(has(tray, /pub fn note_capture_enabled\(/u), 'tray knows the capture setting');
  const commands = read('src-tauri/src/commands.rs');
  assert.ok(has(commands, /tray::note_capture_enabled\(/u), 'and is told when it changes');
  const main = read('src-tauri/src/main.rs');
  assert.ok(has(main, /tray::note_capture_enabled\(/u), 'and on launch');
});
