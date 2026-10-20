// A row the backend has already returned from the pinned shelf: ordered by its
// place in the timeline (createdAt), dated by its capture (capturedAt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesAgo, mountPanel, sampleItem } from './helpers/panel-harness.mjs';
import { relativeTimeAr } from '../src/js/logic.js';

const fortyDaysAgo = minutesAgo(40 * 24 * 60);

test('panel: a returned row from the backend shows capturedAt, ordered by createdAt', async () => {
  const { dom } = await mountPanel({
    pinned: [],
    history: [
      sampleItem('returned', { createdAt: Date.now(), capturedAt: fortyDaysAgo }),
      sampleItem('recent', { createdAt: minutesAgo(3) }),
    ],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const rows = [...doc.querySelectorAll('#list .row')];

  assert.deepEqual(rows.map((row) => row.dataset.id), ['returned', 'recent']);
  assert.equal(rows[0].querySelector('.row-time').textContent, relativeTimeAr(fortyDaysAgo));
  assert.equal(rows[1].querySelector('.row-time').textContent, relativeTimeAr(minutesAgo(3)));
});
