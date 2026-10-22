// Sultan's decision (2026-10-22): ⌥L names the selected pinned item — the
// preview opens held, with its name field taking the keyboard. By the key's
// position (`code`), so it works with the Arabic layout as with the English;
// ⌥L in the search field types nothing; inside the name field it is the
// field's; with ⌘, ⌃ or ⇧ it is not this shortcut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

test('⌥L names the selected pinned item, in both layouts, and nothing else', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [sampleItem('p1', { text: 'عنوان', isPinned: true, pinnedOrder: 0, label: 'المكتب' })],
    history: [sampleItem('h1', { text: 'سطر عادي' })],
    settings: null,
    axTrusted: true,
  });
  const win = dom.window;
  const doc = win.document;
  fake.emit('panel://shown');
  await flush(10);
  const search = doc.getElementById('search');
  const preview = doc.getElementById('preview');
  const form = doc.getElementById('preview-label-form');
  const input = doc.getElementById('preview-label-input');
  const press = (init, target = search) => {
    const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const closeAll = async () => {
    if (!form.hidden) press({ key: 'Escape' }, input);
    await flush(5);
    if (!preview.hidden) press({ key: 'y', code: 'KeyY', metaKey: true });
    await flush(10);
  };

  for (const [layout, key] of [['English', '¬'], ['Arabic', 'ﻻ']]) {
    search.focus();
    selectRowByKeyboard(dom, 'p1');
    const event = press({ key, code: 'KeyL', altKey: true });
    await flush(15);
    assert.equal(event.defaultPrevented, true, `${layout}: nothing typed into the search`);
    assert.equal(search.value, '');
    assert.equal(preview.hidden, false, `${layout}: the preview opens`);
    assert.equal(preview.dataset.id, 'p1');
    assert.equal(form.hidden, false, `${layout}: with its name field`);
    assert.equal(doc.activeElement, input);
    assert.equal(input.value, 'المكتب');

    // Inside the field ⌥L is the field's own key.
    const inField = press({ key, code: 'KeyL', altKey: true }, input);
    assert.equal(inField.defaultPrevented, false, `${layout}: the field keeps ⌥L`);
    assert.equal(form.hidden, false);
    await closeAll();
  }

  // Held down, the repeats do nothing more; and with the field open but the
  // keyboard back in search, ⌥L returns to the field without wiping it.
  search.focus();
  selectRowByKeyboard(dom, 'p1');
  press({ key: '¬', code: 'KeyL', altKey: true });
  await flush(15);
  input.value = 'نصف اسم';
  search.focus();
  press({ key: '¬', code: 'KeyL', altKey: true, repeat: true });
  await flush(10);
  assert.equal(doc.activeElement, search, 'a repeat is not a press');
  press({ key: '¬', code: 'KeyL', altKey: true });
  await flush(10);
  assert.equal(doc.activeElement, input, 'back in the field');
  assert.equal(input.value, 'نصف اسم', 'what was typed stays');
  await closeAll();

  // Not this shortcut with another modifier.
  search.focus();
  selectRowByKeyboard(dom, 'p1');
  for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
    press({ key: 'l', code: 'KeyL', altKey: true, ...extra });
    await flush(10);
    assert.equal(form.hidden, true, JSON.stringify(extra));
  }
  await closeAll();

  // A history row: said, not opened.
  selectRowByKeyboard(dom, 'h1');
  press({ key: '¬', code: 'KeyL', altKey: true });
  await flush(10);
  assert.equal(form.hidden, true);
  assert.match(doc.getElementById('toast')?.textContent ?? doc.body.textContent, /التسمية للمثبّتات فقط\. ثبّته أولًا بـ⁦⌥P⁩/u);

  // Unpinned with its name field open: the field goes, the keyboard returns.
  selectRowByKeyboard(dom, 'p1');
  press({ key: '¬', code: 'KeyL', altKey: true });
  await flush(15);
  assert.equal(form.hidden, false);
  const state = fake.getState();
  const item = state.pinned.find((entry) => entry.id === 'p1');
  fake.setState({ ...state, pinned: [], history: [{ ...item, isPinned: false, pinnedOrder: null }, ...state.history] });
  fake.emit('raff://changed');
  await flush(20);
  assert.equal(form.hidden, true, 'no name field for an item no longer pinned');
  assert.equal(preview.querySelector('[data-action="label"]').hidden, true);
  assert.equal(doc.activeElement, search);
});
