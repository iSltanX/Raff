// The no-IntersectionObserver fallback, in its own file.
//
// `src/js/panel.js` is a per-process module singleton (see the note in
// helpers/panel-harness.mjs), so a scenario that needs a *fresh* first load
// cannot share a file with another mount. The deferral itself is covered in
// panel-thumbnail-deferral.test.mjs.
//
// What this protects: an environment without IntersectionObserver must still
// end up with a complete list. Deferring is an optimisation for the real
// webview; it must never degrade into image rows that stay empty forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('without IntersectionObserver the panel still loads thumbnails eagerly', async () => {
  const { fake } = await mountPanel(
    {
      pinned: [],
      history: [sampleItem('solo', { type: 'image', hasImage: true, text: 'صورة' })],
      settings: null,
      axTrusted: true,
    },
    { withIntersectionObserver: false }
  );

  assert.equal(
    fake.invokeCount('get_image'),
    1,
    'eager loading is the correct behaviour when the observer is unavailable'
  );
});
