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
  const report = read('src-tauri/src/report.rs');
  const monitor = read('src-tauri/src/monitor.rs');

  // Raff re-writes a historical item to the pasteboard, which its own monitor
  // would otherwise observe as a brand-new copy and re-record. Every write
  // goes through the gate that records it (monitor.rs tests interleave a poll
  // with a write both ways; F-OWNWRITE, audit 2026-10-21).
  for (const [name, source] of [['paste.rs', paste], ['report.rs', report]]) {
    const writes = source.match(/macos::write_clip\(/gu)?.length ?? 0;
    const gated = source.match(/\.own_writes\s*\n?\s*\.write\(\|\| \{?\s*\n?\s*(?:crate::)?macos::write_clip\(/gu)?.length ?? 0;
    assert.ok(writes > 0, `${name} writes the pasteboard`);
    assert.equal(gated, writes, `${name}: every pasteboard write is recorded through OwnWrites`);
  }
  const look = monitor.slice(monitor.indexOf('fn look('));
  const held = look.indexOf('own.hold()');
  const count = look.indexOf('pb.change_count()');
  assert.ok(held >= 0 && held < count, 'the poll holds the gate before it reads the count');
});

test('a command that writes the clipboard never runs on the main thread', () => {
  // A write can wait for a poll's read to finish (the gate), and an image
  // copy reads a file: neither belongs on the thread that draws every window.
  const sources = ['commands.rs', 'report.rs'].map((f) => read(`src-tauri/src/${f}`));
  const writers = [];
  for (const source of sources) {
    for (const block of source.split(/#\[tauri::command(?:\([^)]*\))?\]/u).slice(1)) {
      const name = block.match(/pub (?:async )?fn ([a-z_]+)/u)[1];
      const body = block.slice(0, block.search(/\n\}\n/u));
      if (/write_item_to_clipboard\(|write_clipboard\(|paste::paste_item\(/u.test(body)) {
        writers.push(name);
        assert.match(block, new RegExp(`pub async fn ${name}\\b`, 'u'), `${name} must be async`);
      }
    }
  }
  assert.deepEqual(writers.sort(), ['copy_item', 'diagnostics_copy', 'paste_item', 'report_copy', 'report_copy_number']);
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
  // Only the explicit text-only forms — «لصق كنص عادي» and «لصق بلا تشكيل»
  // (IMP-06) — drop the rich representations; the default keeps them.
  assert.match(
    paste,
    /if form == Form::Bare \{\s*\n\s*\(item\.kind, without_tashkeel\(&item\.text\), None, None, image\)/u,
    'the bare form drops them and the tashkeel'
  );
  assert.match(
    paste,
    /\} else if form == Form::Plain \{\s*\n\s*\(item\.kind, item\.text\.clone\(\), None, None, image\)/u,
    'the plain form drops them'
  );
  assert.match(paste, /\(item\.kind, item\.text\.clone\(\), item\.html\.clone\(\), rtf, image\)/u, 'the rich form keeps them');
});
