// A test run of رفّ (ت٤٨): beside the Rust gate, every page gets a script
// before its own that keeps WebKit's native copy, cut and paste away from the
// system clipboard — the keys, the events, and the native context menu that
// offers them. رفّ's own handlers still see the keys (⌘C asks Rust, which
// says the clipboard is off), and its own right-click still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(path.join(here, '../src-tauri/src/inert_clipboard.js'), 'utf8');

function page() {
  const dom = new JSDOM('<input id="field"><div id="row"></div>', { runScripts: 'outside-only' });
  dom.window.eval(script); // as `js_init_script` runs it: before the page's own
  return dom;
}

const key = (w, code, mods = { metaKey: true }) =>
  new w.KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), bubbles: true, cancelable: true, ...mods });

test('⌘C, ⌘X and ⌘V do not reach WebKit, on any layout', () => {
  const dom = page();
  const field = dom.window.document.getElementById('field');
  for (const code of ['KeyC', 'KeyX', 'KeyV']) {
    for (const mods of [{ metaKey: true }, { metaKey: true, shiftKey: true }]) {
      const press = key(dom.window, code, mods);
      field.dispatchEvent(press);
      assert.equal(press.defaultPrevented, true, `${code} ${JSON.stringify(mods)}`);
    }
  }
});

test('the page still hears them, and every other key is left alone', () => {
  const dom = page();
  const heard = [];
  dom.window.addEventListener('keydown', (e) => heard.push(e.code));
  const field = dom.window.document.getElementById('field');
  for (const [code, mods] of [
    ['KeyC', { metaKey: true }],
    ['KeyA', { metaKey: true }],
    ['KeyV', {}],
    ['KeyV', { metaKey: true, altKey: true }],
  ]) {
    const press = key(dom.window, code, mods);
    field.dispatchEvent(press);
    if (code !== 'KeyC') assert.equal(press.defaultPrevented, false, `${code} ${JSON.stringify(mods)}`);
  }
  assert.deepEqual(heard, ['KeyC', 'KeyA', 'KeyV', 'KeyV']);
});

test('copy, cut and paste events are cancelled before any page listener reads them', () => {
  const dom = page();
  let reached = 0;
  dom.window.addEventListener('paste', () => (reached += 1));
  dom.window.document.addEventListener('copy', () => (reached += 1), true);
  const field = dom.window.document.getElementById('field');
  for (const type of ['copy', 'cut', 'paste']) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, type);
  }
  assert.equal(reached, 0, 'no page listener ran');
});

test('no native context menu, yet رفّ’s own right-click still runs', () => {
  const dom = page();
  let opened = 0;
  dom.window.addEventListener('contextmenu', () => (opened += 1));
  const menu = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  dom.window.document.getElementById('row').dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true, 'WebKit offers no Copy or Paste');
  assert.equal(opened, 1, 'the preview still opens');
});
