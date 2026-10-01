// The Accessibility permission is optional. Its absence never stops saving,
// so the panel offers it once per session and afterwards only says where the
// item is — a nag on every paste would present it as a requirement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

test('the optional permission is offered once per session, not on every paste', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('first'), sampleItem('second')],
    settings: null,
    axTrusted: false,
  });
  const pasteSelected = async (id) => {
    selectRowByKeyboard(dom, id);
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flush(10);
  };

  await pasteSelected('first');
  assert.equal(dom.window.document.getElementById('toast-action').hidden, false, 'offered the first time');

  await pasteSelected('second');
  assert.equal(fake.invokeCount('paste_item'), 2);
  assert.equal(
    dom.window.document.getElementById('toast-action').hidden,
    true,
    'later fallbacks only say where the item is'
  );
});
