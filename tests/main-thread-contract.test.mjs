// A `#[tauri::command]` that is neither `async fn` nor `(async)` runs on the
// main thread, which draws every window and the menu-bar icon. The panel's
// delete, undo, final delete and pin each write a journal (flushed to the
// device) and a whole layer before they return — at half the history limit
// that was 44–53 ms measured on an idle internal disk, and up to 213 ms on a
// loaded machine (audit 2026-10-21, F-MAINTHREAD-COST). They run off the main
// thread now; the panel already sends them one at a time (`enqueueMutation`),
// so leaving the main thread does not reorder them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

/** name → whether the command leaves the main thread. */
function commandThreads(source) {
  const threads = new Map();
  for (const m of source.matchAll(/#\[tauri::command(\(async\))?\]\s*pub (async )?fn ([a-z_]+)/gu)) {
    threads.set(m[3], Boolean(m[1] || m[2]));
  }
  return threads;
}

test('the panel’s delete, undo, final delete and pin leave the main thread', () => {
  const threads = commandThreads(read('src-tauri/src/commands.rs'));
  for (const name of ['delete_item', 'undo_delete', 'commit_delete', 'toggle_pin']) {
    assert.equal(threads.get(name), true, `${name} runs off the main thread`);
  }
});

// IMP-01, measured (evidence/2026-10-22-m8): the deep search over the
// largest history رفّ keeps took 256–295 ms per keystroke in release, on the
// main thread, with the store locked throughout. It leaves the main thread,
// and holds the lock only to copy the rows out (~2 ms).
test('the deep search leaves the main thread and the store lock', () => {
  const rust = read('src-tauri/src/commands.rs');
  assert.equal(commandThreads(rust).get('search_items'), true, 'search_items runs off the main thread');
  const body = rust.slice(rust.indexOf('pub async fn search_items('), rust.indexOf('fn matching_ids('));
  const locked = body.indexOf('lock_store');
  const searched = body.indexOf('spawn_blocking');
  assert.ok(locked > 0 && searched > locked, 'the rows are copied out, then searched elsewhere');
  assert.doesNotMatch(body.slice(searched), /lock_store/u, 'and not under the lock');
});

test('and the panel still sends them one at a time', () => {
  const panel = read('src/js/panel.js');
  for (const call of ['api.deleteItem(', 'api.undoDelete(', 'api.commitDelete(', 'api.togglePin(']) {
    let at = panel.indexOf(call);
    assert.ok(at >= 0, call);
    for (; at >= 0; at = panel.indexOf(call, at + 1)) {
      // The enclosing task: the nearest enqueueMutation before the call, with
      // no function declaration in between other than finalizeActiveDelete,
      // which only ever runs inside one.
      const before = panel.slice(0, at);
      const queued = before.lastIndexOf('enqueueMutation(async () => {');
      const fn = before.lastIndexOf('\nasync function ');
      const inFinalize = before.slice(fn).startsWith('\nasync function finalizeActiveDelete');
      assert.ok(queued > fn || inFinalize, `${call} at ${at} is inside the mutation queue`);
    }
  }
  assert.match(panel, /enqueueMutation\(async \(\) => \{\s*await finalizeActiveDelete\(\);/u);
});
