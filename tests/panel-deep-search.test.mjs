// The panel only ever holds the first 1000 characters of a row, and it was the
// only thing that searched — so anything written past that cut was saved but
// unfindable. It now asks Rust about the part it cannot see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, sampleItem, minutesAgo, flush, rowIds } from './helpers/panel-harness.mjs';

const SHALLOW = sampleItem('shallow', {
  text: 'ملاحظة قصيرة عن الفهرسة',
  createdAt: minutesAgo(1),
});
// What the panel holds: the preview, cut and ellipsised exactly as Rust sends it.
const DEEP = sampleItem('deep', {
  text: `${'م '.repeat(500)}…`,
  createdAt: minutesAgo(2),
});

test('panel: search reaches the text the preview cut off', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [SHALLOW, DEEP],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const search = doc.getElementById('search');

  const type = async (value) => {
    search.value = value;
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush(8);
  };

  await t.test('a word only in the hidden tail still finds its row', async () => {
    fake.setSearchResults(['deep']);
    await type('الخزنة');

    assert.deepEqual(rowIds(dom), ['deep'], 'the row Rust matched is the one shown');
    assert.deepEqual(
      fake.invocationArgs('search_items'),
      [{ query: 'الخزنة' }],
      'and it was asked with the query as typed'
    );
  });

  await t.test('what the panel can see itself still matches without waiting', async () => {
    fake.setSearchResults([]);
    await type('الفهرسة');

    assert.deepEqual(rowIds(dom), ['shallow'], 'the local filter still carries the preview');
  });

  await t.test('clearing the query asks nothing and shows everything', async () => {
    const before = fake.invokeCount('search_items');
    await type('');

    assert.deepEqual(rowIds(dom).sort(), ['deep', 'shallow']);
    assert.equal(fake.invokeCount('search_items'), before, 'an empty query is not a search');
  });
});
