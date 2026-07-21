// Endurance: the panel webview lives for the whole app session, so anything
// that accumulates per show/hide cycle (listeners, timers, DOM nodes) turns
// into a slow leak. This drives 30 full cycles plus the long-hidden and
// wake-from-sleep shapes and asserts nothing grows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel, sampleItem, flush, wait, rowIds, listText } from './helpers/panel-harness.mjs';

test('panel endurance: 30 show/hide cycles leak nothing and lose nothing', async (t) => {
  const items = {
    pinned: [sampleItem('p1', { isPinned: true })],
    history: [sampleItem('r1'), sampleItem('r2'), sampleItem('r3')],
    settings: null,
    axTrusted: true,
  };
  const { dom, fake, reloads, uncaught, timers } = await mountPanel(items);

  const intervalsAfterMount = timers.intervalsCreated;

  await t.test('30 open/hide cycles keep exactly one row per item', async () => {
    for (let i = 0; i < 30; i++) {
      fake.emit('panel://shown', null); // user opens with ⇧⌘V
      await flush(4);
      fake.emit('raff://changed', null); // a clip is captured while open/hidden
      await flush(2);
      assert.deepEqual(rowIds(dom), ['p1', 'r1', 'r2', 'r3'], `cycle ${i} stayed correct`);
    }
  });

  await t.test('no listener accumulation across all 30 cycles', () => {
    assert.equal(fake.listenCallCount('panel://shown'), 1, 'still one panel://shown subscription');
    assert.equal(fake.listenCallCount('raff://changed'), 1, 'still one raff://changed subscription');
  });

  await t.test('no repeating-timer accumulation across all 30 cycles', () => {
    assert.equal(
      timers.intervalsCreated,
      intervalsAfterMount,
      'no cycle may create another interval — that would leak for the whole session'
    );
    assert.equal(intervalsAfterMount, 1, 'exactly the one relative-time refresher exists');
  });


  await t.test('no reload happened anywhere in the healthy path', () => {
    assert.equal(reloads.length, 0);
  });

  await t.test('long-hidden then shown: the list repopulates', async () => {
    // Nothing arrives for a while (panel hidden, web process suspended), then
    // the store has changed by the time the user comes back.
    await wait(300);
    fake.setState({
      pinned: [sampleItem('p1', { isPinned: true })],
      history: [sampleItem('r1'), sampleItem('r2'), sampleItem('r3'), sampleItem('r4')],
      settings: null,
      axTrusted: true,
    });
    fake.emit('panel://shown', null);
    await flush(6);
    assert.deepEqual(rowIds(dom), ['p1', 'r1', 'r2', 'r3', 'r4']);
  });

  await t.test('wake-from-sleep shape: focus regained without panel://shown', async () => {
    fake.setState({
      pinned: [sampleItem('p1', { isPinned: true })],
      history: [sampleItem('r1')],
      settings: null,
      axTrusted: true,
    });
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await flush(6);
    assert.deepEqual(rowIds(dom), ['p1', 'r1'], 'focus alone resyncs the list');
    assert.equal(reloads.length, 0, 'and never reloads to do it');
  });

  await t.test('hammering the refresh button 20x produces no reload loop', async () => {
    const btn = dom.window.document.getElementById('refresh-btn');
    for (let i = 0; i < 20; i++) {
      btn.dispatchEvent(new dom.window.Event('click'));
      await flush(1);
    }
    await flush(8);
    assert.equal(reloads.length, 0, 'the healthy soft path never reloads');
    assert.deepEqual(rowIds(dom), ['p1', 'r1'], 'and nothing was lost');
  });

  await t.test('the empty state never appeared while items existed', () => {
    assert.doesNotMatch(listText(dom), /رفّك فارغ/);
    assert.doesNotMatch(listText(dom), /تعذّر عرض محتوى رَفّ/);
  });

  await t.test('no uncaught errors over the whole endurance run', () => {
    assert.deepEqual(uncaught, []);
  });
});
