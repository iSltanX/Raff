// The same refusal for the other reason (017, م٢): the deleted item is past
// the retention period, so it would leave the moment it came back. The panel
// names its age, not a lack of room the user could make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('panel: an undo past the retention period says that, not «no room»', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1'), sampleItem('h2')],
    settings: { captureEnabled: true, hotkey: 'shift+super+v' },
    axTrusted: true,
  });
  const doc = dom.window.document;
  fake.failCommand('undo_delete', 'raff/undo-retention');
  click(dom, doc.querySelector('#list .row[data-id="h1"] .delete-btn'));
  await flush(6);
  click(dom, doc.getElementById('toast-undo'));
  await flush(8);
  const message = doc.getElementById('toast-message').textContent;
  assert.match(message, /انتهت مدة الاحتفاظ بهذا العنصر/u);
  assert.doesNotMatch(message, /متّسع/u);
});
