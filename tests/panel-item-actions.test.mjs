import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  click,
  flush,
  minutesAgo,
  mountPanel,
  rowIds,
  sampleItem,
  wait,
} from './helpers/panel-harness.mjs';

const row = (dom, id) => dom.window.document.querySelector(`.row[data-id="${id}"]`);
const pin = (dom, id) => row(dom, id)?.querySelector('.pin-btn');
const trash = (dom, id) => row(dom, id)?.querySelector('.delete-btn');
const toast = (dom) => dom.window.document.getElementById('toast');
const toastText = (dom) => dom.window.document.getElementById('toast-message').textContent;

function shortcut(dom, init) {
  const event = new dom.window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  dom.window.dispatchEvent(event);
  return event;
}

test('row actions and feedback are transactional, accessible, and deterministic', async (t) => {
  const { dom, fake, timers, uncaught } = await mountPanel({
    pinned: [
      sampleItem('p1', {
        text: 'pinned item',
        isPinned: true,
        createdAt: minutesAgo(50),
      }),
    ],
    history: [
      sampleItem('r1', { createdAt: minutesAgo(1) }),
      sampleItem('r2', { createdAt: minutesAgo(2) }),
      sampleItem('r3', { createdAt: minutesAgo(3) }),
      sampleItem('r4', { createdAt: minutesAgo(4) }),
    ],
    settings: null,
    axTrusted: true,
  });

  await t.test('interactive rows use valid grid semantics and exact control names', () => {
    const list = dom.window.document.getElementById('list');
    const current = row(dom, 'r1');
    assert.equal(dom.window.document.documentElement.dir, 'rtl');
    assert.equal(dom.window.document.getElementById('search').getAttribute('aria-haspopup'), 'grid');
    assert.equal(list.getAttribute('role'), 'grid');
    assert.equal(list.getAttribute('aria-rowcount'), '5');
    assert.equal(current.getAttribute('role'), 'row');
    assert.equal(current.getAttribute('aria-selected'), 'false');
    assert.equal(current.querySelectorAll(':scope > [role="gridcell"]').length, 3);

    assert.equal(pin(dom, 'r1').tabIndex, 0);
    assert.equal(pin(dom, 'r1').title, 'تثبيت العنصر');
    assert.equal(pin(dom, 'r1').getAttribute('aria-label'), 'تثبيت العنصر');
    assert.equal(pin(dom, 'r1').getAttribute('aria-pressed'), 'false');
    assert.equal(pin(dom, 'p1').title, 'إلغاء تثبيت العنصر');
    assert.equal(pin(dom, 'p1').getAttribute('aria-label'), 'إلغاء تثبيت العنصر');
    assert.equal(pin(dom, 'p1').getAttribute('aria-pressed'), 'true');
    assert.equal(trash(dom, 'r2').tabIndex, 0);
    assert.equal(trash(dom, 'r2').title, 'حذف العنصر');
    assert.equal(trash(dom, 'r2').getAttribute('aria-label'), 'حذف العنصر');

    const live = dom.window.document.getElementById('feedback-announcer');
    assert.equal(live.hidden, false, 'live announcer remains mounted while visual toast is hidden');
    assert.equal(live.getAttribute('role'), 'status');
    assert.equal(live.getAttribute('aria-live'), 'polite');
    assert.equal(live.getAttribute('aria-atomic'), 'true');
    assert.equal(toast(dom).getAttribute('role'), 'group');
    assert.equal(dom.window.document.getElementById('toast-icon').getAttribute('aria-hidden'), 'true');
    assert.equal(dom.window.document.getElementById('toast-undo').getAttribute('aria-label'), 'تراجع');
    assert.deepEqual(
      [...dom.window.document.querySelectorAll('#footer-hint .shortcut-hint')].map((hint) =>
        hint.textContent
      ),
      ['⌘Fبحث', '⌘,الإعدادات']
    );
  });

  await t.test('mouse pin and unpin paint immediately and use exact three-second feedback', async () => {
    const firstPin = pin(dom, 'r2');
    click(dom, firstPin);
    assert.equal(pin(dom, 'r2').getAttribute('aria-pressed'), 'true', 'optimistic pin is synchronous');
    assert.equal(pin(dom, 'r2').title, 'إلغاء تثبيت العنصر');
    await flush(10);

    assert.equal(fake.invokeCount('toggle_pin'), 1);
    assert.equal(toastText(dom), 'تم تثبيت العنصر');
    assert.equal(toast(dom).dataset.kind, 'pin');
    assert.equal(dom.window.document.getElementById('feedback-announcer').textContent, 'تم تثبيت العنصر');
    assert.equal(dom.window.document.getElementById('panel-feedback').hidden, false);
    assert.equal(dom.window.document.getElementById('footer-hint').hidden, false);
    assert.ok(timers.feedbackTimeouts.includes(3000));
    timers.fireFeedback(3000);
    timers.fireFeedback(120);
    await flush();
    assert.equal(dom.window.document.getElementById('panel-feedback').hidden, true);

    click(dom, pin(dom, 'r2'));
    assert.equal(pin(dom, 'r2').getAttribute('aria-pressed'), 'false', 'optimistic unpin is synchronous');
    await flush(10);
    assert.equal(fake.invokeCount('toggle_pin'), 2);
    assert.equal(toastText(dom), 'تم إلغاء تثبيت العنصر');
    assert.equal(toast(dom).dataset.kind, 'unpin');
    timers.fireFeedback(3000);
    timers.fireFeedback(120);
    await flush();
  });

  await t.test('mouse delete targets its own row and Undo restores the exact index', async () => {
    click(dom, row(dom, 'r1'));
    assert.equal(row(dom, 'r1').getAttribute('aria-selected'), 'true');
    const before = rowIds(dom);
    click(dom, trash(dom, 'r2'));
    assert.deepEqual(rowIds(dom), before.filter((id) => id !== 'r2'), 'only the clicked row disappears');
    assert.equal(row(dom, 'r1').getAttribute('aria-selected'), 'true', 'another row stays selected');
    await flush(10);

    assert.deepEqual(fake.deletedIds(), ['r2']);
    assert.equal(toastText(dom), 'تم حذف العنصر');
    assert.equal(toast(dom).dataset.kind, 'delete');
    assert.equal(dom.window.document.getElementById('toast-undo').hidden, false);
    assert.ok(timers.feedbackTimeouts.includes(5000));

    const undo = dom.window.document.getElementById('toast-undo');
    undo.focus();
    click(dom, undo);
    assert.deepEqual(rowIds(dom), before, 'frontend restores the exact chronological position immediately');
    assert.equal(dom.window.document.activeElement, dom.window.document.getElementById('search'));
    assert.equal(
      dom.window.document.getElementById('search').getAttribute('aria-activedescendant'),
      row(dom, 'r2').id
    );
    await flush(10);
    assert.deepEqual(rowIds(dom), before, 'native restore remains at the exact position after refresh');
    const restored = fake.getState().history.find((item) => item.id === 'r2');
    assert.ok(restored, 'native state contains the restored row');
    assert.equal(restored.isPinned, false);
    assert.equal(dom.window.document.getElementById('panel-feedback').hidden, true);
  });

  await t.test('Undo restores a deleted pinned item with its prior pinned state', async () => {
    const before = rowIds(dom);
    click(dom, trash(dom, 'p1'));
    await flush(10);
    assert.equal(row(dom, 'p1'), null);
    click(dom, dom.window.document.getElementById('toast-undo'));
    await flush(10);
    assert.deepEqual(rowIds(dom), before);
    assert.equal(fake.getState().pinned[0].id, 'p1');
    assert.equal(fake.getState().pinned[0].isPinned, true);
    assert.equal(pin(dom, 'p1').getAttribute('aria-pressed'), 'true');
    assert.equal(pin(dom, 'p1').getAttribute('aria-label'), 'إلغاء تثبيت العنصر');
  });

  await t.test('five-second expiry commits the delete and dismisses the one toast', async () => {
    click(dom, trash(dom, 'r3'));
    await flush(10);
    const token = fake.pendingDelete().token;
    assert.equal(toastText(dom), 'تم حذف العنصر');
    timers.fireFeedback(5000);
    timers.fireFeedback(120);
    await flush(10);
    assert.equal(fake.pendingDelete(), null);
    assert.ok(fake.committedDeleteTokens().includes(token));
    assert.equal(row(dom, 'r3'), null);
    assert.equal(dom.window.document.getElementById('panel-feedback').hidden, true);
  });

  await t.test('sequential deletes replace safely; only the newest receipt can be undone', async () => {
    click(dom, trash(dom, 'r2'));
    await flush(10);
    const firstToken = fake.pendingDelete().token;
    click(dom, trash(dom, 'r4'));
    await flush(12);

    const second = fake.pendingDelete();
    assert.notEqual(second.token, firstToken);
    assert.equal(second.item.id, 'r4');
    assert.ok(fake.committedDeleteTokens().includes(firstToken));
    assert.equal(dom.window.document.querySelectorAll('#toast:not([hidden])').length, 1);
    assert.equal(toastText(dom), 'تم حذف العنصر');
    assert.equal(dom.window.document.querySelectorAll('#toast-undo:not([hidden])').length, 1);

    click(dom, dom.window.document.getElementById('toast-undo'));
    await flush(12);
    assert.equal(row(dom, 'r2'), null, 'superseded delete stays committed');
    assert.ok(row(dom, 'r4'), 'newest delete is restored');
    assert.deepEqual(rowIds(dom), ['r1', 'r4', 'p1']);
  });

  await t.test('later feedback queues without shortening the five-second Undo window', async () => {
    click(dom, trash(dom, 'r4'));
    await flush(10);
    const deleteToken = fake.pendingDelete().token;
    assert.equal(toastText(dom), 'تم حذف العنصر');

    click(dom, pin(dom, 'r1'));
    assert.equal(pin(dom, 'r1').getAttribute('aria-pressed'), 'true');
    await flush(10);
    assert.equal(toastText(dom), 'تم حذف العنصر', 'pin feedback waits behind active Undo');
    assert.equal(fake.pendingDelete().token, deleteToken, 'later feedback does not commit early');

    timers.fireFeedback(5000);
    timers.fireFeedback(120);
    await wait(160);
    await flush(10);
    assert.equal(fake.pendingDelete(), null);
    assert.ok(fake.committedDeleteTokens().includes(deleteToken));
    assert.equal(toastText(dom), 'تم تثبيت العنصر');
    assert.equal(toast(dom).dataset.kind, 'pin');

    // Restore the shared fixture for the shortcut test that follows.
    click(dom, pin(dom, 'r1'));
    assert.equal(pin(dom, 'r1').getAttribute('aria-pressed'), 'false');
    await flush(10);
  });

  await t.test('Option-P and Command-Backspace use the same live paths', async () => {
    click(dom, row(dom, 'r1'));
    const pinEvent = shortcut(dom, { key: 'p', code: 'KeyP', altKey: true });
    assert.equal(pinEvent.defaultPrevented, true);
    assert.equal(pin(dom, 'r1').getAttribute('aria-pressed'), 'true');
    await flush(10);
    assert.equal(toastText(dom), 'تم تثبيت العنصر');

    const deleteEvent = shortcut(dom, { key: 'Backspace', metaKey: true });
    assert.equal(deleteEvent.defaultPrevented, true);
    assert.equal(row(dom, 'r1'), null);
    await flush(12);
    assert.equal(toastText(dom), 'تم حذف العنصر');
    assert.equal(dom.window.document.getElementById('toast-undo').hidden, false);
  });

  await t.test('Undo accepts exactly Command-Z and rejects extra modifiers', async () => {
    const pendingToken = fake.pendingDelete().token;
    for (const modifiers of [{ altKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      const event = shortcut(dom, {
        key: 'z',
        code: 'KeyZ',
        metaKey: true,
        ...modifiers,
      });
      assert.equal(event.defaultPrevented, false);
      assert.equal(fake.pendingDelete().token, pendingToken);
      assert.equal(row(dom, 'r1'), null);
    }

    const undoEvent = shortcut(dom, { key: 'z', code: 'KeyZ', metaKey: true });
    assert.equal(undoEvent.defaultPrevented, true);
    assert.ok(row(dom, 'r1'), 'exact Command-Z restores the active receipt immediately');
    await flush(10);
    assert.equal(fake.pendingDelete(), null);
  });

  await t.test('all action flows stay free of uncaught errors', () => {
    assert.deepEqual(uncaught, []);
  });
});
