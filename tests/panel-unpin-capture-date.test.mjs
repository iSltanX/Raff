// Unpinning returns a row to its place in time with its own date (Sultan,
// 2026-10-21): it does not jump to the top of «الكل». A row older than every
// row in history is not taken back, and the panel says why it is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, minutesAgo, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';
import { relativeTimeAr } from '../src/js/logic.js';

const fortyDaysAgo = minutesAgo(40 * 24 * 60);

test('panel: unpinning keeps a row in its place in time, or says why it is gone', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [
      sampleItem('mid', { isPinned: true, pinnedOrder: 0, createdAt: minutesAgo(3), text: 'بين الاثنين' }),
      sampleItem('old', { isPinned: true, pinnedOrder: 1, createdAt: fortyDaysAgo, text: 'ردّ محفوظ منذ زمن' }),
    ],
    history: [sampleItem('h1', { createdAt: minutesAgo(1) }), sampleItem('h2', { createdAt: minutesAgo(5) })],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const rowIds = () => [...doc.querySelectorAll('#list .row')].map((row) => row.dataset.id);
  const timeOf = (id) => doc.querySelector(`.row[data-id="${id}"] .row-time`).textContent;
  const toastText = () => doc.getElementById('toast-message').textContent;

  await t.test('a row newer than the oldest stays where its date puts it', async () => {
    assert.deepEqual(rowIds(), ['h1', 'mid', 'h2', 'old']);

    click(dom, doc.querySelector('.row[data-id="mid"] .pin-btn'));
    await flush(10);

    assert.deepEqual(fake.invocationArgs('toggle_pin').at(-1), { id: 'mid', isPinned: false });
    assert.deepEqual(rowIds(), ['h1', 'mid', 'h2', 'old'], 'no jump to the top');
    assert.equal(timeOf('mid'), relativeTimeAr(minutesAgo(3)), 'its own date');
    assert.equal(doc.querySelector('.row[data-id="mid"] .pin-btn').getAttribute('aria-pressed'), 'false');
    assert.equal(toastText(), 'تم إلغاء تثبيت العنصر');
  });

  await t.test('a pin still reaches the backend when a delete of the same row follows it', async () => {
    click(dom, doc.querySelector('.row[data-id="h1"] .pin-btn'));
    click(dom, doc.querySelector('.row[data-id="h1"] .delete-btn'));
    await flush(10);

    assert.deepEqual(
      fake.invocationArgs('toggle_pin').filter((args) => args.id === 'h1'),
      [{ id: 'h1', isPinned: true }],
      'the row was still there, only on its way out'
    );
    assert.deepEqual(fake.invocationArgs('delete_item').at(-1), { id: 'h1' });
    doc.getElementById('toast-undo').click(); // and back, for the next case
    await flush(10);
  });

  await t.test('a row older than all of history is gone, and the panel says why', async () => {
    selectRowByKeyboard(dom, 'old');
    const button = doc.querySelector('.row[data-id="old"] .pin-btn');
    button.focus();
    // A quick second click lands while the first is still on its way.
    click(dom, button);
    click(dom, button);
    await flush(14);

    assert.deepEqual(rowIds(), ['h1', 'mid', 'h2']);
    assert.equal(toastText(), 'أُلغي التثبيت، وحُذف العنصر لأنه أقدم من سجلّك');
    assert.equal(doc.getElementById('toast').dataset.kind, 'delete');
    assert.equal(
      fake.invocationArgs('toggle_pin').filter((args) => args.id === 'old').length,
      1,
      'the second click had nothing left to pin'
    );
    assert.equal(doc.querySelector('#list .row.selected')?.dataset.id, 'h2', 'the row beside it');
    assert.equal(doc.activeElement, doc.getElementById('search'), 'focus not lost to the page');
  });
});
