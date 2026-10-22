// Audit 021 ج2 / IMP-08: the search field is a combobox over the grid of
// rows. `aria-expanded` says whether that grid is there to move into — rows
// on screen — not whether one of them happens to be selected; and the «end of
// results» line inside the grid is a row of its own, since a grid owns rows
// and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('the combobox tells what its grid holds', async () => {
  const { dom } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1', { text: 'تفاحة' }), sampleItem('h2', { text: 'برتقالة' })],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const search = doc.getElementById('search');
  const list = doc.getElementById('list');
  const type = async (value) => {
    search.value = value;
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush(10);
  };

  assert.equal(doc.querySelectorAll('.row.selected').length, 0, 'idle: nothing selected');
  assert.equal(search.getAttribute('aria-expanded'), 'true', 'yet the rows are there');

  await type('تفاحة');
  const end = list.querySelector('.results-end');
  assert.ok(end, 'the end-of-results line');
  assert.equal(end.getAttribute('role'), 'row');
  assert.equal(end.firstElementChild?.getAttribute('role'), 'gridcell');
  assert.equal(list.getAttribute('aria-rowcount'), '2', 'one result and the end line');
  assert.equal(end.getAttribute('aria-rowindex'), '2');
  for (const child of list.children) {
    assert.equal(child.getAttribute('role'), 'row', `${child.className} is a row`);
  }

  // Spaces are no search: no closing line for «nothing».
  await type('   ');
  assert.equal(list.querySelector('.results-end'), null);

  await type('لا شيء يطابق');
  assert.equal(list.querySelectorAll('.row[data-id]').length, 0);
  assert.equal(search.getAttribute('aria-expanded'), 'false', 'nothing to move into');
});
