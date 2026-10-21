// Audit 010: a deleted item's toast is its receipt — five seconds of «تراجع»,
// then the delete is committed. Every other message waits behind it in one
// lane (`deliverFeedback`). The pinned-shelf reorder's failure did not: it
// drew its error over the receipt, which cleared the receipt's timer while
// the delete stayed pending — no «تراجع» on screen, no commit, and ⌘Z still
// armed for an item the user could no longer see being offered back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

test('a failed reorder waits behind a delete receipt instead of erasing it', async () => {
  const pinned = (id, order) => sampleItem(id, { isPinned: true, pinnedOrder: order });
  const { dom, fake } = await mountPanel({
    pinned: [pinned('p1', 0), pinned('p2', 1), pinned('p3', 2)],
    history: [],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const toast = () => ({
    message: doc.getElementById('toast-message').textContent,
    undo: !doc.getElementById('toast-undo').hidden,
  });

  click(dom, doc.querySelector('[data-filter="pinned"]'));
  await flush(5);
  selectRowByKeyboard(dom, 'p3');
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, bubbles: true, cancelable: true })
  );
  await flush(10);
  assert.equal(fake.invokeCount('delete_item'), 1);
  assert.deepEqual(toast(), { message: 'تم حذف العنصر', undo: true }, 'the receipt');

  fake.failCommand('reorder_pinned', 'raff/save-failed');
  click(dom, doc.querySelector('.row[data-id="p1"] .move-down'));
  await flush(10);
  assert.equal(fake.invokeCount('reorder_pinned'), 1);
  assert.deepEqual(toast(), { message: 'تم حذف العنصر', undo: true }, 'still the receipt');

  // Undo settles the receipt; the error that waited is then shown.
  click(dom, doc.getElementById('toast-undo'));
  await flush(10);
  // The waiting message follows once the receipt has left (TOAST_EXIT_MS).
  await new Promise((resolve) => setTimeout(resolve, 250));
  await flush(10);
  assert.equal(fake.invokeCount('undo_delete'), 1);
  assert.notEqual(toast().message, 'تم حذف العنصر');
  assert.match(toast().message, /تعذّر/u, 'the error was not lost');
});
