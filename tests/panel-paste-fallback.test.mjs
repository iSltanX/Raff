import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('clipboard-only paste keeps Raff visible and announces the manual fallback', async () => {
  const { dom, fake, uncaught } = await mountPanel({
    pinned: [],
    history: [sampleItem('manual-paste')],
    settings: null,
    axTrusted: false,
  });
  click(dom, dom.window.document.querySelector('.row[data-id="manual-paste"]'));
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
  assert.equal(
    dom.window.document.getElementById('toast-message').textContent,
    'نُسخ إلى الحافظة — الصقه بـ ⌘V'
  );
  assert.equal(dom.window.document.getElementById('panel-feedback').hidden, false);
  assert.deepEqual(uncaught, []);
});
