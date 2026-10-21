// An unpin history does not take back is announced with its actual reason
// (ت١٧، ت٢٩). Past the retention period the age limit is what let the row go,
// even where history is empty or the row is also older than all of it; that
// is not «older than your history», and the toast must not say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, minutesAgo, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('panel: a removed unpin names the reason the backend gives', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [
      sampleItem('aged', { isPinned: true, pinnedOrder: 0, createdAt: minutesAgo(30 * 24 * 60), text: 'محفوظ منذ شهر' }),
      sampleItem('old', { isPinned: true, pinnedOrder: 1, createdAt: minutesAgo(60), text: 'أقدم من السجل' }),
    ],
    history: [sampleItem('h1', { createdAt: minutesAgo(1) }), sampleItem('h2', { createdAt: minutesAgo(5) })],
    settings: { captureEnabled: true, retentionDays: 7 },
    axTrusted: true,
  });
  const doc = dom.window.document;
  const toastText = () => doc.getElementById('toast-message').textContent;
  const rowIds = () => [...doc.querySelectorAll('#list .row')].map((row) => row.dataset.id);

  await t.test('past the retention period: the age limit is the reason', async () => {
    click(dom, doc.querySelector('.row[data-id="aged"] .pin-btn'));
    await flush(12);

    assert.equal(fake.invocationArgs('toggle_pin').at(-1).id, 'aged');
    assert.ok(!rowIds().includes('aged'), 'gone from the list');
    assert.equal(toastText(), 'أُلغي التثبيت، وحُذف العنصر لانتهاء مدة الاحتفاظ');
    assert.equal(doc.getElementById('toast').dataset.kind, 'delete');
    assert.equal(doc.getElementById('toast-undo').hidden, true, 'no undo for a removal (ت١٧)');
  });

  await t.test('within it, older than all of history: the existing wording', async () => {
    click(dom, doc.querySelector('.row[data-id="old"] .pin-btn'));
    await flush(12);

    assert.ok(!rowIds().includes('old'));
    assert.equal(toastText(), 'أُلغي التثبيت، وحُذف العنصر لأنه أقدم من سجلّك');
  });
});
