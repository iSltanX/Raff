// The first click after the panel opens chose nothing (2026-10-27).
//
// Pressing a row gives the page the focus it lost when the panel was shown,
// and the window's `focus` handler refreshes the list: the rows were rebuilt
// while the button was still down (live trace: `renderList` 3–5 ms after
// `mousedown`, the release 120–220 ms later). WebKit sends `click` only to the
// element the press began on, and that row was gone — so nothing was copied
// or pasted, and the hand settling on the new row opened the hover preview
// instead. A second click worked, the page being focused by then.
//
// The press is modelled as WebKit delivers it: `mousedown` on the row, the
// window's `focus`, the refresh answering with the button down, `mouseup` on
// whatever row is under the pointer now, and `click` only if that is the row
// the press began on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, minutesAgo, mountPanel, rowIds, sampleItem, wait } from './helpers/panel-harness.mjs';
import { DWELL_MS } from '../src/js/hover-intent.js';

test('a row pressed while the list refreshes is the row the click chooses', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [
      sampleItem('h1', { createdAt: minutesAgo(1) }),
      sampleItem('h2', { createdAt: minutesAgo(2) }),
      sampleItem('h3', { createdAt: minutesAgo(3) }),
    ],
    axTrusted: false,
  });
  const win = dom.window;
  const doc = win.document;
  const row = (id) => doc.querySelector(`#list .row[data-id="${id}"]`);
  const preview = doc.getElementById('preview');
  const at = (x, y) => ({ bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

  // Something changes while the panel is open: the refresh the press sets off
  // has news to draw.
  const state = fake.getState();
  state.history.unshift(sampleItem('h9', { createdAt: minutesAgo(0) }));
  fake.setState(state);

  const refreshesBefore = fake.getStateCallCount();
  const pressed = row('h2');
  pressed.dispatchEvent(new win.MouseEvent('mouseover', at(200, 100)));
  pressed.dispatchEvent(new win.MouseEvent('mousedown', at(200, 100)));
  win.dispatchEvent(new win.FocusEvent('focus'));
  await flush(10); // the refresh answers; the button is still down
  assert.ok(fake.getStateCallCount() > refreshesBefore, 'the press refreshed the list');

  row('h2').dispatchEvent(new win.MouseEvent('mouseup', at(200, 100)));
  // WebKit sends `click` right after the `mouseup`, in the same turn: the row
  // the press began on has to be there still, past the release's handlers.
  const kept = pressed.isConnected && row('h2') === pressed;
  assert.ok(kept, 'the pressed row is still the one under the pointer');
  if (kept) pressed.dispatchEvent(new win.MouseEvent('click', at(200, 100)));
  await flush(10);

  assert.deepEqual(fake.invocationArgs('paste_item').map((args) => args.id), ['h2']);
  assert.ok(rowIds(dom).includes('h9'), 'what changed during the press is drawn after it');

  // The hand settles after the click, a few points off and then more, still
  // on the row. Copied only (no Accessibility), the panel stays — and the
  // click is not a request to preview the row.
  row('h2').dispatchEvent(new win.MouseEvent('mousemove', at(202, 101)));
  row('h2').dispatchEvent(new win.MouseEvent('mousemove', at(214, 104)));
  await wait(DWELL_MS + 150);
  await flush();
  assert.equal(preview.hidden, true, 'no preview after a click');
  assert.equal(fake.invokeCount('panel_preview_side'), 0);

  // Hover still previews once the pointer goes to another row.
  row('h3').dispatchEvent(new win.MouseEvent('mouseover', at(200, 160)));
  row('h3').dispatchEvent(new win.MouseEvent('mousemove', at(204, 162)));
  await wait(DWELL_MS + 150);
  await flush();
  assert.equal(preview.hidden, false, 'hover previews again');
  assert.equal(preview.dataset.id, 'h3');

  // A click on the row that preview is of chooses it, and the hover preview
  // goes with the click.
  const clickRow = (id, x, y) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      row(id).dispatchEvent(new win.MouseEvent(type, at(x, y)));
    }
  };
  clickRow('h3', 204, 162);
  await flush(10);
  assert.equal(preview.hidden, true, 'a hover preview closes with the click');

  // A preview a right-click held open is the user's: a click keeps it, and
  // it follows the choice.
  row('h1').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await flush(10);
  assert.equal(preview.dataset.id, 'h1');
  clickRow('h1', 200, 40);
  await flush(10);
  assert.equal(preview.hidden, false, 'a held preview stays');
  assert.equal(preview.dataset.id, 'h1');
  assert.deepEqual(fake.invocationArgs('paste_item').map((args) => args.id), ['h2', 'h3', 'h1']);
});
