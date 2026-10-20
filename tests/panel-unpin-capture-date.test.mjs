// An unpinned row returns to the top of the list, and keeps showing the date
// it was captured — not the moment it came back (RAFF-2026-001, user decision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, minutesAgo, mountPanel, sampleItem } from './helpers/panel-harness.mjs';
import { relativeTimeAr } from '../src/js/logic.js';

const fortyDaysAgo = minutesAgo(40 * 24 * 60);

test('panel: unpinning puts the row on top with its original capture date', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [sampleItem('old', { isPinned: true, pinnedOrder: 0, createdAt: fortyDaysAgo, text: 'ردّ محفوظ منذ زمن' })],
    history: [
      sampleItem('h1', { createdAt: minutesAgo(1) }),
      sampleItem('h2', { createdAt: minutesAgo(2) }),
    ],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const rowIds = () => [...doc.querySelectorAll('#list .row')].map((row) => row.dataset.id);
  const timeOf = (id) => doc.querySelector(`.row[data-id="${id}"] .row-time`).textContent;

  assert.equal(rowIds().at(-1), 'old', 'pinned long ago: at the bottom of the timeline');

  click(dom, doc.querySelector('.row[data-id="old"] .pin-btn'));
  await flush(10);

  assert.deepEqual(fake.invocationArgs('toggle_pin').at(-1), { id: 'old', isPinned: false });
  assert.equal(rowIds()[0], 'old', 'back on top');
  assert.equal(timeOf('old'), relativeTimeAr(fortyDaysAgo), 'showing when it was captured');
  assert.notEqual(timeOf('old'), 'الآن');
  assert.equal(timeOf('h1'), relativeTimeAr(minutesAgo(1)), 'other rows are untouched');
});
