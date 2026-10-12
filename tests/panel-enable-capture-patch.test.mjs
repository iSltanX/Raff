// The panel's «تفعيل» used to send `{ ...state.settings, captureEnabled: true }`
// — every field as the panel last saw them, so anything changed elsewhere in
// the meantime (an exclusion added in Settings, say) was put back (H6). It
// now sends the one field it changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('panel: «تفعيل» sends only captureEnabled', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('row')],
    settings: {
      hotkey: 'shift+super+v',
      launchAtLogin: false,
      historyLimit: 500,
      captureEnabled: false,
      respectConcealed: true,
      excludedApps: [],
      learningEnabled: true,
      firstRunShown: true,
      appearance: 'light',
      followSystem: true,
      retentionDays: 0,
    },
    axTrusted: true,
    unreadableLayer: false,
    unreadableSettings: false,
    captureAlive: true,
  });
  fake.emit('panel://shown', null);
  await flush(8);

  const action = dom.window.document.getElementById('capture-strip-action');
  assert.equal(action.textContent, 'تفعيل');
  click(dom, action);
  await flush(8);

  assert.deepEqual(fake.invocationArgs('update_settings'), [{ settings: { captureEnabled: true } }]);
});
