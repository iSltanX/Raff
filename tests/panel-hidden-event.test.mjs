// «Deferred while hidden» held only for the close button and Escape (audit
// 2026-10-21, F-HIDDEN). Every other way the panel goes away — a paste, a
// click outside it, the hotkey, the menu-bar icon — is Rust concealing the
// NSPanel, and the page heard nothing of it: it kept `isShown` true and
// fetched and rebuilt the whole list on every copy made in another app, for
// a panel nobody could see. Rust now says `panel://hidden` wherever it
// conceals a shown panel, and the page listens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { emptyState, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelRs = readFileSync(path.join(here, '../src-tauri/src/panel.rs'), 'utf8');

/** The body of a top-level Rust function in panel.rs. */
function rustFn(name) {
  const start = panelRs.search(new RegExp(`\\nfn ${name}\\(|\\npub fn ${name}\\(`, 'u'));
  assert.ok(start >= 0, `fn ${name}`);
  return panelRs.slice(start, panelRs.indexOf('\n}\n', start));
}

test('Rust tells the page whenever it conceals a shown panel', () => {
  // Every conceal outside setup goes through the one function that says so.
  const sites = [...panelRs.matchAll(/\bconceal\(&?panel\)/gu)].length;
  assert.equal(sites, 2, 'init, and hide_shown');
  assert.match(rustFn('init'), /\bconceal\(&panel\)/u);
  const hideShown = rustFn('hide_shown');
  assert.match(hideShown, /\bconceal\(panel\);[^]*emit_to\(PANEL_LABEL, "panel:\/\/hidden"/u);
  for (const caller of ['hide', 'toggle']) {
    assert.match(rustFn(caller), /\bhide_shown\(/u, `${caller} hides through hide_shown`);
  }
});

test('panel: a native hide stops the refetches until it is shown again', async () => {
  const state = { ...emptyState(), history: [sampleItem('a')] };
  const { fake, uncaught } = await mountPanel(state);
  fake.emit('panel://shown', null);
  await flush(6);

  fake.emit('panel://hidden', null);
  await flush(2);
  const before = fake.getStateCallCount();
  fake.emit('raff://changed', null);
  fake.emit('raff://changed', null);
  await flush(4);
  assert.equal(fake.getStateCallCount(), before, 'no fetch for a panel nobody can see');

  fake.emit('panel://shown', null);
  await flush(6);
  assert.equal(fake.getStateCallCount(), before + 1, 'one sync when it is shown again');

  fake.emit('raff://changed', null);
  await flush(4);
  assert.equal(fake.getStateCallCount(), before + 2, 'and shown, it follows changes again');
  assert.deepEqual(uncaught, []);
});
