// A test run of رفّ has no clipboard (ت٤٨): copying or pasting an item there
// says so — not «لم يعد هذا العنصر موجودًا», which would read as a bug in a
// row that is plainly still on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

test('panel: a copy in a test run says the clipboard is off, not that the item is gone', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('a')],
    settings: { captureEnabled: true, hotkey: 'shift+super+v' },
    axTrusted: true,
  });
  const doc = dom.window.document;
  fake.failCommand('copy_item', 'raff/clipboard-off');
  selectRowByKeyboard(dom, 'a');
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, bubbles: true, cancelable: true })
  );
  await flush(8);
  const shown = doc.getElementById('toast')?.textContent ?? '';
  assert.match(shown, /نسخة تجربة/u);
  assert.doesNotMatch(shown, /لم يعد هذا العنصر موجودًا/u);
});
