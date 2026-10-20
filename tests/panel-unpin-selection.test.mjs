// Unpinning inside «مثبّت» takes the row out of the list. Like a delete, the
// selection moves to the row beside it, and focus never falls to the page
// (the live UI audit of 2026-10-20, issue 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  click,
  clickFilter,
  flush,
  minutesAgo,
  mountPanel,
  sampleItem,
  selectRowByKeyboard,
} from './helpers/panel-harness.mjs';

test('panel: unpinning inside مثبّت keeps a selection and a focus', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: ['a', 'b', 'c'].map((id, order) =>
      sampleItem(id, { isPinned: true, pinnedOrder: order, createdAt: minutesAgo(2 + order * 2) })
    ),
    history: [sampleItem('h', { createdAt: minutesAgo(1) })],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const rowIds = () => [...doc.querySelectorAll('#list .row')].map((row) => row.dataset.id);
  const selected = () => doc.querySelector('#list .row.selected')?.dataset.id ?? null;
  clickFilter(dom, 'pinned');
  assert.deepEqual(rowIds(), ['a', 'b', 'c']);

  await t.test('from its button: focus goes to search, the selection to the next row', async () => {
    selectRowByKeyboard(dom, 'a');
    const button = doc.querySelector('.row[data-id="a"] .pin-btn');
    button.focus();
    click(dom, button);
    await flush(10);

    assert.deepEqual(rowIds(), ['b', 'c']);
    assert.equal(selected(), 'b');
    assert.equal(doc.activeElement, doc.getElementById('search'), 'not the page');
    assert.equal(
      doc.getElementById('search').getAttribute('aria-activedescendant'),
      doc.querySelector('.row[data-id="b"]').id
    );
  });

  await t.test('by ⌥P: the selection moves on with it', async () => {
    doc.getElementById('search').blur();
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'π',
        code: 'KeyP',
        altKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await flush(10);

    assert.deepEqual(rowIds(), ['c']);
    assert.equal(selected(), 'c');
  });

  await t.test('a refused unpin puts the row, its selection and its focus back', async () => {
    fake.failCommand('toggle_pin', 'raff/save-failed');
    const button = doc.querySelector('.row[data-id="c"] .pin-btn');
    button.focus();
    click(dom, button);
    await flush(10);

    assert.deepEqual(rowIds(), ['c']);
    assert.equal(selected(), 'c');
    assert.equal(doc.activeElement, doc.querySelector('.row[data-id="c"] .pin-btn'));
    assert.equal(doc.getElementById('toast-message').textContent, 'تعذّر حفظ التغيير. حاول مرة أخرى.');
  });

  await t.test('a refusal does not take focus from someone typing a search', async () => {
    const button = doc.querySelector('.row[data-id="c"] .pin-btn');
    button.focus();
    click(dom, button);
    const search = doc.getElementById('search');
    assert.equal(doc.activeElement, search);
    search.value = 'item';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush(10);

    assert.deepEqual(rowIds(), ['c'], 'refused: back in the list');
    assert.equal(doc.activeElement, search, 'still typing');
  });
});
