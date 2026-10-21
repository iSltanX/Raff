// The Images filter is a grid of cards (approved proposal, Figma «02 · مساحة
// العمل» 39:1073 and Item Card 35:301): three 136pt cards a row, each the
// picture over its time and kind. It is the same list, drawn for pictures —
// the same selection, the same click, the same ⌘1–9 — with the arrow keys
// moving across (RTL: ← is next) and down (one row of three).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, clickFilter, flush, minutesAgo, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

const images = Array.from({ length: 7 }, (_, i) =>
  sampleItem(`img${i + 1}`, { type: 'image', text: `صورة ${i + 1}`, hasImage: true, createdAt: minutesAgo(i + 1) })
);

test('panel: the Images filter is a keyboard-navigable grid of cards', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('t1', { createdAt: minutesAgo(0) }), ...images],
    settings: { captureEnabled: true, hotkey: 'shift+super+v' },
    axTrusted: true,
  });
  const doc = dom.window.document;
  const list = doc.getElementById('list');
  const key = (init) =>
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const selected = () => doc.querySelector('#list .row.selected')?.dataset.id ?? null;

  await t.test('the list is rows everywhere else', () => {
    assert.equal(list.classList.contains('is-grid'), false);
    assert.equal(doc.querySelectorAll('#list .row.is-card').length, 0);
  });

  await t.test('pictures are cards: the picture, then its time and kind', () => {
    clickFilter(dom, 'image');
    assert.equal(list.classList.contains('is-grid'), true);
    const cards = [...doc.querySelectorAll('#list .row')];
    assert.equal(cards.length, 7);
    for (const card of cards) {
      assert.ok(card.classList.contains('is-card'));
      assert.equal(card.getAttribute('role'), 'row', 'the same accessible list');
      assert.ok(card.querySelector('.card-media .preview-thumb'), 'the picture');
      assert.ok(card.querySelector('.card-foot .row-time'), 'its time');
      assert.ok(card.querySelector('.card-foot .row-kind'), 'its kind');
      assert.equal(card.querySelector('.row-actions'), null, 'no buttons on a card (Figma Item Card)');
    }
  });

  await t.test('arrows move across and down the grid', () => {
    doc.getElementById('search').blur();
    key({ key: 'ArrowDown' });
    assert.equal(selected(), 'img1', 'the first card');
    key({ key: 'ArrowLeft' });
    assert.equal(selected(), 'img2', '← is next in RTL');
    key({ key: 'ArrowDown' });
    assert.equal(selected(), 'img5', '↓ is one row of three');
    key({ key: 'ArrowRight' });
    assert.equal(selected(), 'img4', '→ is back');
    key({ key: 'ArrowUp' });
    assert.equal(selected(), 'img1', '↑ is one row up');
    key({ key: 'ArrowUp' });
    assert.equal(selected(), 'img1', 'and stops at the top');
  });

  await t.test('⌘2 and a click choose a card exactly as they choose a row', async () => {
    key({ key: '2', code: 'Digit2', metaKey: true });
    await flush(4);
    assert.equal(fake.invocationArgs('paste_item').at(-1)?.id, 'img2');
    click(dom, doc.querySelector('#list .row[data-id="img3"]'));
    await flush(4);
    assert.equal(fake.invocationArgs('paste_item').at(-1)?.id, 'img3');
  });

  await t.test('back to every kind, back to rows', () => {
    clickFilter(dom, 'all');
    assert.equal(list.classList.contains('is-grid'), false);
    assert.equal(doc.querySelectorAll('#list .row.is-card').length, 0);
  });
});
