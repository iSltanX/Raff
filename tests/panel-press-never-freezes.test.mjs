// A press on a row holds the list's re-renders until its click has landed
// (panel-press-survives-refresh). A press whose release the page never hears
// of must not leave the list frozen: typed letters would filter nothing on
// screen, and Enter would choose from rows no longer meant (review,
// 2026-10-27). Each way a press can end is checked on its own, by typing into
// the search — an `input` with no key, so only the exit under test can free
// the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, minutesAgo, mountPanel, rowIds, sampleItem } from './helpers/panel-harness.mjs';

test('a press without its release never leaves the list unpainted', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [
      sampleItem('apple', { text: 'apple', createdAt: minutesAgo(1) }),
      sampleItem('banana', { text: 'banana', createdAt: minutesAgo(2) }),
      sampleItem('cherry', { text: 'cherry', createdAt: minutesAgo(3) }),
    ],
    axTrusted: false,
  });
  const win = dom.window;
  const doc = win.document;
  const search = doc.getElementById('search');
  const all = ['apple', 'banana', 'cherry'];
  const row = (id) => doc.querySelector(`#list .row[data-id="${id}"]`);
  const press = (target, init = {}) =>
    target.dispatchEvent(
      new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init })
    );
  const type = (text) => {
    search.value = text;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  const reset = async () => {
    win.dispatchEvent(new win.MouseEvent('mousemove', { buttons: 0 }));
    type('');
    await flush();
    assert.deepEqual(rowIds(dom), all);
  };

  // The hold itself: typed during a press, drawn once the press is over.
  press(row('apple'));
  type('cherry');
  assert.deepEqual(rowIds(dom), all, 'held while the button is down');
  win.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, buttons: 0 }));
  assert.deepEqual(rowIds(dom), ['cherry'], 'the pointer moving with no button down ends it');
  await reset();

  // Not a press on a row at all.
  press(row('apple'), { ctrlKey: true });
  type('banana');
  assert.deepEqual(rowIds(dom), ['banana'], '⌃-click is a right-click');
  await reset();
  press(doc.getElementById('list'));
  type('banana');
  assert.deepEqual(rowIds(dom), ['banana'], 'the scrollbar or a gap has no click to lose');
  await reset();

  // Every other way out.
  const exits = {
    'a key': () => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Shift', bubbles: true })),
    'a menu': () => row('apple').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    'the focus leaving': () => win.dispatchEvent(new win.FocusEvent('blur')),
    'the panel hiding': () => fake.emit('panel://hidden'),
  };
  for (const [exit, end] of Object.entries(exits)) {
    press(row('apple'));
    type('cherry');
    end();
    await flush();
    assert.deepEqual(rowIds(dom), ['cherry'], exit);
    await reset();
  }

  // Shown again: the panel starts over, whatever press it was hidden under.
  press(row('apple'));
  type('cherry');
  fake.emit('panel://shown');
  await flush(10);
  assert.deepEqual(rowIds(dom), all, 'the panel shown again draws its list');
  type('banana');
  assert.deepEqual(rowIds(dom), ['banana'], 'and is not holding it any more');
});
