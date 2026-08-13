// The native half of "copy → paste → keep on the clipboard".
//
// These two invariants cannot be unit-tested in Rust without a live
// NSPasteboard and a real frontmost application, so they are guarded at the
// source level — the same approach image-thumbnail-contract.test.mjs uses for
// monitor.rs. They are cheap, and each one protects a behaviour a user would
// notice immediately if it regressed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

test('the chosen item STAYS on the clipboard after being pasted', () => {
  const paste = read('src-tauri/src/paste.rs');

  // The whole point of the action: ⌘V immediately afterwards must paste the
  // same thing again. Any "save the old pasteboard and put it back" logic
  // would silently break that, so no such restore may exist.
  assert.doesNotMatch(
    paste,
    /restore_(?:previous_)?clip|previous_clip|saved_pasteboard|restore_pasteboard/u,
    'paste.rs must never restore a previous pasteboard — the chosen item stays current'
  );

  // The item is written before anything else is attempted, so a failure to
  // synthesize ⌘V still leaves the user with the item on their clipboard.
  const body = paste.slice(paste.indexOf('pub async fn paste_item'));
  const writeAt = body.indexOf('write_item_to_clipboard');
  const axAt = body.indexOf('ax_trusted');
  assert.ok(writeAt >= 0 && axAt >= 0, 'paste_item must write the clip and check Accessibility');
  assert.ok(
    writeAt < axAt,
    'the clipboard write must happen BEFORE the Accessibility check, so copy never depends on permission'
  );
});

test('writing our own item back does not create a duplicate history entry', () => {
  const paste = read('src-tauri/src/paste.rs');
  const monitor = read('src-tauri/src/monitor.rs');

  // Raff re-writes a historical item to the pasteboard, which its own monitor
  // would otherwise observe as a brand-new copy and re-record.
  assert.match(
    paste,
    /skip_change_count\s*\n?\s*\.store\(/u,
    'the pasteboard write must record its change count for the monitor to skip'
  );
  assert.match(
    monitor,
    /skip_change_count\.swap\(-1, Ordering::SeqCst\) == count as i64/u,
    'the monitor must skip exactly the change count Raff produced, once'
  );
});

test('the full pasteboard payload is restored, not flattened to text', () => {
  const paste = read('src-tauri/src/paste.rs');

  // A link, rich text or an image must arrive in the target app as that
  // thing. `plain` is the explicit opt-out (⌥⏎ / ⌥click), not the default.
  assert.match(
    paste,
    /macos::write_clip\(\s*\n?\s*if is_image \{ None \} else \{ Some\(&text\) \},\s*\n?\s*html\.as_deref\(\),\s*\n?\s*rtf\.as_deref\(\),\s*\n?\s*png\.as_deref\(\),/u,
    'text, html, rtf and png representations must all be offered to the pasteboard'
  );
  assert.match(
    paste,
    /if plain \{\s*\n\s*\(item\.kind, item\.text\.clone\(\), None, None, png\)/u,
    'only the explicit plain-text mode drops the rich representations'
  );
});
