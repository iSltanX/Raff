// An image item with no picture to show says why (audit 2026-10-21,
// F-THUMB-FALLBACK). Rust no longer sends an original past the bridge limit
// when the thumbnail is missing; it answers `raff/preview-too-large`, and the
// panel tells that apart from a file that is gone: «المعاينة غير متاحة» for a
// picture that is there and still pastes, «الملف مفقود» for one that is not.
// And the pictures the list keeps are those of the items it still has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, clickFilter, emptyState, flush, minutesAgo, mountPanel, sampleItem, wait } from './helpers/panel-harness.mjs';

const image = (id, minutes) => sampleItem(id, { type: 'image', text: `صورة ${id}`, hasImage: true, createdAt: minutesAgo(minutes) });
const ITEMS = [image('ok', 1), image('gone', 2), image('big', 3)];

test('panel: a picture too large to preview is not a missing file', async (t) => {
  const { dom, fake, uncaught } = await mountPanel(emptyState());
  fake.respond('get_image', ({ id }) => {
    if (id === 'gone') return null;
    if (id === 'big') return Promise.reject('raff/preview-too-large');
    return 'data:image/png;base64,AAAA';
  });
  fake.setState({ ...emptyState(), history: structuredClone(ITEMS) });
  fake.emit('panel://shown', null);
  await flush(8);
  const doc = dom.window.document;
  const row = (id) => doc.querySelector(`#list .row[data-id="${id}"]`);
  const note = (id) => row(id).querySelector('.preview-missing').textContent;
  const fetchesOf = (id) => fake.invocationArgs('get_image').filter((args) => args.id === id && !args.full).length;

  await t.test('each row says what it lacks', () => {
    assert.equal(row('ok').classList.contains('is-image-missing'), false);
    assert.equal(row('ok').classList.contains('is-preview-unavailable'), false);
    assert.ok(row('gone').classList.contains('is-image-missing'));
    assert.equal(note('gone'), 'الملف مفقود');
    assert.ok(row('big').classList.contains('is-preview-unavailable'));
    assert.equal(row('big').classList.contains('is-image-missing'), false, 'the file is there');
    assert.equal(note('big'), 'المعاينة غير متاحة');
  });

  await t.test('the cards in the Images grid keep the difference', () => {
    clickFilter(dom, 'image');
    assert.ok(row('big').classList.contains('is-card'));
    assert.ok(row('big').classList.contains('is-preview-unavailable'));
    assert.equal(note('big'), 'المعاينة غير متاحة');
    assert.ok(row('gone').classList.contains('is-image-missing'));
    assert.equal(note('gone'), 'الملف مفقود');
    clickFilter(dom, 'all');
  });

  await t.test('a picture too large to preview still pastes', async () => {
    click(dom, row('big'));
    await flush(4);
    assert.deepEqual(fake.invocationArgs('paste_item').at(-1), { id: 'big', plain: false });
  });

  await t.test('the preview beside the panel says the same', async () => {
    fake.emit('panel://shown', null);
    await flush(8);
    const preview = doc.getElementById('preview');
    for (const [id, words] of [
      ['big', 'المعاينة غير متاحة'],
      ['gone', 'الملف مفقود'],
    ]) {
      row(id).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
      await wait(250); // past the preview's settle before it asks for the original
      await flush(4);
      assert.equal(preview.hidden, false);
      assert.equal(preview.querySelector('.preview-missing-note')?.textContent, words, id);
    }
  });

  await t.test('pictures of items that left the state are not kept', async () => {
    assert.equal(fetchesOf('ok'), 1, 'asked once, then kept');
    fake.setState({ ...emptyState(), history: structuredClone(ITEMS.slice(1)) });
    fake.emit('raff://changed', null);
    await flush(8);
    assert.equal(row('ok'), null);
    // The same item back (an undo that already committed, a re-copy): its
    // picture is asked for again rather than served from a session-long cache.
    fake.setState({ ...emptyState(), history: structuredClone(ITEMS) });
    fake.emit('raff://changed', null);
    await flush(8);
    assert.equal(fetchesOf('ok'), 2);
    assert.equal(row('ok').querySelector('img').getAttribute('src'), 'data:image/png;base64,AAAA');
  });

  await t.test('no uncaught errors', () => {
    assert.deepEqual(uncaught, []);
  });
});
