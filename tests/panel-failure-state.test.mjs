// A load that fails permanently must land on the Arabic failure state — never
// a silent blank panel and never the «الرفّ فارغ» empty shelf, which would
// falsely tell the user their saved clips are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  wait,
  RETRIES_EXHAUSTED_MS,
  rowIds,
  listText,
  click,
} from './helpers/panel-harness.mjs';

test('panel failure state: a permanently failing load shows a recoverable Arabic error', async (t) => {
  const { dom, fake, reloads, uncaught } = await mountPanel(
    {
      pinned: [],
      history: [sampleItem('r1', { createdAt: minutesAgo(10) })],
      settings: null,
      axTrusted: true,
    },
    { failTimes: Infinity }
  );

  // The list area is a three-valued machine — loading / ready / error — and
  // the three must never be confused. While the retries are still in flight
  // the panel is 'loading': not an error yet, and emphatically not an empty
  // shelf that would claim the user's clips are gone.
  await t.test('while the first fetch is still in flight the panel reads as loading', async () => {
    assert.doesNotMatch(listText(dom), /الرفّ فارغ/, 'loading must never read as an empty shelf');
    assert.doesNotMatch(listText(dom), /تعذّر عرض محتوى رفّ/, 'and not as a failure either');
    assert.equal(
      dom.window.document.querySelector('.state-view.is-failure'),
      null,
      'the failure view has not been built yet'
    );

    // Any render that happens in this window must paint the Arabic loading
    // view — the 'loading' arm of the phase machine, distinct from both
    // 'ready + zero items' and 'error'.
    dom.window.document.getElementById('search').dispatchEvent(new dom.window.Event('input'));
    await flush(1);
    assert.match(listText(dom), /جارٍ التحميل…/);
    assert.doesNotMatch(listText(dom), /الرفّ فارغ/);
    assert.doesNotMatch(listText(dom), /تعذّر عرض محتوى رفّ/);
  });

  await t.test('retries are attempted, then bounded — not an infinite loop', async () => {
    await wait(RETRIES_EXHAUSTED_MS);
    const afterGivingUp = fake.getStateCallCount();
    assert.equal(afterGivingUp, 3, 'exactly one attempt plus two retries');
    await wait(600);
    assert.equal(fake.getStateCallCount(), afterGivingUp, 'no further attempts on its own');
  });

  await t.test('the failure state is shown instead of a blank list', () => {
    assert.match(listText(dom), /تعذّر عرض محتوى رفّ/);
    assert.equal(
      dom.window.document.querySelector('.state-view.is-failure .state-title').textContent,
      'تعذّر عرض محتوى رفّ'
    );
    assert.notEqual(
      dom.window.document.getElementById('list').children.length,
      0,
      'the list area must never be left empty and silent'
    );
  });

  await t.test('it is not confused with a genuinely empty shelf', () => {
    assert.doesNotMatch(listText(dom), /الرفّ فارغ/);
    // The empty shelf is a plain .state-view; only the failure carries
    // .is-failure. Confusing the two would tell the user their clips are gone.
    const views = [...dom.window.document.querySelectorAll('.state-view')];
    assert.equal(views.length, 1, 'exactly one state view is on screen');
    assert.ok(views[0].classList.contains('is-failure'), 'and it is the failure one');
  });

  await t.test('it offers an Arabic way out and leaks no technical detail', () => {
    const action = dom.window.document.getElementById('failure-reload');
    assert.ok(action, 'a recovery button is present');
    assert.equal(action.textContent, 'إعادة تحميل الواجهة');
    assert.doesNotMatch(listText(dom), /IPC|Error|reload/i, 'no technical detail reaches the user');
  });

  await t.test('the failure copy is the approved wording, reassuring and non-technical', () => {
    assert.equal(
      dom.window.document.querySelector('.state-view.is-failure .state-sub').textContent,
      'حدث خلل مؤقت في العرض. يمكنك إعادة تحميل الواجهة دون فقدان محتواك.'
    );
    // The user must never be shown implementation nouns.
    assert.doesNotMatch(listText(dom), /WebView|webview|قاعدة البيانات|IPC/i);
  });

  await t.test('the app did not reload itself behind the scenes', () => {
    assert.equal(reloads.length, 0, 'recovery must be offered, never silently repeated');
  });

  await t.test('the failure button reloads the frontend when pressed', async () => {
    click(dom, dom.window.document.getElementById('failure-reload'));
    await flush();
    assert.equal(reloads.length, 1, 'exactly one reload, on explicit user action');
  });

  await t.test('recovery is possible without a reload once IPC returns', async () => {
    fake.stopFailing();
    fake.emit('panel://shown', null);
    await flush(6);
    assert.deepEqual(rowIds(dom), ['r1'], 'the list comes back on the next show');
    assert.doesNotMatch(listText(dom), /تعذّر عرض محتوى رفّ/, 'failure state cleared');
    assert.equal(
      dom.window.document.querySelector('.state-view.is-failure'),
      null,
      'the failure view is gone from the DOM'
    );
  });

  await t.test('the whole failure path produced no uncaught errors', () => {
    assert.deepEqual(uncaught, []);
  });
});
