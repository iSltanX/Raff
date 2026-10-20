// Every row is dated and ordered by createdAt alone: pinning and unpinning
// never change it. A second date from the reverted 001 design (capturedAt)
// is not read, even if a payload carried one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesAgo, mountPanel, sampleItem } from './helpers/panel-harness.mjs';
import { relativeTimeAr } from '../src/js/logic.js';

test('panel: a row is dated and ordered by createdAt alone', async () => {
  const { dom } = await mountPanel({
    pinned: [],
    history: [
      sampleItem('recent', { createdAt: minutesAgo(3) }),
      sampleItem('earlier', { createdAt: minutesAgo(10), capturedAt: minutesAgo(40 * 24 * 60) }),
    ],
    settings: null,
    axTrusted: true,
  });
  const rows = [...dom.window.document.querySelectorAll('#list .row')];

  assert.deepEqual(rows.map((row) => row.dataset.id), ['recent', 'earlier']);
  assert.equal(rows[0].querySelector('.row-time').textContent, relativeTimeAr(minutesAgo(3)));
  assert.equal(rows[1].querySelector('.row-time').textContent, relativeTimeAr(minutesAgo(10)));
});
