// A load that fails permanently must land on the Arabic failure state — never
// a silent blank panel and never the «رفّك فارغ» empty shelf, which would
// falsely tell the user their saved clips are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  flush,
  wait,
  RETRIES_EXHAUSTED_MS,
  rowIds,
  listText,
} from './helpers/panel-harness.mjs';

test('panel failure state: a permanently failing load shows a recoverable Arabic error', async (t) => {
  const { dom, fake, reloads, uncaught } = await mountPanel(
    { pinned: [], history: [sampleItem('r1')], settings: null, axTrusted: true },
    { failTimes: Infinity }
  );

  await t.test('retries are attempted, then bounded — not an infinite loop', async () => {
    await wait(RETRIES_EXHAUSTED_MS);
    const afterGivingUp = fake.getStateCallCount();
    assert.equal(afterGivingUp, 3, 'exactly one attempt plus two retries');
    await wait(600);
    assert.equal(fake.getStateCallCount(), afterGivingUp, 'no further attempts on its own');
  });

  await t.test('the failure state is shown instead of a blank list', () => {
    assert.match(listText(dom), /تعذّر عرض محتوى رَفّ/);
    assert.notEqual(
      dom.window.document.getElementById('list').children.length,
      0,
      'the list area must never be left empty and silent'
    );
  });

  await t.test('it is not confused with a genuinely empty shelf', () => {
    assert.doesNotMatch(listText(dom), /رفّك فارغ/);
  });

  await t.test('it offers an Arabic way out and leaks no technical detail', () => {
    const action = dom.window.document.getElementById('failure-reload');
    assert.ok(action, 'a recovery button is present');
    assert.equal(action.textContent, 'إعادة تحميل الواجهة');
    assert.doesNotMatch(listText(dom), /IPC|Error|reload/i, 'no technical detail reaches the user');
  });

  await t.test('the failure copy is the approved wording, reassuring and non-technical', () => {
    assert.equal(
      dom.window.document.querySelector('.state-view.failure .state-sub').textContent,
      'حدث خلل مؤقت في عرض العناصر. يمكنك إعادة تحميل الواجهة دون فقدان محتواك.'
    );
    // The user must never be shown implementation nouns.
    assert.doesNotMatch(listText(dom), /WebView|webview|قاعدة البيانات|IPC/i);
  });

  await t.test('the app did not reload itself behind the scenes', () => {
    assert.equal(reloads.length, 0, 'recovery must be offered, never silently repeated');
  });

  await t.test('the failure button reloads the frontend when pressed', async () => {
    dom.window.document.getElementById('failure-reload').dispatchEvent(new dom.window.Event('click'));
    await flush();
    assert.equal(reloads.length, 1, 'exactly one reload, on explicit user action');
  });

  await t.test('recovery is possible without a reload once IPC returns', async () => {
    fake.stopFailing();
    fake.emit('panel://shown', null);
    await flush(6);
    assert.deepEqual(rowIds(dom), ['r1'], 'the list comes back on the next show');
    assert.doesNotMatch(listText(dom), /تعذّر عرض محتوى رَفّ/, 'failure state cleared');
  });

  await t.test('the whole failure path produced no uncaught errors', () => {
    assert.deepEqual(uncaught, []);
  });
});
