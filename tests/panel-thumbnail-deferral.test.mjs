// Thumbnails must not be fetched for rows nobody can see yet.
//
// This guards a cold-start defect, not a styling detail. Thumbnails come back
// over IPC as base64 data URLs, and Tauri delivers every IPC reply by
// evaluating script ON THE MACOS MAIN THREAD. Building a long history used to
// ask for every image row's thumbnail the moment the row was created, so a
// few hundred saved images queued a few hundred large main-thread injections
// while the panel was still hidden. The menu-bar icon was already up, but the
// main thread was busy draining that backlog, so the first clicks landed on a
// process that could not answer them — the reported "clicking does nothing for
// the first ~30 seconds".
//
// The assertions below are behavioural: they count real IPC calls rather than
// matching source text, so the protection survives any rewrite that keeps the
// behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountPanel, sampleItem, flush } from './helpers/panel-harness.mjs';

function imageItem(id, overrides = {}) {
  return sampleItem(id, { type: 'image', hasImage: true, text: `صورة ${id}`, ...overrides });
}

const HISTORY = Array.from({ length: 12 }, (_, i) => imageItem(`img-${i + 1}`));

test('image rows defer their thumbnail until they are actually near the viewport', async () => {
  const { fake, observers } = await mountPanel(
    { pinned: [], history: HISTORY, settings: null, axTrusted: true },
    { withIntersectionObserver: true }
  );

  assert.equal(
    fake.invokeCount('get_image'),
    0,
    'a freshly hydrated list must not fetch a single thumbnail before anything is on screen'
  );
  assert.ok(observers.length > 0, 'the panel must register an IntersectionObserver');

  const observer = observers[0];
  assert.equal(
    observer.targets.size,
    HISTORY.length,
    'every image row should be waiting on the observer'
  );

  // Nothing is fetched by merely observing; the fetch is the reveal.
  observer.revealAll();
  await flush();

  assert.equal(
    fake.invokeCount('get_image'),
    HISTORY.length,
    'revealed rows fetch exactly once each'
  );

  // A second reveal must not refetch: revealed targets are unobserved, and
  // resolved thumbnails are cached by item id.
  observer.revealAll();
  await flush();
  assert.equal(
    fake.invokeCount('get_image'),
    HISTORY.length,
    'a thumbnail is never fetched twice for the same row'
  );
});
