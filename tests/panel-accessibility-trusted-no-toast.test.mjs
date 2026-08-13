// With Accessibility already trusted, a choice pastes silently — no
// explanation, no "grant permission" action, and Raff never nags about a
// permission it already has.
//
// Own file: `panel.js` is a per-process module singleton (see the harness).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountPanel, sampleItem, flush, click } from './helpers/panel-harness.mjs';

test('a trusted choice pastes with no toast and no permission action', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('r1')],
    settings: null,
    axTrusted: true,
  });

  click(dom, dom.window.document.querySelector('.row[data-id="r1"]'));
  await flush(10);

  assert.equal(
    dom.window.document.getElementById('panel-feedback').hidden,
    true,
    'a successful auto-paste needs no toast at all'
  );
  assert.equal(fake.invokeCount('request_accessibility'), 0, 'never offered when not needed');
});
