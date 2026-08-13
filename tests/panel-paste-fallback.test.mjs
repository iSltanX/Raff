import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flush,
  mountPanel,
  sampleItem,
  selectRowByKeyboard,
} from './helpers/panel-harness.mjs';

test('clipboard-only paste keeps Raff visible and announces the manual fallback', async () => {
  const { dom, fake, uncaught } = await mountPanel({
    pinned: [],
    history: [sampleItem('manual-paste')],
    settings: null,
    axTrusted: false,
  });
  // Select without choosing: a click is itself the paste action now, so
  // clicking here would make this a two-paste test.
  selectRowByKeyboard(dom, 'manual-paste');
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })
  );
  await flush(10);

  assert.equal(fake.invokeCount('paste_item'), 1);
  assert.equal(fake.invokeCount('hide_panel'), 0);
  assert.match(
    dom.window.document.getElementById('toast-message').textContent,
    /الصقه بـ ⌘V/u,
    'immediate manual-paste guidance is not dropped by the added explanation'
  );
  assert.match(
    dom.window.document.getElementById('toast-message').textContent,
    /تسهيل الوصول/u,
    'the toast explains WHY auto-paste did not happen'
  );
  assert.equal(
    dom.window.document.getElementById('toast-action').hidden,
    false,
    'a one-click way to grant the permission is offered, not just an explanation'
  );
  assert.equal(dom.window.document.getElementById('panel-feedback').hidden, false);
  assert.deepEqual(uncaught, []);
});
