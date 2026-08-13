// Endurance: the panel webview lives for the whole app session, so anything
// that accumulates per show/hide cycle (listeners, timers, DOM nodes) turns
// into a slow leak. This drives 30 full cycles plus the long-hidden and
// wake-from-sleep shapes and asserts nothing grows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SHELF_HEADLINE,
  FAILURE_HEADLINE,
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  wait,
  rowIds,
  listText,
  pressCmdR,
} from './helpers/panel-harness.mjs';

/** Total element count in the document — the cheapest honest proxy for DOM
 *  growth. The rendered list is identical on every cycle, so this number must
 *  be identical too. */
const nodeCount = (dom) => dom.window.document.querySelectorAll('*').length;

test('panel endurance: 30 show/hide cycles leak nothing and lose nothing', async (t) => {
  // `p1` is pinned AND the oldest item, so the expected order below is the
  // designed chronological one — pinned is marked in place, never lifted.
  const items = {
    pinned: [sampleItem('p1', { isPinned: true, createdAt: minutesAgo(90) })],
    history: [
      sampleItem('r1', { createdAt: minutesAgo(10) }),
      sampleItem('r2', { createdAt: minutesAgo(20) }),
      sampleItem('r3', { createdAt: minutesAgo(30) }),
    ],
    settings: null,
    axTrusted: true,
  };
  const { dom, fake, reloads, uncaught, timers } = await mountPanel(items);

  const intervalsAfterMount = timers.intervalsCreated;
  let nodesAfterFirstCycle = 0;

  await t.test('30 open/hide cycles keep exactly one row per item', async () => {
    for (let i = 0; i < 30; i++) {
      fake.emit('panel://shown', null); // user opens with ⇧⌘V
      await flush(4);
      fake.emit('raff://changed', null); // a clip is captured while open/hidden
      await flush(2);
      assert.deepEqual(rowIds(dom), ['r1', 'r2', 'r3', 'p1'], `cycle ${i} stayed correct`);
      if (i === 0) nodesAfterFirstCycle = nodeCount(dom);
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
    assert.equal(intervalsAfterMount, 0, 'the time-free row needs no repeating refresher');
  });

  await t.test('no DOM accumulation across all 30 cycles', () => {
    assert.equal(
      nodeCount(dom),
      nodesAfterFirstCycle,
      'the same content must render to the same number of nodes, cycle after cycle'
    );
  });

  await t.test('no reload happened anywhere in the healthy path', () => {
    assert.equal(reloads.length, 0);
  });

  await t.test('long-hidden then shown: the list repopulates', async () => {
    // Nothing arrives for a while (panel hidden, web process suspended), then
    // the store has changed by the time the user comes back.
    await wait(300);
    fake.setState({
      pinned: [sampleItem('p1', { isPinned: true, createdAt: minutesAgo(90) })],
      history: [
        sampleItem('r1', { createdAt: minutesAgo(10) }),
        sampleItem('r2', { createdAt: minutesAgo(20) }),
        sampleItem('r3', { createdAt: minutesAgo(30) }),
        sampleItem('r4', { createdAt: minutesAgo(40) }),
      ],
      settings: null,
      axTrusted: true,
    });
    fake.emit('panel://shown', null);
    await flush(6);
    assert.deepEqual(rowIds(dom), ['r1', 'r2', 'r3', 'r4', 'p1']);
  });

  await t.test('wake-from-sleep shape: focus regained without panel://shown', async () => {
    fake.setState({
      pinned: [sampleItem('p1', { isPinned: true, createdAt: minutesAgo(90) })],
      history: [sampleItem('r1', { createdAt: minutesAgo(10) })],
      settings: null,
      axTrusted: true,
    });
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await flush(6);
    assert.deepEqual(rowIds(dom), ['r1', 'p1'], 'focus alone resyncs the list');
    assert.equal(reloads.length, 0, 'and never reloads to do it');
  });

  await t.test('hammering ⌘R 20x produces no reload loop', async () => {
    for (let i = 0; i < 20; i++) {
      pressCmdR(dom);
      await flush(1);
    }
    await flush(8);
    assert.equal(reloads.length, 0, 'the healthy soft path never reloads');
    assert.deepEqual(rowIds(dom), ['r1', 'p1'], 'and nothing was lost');
  });

  await t.test('the empty state never appeared while items existed', () => {
    assert.doesNotMatch(listText(dom), EMPTY_SHELF_HEADLINE);
    assert.doesNotMatch(listText(dom), FAILURE_HEADLINE);
  });

  await t.test('no uncaught errors over the whole endurance run', () => {
    assert.deepEqual(uncaught, []);
  });
});
