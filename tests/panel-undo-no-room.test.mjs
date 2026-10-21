// An undo the history no longer has room for (017, م٢): the deleted item
// would be the one to leave the moment it came back. The panel says so — not
// «حاول مرة أخرى», which would promise a retry that cannot work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('panel: an undo with no room left says why', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1'), sampleItem('h2')],
    settings: { captureEnabled: true, hotkey: 'shift+super+v' },
    axTrusted: true,
  });
  const doc = dom.window.document;
  fake.failCommand('undo_delete', 'raff/undo-no-room');
  click(dom, doc.querySelector('#list .row[data-id="h1"] .delete-btn'));
  await flush(6);
  click(dom, doc.getElementById('toast-undo'));
  await flush(8);
  assert.match(doc.getElementById('toast-message').textContent, /لم يعد في سجلّك متّسع لهذا العنصر/u);
});
