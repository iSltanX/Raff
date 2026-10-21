// The harness has to fail loudly where it used to pass quietly (audit
// 2026-10-21, F-MODCACHE and §٤-ب):
//
// - `panel.js` is an ES module, cached per process, so a second `mountPanel`
//   in one file never re-ran it: nothing was drawn, the second fake was never
//   asked anything, and every negative assertion after it held vacuously.
// - The fake answered `null` to any command it did not know, where Tauri
//   rejects an unregistered one — a misspelt or new command passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeTauri, emptyState, mountPanel, rowIds, sampleItem, flush } from './helpers/panel-harness.mjs';

test('a second mount in one file is refused, not silently inert', async () => {
  const state = emptyState();
  state.history.push(sampleItem('a1'));
  const { dom } = await mountPanel(state);
  await flush(6);
  assert.deepEqual(rowIds(dom), ['a1']);
  await assert.rejects(mountPanel(emptyState()), /once per test file/u);
});

test('a command the app does not register is rejected, as Tauri rejects it', async () => {
  const fake = createFakeTauri(emptyState());
  await assert.rejects(fake.tauri.core.invoke('get_stat'), /get_stat not found/u);
  assert.equal(await fake.tauri.core.invoke('hide_panel'), null, 'a registered command still answers');
});
