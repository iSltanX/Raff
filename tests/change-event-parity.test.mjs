// `raff://changed` is how the app tells its pages that what they show is
// stale. A stand-in that answers a command without announcing the change the
// app would announce lets a page test pass on a state the app never reaches
// — the selection after a paste, for one (verification of audit 012). Both
// stand-ins, the panel harness and the browser mock, announce exactly what
// Rust announces, and the list of what Rust announces is read from Rust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFakeTauri, emptyState, flush, sampleItem } from './helpers/panel-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

/** Every command a page can call, from the one IPC layer they all share. */
const PAGE_COMMANDS = [
  ...new Set([...read('src/js/store.js').matchAll(/invoke\('([a-z_]+)'/gu)].map((m) => m[1])),
];

const RUST_FILES = readdirSync(path.join(here, '../src-tauri/src')).filter((f) => f.endsWith('.rs'));

/**
 * The commands whose success Rust follows with `raff://changed`. `source`
 * gives a Rust file's text, so a test can hand it an edited copy.
 */
function rustAnnounces(source = (file) => read(`src-tauri/src/${file}`)) {
  const commands = source('commands.rs');
  const announced = new Set();
  // Every module, not just commands.rs: a command added elsewhere that
  // announces directly is caught too.
  for (const file of RUST_FILES) {
    // Both spellings: `#[tauri::command]` and `#[tauri::command(async)]`.
    for (const block of source(file).split(/#\[tauri::command(?:\([^)]*\))?\]/u).slice(1)) {
      const name = block.match(/pub (?:async )?fn ([a-z_]+)/u)[1];
      const body = block.slice(0, block.search(/\n\}\n/u));
      if (/\bnotify\(&app\)|emit\("raff:\/\/changed"/u.test(body)) announced.add(name);
    }
  }

  // Four announce on the way through another function; each path is checked
  // so the list cannot outlive the code it describes.
  const paste = source('paste.rs');
  const bump = paste.slice(paste.indexOf('fn bump_signals'));
  assert.match(bump.slice(0, bump.indexOf('\n}\n')), /emit\("raff:\/\/changed"/u, 'a counted use announces');
  assert.match(paste, /pub async fn paste_item[^]*?bump_paste_signals\(/u);
  assert.match(commands, /pub (?:async )?fn copy_item[^]*?paste::bump_copy_signals\(/u);
  announced.add('paste_item');
  announced.add('copy_item');

  const tray = source('tray.rs');
  const setPause = tray.slice(tray.indexOf('fn set_pause'));
  assert.match(setPause.slice(0, setPause.indexOf('\n}\n')), /emit\("raff:\/\/changed"/u);
  assert.match(tray, /pub fn resume_capture\(\) \{\s*set_pause\(/u);
  // After its window check (`access`), the command is the tray's path.
  assert.match(
    commands,
    /pub (?:async )?fn resume_capture\([^)]*\)[^{]*\{\s*crate::access::require\(&window, "resume_capture"\)\?;\s*crate::tray::resume_capture\(\)/u
  );
  announced.add('resume_capture');

  // The settings command checks its window, then hands over to the path the
  // menu bar takes too.
  const apply = commands.slice(commands.indexOf('fn apply_settings('));
  assert.match(apply.slice(0, apply.indexOf('\n}\n')), /\bnotify\(&app\)/u, 'saved settings announce');
  assert.match(
    commands,
    /pub fn update_settings\([^)]*\)[^{]*\{\s*crate::access::require\(&window, "update_settings"\)\?;\s*if !crate::access::patch_allowed\([^}]*\}\s*apply_settings\(/u
  );
  announced.add('update_settings');
  return announced;
}

const ANNOUNCED = rustAnnounces();

test('a command moved off the main thread is still read as announcing', () => {
  // `#[tauri::command(async)]` and `pub async fn` are how a command leaves the
  // main thread. Neither may drop it from the list: the list would then fail
  // with a diff that says the command stopped announcing, and a new command
  // written that way would never be asked of the stand-ins at all.
  const offMain = (text) =>
    text
      .replace(/#\[tauri::command\]\n(pub fn (?:delete_item|toggle_pin|undo_delete|clear_history))\b/gu, '#[tauri::command(async)]\n$1')
      .replace(/#\[tauri::command\]\npub fn (copy_item|reorder_pinned)\b/gu, '#[tauri::command]\npub async fn $1');
  const edited = read('src-tauri/src/commands.rs');
  assert.notEqual(offMain(edited), edited, 'the edit reaches the commands it names');
  const moved = rustAnnounces((file) => {
    const text = read(`src-tauri/src/${file}`);
    return file === 'commands.rs' ? offMain(text) : text;
  });
  assert.deepEqual([...moved].sort(), [...ANNOUNCED].sort());
});

test('the list read from Rust is the one this suite expects', () => {
  assert.deepEqual(
    [...ANNOUNCED].sort(),
    [
      'clear_history',
      'clear_learning',
      'copy_item',
      'delete_item',
      'paste_item',
      'reorder_pinned',
      'resume_capture',
      'toggle_pin',
      'undo_delete',
      'update_settings',
    ]
  );
  for (const command of ANNOUNCED) assert.ok(PAGE_COMMANDS.includes(command), `${command} is callable`);
});

/** Arguments that make each command succeed on the fixtures below. */
const ARGS = {
  toggle_pin: { id: 'h1', isPinned: true },
  delete_item: { id: 'h2' },
  paste_item: { id: 'h1', plain: false },
  copy_item: { id: 'h1' },
  reorder_pinned: { ids: ['p1'] },
  update_settings: { settings: { historyLimit: 400 } },
  search_items: { query: 'item' },
  get_image: { id: 'h1' },
  report_prepare: { kind: 'problem', category: 'other', description: 'وصف' },
};

function harnessFixture(settings = { learningEnabled: true }) {
  return {
    ...emptyState(),
    settings,
    pinned: [sampleItem('p1', { isPinned: true, pinnedOrder: 0 })],
    history: [sampleItem('h1'), sampleItem('h2')],
  };
}

async function harnessEvents(command, { settings, args = ARGS[command] ?? {} } = {}) {
  const fake = createFakeTauri(harnessFixture(settings));
  let events = 0;
  await fake.tauri.event.listen('raff://changed', () => {
    events += 1;
  });
  let callArgs = args;
  if (command === 'undo_delete') {
    const { token } = await fake.tauri.core.invoke('delete_item', { id: 'h2' });
    callArgs = { token };
    events = 0;
  }
  await fake.tauri.core.invoke(command, callArgs);
  await flush();
  return events;
}

test('the panel harness announces after exactly the commands Rust does', async () => {
  const wrong = [];
  for (const command of PAGE_COMMANDS) {
    const events = await harnessEvents(command);
    const expected = ANNOUNCED.has(command) ? 1 : 0;
    if (events !== expected) wrong.push(`${command}: ${events} (Rust: ${expected})`);
  }
  assert.deepEqual(wrong, []);
});

test('the harness: a use is announced only when learning counts it', async () => {
  // `count_use` changes nothing with learning off, or for an id it cannot
  // find, and then `bump_signals` returns before it emits.
  for (const command of ['paste_item', 'copy_item']) {
    assert.equal(await harnessEvents(command, { settings: { learningEnabled: false } }), 0, command);
    assert.equal(await harnessEvents(command, { settings: null }), 1, `${command}: learning is on by default`);
  }
});

test('the harness: a command that fails announces nothing', async () => {
  const fake = createFakeTauri(harnessFixture());
  let events = 0;
  await fake.tauri.event.listen('raff://changed', () => {
    events += 1;
  });
  fake.failCommand('reorder_pinned', 'raff/save-failed');
  await assert.rejects(fake.tauri.core.invoke('reorder_pinned', { ids: ['p1'] }));
  await assert.rejects(fake.tauri.core.invoke('toggle_pin', { id: 'missing', isPinned: true }));
  await flush();
  assert.equal(events, 0);
});

test('the browser mock announces after exactly the commands Rust does', async () => {
  globalThis.window = { innerWidth: 900 };
  const { mockInvoke, mockListen } = await import('../src/js/mock.js');
  let events = 0;
  await mockListen('raff://changed', () => {
    events += 1;
  });
  // The mock keeps one shelf for the whole page, so the commands run in an
  // order that leaves each one something to act on.
  const MOCK_ARGS = {
    ...ARGS,
    toggle_pin: { id: 'r1', isPinned: true },
    delete_item: { id: 'r2' },
    paste_item: { id: 'r3', plain: false },
    copy_item: { id: 'r3' },
    get_image: { id: 'r3' },
    search_items: { query: 'رفّ' },
  };
  const order = [...PAGE_COMMANDS].sort(
    (a, b) => (a === 'clear_history') - (b === 'clear_history')
  );
  const wrong = [];
  for (const command of order) {
    let args = MOCK_ARGS[command] ?? {};
    if (command === 'undo_delete') {
      const { token } = await mockInvoke('delete_item', { id: 'r4' });
      args = { token };
    }
    if (command === 'reorder_pinned') {
      args = { ids: (await mockInvoke('get_state')).pinned.map((item) => item.id).reverse() };
    }
    events = 0;
    await mockInvoke(command, args);
    await flush();
    const expected = ANNOUNCED.has(command) ? 1 : 0;
    if (events !== expected) wrong.push(`${command}: ${events} (Rust: ${expected})`);
  }
  assert.deepEqual(wrong, []);
});

test('the hourly retention sweep announces only when a row went', () => {
  // An announcement makes a shown panel fetch and redraw everything; an hour
  // with nothing past its limit has nothing to show (audit 2026-10-21 §٤-هـ).
  const monitor = read('src-tauri/src/monitor.rs');
  const sweeper = monitor.slice(monitor.indexOf('fn start_retention_sweeper'));
  const body = sweeper.slice(0, sweeper.indexOf('\n}\n'));
  assert.match(body, /let trimmed = [^;]*\.trim_history\(\);\s*if trimmed \{\s*let _ = app\.emit\("raff:\/\/changed"/u);
  assert.equal(body.match(/raff:\/\/changed/gu).length, 1);
});
