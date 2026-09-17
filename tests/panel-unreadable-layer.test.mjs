// A layer that could not be read is not an empty shelf. «رفّك جاهز» tells the
// user nothing is saved; after a corrupt history.json the truth is the
// opposite — their content exists, it just was not read — and the two must
// never share a screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SHELF_HEADLINE, mountPanel, listText } from './helpers/panel-harness.mjs';

const UNREADABLE_HEADLINE = /تعذّرت قراءة سجلّك/u;

test('panel: an unreadable layer replaces the empty shelf with its own state', async (t) => {
  const { dom } = await mountPanel({
    pinned: [],
    history: [],
    settings: null,
    axTrusted: true,
    unreadableLayer: true,
  });

  await t.test('the unreadable-layer state is shown instead of «رفّك جاهز»', () => {
    assert.match(listText(dom), UNREADABLE_HEADLINE);
    assert.doesNotMatch(
      listText(dom),
      EMPTY_SHELF_HEADLINE,
      'claiming an empty shelf would say the saved clips are gone'
    );
  });

  await t.test('it is announced, and does not borrow the empty-shelf illustration', () => {
    const view = dom.window.document.querySelector('.state-view.is-unreadable');
    assert.ok(view, 'the state has its own class');
    assert.equal(view.getAttribute('role'), 'status');
    assert.equal(view.getAttribute('aria-live'), 'polite');
    assert.equal(
      view.querySelector('.brand-art'),
      null,
      'the shelf illustration belongs to a genuinely empty collection'
    );
  });
});

// The converse — a readable, genuinely empty store still showing «رفّك جاهز» —
// is already asserted by `panel-recovery` and `panel-delete-shortcut`, and the
// harness allows only one mount per file (panel.js is a module singleton).
