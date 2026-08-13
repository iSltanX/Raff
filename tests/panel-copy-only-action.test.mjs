// ⌘C is the secondary action: copy WITHOUT pasting.
//
// Its own file because `src/js/panel.js` is a per-process module singleton —
// see the note in helpers/panel-harness.mjs — so each fresh mount needs its
// own file. The primary click/Enter action is covered in
// panel-primary-action.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountPanel, sampleItem, flush } from './helpers/panel-harness.mjs';

test('⌘C copies the selected item without pasting it', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('r1'), sampleItem('r2')],
    settings: null,
    axTrusted: true,
  });

  // Select without choosing.
  dom.window.document.getElementById('search').blur();
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  );
  await flush(2);

  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      code: 'KeyC',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  await flush(6);

  assert.equal(fake.invokeCount('copy_item'), 1, 'copy-only is still reachable');
  assert.equal(fake.invokeCount('paste_item'), 0, 'and it must never paste');
});
