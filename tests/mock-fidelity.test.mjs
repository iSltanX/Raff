// The browser mock is what design review and README screenshots see. Where it
// answers a command the way Rust never would, the page under review is in a
// state the app never reaches: a reordered shelf snapping back, an update
// window saying «جارٍ التحقق» forever (audit 025, as corrected by the
// verification).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { innerWidth: 900 };
const { mockInvoke } = await import('../src/js/mock.js');

const state = () => mockInvoke('get_state');

test('search_items answers with the ids whose full text matches, folded like the panel', async () => {
  assert.deepEqual(await mockInvoke('search_items', { query: 'pasteboarditems' }), ['r4']);
  // «الإبداع» found by «ابداع»: alef forms fold as in `normalize_for_search`.
  assert.deepEqual(await mockInvoke('search_items', { query: '  ابداع ' }), ['r1']);
  // ...on both sides: the query is folded too.
  assert.deepEqual(await mockInvoke('search_items', { query: 'الإبداع' }), ['r1']);
  assert.deepEqual(await mockInvoke('search_items', { query: 'PasteboardItems' }), ['r4']);
  assert.deepEqual(await mockInvoke('search_items', { query: '   ' }), [], 'an empty query matches nothing');
});

test('reorder_pinned keeps the order it was given', async () => {
  await mockInvoke('toggle_pin', { id: 'r5', isPinned: true });
  await mockInvoke('reorder_pinned', { ids: ['r5', 'p1'] });
  assert.deepEqual((await state()).pinned.map((item) => item.id), ['r5', 'p1']);
  await mockInvoke('reorder_pinned', { ids: ['p1', 'r5'] });
  assert.deepEqual((await state()).pinned.map((item) => item.id), ['p1', 'r5']);
});

test('clear_learning resets every row the way Rust does', async () => {
  await mockInvoke('clear_learning');
  const { pinned, history } = await state();
  for (const item of [...pinned, ...history]) {
    assert.equal(item.copyCount, 0, item.id);
    assert.equal(item.pasteCount, 0, item.id);
    assert.equal(item.lastUsedAt, item.createdAt, item.id);
  }
});

test('the update window opened from the menu checks once, as in the app', async () => {
  // Every way into the window goes through `open_updates`, which leaves one
  // check to claim; the second claim (the event after the load) finds none.
  assert.equal(await mockInvoke('consume_update_intent'), true);
  assert.equal(await mockInvoke('consume_update_intent'), false);
  // «التحقق» in Settings or About found a version: one more check to claim.
  await mockInvoke('open_updates');
  assert.equal(await mockInvoke('consume_update_intent'), true);
  assert.equal(await mockInvoke('consume_update_intent'), false);
});

test('clear_history empties history and keeps the shelf', async () => {
  await mockInvoke('clear_history');
  const { pinned, history } = await state();
  assert.deepEqual(history, []);
  assert.deepEqual(pinned.map((item) => item.id), ['p1', 'r5']);
});
