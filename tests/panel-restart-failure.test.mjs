// «إعادة تشغيل رفّ» used to be unable to fail: `app.restart()` never returned.
// It now goes through a relauncher that can refuse (no shell to spawn, say),
// and the panel must say so instead of re-arming the button in silence and
// leaving an unhandled rejection behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('panel: a refused restart is reported, not swallowed', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('row')],
    settings: null,
    axTrusted: true,
    unreadableLayer: false,
    unreadableSettings: false,
    captureAlive: false,
  });
  fake.emit('panel://shown', null);
  await flush(8);

  const doc = dom.window.document;
  const action = doc.getElementById('capture-strip-action');
  assert.equal(action.textContent, 'إعادة تشغيل رفّ');

  fake.failCommand('restart_app', 'تعذّر جدولة إعادة تشغيل Raff: Resource temporarily unavailable');
  click(dom, action);
  await flush(8);

  assert.equal(fake.invokeCount('restart_app'), 1);
  assert.equal(doc.getElementById('toast').hidden, false, 'the failure is shown');
  assert.equal(doc.getElementById('toast').dataset.kind, 'error');
  assert.equal(
    doc.getElementById('toast-message').textContent.trim(),
    'تعذّر إتمام العملية. حاول مرة أخرى.',
    'in رفّ’s words, not the raw backend string',
  );
  assert.equal(action.disabled, false, 'and the button can be tried again');
});
