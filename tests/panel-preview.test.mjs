// The preview beside the panel (approved proposal, Figma «05 · التفاصيل والفحص»
// 45:5325 / 45:5512). Its triggers were chosen after reading how the panel
// already behaves (decisions ت٣٢):
//
//   - hover, with intent: the pointer has to rest on one item ~300 ms; passing
//     over rows on the way somewhere never opens it;
//   - right-click opens it at once — the panel has no context menu to keep;
//   - Space (while the search is empty) and ⌘Y toggle it from the keyboard,
//     and it then follows the selection;
//   - Esc closes it before it closes the panel.
//
// Hover only previews: it never changes the selection, never takes the focus
// from the search field, never copies or pastes. A click still chooses. The
// preview's own buttons act on the item it shows and leave the focus where
// it was. It works on rows and on the Images grid alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, minutesAgo, mountPanel, sampleItem, wait } from './helpers/panel-harness.mjs';

const DWELL = 300;

test('panel: the preview opens with intent, previews only, and closes in order', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [
      sampleItem('a', {
        text: 'اجتماع الفريق الساعة ٤ عصرًا في القاعة الكبيرة',
        createdAt: minutesAgo(1),
        copyCount: 3,
        pasteCount: 5,
      }),
      sampleItem('b', { type: 'link', text: 'https://github.com/iSltanX/Raff', createdAt: minutesAgo(2) }),
      sampleItem('c', { text: 'ثالث', createdAt: minutesAgo(3) }),
      sampleItem('img', { type: 'image', text: 'لقطة شاشة', hasImage: true, createdAt: minutesAgo(4) }),
    ],
    settings: { captureEnabled: true, hotkey: 'shift+super+v', retentionDays: 30 },
    axTrusted: true,
  });
  const win = dom.window;
  const doc = win.document;
  const html = doc.documentElement;
  const search = doc.getElementById('search');
  const preview = doc.getElementById('preview');
  const row = (id) => doc.querySelector(`#list .row[data-id="${id}"]`);
  const isOpen = () => !preview.hidden;
  const shows = () => preview.dataset.id ?? null;
  const pointer = (el, type, init = {}) =>
    el.dispatchEvent(new win.MouseEvent(type, { bubbles: type !== 'mouseenter' && type !== 'mouseleave', cancelable: true, clientX: 100, clientY: 100, ...init }));
  const hover = (el, init) => {
    pointer(el, 'mouseover', init);
    pointer(el, 'mousemove', init);
  };
  const key = (init) => win.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const leavePanel = () => pointer(doc.getElementById('panel'), 'mouseout', { relatedTarget: doc.body });

  search.focus();

  await t.test('passing over rows on the way somewhere opens nothing', async () => {
    hover(row('a'));
    await wait(DWELL / 3);
    hover(row('b'));
    await wait(DWELL / 3);
    hover(row('c'));
    await wait(DWELL / 3);
    leavePanel();
    await wait(DWELL);
    assert.equal(isOpen(), false);
    assert.equal(fake.invokeCount('set_panel_preview'), 0, 'the window never widened');
  });

  await t.test('resting on a row opens its preview — and changes nothing else', async () => {
    hover(row('a'));
    await wait(DWELL + 80);
    await flush(4);
    assert.equal(isOpen(), true);
    assert.equal(shows(), 'a');
    assert.equal(html.dataset.preview, 'left', 'beside the panel, on the side with room');
    assert.deepEqual(fake.invocationArgs('set_panel_preview').at(-1), { side: 'left' });
    assert.equal(doc.querySelector('#list .row.selected'), null, 'no selection');
    assert.equal(doc.activeElement, search, 'the search keeps the focus');
    assert.equal(fake.invokeCount('paste_item') + fake.invokeCount('copy_item'), 0, 'nothing copied or pasted');
  });

  await t.test('it says what the item is, when, from where, how big, and what keeps it', () => {
    assert.match(preview.querySelector('.preview-kind').textContent, /نص/u);
    assert.match(preview.querySelector('.preview-when').textContent, /Notes/u);
    assert.match(preview.querySelector('.preview-size').textContent, /حرفًا/u);
    assert.equal(preview.querySelector('.preview-body').textContent, 'اجتماع الفريق الساعة ٤ عصرًا في القاعة الكبيرة');
    assert.match(preview.querySelector('.preview-notes').textContent, /نُسخ ٣ مرات · لُصق ٥ مرات/u);
    assert.match(preview.querySelector('.preview-notes').textContent, /يُحذف بعد .* ما لم يُثبَّت/u);
  });

  await t.test('resting on another row follows it; leaving everything closes it', async () => {
    hover(row('b'));
    await wait(DWELL);
    assert.equal(shows(), 'b');
    assert.match(preview.querySelector('.preview-body').textContent, /github\.com/u);
    leavePanel();
    await wait(DWELL + 80);
    await flush(4);
    assert.equal(isOpen(), false);
    assert.deepEqual(fake.invocationArgs('set_panel_preview').at(-1), { side: null }, 'the window narrows back');
    assert.equal(html.dataset.preview, undefined);
  });

  await t.test('crossing the gap to the preview keeps it open, and its buttons work in place', async () => {
    hover(row('a'));
    await wait(DWELL + 80);
    await flush(4);
    assert.equal(isOpen(), true);
    leavePanel();
    await wait(40);
    hover(preview);
    await wait(DWELL + 80);
    assert.equal(isOpen(), true, 'still open while the pointer is on it');

    const copy = preview.querySelector('[data-action="copy"]');
    const down = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    copy.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true, 'pressing a button does not take the focus');
    copy.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush(4);
    assert.deepEqual(fake.invocationArgs('copy_item').at(-1), { id: 'a' });
    assert.equal(doc.activeElement, search);

    preview.querySelector('[data-action="paste"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await flush(4);
    assert.equal(fake.invocationArgs('paste_item').at(-1)?.id, 'a');
    preview.querySelector('[data-action="plain"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await flush(4);
    assert.deepEqual(fake.invocationArgs('paste_item').at(-1), { id: 'a', plain: true });

    pointer(preview, 'mouseout', { relatedTarget: doc.body });
    await wait(DWELL + 80);
    await flush(4);
    assert.equal(isOpen(), false, 'leaving the preview too closes it');
  });

  await t.test('right-click opens it at once, without a menu and without selecting', async () => {
    const menu = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    row('c').dispatchEvent(menu);
    await flush(4);
    assert.equal(menu.defaultPrevented, true);
    assert.equal(isOpen(), true);
    assert.equal(shows(), 'c');
    assert.equal(doc.querySelector('#list .row.selected'), null);
    key({ key: 'Escape' });
    await flush(4);
    assert.equal(isOpen(), false, 'Esc closes the preview first');
    assert.equal(fake.invokeCount('hide_panel'), 0, 'not the panel');
  });

  await t.test('Space and ⌘Y toggle it from the keyboard, and it follows the selection', async () => {
    key({ key: 'ArrowDown' });
    assert.equal(doc.querySelector('#list .row.selected')?.dataset.id, 'a');
    key({ key: ' ', code: 'Space' });
    await flush(4);
    assert.equal(isOpen(), true);
    assert.equal(shows(), 'a');
    key({ key: 'ArrowDown' });
    await flush(2);
    assert.equal(shows(), 'b', 'follows the selection');
    key({ key: ' ', code: 'Space' });
    await flush(4);
    assert.equal(isOpen(), false);
    key({ key: 'y', code: 'KeyY', metaKey: true });
    await flush(4);
    assert.equal(isOpen(), true);
    key({ key: 'y', code: 'KeyY', metaKey: true });
    await flush(4);
    assert.equal(isOpen(), false);
  });

  await t.test('while searching, Space is a space', async () => {
    search.value = 'ا';
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush(4);
    const space = new win.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    win.dispatchEvent(space);
    await flush(4);
    assert.equal(space.defaultPrevented, false);
    assert.equal(isOpen(), false);
    search.value = '';
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
    await flush(4);
  });

  await t.test('it previews cards in the Images grid, picture included', async () => {
    doc.querySelector('#filters .segment[data-filter="image"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await flush(4);
    hover(row('img'));
    await wait(DWELL + 80);
    await flush(6);
    assert.equal(isOpen(), true);
    assert.equal(shows(), 'img');
    assert.match(preview.querySelector('.preview-kind').textContent, /صورة/u);
    assert.ok(preview.querySelector('.preview-body img'), 'the picture itself');
    leavePanel();
    await wait(DWELL + 80);
  });

  await t.test('a panel that appears under a resting pointer previews nothing until it moves', async () => {
    const state = fake.getState();
    fake.setState({ ...state, previewSide: 'left' });
    fake.emit('panel://shown', null);
    await flush(6);
    const first = doc.querySelector('#list .row');
    // WebKit re-sends the pointer where it already is when content changes
    // under it; that is not a person resting on a row.
    hover(first, { clientX: 300, clientY: 140 });
    await wait(DWELL + 80);
    await flush(4);
    assert.equal(isOpen(), false, 'appearing under the pointer is not intent');
    hover(first, { clientX: 312, clientY: 141 });
    hover(first, { clientX: 312, clientY: 141 });
    await wait(DWELL + 80);
    await flush(6);
    assert.equal(isOpen(), true, 'once it moves and rests, it previews');
    key({ key: 'Escape' });
    await flush(4);
    fake.setState(state);
  });

  await t.test('no room on either side: no preview, and nothing breaks', async () => {
    const state = fake.getState();
    fake.setState({ ...state, previewSide: null });
    hover(row('img'));
    await wait(DWELL + 80);
    await flush(6);
    assert.equal(isOpen(), false);
    assert.equal(html.dataset.preview, undefined);
  });
});
