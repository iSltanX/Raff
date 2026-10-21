// Audit 012: a click on a row, or ⌘1–9, chooses that row — and when the
// panel stays open afterwards (no Accessibility permission, or a paste that
// fell back to the clipboard), what it shows as selected must be that row.
// It used to set the selection behind the list's back: the highlight,
// `aria-selected`, `aria-activedescendant` and the shortcut bar stayed on the
// old row, while ⌘⌫ deleted the new one. With learning off nothing is
// announced after a paste, so no refresh repaired it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, mountPanel, sampleItem, selectRowByKeyboard } from './helpers/panel-harness.mjs';

test('the row a click or ⌘1–9 chooses is the row shown as selected', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1'), sampleItem('h2'), sampleItem('h3')],
    settings: { learningEnabled: false },
    axTrusted: false,
  });
  const doc = dom.window.document;
  const row = (id) => doc.querySelector(`.row[data-id="${id}"]`);
  const shown = () => {
    const selected = [...doc.querySelectorAll('.row.selected')].map((r) => r.dataset.id);
    const aria = [...doc.querySelectorAll('.row[aria-selected="true"]')].map((r) => r.dataset.id);
    const active = doc.getElementById('search').getAttribute('aria-activedescendant');
    return { selected, aria, active: active && doc.getElementById(active)?.dataset.id };
  };

  selectRowByKeyboard(dom, 'h1');
  assert.deepEqual(shown(), { selected: ['h1'], aria: ['h1'], active: 'h1' });

  row('h2').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush(10);
  assert.equal(fake.invokeCount('paste_item'), 1);
  assert.equal(fake.invokeCount('hide_panel'), 0, 'the panel stays open');
  assert.deepEqual(shown(), { selected: ['h2'], aria: ['h2'], active: 'h2' }, 'after a click');

  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: '3',
      code: 'Digit3',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  await flush(10);
  assert.equal(fake.invokeCount('paste_item'), 2);
  assert.deepEqual(shown(), { selected: ['h3'], aria: ['h3'], active: 'h3' }, 'after ⌘3');
});
