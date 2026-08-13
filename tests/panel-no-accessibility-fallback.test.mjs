// Losing Accessibility permission must degrade to copy-only, never fail —
// and the user must be told exactly why, with a one-click fix.
//
// Rust returns `false` from `paste_item` when it wrote the item to the
// clipboard but could not synthesize ⌘V (proven live against the real
// candidate: ax_trusted() is checked and the whole hide/activate/paste
// sequence is skipped BEFORE any of it runs, so the copy itself is
// unconditional). This file covers what the frontend does with that
// `false` — it must not look like a silent, unlabeled failure, and the
// immediate "press ⌘V yourself" guidance must survive alongside the added
// explanation.
//
// One shared mount (see helpers/panel-harness.mjs on why panel.js allows
// only one fresh load per file) driven as sequential `t.test()` scenarios.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountPanel, sampleItem, flush, click } from './helpers/panel-harness.mjs';

test('choosing without Accessibility permission: explained, not silent', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('r1')],
    settings: null,
    axTrusted: false,
  });

  await t.test('the copy half runs, and the toast explains why auto-paste did not', async () => {
    click(dom, dom.window.document.querySelector('.row[data-id="r1"]'));
    await flush(10);

    assert.equal(fake.invokeCount('paste_item'), 1, 'the copy half still runs unconditionally');

    const message = dom.window.document.getElementById('toast-message').textContent;
    assert.match(message, /⌘V/u, 'still tells the user they can paste manually right now');
    assert.match(message, /تسهيل الوصول/u, 'names Accessibility as the reason, not a vague failure');

    const action = dom.window.document.getElementById('toast-action');
    assert.equal(action.hidden, false, 'a one-click fix is offered, not just an explanation');
    assert.match(action.textContent, /إذن|الوصول/u);
  });

  await t.test('the toast action requests Accessibility and opens the settings pane', async () => {
    click(dom, dom.window.document.getElementById('toast-action'));
    await flush(4);

    assert.equal(fake.invokeCount('request_accessibility'), 1);
    assert.equal(fake.invokeCount('open_accessibility_settings'), 1);
  });
});
