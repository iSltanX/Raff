// IMP-07 after the interface review (2026-10-22), each point checked live
// first (`evidence/2026-10-22-m9/ui-review-live-before.txt`):
//   - a name being typed survives the pointer leaving a hover preview;
//   - the field replaces «تسمية» while open, and saving an unchanged name
//     writes nothing;
//   - in the list the name sits above the text, in one column with it;
//   - the field is styled in the panel, and «حفظ» is not a second accent
//     button beside «لصق».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { flush, mountPanel, sampleItem, wait } from './helpers/panel-harness.mjs';
import { DWELL_MS as DWELL } from '../src/js/hover-intent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = (name) => readFileSync(path.join(here, '../src', name), 'utf8');
const html = readFileSync(path.join(here, '../src/index.html'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(sheet, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(sheet);
  return match ? match[1] : null;
}

test('the name: one column in the list; in the preview, hover, its button, unchanged names', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [
      sampleItem('p1', { text: 'طريق الملك ٠٠ حي التجربة', isPinned: true, pinnedOrder: 0, label: 'المكتب' }),
      sampleItem('p2', { text: 'بلا اسم', isPinned: true, pinnedOrder: 1 }),
    ],
    history: [],
    settings: null,
    axTrusted: true,
  });
  const win = dom.window;
  const doc = win.document;
  fake.emit('panel://shown');
  await flush(10);

  // In the list the name is above the text, in one column with it.
  const named = doc.querySelector('.row[data-id="p1"] .row-label');
  const stack = named?.parentElement;
  assert.equal(stack?.className, 'row-text', 'name and text share a column');
  assert.equal(stack.querySelector('.preview-title')?.textContent, 'طريق الملك ٠٠ حي التجربة');
  assert.equal(stack.firstElementChild, named, 'the name comes first, above');
  assert.equal(doc.querySelector('.row[data-id="p2"] .row-text'), null, 'a row without a name is unchanged');
  assert.match(rule(css('panel.css'), '.row-text') ?? '', /flex-direction:\s*column/u);
  const preview = doc.getElementById('preview');
  const form = doc.getElementById('preview-label-form');
  const input = doc.getElementById('preview-label-input');
  const labelButton = preview.querySelector('[data-action="label"]');
  const pointer = (el, type, init = {}) =>
    el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 100, ...init }));

  // Opened by resting on the row.
  const row = doc.querySelector('.row[data-id="p1"]');
  pointer(row, 'mouseover', { clientX: 110 });
  pointer(row, 'mousemove', { clientX: 115 });
  await wait(DWELL + 80);
  await flush(4);
  assert.equal(preview.hidden, false, 'hover opened the preview');

  pointer(preview, 'mouseover', { clientX: 400 });
  labelButton.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush(5);
  assert.equal(form.hidden, false);
  assert.equal(labelButton.hidden, true, 'the field takes the button’s place');

  // The pointer wanders off while the name is typed.
  input.value = 'المكتب الرئيسي';
  pointer(doc.getElementById('panel'), 'mouseout', { relatedTarget: doc.body });
  await wait(DWELL + 80);
  await flush(4);
  assert.equal(preview.hidden, false, 'typing a name keeps the preview open');
  assert.equal(form.hidden, false);
  assert.equal(input.value, 'المكتب الرئيسي', 'nothing typed is lost');

  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flush(5);
  assert.equal(labelButton.hidden, false, 'the button is back once the field closes');

  // Saving the name it already has writes nothing.
  labelButton.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush(5);
  input.value = ' المكتب ';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush(10);
  assert.equal(fake.invokeCount('set_label'), 0);
  assert.equal(form.hidden, true);

  // The panel hidden and shown again with the field open: the preview goes,
  // and takes its field with it — no keyboard left in a field nobody sees.
  labelButton.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush(5);
  assert.equal(doc.activeElement, input);
  fake.emit('panel://shown');
  await flush(10);
  assert.equal(preview.hidden, true);
  assert.equal(form.hidden, true, 'the field went with its preview');
  assert.equal(doc.activeElement, doc.getElementById('search'));
});

test('the field and its button look like Najdi in the panel', () => {
  const controls = css('controls.css');
  const panel = css('panel.css');
  assert.ok(rule(controls, '.text-input'), '.text-input lives in the shared controls, which the panel loads');
  assert.equal(rule(css('settings.css'), '.text-input'), null, 'one definition, not two');
  assert.match(rule(controls, '.text-input'), /user-select:\s*text/u, 'the body’s user-select:none does not reach the field');
  // `.preview-actions .btn` stretches every action to the full width; the
  // field's own button must not take the field's width with it.
  assert.match(rule(panel, '.preview-label-form .btn') ?? '', /width:\s*auto/u);
  assert.match(rule(panel, '.preview-label-form .btn') ?? '', /flex:\s*none/u);

  const save = /<form[^>]*id="preview-label-form"[\s\S]*?<\/form>/u.exec(html)[0];
  assert.doesNotMatch(save, /btn-primary/u, 'the accent is for «لصق» alone');
  assert.match(html, /data-action="bare"[\s\S]*?لصق بلا تشكيل/u, 'a noun like its siblings');
  assert.match(html, /id="preview-label-text">تسمية</u);
  assert.doesNotMatch(html, /id="preview-label-text">[^<]*…/u, 'opens a field in place, not a dialog');
});
