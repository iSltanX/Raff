// When in-place re-initialisation cannot recover, the «تحديث رَفّ» button must
// fall back to reloading the frontend — the fallback, never the first move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, sampleItem, flush, wait, rowIds } from './helpers/panel-harness.mjs';

test('refresh button: falls back to a frontend reload only when re-initialising fails', async (t) => {
  const { dom, fake, reloads, uncaught } = await mountPanel({
    pinned: [],
    history: [sampleItem('r1'), sampleItem('r2')],
    settings: null,
    axTrusted: true,
  });

  await t.test('the panel starts healthy', () => {
    assert.deepEqual(rowIds(dom), ['r1', 'r2']);
    assert.equal(reloads.length, 0);
  });

  await t.test('with IPC wedged, refresh tries in place first and only then reloads', async () => {
    fake.failForever();
    const before = fake.getStateCallCount();
    dom.window.document.getElementById('refresh-btn').dispatchEvent(new dom.window.Event('click'));

    // Still no reload while the retries are in flight.
    await flush(4);
    assert.equal(reloads.length, 0, 'reload must not be the first move');

    await wait(1400); // past both backoffs
    assert.equal(fake.getStateCallCount() - before, 3, 'one attempt plus two retries were made');
    assert.equal(reloads.length, 1, 'then exactly one reload as the fallback');
  });

  await t.test('a wedged panel keeps the last good list rather than blanking', () => {
    assert.deepEqual(rowIds(dom), ['r1', 'r2'], 'items already on screen are not thrown away');
  });

  await t.test('the fallback does not loop', async () => {
    await wait(600);
    assert.equal(reloads.length, 1, 'no further reloads without another user action');
  });

  await t.test('a panel://shown landing mid-refresh is not mistaken for a failure', async () => {
    fake.stopFailing();
    const before = reloads.length;
    // Press refresh, then immediately reopen the panel — the reopen supersedes
    // the button's in-flight fetch. That is a normal race, not a fault, and
    // must not be answered with a reload.
    dom.window.document.getElementById('refresh-btn').dispatchEvent(new dom.window.Event('click'));
    fake.emit('panel://shown', null);
    await wait(1400);
    assert.equal(reloads.length, before, 'a superseded refresh must never trigger a reload');
    assert.deepEqual(rowIds(dom), ['r1', 'r2'], 'and the list is intact');
  });

  await t.test('no uncaught errors', () => {
    assert.deepEqual(uncaught, []);
  });
});
