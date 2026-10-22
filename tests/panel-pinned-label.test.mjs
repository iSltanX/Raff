// IMP-07: a pinned item can be given a name from the preview («تسمية»),
// which shows above its text in the list and is found by search. Only pinned
// items: the button is not offered for history rows. Enter saves, Escape
// cancels and gives the keyboard back to search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

test('a pinned item is named from the preview, shown and searched by its name', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [sampleItem('p1', { text: 'طريق الملك ٠٠ حي التجربة', isPinned: true, pinnedOrder: 0 })],
    history: [sampleItem('h1', { text: 'سطر عادي' })],
    settings: null,
    axTrusted: true,
  });
  const win = dom.window;
  const doc = win.document;
  fake.emit('panel://shown');
  await flush(10);
  const key = (init, target = win) =>
    target.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const labelButton = () => doc.querySelector('#preview [data-action="label"]');
  const form = () => doc.getElementById('preview-label-form');
  const input = () => doc.getElementById('preview-label-input');

  selectRowByKeyboard(dom, 'h1');
  key({ key: 'y', code: 'KeyY', metaKey: true });
  await flush(10);
  assert.equal(labelButton().hidden, true, 'not for a history row');

  selectRowByKeyboard(dom, 'p1');
  await flush(10);
  assert.equal(labelButton().hidden, false, 'offered for a pinned row');
  labelButton().dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush(5);
  assert.equal(form().hidden, false);
  assert.equal(doc.activeElement, input(), 'the field takes the keyboard');

  input().value = '  عنوان المكتب ';
  key({ key: 'Enter' }, input());
  await flush(15);
  assert.deepEqual(fake.invocationArgs('set_label').at(-1), { id: 'p1', label: 'عنوان المكتب' });
  assert.equal(fake.invokeCount('paste_item'), 0, 'Enter in the field saves, it does not paste');
  assert.equal(form().hidden, true);
  assert.equal(doc.querySelector('.row[data-id="p1"] .row-label')?.textContent, 'عنوان المكتب');

  // Found by its name.
  const search = doc.getElementById('search');
  search.focus();
  search.value = 'المكتب';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  await flush(10);
  assert.deepEqual([...doc.querySelectorAll('.row[data-id]')].map((r) => r.dataset.id), ['p1']);

  // Escape in the field cancels and hands the keyboard back.
  search.value = '';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  await flush(10);
  selectRowByKeyboard(dom, 'p1');
  if (doc.getElementById('preview').hidden) key({ key: 'y', code: 'KeyY', metaKey: true });
  await flush(10);
  assert.equal(doc.getElementById('preview').dataset.id, 'p1');
  labelButton().dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush(5);
  assert.equal(input().value, 'عنوان المكتب', 'the field starts from the current name');
  const before = fake.invokeCount('set_label');
  key({ key: 'Escape' }, input());
  await flush(5);
  assert.equal(form().hidden, true);
  assert.equal(fake.invokeCount('set_label'), before, 'nothing saved');
  assert.equal(doc.activeElement, doc.getElementById('search'));
  assert.equal(doc.getElementById('preview').hidden, false, 'Escape closed the field, not the preview');
});
