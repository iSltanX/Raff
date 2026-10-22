// Sultan's decisions (2026-10-22):
//   - «لصق بلا تشكيل» and «تسمية» share one row of the preview (option ب);
//     either alone fills it, and the row goes when neither applies.
//   - In the pictures grid a pinned picture's name shows on its card, and the
//     time stays on the card beside the kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

const css = readFileSync(new URL('../src/panel.css', import.meta.url), 'utf8');

test('the preview row of the two, and the name in the grid', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [
      sampleItem('both', { text: 'مُحَمَّدٌ', isPinned: true, pinnedOrder: 0 }),
      sampleItem('pic', { type: 'image', text: 'صورة 10×10', hasImage: true, isPinned: true, pinnedOrder: 1, label: 'فاتورة الكهرباء' }),
    ],
    history: [sampleItem('bare', { text: 'رَسُولُ' }), sampleItem('none', { text: 'سطر عادي' })],
    settings: null,
    axTrusted: true,
  });
  const win = dom.window;
  const doc = win.document;
  fake.emit('panel://shown');
  await flush(10);
  const preview = doc.getElementById('preview');
  const bare = preview.querySelector('[data-action="bare"]');
  const label = preview.querySelector('[data-action="label"]');
  const key = (init) => win.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const show = async (id) => {
    if (!preview.hidden) key({ key: 'y', code: 'KeyY', metaKey: true });
    await flush(10);
    selectRowByKeyboard(dom, id);
    key({ key: 'y', code: 'KeyY', metaKey: true });
    await flush(10);
    assert.equal(preview.dataset.id, id);
  };

  assert.equal(bare.parentElement, label.parentElement, 'one row');
  const row = bare.parentElement;
  assert.ok(row.classList.contains('preview-pair'));
  assert.equal(label.getAttribute('aria-keyshortcuts'), 'Alt+L');
  assert.match(label.querySelector('.btn-keys')?.textContent ?? '', /⌥L/u);

  await show('both');
  assert.deepEqual([bare.hidden, label.hidden, row.hidden], [false, false, false]);
  await show('bare');
  assert.deepEqual([bare.hidden, label.hidden, row.hidden], [false, true, false]);
  await show('none');
  assert.equal(row.hidden, true, 'nothing for the row: it goes');
  // One button alone fills the row: the pair is a flex row, not two columns.
  assert.match(css, /\.preview-pair\.is-flex\s*\{[^}]*display:\s*flex/u);
  assert.match(css, /\.preview-pair\.is-flex\s*>\s*\.btn\s*\{[^}]*flex:\s*1/u);

  // The pictures grid: the name above the foot, the time still in it.
  doc.querySelector('[data-filter="image"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush(10);
  const card = doc.querySelector('.row.is-card[data-id="pic"]');
  assert.ok(card, 'a card');
  assert.equal(card.querySelector('.card-label')?.textContent, 'فاتورة الكهرباء');
  assert.equal(card.querySelector('.card-label').getAttribute('role'), 'gridcell', 'a cell, like the card’s others');
  // Unnamed cards in the same grid row keep their foot level with a named one.
  assert.match(css, /\.card-foot\s*\{[^}]*margin-top:\s*auto/u);
  assert.ok(card.querySelector('.card-foot .row-time')?.textContent.trim(), 'the time stays');
  assert.match(css, /\.card-label\s*\{[^}]*text-overflow:\s*ellipsis/u);
});
