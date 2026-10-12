// A settings.json that did not parse used to fall back to the defaults in
// silence: capture back on, the exclusions list empty, nothing on screen
// (RAFF-AUD-002). The backend now holds capture off and says why; the panel
// has to say it too, and send the user to the list that was lost rather than
// offer to turn capture straight back on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SHELF_HEADLINE,
  click,
  flush,
  listText,
  mountPanel,
  sampleItem,
} from './helpers/panel-harness.mjs';

const SETTINGS = {
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
};

test('panel: unreadable settings are named, and lead to Settings', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('kept')],
    settings: structuredClone(SETTINGS),
    axTrusted: true,
    unreadableLayer: false,
    unreadableSettings: true,
    captureAlive: true,
  });
  const doc = dom.window.document;
  const strip = doc.getElementById('capture-strip');
  // Changes reach a panel that is on screen; a hidden one defers them.
  fake.emit('panel://shown', null);
  await flush(8);

  await t.test('the strip says the settings were not read and capture is off', () => {
    assert.equal(strip.hidden, false);
    assert.match(doc.getElementById('capture-strip-text').textContent, /تعذّرت قراءة الإعدادات/u);
    assert.match(doc.getElementById('capture-strip-text').textContent, /الالتقاط معطّل/u);
    assert.equal(strip.dataset.tone, 'danger');
    assert.equal(strip.getAttribute('role'), 'alert');
  });

  await t.test('its action opens Settings instead of turning capture back on', async () => {
    const action = doc.getElementById('capture-strip-action');
    assert.equal(action.textContent, 'مراجعة');
    click(dom, action);
    await flush();
    assert.equal(fake.invokeCount('open_settings'), 1);
    assert.equal(fake.invokeCount('update_settings'), 0, 'nothing is re-enabled behind the user');
  });

  await t.test('the shelf itself was read, so its rows are still shown', () => {
    assert.ok(doc.querySelector('.row[data-id="kept"]'));
  });

  await t.test('an empty shelf is not called unreadable for a settings problem', async () => {
    fake.setState({ ...fake.getState(), history: [] });
    fake.emit('raff://changed');
    await flush(8);
    assert.equal(doc.querySelector('.row'), null, 'the empty shelf is what is on screen');
    assert.doesNotMatch(listText(dom), /تعذّرت قراءة سجلّك/u);
    assert.doesNotMatch(listText(dom), EMPTY_SHELF_HEADLINE, 'capture is off: «سيظهر هنا فورًا» would not hold');
  });

  await t.test('once capture is turned back on, the notice goes', async () => {
    fake.setState({
      ...fake.getState(),
      settings: { ...SETTINGS, captureEnabled: true },
      unreadableSettings: false,
    });
    fake.emit('raff://changed');
    await flush(8);
    assert.equal(strip.hidden, true);
  });
});
