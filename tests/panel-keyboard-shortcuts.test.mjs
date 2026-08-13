// Focused keyboard-contract coverage for Raff's long-lived floating panel.
//
// Keep this suite layout-free: it drives the real `panel.js` keydown handler
// through jsdom and observes DOM selection/focus plus the exact Tauri command
// arguments recorded by the shared panel harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  rowIds,
  click,
  selectRowByKeyboard,
} from './helpers/panel-harness.mjs';

function press(dom, init) {
  const event = new dom.window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  dom.window.dispatchEvent(event);
  return event;
}

function pressOn(dom, target, init) {
  const event = new dom.window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function selectedId(dom) {
  return dom.window.document.querySelector('.row.selected')?.dataset.id ?? null;
}

function selectRow(dom, id) {
  selectRowByKeyboard(dom, id);
}

function setSearch(dom, value) {
  const search = dom.window.document.getElementById('search');
  search.value = value;
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return search;
}

test('panel keyboard contract: navigation, actions, search routing, and native editing', async (t) => {
  const history = Array.from({ length: 10 }, (_, index) =>
    sampleItem(`r${index + 1}`, {
      text: `clip ${index + 1}`,
      createdAt: minutesAgo(index + 1),
    })
  );
  const { dom, fake, uncaught } = await mountPanel({
    pinned: [],
    history,
    settings: null,
    axTrusted: true,
  });

  await t.test('idle list starts intentionally unselected and exposes no active descendant', () => {
    const search = dom.window.document.getElementById('search');
    const list = dom.window.document.getElementById('list');
    const rows = [...list.querySelectorAll('[role="row"]')];

    assert.equal(search.getAttribute('role'), 'combobox');
    assert.equal(search.getAttribute('aria-controls'), list.id);
    assert.equal(search.getAttribute('aria-autocomplete'), 'list');
    assert.equal(search.getAttribute('aria-expanded'), 'false');
    assert.equal(search.getAttribute('aria-haspopup'), 'grid');
    assert.equal(list.getAttribute('role'), 'grid');
    assert.equal(list.getAttribute('aria-rowcount'), String(history.length));
    assert.equal(rows.length, history.length);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'row IDs are unique');
    assert.ok(rows.every((row) => row.id), 'every row has an ID');
    assert.ok(
      rows.every((row) => row.querySelectorAll(':scope > [role="gridcell"]').length === 3),
      'each interactive row exposes its four semantic cells'
    );
    assert.equal(search.hasAttribute('aria-activedescendant'), false);
    assert.equal(list.querySelector('[role="row"][aria-selected="true"]'), null);
    assert.deepEqual(
      [...dom.window.document.querySelectorAll('#footer-hint .shortcut-hint')].map((hint) => [
        hint.querySelector('kbd').textContent,
        hint.querySelector('.shortcut-label').textContent,
      ]),
      [
        ['⌘F', 'بحث'],
        ['⌘,', 'الإعدادات'],
      ]
    );
  });

  await t.test('filter tabs rove in RTL order and automatically activate', () => {
    const segments = [...dom.window.document.querySelectorAll('#filters [role="tab"]')];
    const active = () => segments.find((segment) => segment.getAttribute('aria-selected') === 'true');
    const tabbable = () => segments.filter((segment) => segment.tabIndex === 0);

    assert.equal(active().dataset.filter, 'all');
    assert.deepEqual(tabbable(), [active()]);
    segments[0].focus();

    const left = pressOn(dom, segments[0], { key: 'ArrowLeft' });
    assert.equal(left.defaultPrevented, true);
    assert.equal(active().dataset.filter, 'text');
    assert.equal(dom.window.document.activeElement, segments[1]);
    assert.deepEqual(tabbable(), [segments[1]]);

    pressOn(dom, segments[1], { key: 'End' });
    assert.equal(active().dataset.filter, 'pinned');
    assert.equal(dom.window.document.getElementById('list').getAttribute('role'), 'region');
    assert.equal(dom.window.document.getElementById('search').hasAttribute('aria-activedescendant'), false);
    assert.equal(dom.window.document.querySelector('.state-view.is-no-results')?.getAttribute('role'), 'status');

    pressOn(dom, segments.at(-1), { key: 'Home' });
    assert.equal(active().dataset.filter, 'all');
    assert.equal(dom.window.document.activeElement, segments[0]);
    assert.deepEqual(tabbable(), [segments[0]]);

    pressOn(dom, segments[0], { key: 'ArrowRight' });
    assert.equal(active().dataset.filter, 'pinned', 'ArrowRight wraps to the visual left edge');
    pressOn(dom, segments.at(-1), { key: 'Home' });
    assert.equal(active().dataset.filter, 'all');
  });

  await t.test('Settings is tabbable and has the standard macOS shortcut', async () => {
    const settingsButton = dom.window.document.getElementById('settings-btn');
    assert.equal(settingsButton.tabIndex, 0);
    assert.equal(settingsButton.getAttribute('aria-keyshortcuts'), 'Meta+,');
    const before = fake.invokeCount('open_settings');
    const shortcut = press(dom, { key: ',', code: 'Comma', metaKey: true });
    await flush();
    assert.equal(shortcut.defaultPrevented, true);
    assert.equal(fake.invokeCount('open_settings'), before + 1);
  });

  await t.test('Arrow and Page navigation clamp at both list boundaries', () => {
    const search = dom.window.document.getElementById('search');
    search.blur();
    assert.equal(selectedId(dom), null, 'idle content begins without a selected row');

    assert.equal(press(dom, { key: 'ArrowDown' }).defaultPrevented, true);
    assert.equal(selectedId(dom), 'r1', 'ArrowDown enters the grid at the first row');

    assert.equal(press(dom, { key: 'ArrowUp' }).defaultPrevented, true);
    assert.equal(selectedId(dom), 'r1', 'ArrowUp cannot move before the first row');

    press(dom, { key: 'ArrowDown' });
    assert.equal(selectedId(dom), 'r2');
    assert.equal(
      dom.window.document.getElementById('search').getAttribute('aria-activedescendant'),
      dom.window.document.querySelector('.row.selected').id,
      'the announced active option follows keyboard selection'
    );
    press(dom, { key: 'PageDown' });
    assert.equal(selectedId(dom), 'r8', 'PageDown advances six rows');
    press(dom, { key: 'PageDown' });
    assert.equal(selectedId(dom), 'r10', 'PageDown clamps to the final row');
    press(dom, { key: 'ArrowDown' });
    assert.equal(selectedId(dom), 'r10', 'ArrowDown cannot move beyond the final row');

    press(dom, { key: 'PageUp' });
    assert.equal(selectedId(dom), 'r4', 'PageUp retreats six rows');
    press(dom, { key: 'PageUp' });
    assert.equal(selectedId(dom), 'r1', 'PageUp clamps to the first row');
    press(dom, { key: 'ArrowUp' });
    assert.equal(selectedId(dom), 'r1');
  });

  await t.test('selection scrolls only the results container, never the WebView document', () => {
    const list = dom.window.document.getElementById('list');
    const originalRect = dom.window.Element.prototype.getBoundingClientRect;
    dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === list) return { top: 100, bottom: 300, left: 0, right: 500, width: 500, height: 200 };
      if (this.classList?.contains('selected')) {
        return { top: 50, bottom: 90, left: 0, right: 500, width: 500, height: 40 };
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    };

    // Land on the row *before* the one under test first, then stage the
    // scroll position, so exactly ONE selection move is measured. (Getting
    // there is several arrow presses now that clicking a row pastes it, and
    // every press re-runs the scroll adjustment.)
    selectRow(dom, 'r1');
    list.scrollTop = 100;
    press(dom, { key: 'ArrowDown' });
    assert.equal(selectedId(dom), 'r2');
    assert.equal(list.scrollTop, 50, 'an item above the viewport adjusts the list itself');
    assert.equal(dom.window.scrollY, 0, 'panel chrome remains at the document origin');
    dom.window.Element.prototype.getBoundingClientRect = originalRect;
  });

  await t.test('⌘F focuses and selects the search field', () => {
    const search = dom.window.document.getElementById('search');
    search.value = 'needle';
    search.blur();

    const event = press(dom, { key: 'f', code: 'KeyF', metaKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(dom.window.document.activeElement, search);
    assert.equal(search.selectionStart, 0);
    assert.equal(search.selectionEnd, search.value.length);

    setSearch(dom, '');
  });

  await t.test('⌘C copies the selected row when focus is outside the editor', async () => {
    selectRow(dom, 'r3');
    const before = fake.invokeCount('copy_item');

    const event = press(dom, { key: 'c', code: 'KeyC', metaKey: true });
    await flush();

    assert.equal(event.defaultPrevented, true);
    assert.equal(fake.invokeCount('copy_item'), before + 1);
    assert.deepEqual(fake.invocationArgs('copy_item').at(-1), { id: 'r3' });
  });

  await t.test('Enter pastes normally and Option-Enter requests plain text', async () => {
    selectRow(dom, 'r4');
    const normal = press(dom, { key: 'Enter' });
    await flush();
    assert.equal(normal.defaultPrevented, true);
    assert.deepEqual(fake.invocationArgs('paste_item').at(-1), { id: 'r4', plain: false });

    selectRow(dom, 'r5');
    const plain = press(dom, { key: 'Enter', altKey: true });
    await flush();
    assert.equal(plain.defaultPrevented, true);
    assert.deepEqual(fake.invocationArgs('paste_item').at(-1), { id: 'r5', plain: true });
  });

  await t.test('Escape clears an active query first, then hides on the next press', async () => {
    const search = setSearch(dom, 'clip 8');
    search.focus();
    assert.deepEqual(rowIds(dom), ['r8']);
    const hidesBefore = fake.invokeCount('hide_panel');

    const clear = press(dom, { key: 'Escape' });
    await flush();
    assert.equal(clear.defaultPrevented, true);
    assert.equal(search.value, '');
    assert.deepEqual(rowIds(dom), history.map((item) => item.id));
    assert.equal(fake.invokeCount('hide_panel'), hidesBefore, 'clearing does not hide the panel');

    const hide = press(dom, { key: 'Escape' });
    await flush();
    assert.equal(hide.defaultPrevented, true);
    assert.equal(fake.invokeCount('hide_panel'), hidesBefore + 1);
  });

  await t.test('a printable key routes typing focus to search without cancelling its default input', () => {
    const search = dom.window.document.getElementById('search');
    search.blur();
    const event = press(dom, { key: 'ر', code: 'KeyR' });

    assert.equal(dom.window.document.activeElement, search);
    assert.equal(event.defaultPrevented, false, 'WebKit remains free to insert the printable character');
  });

  await t.test('non-printable and composing keys never steal focus', () => {
    const search = dom.window.document.getElementById('search');
    const outside = dom.window.document.querySelector('.row');
    outside.setAttribute('tabindex', '-1');

    for (const init of [
      { key: 'Shift', code: 'ShiftLeft', shiftKey: true },
      { key: 'Alt', code: 'AltLeft', altKey: true },
      { key: 'Dead', code: 'Backquote' },
      { key: 'Process', code: 'KeyA', isComposing: true },
    ]) {
      outside.focus();
      press(dom, init);
      assert.notEqual(dom.window.document.activeElement, search, `${init.key} keeps native focus`);
    }
  });

  await t.test('Option-P invokes pin for the selected row', async () => {
    selectRow(dom, 'r6');
    const before = fake.invokeCount('toggle_pin');

    const event = press(dom, { key: 'p', code: 'KeyP', altKey: true });
    await flush();

    assert.equal(event.defaultPrevented, true);
    assert.equal(fake.invokeCount('toggle_pin'), before + 1);
    assert.deepEqual(fake.invocationArgs('toggle_pin').at(-1), { id: 'r6', isPinned: true });
  });

  await t.test('extra modifiers do not trigger exact pin or copy shortcuts', async () => {
    selectRow(dom, 'r6');
    const pins = fake.invokeCount('toggle_pin');
    const copies = fake.invokeCount('copy_item');
    for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      press(dom, { key: 'p', code: 'KeyP', altKey: true, ...extra });
    }
    for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }]) {
      press(dom, { key: 'c', code: 'KeyC', metaKey: true, ...extra });
    }
    await flush();
    assert.equal(fake.invokeCount('toggle_pin'), pins);
    assert.equal(fake.invokeCount('copy_item'), copies);
  });

  await t.test('native search editing shortcuts are not stolen by row actions', async () => {
    const search = setSearch(dom, 'clip');
    search.focus();
    search.setSelectionRange(0, search.value.length);
    const copiesBefore = fake.invokeCount('copy_item');
    const pinsBefore = fake.invokeCount('toggle_pin');

    const copy = press(dom, { key: 'c', code: 'KeyC', metaKey: true });
    const selectAll = press(dom, { key: 'a', code: 'KeyA', metaKey: true });
    const cut = press(dom, { key: 'x', code: 'KeyX', metaKey: true });
    const paste = press(dom, { key: 'v', code: 'KeyV', metaKey: true });
    search.setSelectionRange(search.value.length, search.value.length);
    const hiddenCopy = press(dom, { key: 'c', code: 'KeyC', metaKey: true });
    const hiddenPin = press(dom, { key: 'p', code: 'KeyP', altKey: true });
    const hiddenDelete = press(dom, { key: 'Backspace', metaKey: true });
    await flush();

    assert.equal(copy.defaultPrevented, false, '⌘C remains native while editing search');
    assert.equal(selectAll.defaultPrevented, false, '⌘A remains native while editing search');
    assert.equal(cut.defaultPrevented, false, '⌘X remains native while editing search');
    assert.equal(paste.defaultPrevented, false, '⌘V remains native while editing search');
    assert.equal(hiddenCopy.defaultPrevented, false, 'collapsed-caret ⌘C stays inert/native in search');
    assert.equal(hiddenPin.defaultPrevented, false, 'undisclosed ⌥P is disabled in search');
    assert.equal(hiddenDelete.defaultPrevented, false, 'undisclosed ⌘⌫ is disabled in search');
    assert.equal(fake.invokeCount('copy_item'), copiesBefore, 'search copy never copies a clipboard row');
    assert.equal(fake.invokeCount('toggle_pin'), pinsBefore, 'editing shortcuts never pin a row');

    setSearch(dom, '');
  });

  await t.test('the complete keyboard flow produces no uncaught errors', () => {
    assert.deepEqual(uncaught, []);
  });
});
