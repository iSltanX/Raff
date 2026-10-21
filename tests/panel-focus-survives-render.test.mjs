// Audit 020 ج1 / IMP-08: every render rebuilds the rows, so a row's button
// that held focus is replaced and focus fell to <body> — a keyboard user
// moving a pinned item had to find their place again after every step, and
// a change announced while they sat on a button did the same. Focus now
// comes back to the same control of the same row, or to search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('focus on a row control stays with that control across a render', async () => {
  const pinned = (id, order) => sampleItem(id, { isPinned: true, pinnedOrder: order });
  const { dom, fake } = await mountPanel({
    pinned: [pinned('p1', 0), pinned('p2', 1), pinned('p3', 2)],
    history: [],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const focused = () => {
    const el = doc.activeElement;
    const row = el?.closest?.('.row[data-id]');
    return row ? `${row.dataset.id} ${[...el.classList].join('.')}` : el?.id || el?.tagName;
  };

  click(dom, doc.querySelector('[data-filter="pinned"]'));
  await flush(5);

  const moveDown = doc.querySelector('.row[data-id="p1"] .move-down');
  moveDown.focus();
  click(dom, moveDown);
  await flush(10);
  assert.equal(fake.invokeCount('reorder_pinned'), 1);
  assert.deepEqual(
    [...doc.querySelectorAll('.row[data-id]')].map((r) => r.dataset.id),
    ['p2', 'p1', 'p3']
  );
  assert.equal(focused(), 'p1 row-action.move-down', 'still on p1’s «نقل لأسفل»');

  // Moved to the bottom, the same button is disabled: focus goes to its
  // opposite, the move that is still possible, not to a dead control.
  click(dom, doc.activeElement);
  await flush(10);
  assert.deepEqual(
    [...doc.querySelectorAll('.row[data-id]')].map((r) => r.dataset.id),
    ['p2', 'p3', 'p1']
  );
  assert.equal(focused(), 'p1 row-action.move-up');

  // A control whose state class flips (the pin: is-pinned) is still found.
  const pin = doc.querySelector('.row[data-id="p1"] .pin-btn');
  pin.focus();
  fake.failCommand('toggle_pin', 'raff/save-failed');
  click(dom, pin);
  await flush(10);
  assert.equal(focused(), 'p1 row-action.pin-btn.is-pinned', 'back on its pin after a failed unpin');
});
