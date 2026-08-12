// ⌘⌫ deletes the selected item — guarded shortcut, persistence, and selection
// movement after the delete.
//
// One `mountPanel()` per file (see the harness header comment): `panel.js` is
// imported once per process and its module-level DOM references are captured
// at that first import, so a second mount in the same file would silently
// keep operating on the first mount's stale `document`/`window`. Every
// scenario below therefore lives as a `t.test()` under one shared mount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  rowIds,
  listText,
  click,
} from './helpers/panel-harness.mjs';

function pressCmdBackspace(dom) {
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, bubbles: true, cancelable: true })
  );
}

function pressAltP(dom) {
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { code: 'KeyP', altKey: true, bubbles: true, cancelable: true })
  );
}

function pressEnter(dom) {
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
}

/** Selects a row the way a real click does. Real WebKit blurs the currently
 * focused element on mousedown over a non-focusable target (the `.row` divs
 * carry no tabindex) *before* the click handler runs — jsdom does not
 * simulate that particular default action, so it is reproduced explicitly to
 * keep the test faithful to the shipped WebView instead of to a jsdom gap. */
function selectRow(dom, id) {
  dom.window.document.getElementById('search').blur();
  click(dom, dom.window.document.querySelector(`.row[data-id="${id}"]`));
}

test('delete shortcut: ⌘⌫ removes the selected item', async (t) => {
  const { dom, fake, uncaught } = await mountPanel({
    pinned: [],
    history: [
      sampleItem('r1', { createdAt: minutesAgo(10) }),
      sampleItem('r2', { createdAt: minutesAgo(20) }),
      sampleItem('r3', { createdAt: minutesAgo(30) }),
    ],
    settings: null,
    axTrusted: true,
  });

  // «08 — Product Screens» replaced the old shortcut-chip strip with a single
  // hint line, so there is no ⌘⌫ chip to assert any more. The shortcut itself
  // is covered in full by the behavioural tests below.
  await t.test('the footer carries the designed single Arabic hint', () => {
    const hint = dom.window.document.getElementById('footer-hint');
    assert.equal(hint.hidden, false, 'the hint line is visible in the ready state');
    assert.equal(hint.querySelector('kbd').textContent, '⌘V');
    assert.equal(hint.textContent, '⌘V للصق الفوري');
  });

  await t.test('does not delete anything when nothing is selected', async () => {
    // Emptying the filtered view clears selectedId through the normal render
    // path (render() sets selectedId to null when nothing visible matches).
    const search = dom.window.document.getElementById('search');
    search.value = 'no such clip at all';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    search.blur();

    pressCmdBackspace(dom);
    await flush();
    assert.deepEqual(fake.deletedIds(), [], 'nothing was sent for deletion with no selection');

    // Restore the full list for the assertions below.
    search.value = '';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
  });

  await t.test('does not fire while the search field is focused (native ⌘⌫ text editing wins)', async () => {
    selectRow(dom, 'r2'); // establishes a real selection first
    await flush();

    const search = dom.window.document.getElementById('search');
    search.value = 'something typed';
    search.focus();
    pressCmdBackspace(dom);
    await flush();

    assert.deepEqual(fake.deletedIds(), [], 'no delete_item call while typing in the search field');
    assert.deepEqual(rowIds(dom), ['r1', 'r2', 'r3'], 'the list is untouched');
    assert.equal(search.value, 'something typed', 'the search field keeps its own text-editing behaviour');

    search.value = '';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
  });

  await t.test('⌥P (pin) still works and is not shadowed by the delete shortcut', async () => {
    selectRow(dom, 'r1');
    pressAltP(dom);
    await flush();
    // togglePin resolves to null in the fake and does not mutate state, so
    // the only observable contract here is that ⌥P took the pin branch and
    // not the delete branch.
    assert.deepEqual(fake.deletedIds(), [], '⌥P must never be treated as a delete');
    assert.deepEqual(rowIds(dom), ['r1', 'r2', 'r3']);
  });

  await t.test('↩ (paste) still works and is not shadowed by the delete shortcut', async () => {
    selectRow(dom, 'r1');
    pressEnter(dom);
    await flush();
    assert.deepEqual(fake.deletedIds(), [], '↩ must never be treated as a delete');
    assert.deepEqual(rowIds(dom), ['r1', 'r2', 'r3'], 'paste does not remove the item from the list');
  });

  await t.test('deleting the middle item moves selection to the next item', async () => {
    selectRow(dom, 'r2');
    pressCmdBackspace(dom);
    await flush(6);
    assert.deepEqual(fake.deletedIds(), ['r2'], 'exactly the selected item was sent for deletion');
    assert.deepEqual(rowIds(dom), ['r1', 'r3'], 'removed from the list and not duplicated');
    assert.ok(
      dom.window.document.querySelector('.row[data-id="r3"]').classList.contains('selected'),
      'selection moved to the next item'
    );
  });

  await t.test('the deletion survives a refresh — it does not come back', async () => {
    fake.emit('panel://shown', null);
    await flush(6);
    assert.deepEqual(rowIds(dom), ['r1', 'r3'], 'r2 stays gone after a full reload of state');
  });

  await t.test('deleting the last item in the list moves selection to the previous item', async () => {
    selectRow(dom, 'r3');
    pressCmdBackspace(dom);
    await flush(6);
    assert.deepEqual(rowIds(dom), ['r1']);
    assert.ok(
      dom.window.document.querySelector('.row[data-id="r1"]').classList.contains('selected'),
      'selection fell back to the previous (now only) item'
    );
  });

  await t.test('deleting the only remaining item leaves selection empty, not stuck', async () => {
    selectRow(dom, 'r1');
    pressCmdBackspace(dom);
    await flush(6);
    assert.deepEqual(rowIds(dom), []);
    assert.match(listText(dom), /الرفّ فارغ/, 'reads as the natural empty state, not an error');
    assert.equal(
      dom.window.document.querySelector('.state-view.is-failure'),
      null,
      'an emptied shelf is never the failure state'
    );
  });

  await t.test('no uncaught errors across the whole flow', () => {
    assert.deepEqual(uncaught, []);
  });
});
