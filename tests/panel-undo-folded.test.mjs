// An undo that folds into a newer copy (017, م٢): the text was deleted, then
// copied again inside the undo window, so the backend keeps the new row and
// does not bring the old one back. The panel shows what the backend kept —
// not the deleted row painted back over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, minutesAgo, mountPanel, rowIds, sampleItem } from './helpers/panel-harness.mjs';

test('panel: an undo folded into a newer copy leaves no ghost row', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1', { text: 'نفس النص', createdAt: minutesAgo(1) }), sampleItem('h2', { createdAt: minutesAgo(2) })],
    settings: { captureEnabled: true, hotkey: 'shift+super+v' },
    axTrusted: true,
  });
  const doc = dom.window.document;
  click(dom, doc.querySelector('#list .row[data-id="h1"] .delete-btn'));
  await flush(6);

  // Copied again in the undo window: the backend now holds c1, and the undo
  // folds h1 into it.
  fake.respond('undo_delete', (_args, state) => {
    state.history = [sampleItem('c1', { text: 'نفس النص', copyCount: 2, createdAt: Date.now() }), ...state.history.filter((i) => i.id !== 'h1')];
    // As Rust answers: the id of the row that now stands for the item.
    return 'c1';
  });
  click(dom, doc.getElementById('toast-undo'));
  await flush(10);
  assert.deepEqual(rowIds(dom), ['c1', 'h2'], 'one row for the text, the one the backend kept');
  // ت٤٥ ب٦: the undone item is selected, as an undo selects — here as the
  // row it was folded into, not as nothing because its own id is gone.
  assert.deepEqual(
    [...doc.querySelectorAll('.row.selected')].map((row) => row.dataset.id),
    ['c1'],
    'the row it was folded into is selected'
  );
});
