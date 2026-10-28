// A held key repeats; it is still one press (DS-008). macOS auto-repeats a
// key held past its delay, ⌘ or ⌥ combinations included, and WebKit hands
// each repeat to the page as a `keydown` with `repeat: true`. The keys that
// act on the selected item must act once: a held ⌘⌫ used to delete row after
// row — pinned ones too — finalizing each previous delete, so «تراجع» could
// bring back only the last.
//
// One `mountPanel()` per file (see the harness header comment); every
// scenario is a `t.test()` under the shared mount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  wait,
  rowIds,
  selectRowByKeyboard,
} from './helpers/panel-harness.mjs';

/** One press held through `repeats` auto-repeats, 33ms apart — close to the
 * fastest key repeat macOS offers. Returns every event, to check what each did. */
async function hold(dom, init, repeats) {
  const send = (repeat) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
      repeat,
    });
    dom.window.dispatchEvent(event);
    return event;
  };
  const events = [send(false)];
  for (let i = 0; i < repeats; i += 1) {
    await wait(33);
    events.push(send(true));
  }
  await flush(20);
  return events;
}

test('held keys: the item keys act once however long they are held', async (t) => {
  const { dom, fake, uncaught } = await mountPanel({
    pinned: [
      sampleItem('p1', { isPinned: true, pinnedOrder: 0, createdAt: minutesAgo(1) }),
      sampleItem('p2', { isPinned: true, pinnedOrder: 1, createdAt: minutesAgo(2) }),
    ],
    history: ['h1', 'h2', 'h3', 'h4', 'h5'].map((id, i) =>
      sampleItem(id, { createdAt: minutesAgo(10 + i) })
    ),
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;

  await t.test('⌘⌫ held deletes one item, and «تراجع» brings it back', async () => {
    selectRowByKeyboard(dom, 'p1');
    const events = await hold(dom, { key: 'Backspace', code: 'Backspace', metaKey: true }, 5);

    assert.deepEqual(fake.deletedIds(), ['p1'], 'only the selected item');
    assert.equal(fake.invokeCount('delete_item'), 1);
    assert.equal(fake.invokeCount('commit_delete'), 0, 'no delete made final behind the user');
    assert.ok(
      events.every((event) => event.defaultPrevented),
      'the repeats are still ⌘⌫ of the panel, not of the field'
    );
    assert.deepEqual(rowIds(dom), ['p2', 'h1', 'h2', 'h3', 'h4', 'h5']);

    doc.getElementById('toast-undo').click();
    await flush(20);
    assert.deepEqual(rowIds(dom), ['p1', 'p2', 'h1', 'h2', 'h3', 'h4', 'h5']);
  });

  await t.test('⌥P held pins once', async () => {
    selectRowByKeyboard(dom, 'h1');
    const before = fake.invokeCount('toggle_pin');
    const events = await hold(dom, { key: 'π', code: 'KeyP', altKey: true }, 3);

    assert.equal(fake.invokeCount('toggle_pin') - before, 1);
    assert.deepEqual(fake.invocationArgs('toggle_pin').at(-1), { id: 'h1', isPinned: true });
    assert.ok(fake.getState().pinned.some((item) => item.id === 'h1'), 'and it stays pinned');
    assert.ok(events.every((event) => event.defaultPrevented));
  });

  await t.test('⏎ held pastes once', async () => {
    selectRowByKeyboard(dom, 'h2');
    const before = fake.invokeCount('paste_item');
    const events = await hold(dom, { key: 'Enter', code: 'Enter' }, 9);

    assert.equal(fake.invokeCount('paste_item') - before, 1);
    assert.equal(fake.invocationArgs('paste_item').at(-1).id, 'h2');
    assert.ok(events.every((event) => event.defaultPrevented));
  });

  await t.test('⌘1 held pastes once', async () => {
    const before = fake.invokeCount('paste_item');
    const events = await hold(dom, { key: '1', code: 'Digit1', metaKey: true }, 4);

    assert.equal(fake.invokeCount('paste_item') - before, 1);
    assert.ok(events.every((event) => event.defaultPrevented));
  });

  await t.test('⌘C held copies once', async () => {
    selectRowByKeyboard(dom, 'h3');
    const before = fake.invokeCount('copy_item');
    const events = await hold(dom, { key: 'c', code: 'KeyC', metaKey: true }, 4);

    assert.equal(fake.invokeCount('copy_item') - before, 1);
    assert.ok(events.every((event) => event.defaultPrevented));
  });

  await t.test('the arrows still repeat: holding one walks the list', async () => {
    selectRowByKeyboard(dom, 'p1');
    await hold(dom, { key: 'ArrowDown', code: 'ArrowDown' }, 2);
    assert.equal(doc.querySelector('.row.selected')?.dataset.id, rowIds(dom)[3]);
  });

  assert.deepEqual(uncaught, []);
});
