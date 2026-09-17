// Five paths passed `String(err)` from Rust straight into an Arabic toast. A
// storage failure carries an io::Error and the file path it happened on, so a
// failed pin could show the shape of the user's disk in the UI — and made the
// wording of every message a backend concern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  selectRowByKeyboard,
} from './helpers/panel-harness.mjs';

const ITEMS = [sampleItem('a', { createdAt: minutesAgo(1) })];

// What `try_save_json` produces today, verbatim.
const LEAKY = 'تعذّر حفظ /Users/someone/Library/Application Support/com.raff.app/history.json: No space left on device';

test('panel: a backend failure is shown in Raff’s own words', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: ITEMS,
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const toastText = () => doc.getElementById('toast')?.textContent ?? '';

  await t.test('a storage failure says what went wrong, and only that', async () => {
    fake.failCommand('toggle_pin', 'raff/save-failed');
    selectRowByKeyboard(dom, 'a');
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'p',
        code: 'KeyP',
        altKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await flush(8);

    const shown = toastText();
    assert.ok(shown.length > 0, 'the failure is still reported');
    assert.doesNotMatch(shown, /\/Users\//u, 'no local path');
    assert.doesNotMatch(shown, /history\.json/u, 'no file name');
    assert.doesNotMatch(shown, /No space left/u, 'no operating-system text');
    assert.match(shown, /تعذّر حفظ التغيير/u, 'and it says what went wrong, in Arabic');
  });

  // Defence in depth: even if something the panel has no word for reaches it —
  // an older backend, a path Rust has not been taught to classify — the raw
  // string must not be what the user is shown.
  await t.test('and an unclassified failure is never rendered verbatim', async () => {
    fake.failCommand('copy_item', LEAKY);
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await flush(8);

    const shown = toastText();
    assert.doesNotMatch(shown, /\/Users\//u, 'no local path');
    assert.doesNotMatch(shown, /history\.json/u, 'no file name');
    assert.doesNotMatch(shown, /No space left/u, 'no operating-system text');
    assert.match(shown, /حاول مرة أخرى/u, 'but still a sentence, not a blank');
  });
});
