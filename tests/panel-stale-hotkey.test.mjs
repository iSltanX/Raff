// The panel is what a stale hotkey opens — ⌘V pressed to paste anywhere
// brings رفّ up instead. So the panel is where it says so first (ت٣١).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('panel: a stale refused hotkey is called out in the status strip', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1')],
    settings: { captureEnabled: true, hotkey: 'super+v' },
    axTrusted: true,
  });
  const doc = dom.window.document;
  const strip = doc.getElementById('capture-strip');
  assert.equal(strip.hidden, false);
  assert.equal(strip.dataset.tone, 'warning');
  assert.match(doc.getElementById('capture-strip-text').textContent, /\u2066⌘V\u2069/u);
  assert.equal(doc.getElementById('capture-strip-action').textContent, 'تغيير');
  click(dom, doc.getElementById('capture-strip-action'));
  await flush(6);
  assert.equal(fake.invocationArgs('open_settings').length, 1, 'to the settings, where it is changed');
  assert.ok(doc.querySelector('#list .row[data-id="h1"]'), 'the list is still there: it does not block');
});
