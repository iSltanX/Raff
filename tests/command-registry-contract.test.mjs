// Three lists name the same IPC surface: the commands `store.js` invokes, the
// ones `generate_handler!` registers, and the Rust functions marked
// `#[tauri::command]`. A name in one list and not the others is a call Tauri
// rejects at runtime, or a registered command nothing reaches — and the page
// suites cannot see either, because their fake answers whatever it is asked
// (audit 2026-10-21 §٤-ب). This holds the three together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REGISTERED_COMMANDS } from './helpers/panel-harness.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const sorted = (names) => [...names].sort();

const PAGE_COMMANDS = new Set([...read('src/js/store.js').matchAll(/invoke\('([a-z_]+)'/gu)].map((m) => m[1]));

/** `module::name` for each Rust function marked as a command, either spelling. */
function rustCommands() {
  const out = new Set();
  for (const file of readdirSync(path.join(root, 'src-tauri/src')).filter((f) => f.endsWith('.rs'))) {
    const module = file.replace(/\.rs$/u, '');
    for (const m of read(`src-tauri/src/${file}`).matchAll(
      /#\[tauri::command(?:\([^)]*\))?\]\s*pub (?:async )?fn ([a-z_]+)/gu
    )) {
      out.add(`${module}::${m[1]}`);
    }
  }
  return out;
}

test('every registered command is a Rust command, under its own module', () => {
  const main = read('src-tauri/src/main.rs');
  const registered = [...main.match(/generate_handler!\[([^\]]*)\]/u)[1].matchAll(/(\w+::\w+)/gu)].map((m) => m[1]);
  assert.equal(new Set(registered).size, registered.length, 'no command registered twice');
  assert.deepEqual(sorted(registered), sorted(rustCommands()));
});

test('the pages invoke exactly the registered commands', () => {
  assert.ok(PAGE_COMMANDS.size > 40, 'the invoke pattern still matches store.js');
  assert.deepEqual(sorted(PAGE_COMMANDS), sorted(REGISTERED_COMMANDS));
});

test('no page reaches the bridge except through store.js', () => {
  const pages = readdirSync(path.join(root, 'src/js')).filter((f) => f.endsWith('.js') && f !== 'store.js' && f !== 'mock.js');
  for (const page of pages) {
    assert.doesNotMatch(read(`src/js/${page}`), /\binvoke\(/u, `${page} calls invoke directly`);
  }
});
