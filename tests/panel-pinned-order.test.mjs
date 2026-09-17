// `pinnedOrder` was written on every pin and read by nothing: the panel sorted
// everything by `createdAt`, so the pinned shelf was a timeline the user could
// not arrange. Where pinned items appear as a group, the order is theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  clickFilter,
  rowIds,
  click,
} from './helpers/panel-harness.mjs';

// Deliberately at odds: newest first by time is the reverse of the arrangement.
const PINNED = [
  sampleItem('p-old', { isPinned: true, pinnedOrder: 0, createdAt: minutesAgo(90) }),
  sampleItem('p-mid', { isPinned: true, pinnedOrder: 1, createdAt: minutesAgo(60) }),
  sampleItem('p-new', { isPinned: true, pinnedOrder: 2, createdAt: minutesAgo(30) }),
];
const HISTORY = [
  sampleItem('h1', { createdAt: minutesAgo(5) }),
  sampleItem('h2', { createdAt: minutesAgo(10) }),
];

test('panel: the pinned shelf is arranged, not dated', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: PINNED,
    history: HISTORY,
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;

  await t.test('the default list is still one timeline', () => {
    assert.deepEqual(
      rowIds(dom),
      ['h1', 'h2', 'p-new', 'p-mid', 'p-old'],
      'newest first, pinned marked in place — unchanged'
    );
  });

  await t.test('the مثبّت segment follows pinnedOrder instead', async () => {
    clickFilter(dom, 'pinned');
    await flush(4);
    assert.deepEqual(rowIds(dom), ['p-old', 'p-mid', 'p-new']);
  });

  await t.test('move buttons are offered there, and bounded', () => {
    const rows = [...doc.querySelectorAll('.row[role="row"]')];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector('.move-up').disabled, true, 'nothing above the first');
    assert.equal(rows[2].querySelector('.move-down').disabled, true, 'nothing below the last');
    assert.equal(rows[1].querySelector('.move-up').disabled, false);
  });

  await t.test('moving one down sends the whole new order', async () => {
    const rows = [...doc.querySelectorAll('.row[role="row"]')];
    click(dom, rows[0].querySelector('.move-down'));
    await flush(8);

    assert.deepEqual(fake.invocationArgs('reorder_pinned'), [
      { ids: ['p-mid', 'p-old', 'p-new'] },
    ]);
    assert.deepEqual(rowIds(dom), ['p-mid', 'p-old', 'p-new'], 'and the list already shows it');
  });

  await t.test('the buttons are absent where the order has no meaning', async () => {
    clickFilter(dom, 'all');
    await flush(4);
    assert.equal(
      doc.querySelector('.move-up'),
      null,
      'a timeline is not something to rearrange'
    );
  });
});
