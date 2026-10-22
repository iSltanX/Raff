// IMP-06 «لصق بلا تشكيل»: ⌃⏎, and a button in the preview, paste the
// item's text without its harakat and tatweel (Rust: `paste::without_tashkeel`
// over the full text). ⏎ and ⌥⏎ are what they were. The button shows only
// where there is tashkeel or tatweel to drop, and ⌃⏎ elsewhere is ⏎.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

test('⌃⏎ and the preview button paste without tashkeel; ⏎ does not', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('d', { text: 'مُحَمَّدٌ رَسُولُ' }), sampleItem('p', { text: 'نص بلا حركات' })],
    settings: null,
    axTrusted: true,
  });
  const win = dom.window;
  const doc = win.document;
  const key = (init) => win.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const lastPaste = () => fake.invocationArgs('paste_item').at(-1);
  const bareButton = () => doc.querySelector('#preview [data-action="bare"]');

  selectRowByKeyboard(dom, 'd');
  key({ key: 'Enter', ctrlKey: true });
  await flush(10);
  assert.deepEqual(lastPaste(), { id: 'd', plain: false, bare: true }, '⌃⏎');

  fake.emit('panel://shown');
  await flush(10);
  selectRowByKeyboard(dom, 'd');
  key({ key: 'Enter' });
  await flush(10);
  assert.deepEqual(lastPaste(), { id: 'd', plain: false }, '⏎ unchanged');

  fake.emit('panel://shown');
  await flush(10);
  selectRowByKeyboard(dom, 'd');
  key({ key: 'y', code: 'KeyY', metaKey: true });
  await flush(10);
  assert.ok(bareButton(), 'the preview has the button');
  assert.equal(bareButton().hidden, false, 'shown for text with tashkeel');
  assert.equal(bareButton().getAttribute('aria-keyshortcuts'), 'Control+Enter');
  bareButton().dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush(10);
  assert.deepEqual(lastPaste(), { id: 'd', plain: false, bare: true }, 'the button');

  fake.emit('panel://shown');
  await flush(10);
  selectRowByKeyboard(dom, 'p');
  key({ key: 'y', code: 'KeyY', metaKey: true });
  await flush(10);
  assert.equal(bareButton().hidden, true, 'nothing to drop, no button');

  // Nothing to drop: ⌃⏎ is the ordinary paste, and keeps the formatting
  // (review 2026-10-22: it used to paste plain text, silently).
  fake.emit('panel://shown');
  await flush(10);
  selectRowByKeyboard(dom, 'p');
  key({ key: 'Enter', ctrlKey: true });
  await flush(10);
  assert.deepEqual(lastPaste(), { id: 'p', plain: false }, '⌃⏎ with nothing to drop');
});
