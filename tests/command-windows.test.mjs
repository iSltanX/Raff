// Rust refuses a command called from a window its table does not name
// (`src-tauri/src/access.rs`, audit 014). This test reads that table and every
// page's calls, so a page that starts calling a command its window may not —
// or a table entry that drops a window still calling it — fails here, not in
// the app as a silent «raff/wrong-window».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

/** The window label each page runs in, and its entry script. */
const PAGES = {
  panel: 'src/js/panel.js',
  settings: 'src/js/settings.js',
  firstrun: 'src/js/firstrun.js',
  about: 'src/js/about.js',
  update: 'src/js/update.js',
  report: 'src/js/report.js',
};

/** `api.method` → command, from the one IPC layer every page shares. */
const API = Object.fromEntries(
  [...read('src/js/store.js').matchAll(/^ {2}(\w+): \([^)]*\) =>\s*invoke\('([a-z_]+)'/gmu)].map(
    (m) => [m[1], m[2]]
  )
);

/** The scripts a page loads: its entry and what it imports, transitively. */
function scripts(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const m of read(entry).matchAll(/^import .* from '\.\/([\w-]+\.js)';/gmu)) {
    if (m[1] !== 'store.js' && m[1] !== 'mock.js') scripts(`src/js/${m[1]}`, seen);
  }
  return seen;
}

/** The commands a page can call: every `.method(` of the API in its scripts. */
function pageCommands(entry) {
  const calls = new Set();
  for (const file of scripts(entry)) {
    const source = read(file);
    for (const [method, command] of Object.entries(API)) {
      if (new RegExp(`\\.\\s*${method}\\s*(\\?\\.)?\\(`, 'u').test(source)) calls.add(command);
    }
  }
  return calls;
}

/** The Rust table: command → windows, and the commands open to all. */
function rustTable() {
  const source = read('src-tauri/src/access.rs');
  const windows = new Map();
  const table = source.slice(source.indexOf('pub const WINDOWS'), source.indexOf('pub const OPEN'));
  for (const m of table.matchAll(/\("([a-z_]+)",\s*&\[([^\]]*)\]\)/gu)) {
    windows.set(m[1], [...m[2].matchAll(/"([a-z]+)"/gu)].map((w) => w[1]));
  }
  const openBlock = source.slice(source.indexOf('pub const OPEN'));
  const open = new Set(
    [...openBlock.slice(0, openBlock.indexOf('];')).matchAll(/"([a-z_]+)"/gu)].map((m) => m[1])
  );
  return { windows, open };
}

test('the table and the store agree on what exists', () => {
  const { windows, open } = rustTable();
  assert.ok(windows.size > 30, `read ${windows.size} rows`);
  for (const command of Object.values(API)) {
    assert.ok(windows.has(command) || open.has(command), `${command} is in neither list`);
  }
});

for (const [label, entry] of Object.entries(PAGES)) {
  test(`every command the ${label} window calls is one it may call`, () => {
    const { windows, open } = rustTable();
    const calls = pageCommands(entry);
    assert.ok(calls.size > 0, `${label} calls nothing?`);
    for (const command of calls) {
      if (open.has(command)) continue;
      assert.ok(
        windows.get(command)?.includes(label),
        `${label} calls ${command}, which only ${windows.get(command)?.join(', ') ?? 'no window'} may call`
      );
    }
  });
}

test('a page calling a command its window may not is caught', () => {
  const { windows } = rustTable();
  assert.ok(!windows.get('get_state').includes('report'));
  assert.ok(!windows.get('paste_item').includes('settings'));
  assert.ok(pageCommands('src/js/panel.js').has('get_state'));
  assert.ok(!pageCommands('src/js/report.js').has('get_state'));
});
