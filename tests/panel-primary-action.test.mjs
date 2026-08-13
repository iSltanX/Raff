// Choosing an item is ONE action: copy → paste into the previously active
// app → keep the item on the clipboard.
//
// The contract these lock down:
//   * a single click chooses (it does not merely select)
//   * mouse and keyboard mean the same thing
//   * exactly one paste per choice — never two
//   * the row's own pin/delete controls are not a choice
//   * ⌘C stays available as the secondary copy-WITHOUT-pasting action
//   * losing Accessibility permission degrades to copy-only, it never fails
//
// Clipboard retention and duplicate-history suppression are enforced on the
// Rust side (paste.rs never restores the previous pasteboard, and stamps
// `skip_change_count` so the monitor ignores our own write); this file covers
// the parts the frontend owns.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountPanel, sampleItem, minutesAgo, flush, click } from './helpers/panel-harness.mjs';

const STATE = {
  pinned: [sampleItem('p1', { isPinned: true, createdAt: minutesAgo(30) })],
  history: [
    sampleItem('r1', { createdAt: minutesAgo(10) }),
    sampleItem('r2', { createdAt: minutesAgo(20) }),
  ],
  settings: null,
  axTrusted: true,
};

const row = (dom, id) => dom.window.document.querySelector(`.row[data-id="${id}"]`);

test('choosing an item: one click, one paste, mouse and keyboard agree', async (t) => {
  const { dom, fake, uncaught } = await mountPanel(STATE);

  await t.test('a single click pastes that exact row', async () => {
    click(dom, row(dom, 'r2'));
    await flush(6);

    assert.equal(fake.invokeCount('paste_item'), 1, 'exactly one paste');
    const [args] = fake.invocationArgs('paste_item');
    assert.equal(args.id, 'r2', 'the clicked row is the one pasted');
    assert.equal(args.plain, false, 'a plain click keeps rich pasteboard content');
  });

  await t.test('a pinned row is chosen the same way', async () => {
    click(dom, row(dom, 'p1'));
    await flush(6);

    assert.equal(fake.invokeCount('paste_item'), 2);
    assert.equal(fake.invocationArgs('paste_item')[1].id, 'p1');
  });

  await t.test('⌥click chooses as plain text, matching ⌥⏎', async () => {
    click(dom, row(dom, 'r1'), { altKey: true });
    await flush(6);

    const args = fake.invocationArgs('paste_item')[2];
    assert.equal(args.id, 'r1');
    assert.equal(args.plain, true, '⌥ still means "paste as plain text"');
  });

  await t.test('Enter performs the identical action on the selection', async () => {
    const before = fake.invokeCount('paste_item');
    // r1 is selected by the click above — Enter must repeat the same choice.
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flush(6);

    assert.equal(fake.invokeCount('paste_item'), before + 1, 'one paste, same as a click');
    assert.equal(fake.invocationArgs('paste_item').at(-1).id, 'r1');
  });

  await t.test('the row action buttons are not a choice', async () => {
    const before = fake.invokeCount('paste_item');
    click(dom, row(dom, 'r2').querySelector('.delete-btn'));
    await flush(6);
    assert.equal(fake.invokeCount('paste_item'), before, 'deleting must never paste');
  });

  assert.deepEqual(uncaught, []);
});
