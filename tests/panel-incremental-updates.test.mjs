// `render()` was the only way to change anything on screen: it cleared the
// container and rebuilt every row from scratch. Two paths made that hurt —
// moving the selection by one, and every capture arriving while the panel was
// hidden but its webview still very much alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, sampleItem, minutesAgo, flush, click } from './helpers/panel-harness.mjs';

const ITEMS = Array.from({ length: 200 }, (_, index) =>
  sampleItem(`r${index}`, { createdAt: minutesAgo(index + 1) })
);

const press = (dom, key) =>
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );

test('panel: incremental updates', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: ITEMS,
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;

  await t.test('moving the selection keeps the very same row nodes', async () => {
    doc.getElementById('search').blur();
    const firstRow = doc.querySelector('.row[role="row"]');
    assert.ok(firstRow, 'the list is painted');
    const rowCount = doc.querySelectorAll('.row[role="row"]').length;

    press(dom, 'ArrowDown');
    await flush(2);
    press(dom, 'ArrowDown');
    await flush(2);

    assert.ok(
      firstRow.isConnected,
      'the node that was there is still in the document — not rebuilt'
    );
    assert.equal(
      doc.querySelectorAll('.row[role="row"]').length,
      rowCount,
      'and no row was added or removed'
    );
    assert.equal(
      firstRow.getAttribute('aria-selected'),
      'false',
      'the selection moved off the first row'
    );
    const selected = doc.querySelectorAll('.row.selected[role="row"]');
    assert.equal(selected.length, 1, 'exactly one row carries the selection');
    assert.equal(selected[0].getAttribute('aria-selected'), 'true');
    assert.equal(
      doc.getElementById('search').getAttribute('aria-activedescendant'),
      selected[0].id,
      'the announced row followed it'
    );
  });

  await t.test('a capture arriving while hidden is not fetched or rebuilt', async () => {
    click(dom, doc.getElementById('panel-close'));
    await flush(2);
    const before = fake.getStateCallCount();

    fake.emit('raff://changed');
    await flush(4);

    assert.equal(
      fake.getStateCallCount(),
      before,
      'nothing is refetched for a panel nobody is looking at'
    );
  });

  await t.test('and showing it again picks up whatever was missed', async () => {
    const before = fake.getStateCallCount();
    fake.emit('panel://shown');
    await flush(6);

    assert.ok(
      fake.getStateCallCount() > before,
      'the show path is what reconciles the deferred changes'
    );
  });
});
