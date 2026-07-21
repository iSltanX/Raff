// The happy path plus in-place recovery: a first load that stumbles once and
// then succeeds, and the «تحديث رَفّ» button re-initialising without a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  flush,
  wait,
  rowIds,
  listText,
} from './helpers/panel-harness.mjs';

test('panel recovery: first load retries, then the refresh button re-initialises in place', async (t) => {
  // The very first get_state fails; the built-in retry must rescue the load
  // without any user action and without a reload.
  const { dom, fake, reloads, uncaught } = await mountPanel(
    {
      pinned: [sampleItem('pin1', { isPinned: true })],
      history: [sampleItem('r1'), sampleItem('r2')],
      settings: null,
      axTrusted: true,
    },
    { failTimes: 1 }
  );

  await t.test('a failed first load is retried automatically and succeeds', async () => {
    await wait(500); // past the first 250ms backoff
    assert.deepEqual(rowIds(dom), ['pin1', 'r1', 'r2'], 'retry populated the list');
    assert.ok(fake.getStateCallCount() >= 2, 'the failed attempt was actually retried');
  });

  await t.test('the transient failure never showed the error state to the user', () => {
    assert.doesNotMatch(listText(dom), /تعذّر عرض محتوى رَفّ/);
  });

  await t.test('the refresh button carries Arabic labels only', () => {
    const btn = dom.window.document.getElementById('refresh-btn');
    assert.equal(btn.title, 'تحديث رَفّ');
    assert.equal(btn.getAttribute('aria-label'), 'تحديث محتوى رَفّ');
  });

  await t.test('pressing refresh re-initialises the data without reloading', async () => {
    fake.setState({
      pinned: [sampleItem('pin1', { isPinned: true })],
      history: [sampleItem('r1'), sampleItem('r2'), sampleItem('r3')],
      settings: null,
      axTrusted: true,
    });
    const btn = dom.window.document.getElementById('refresh-btn');
    btn.dispatchEvent(new dom.window.Event('click'));
    await flush(6);

    assert.deepEqual(rowIds(dom), ['pin1', 'r1', 'r2', 'r3'], 'fresh data is on screen');
    assert.equal(reloads.length, 0, 'the soft path must not reload the frontend');
  });

  await t.test('refresh never loses already-saved items', async () => {
    const before = rowIds(dom);
    const btn = dom.window.document.getElementById('refresh-btn');
    btn.dispatchEvent(new dom.window.Event('click'));
    await flush(6);
    assert.deepEqual(rowIds(dom), before, 'the same items are still there afterwards');
  });

  await t.test('a burst of clicks is collapsed by the busy state', async () => {
    const btn = dom.window.document.getElementById('refresh-btn');
    const before = fake.getStateCallCount();
    for (let i = 0; i < 6; i++) btn.dispatchEvent(new dom.window.Event('click'));
    await flush(6);
    assert.equal(
      fake.getStateCallCount() - before,
      1,
      'six rapid clicks must produce exactly one fetch'
    );
  });

  await t.test('refreshing does not re-subscribe the background events', () => {
    assert.equal(fake.listenCallCount('panel://shown'), 1);
    assert.equal(fake.listenCallCount('raff://changed'), 1);
  });

  await t.test('repeated show/refresh cycles never trigger a reload loop', async () => {
    for (let i = 0; i < 5; i++) {
      fake.emit('panel://shown', null);
      await flush(4);
      dom.window.document.getElementById('refresh-btn').dispatchEvent(new dom.window.Event('click'));
      await flush(6);
    }
    assert.equal(reloads.length, 0, 'nothing in the healthy path may reload the frontend');
    assert.equal(fake.listenCallCount('panel://shown'), 1, 'still exactly one subscription');
  });

  await t.test('an empty shelf reads as empty, never as an error', async () => {
    fake.setState({ pinned: [], history: [], settings: null, axTrusted: true });
    fake.emit('panel://shown', null);
    await flush(6);
    assert.match(listText(dom), /رفّك فارغ/, 'the natural empty state is shown');
    assert.doesNotMatch(listText(dom), /تعذّر عرض محتوى رَفّ/, 'and never the failure state');
  });

  await t.test('the panel exposes no English "Reload" affordance', () => {
    const html = dom.window.document.body.innerHTML;
    assert.doesNotMatch(html, /reload/i, 'no English reload text anywhere in the panel UI');
  });

  await t.test('the native page menu is suppressed over inert areas', () => {
    const event = new dom.window.Event('contextmenu', { cancelable: true, bubbles: true });
    dom.window.document.getElementById('list').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'the English page menu must not open on the list');
  });

  await t.test('the search field keeps its native editing menu', () => {
    const event = new dom.window.Event('contextmenu', { cancelable: true, bubbles: true });
    dom.window.document.getElementById('search').dispatchEvent(event);
    assert.equal(
      event.defaultPrevented,
      false,
      'cut/copy/paste/select must keep working inside the search field'
    );
  });

  await t.test('selected text keeps its native copy menu', () => {
    // The brand lockup always exists, so this does not depend on list state.
    const range = dom.window.document.createRange();
    range.selectNodeContents(dom.window.document.querySelector('.panel-brand strong'));
    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const event = new dom.window.Event('contextmenu', { cancelable: true, bubbles: true });
    dom.window.document.getElementById('list').dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'copying a selection must stay possible');
    sel.removeAllRanges();
  });

  await t.test('typing or pasting into the search field still filters', async () => {
    fake.setState({
      pinned: [],
      history: [sampleItem('r1'), sampleItem('r2')],
      settings: null,
      axTrusted: true,
    });
    fake.emit('panel://shown', null);
    await flush(6);

    const search = dom.window.document.getElementById('search');
    search.value = 'r2'; // as if pasted with ⌘V or the editing menu
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.deepEqual(rowIds(dom), ['r2'], 'pasted text filters the list');

    search.value = '';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.deepEqual(rowIds(dom), ['r1', 'r2'], 'clearing restores the full list');
  });

  await t.test('no uncaught errors during the whole session', () => {
    assert.deepEqual(uncaught, []);
  });
});
