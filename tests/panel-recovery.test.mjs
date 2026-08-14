// The happy path plus in-place recovery: a first load that stumbles once and
// then succeeds, and ⌘R re-initialising the panel without a reload.
//
// «08 — Product Screens» leaves the header with only the settings action, so
// the old #refresh-btn is gone. The capability it carried is unchanged and is
// now reached by ⌘R (and by the failure view's own button) — every recovery
// guarantee below is asserted through that route instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SHELF_HEADLINE,
  FAILURE_HEADLINE,
  mountPanel,
  sampleItem,
  minutesAgo,
  flush,
  wait,
  rowIds,
  listText,
  click,
  pressCmdR,
  clickFilter,
  activeFilter,
} from './helpers/panel-harness.mjs';

/** The designed list: one chronological run, newest first, with pinned items
 *  marked in place rather than lifted to the top. `pin1` is deliberately the
 *  OLDEST item so every ordering assertion below proves that. */
function loadedState(extra = []) {
  return {
    pinned: [sampleItem('pin1', { isPinned: true, createdAt: minutesAgo(90) })],
    history: [
      sampleItem('r1', { createdAt: minutesAgo(10) }),
      sampleItem('r2', { createdAt: minutesAgo(20) }),
      ...extra,
    ],
    settings: null,
    axTrusted: true,
  };
}

test('panel recovery: first load retries, then ⌘R re-initialises in place', async (t) => {
  // The very first get_state fails; the built-in retry must rescue the load
  // without any user action and without a reload.
  const { dom, fake, reloads, uncaught } = await mountPanel(loadedState(), { failTimes: 1 });

  await t.test('a failed first load is retried automatically and succeeds', async () => {
    await wait(500); // past the first 250ms backoff
    assert.deepEqual(rowIds(dom), ['r1', 'r2', 'pin1'], 'retry populated the list');
    assert.ok(fake.getStateCallCount() >= 2, 'the failed attempt was actually retried');
  });

  await t.test('the transient failure never showed the error state to the user', () => {
    assert.doesNotMatch(listText(dom), FAILURE_HEADLINE);
  });

  await t.test('one chronological list — pinned items stay in place with one clear action', () => {
    // `pin1` is the oldest clip, so it sorts last even though it is pinned.
    assert.deepEqual(rowIds(dom), ['r1', 'r2', 'pin1']);
    const pinned = dom.window.document.querySelector('.row[data-id="pin1"]');
    const pinAction = pinned.querySelector('.pin-btn.is-pinned');
    assert.ok(pinAction, 'the pinned row keeps its unpin action visible');
    assert.equal(pinAction.title, 'إلغاء تثبيت العنصر');
    assert.equal(pinAction.getAttribute('aria-label'), 'إلغاء تثبيت العنصر');
    assert.equal(pinAction.getAttribute('aria-pressed'), 'true');
    assert.equal(
      dom.window.document.querySelector('.row[data-id="r1"] .pin-indicator'),
      null,
      'rows never duplicate pin state with a second status marker'
    );
    assert.equal(
      dom.window.document.querySelectorAll('.section-header').length,
      0,
      '«08» has no section headers — one list only'
    );
  });

  await t.test('the header actions carry Arabic labels only', () => {
    const settings = dom.window.document.getElementById('settings-btn');
    assert.equal(settings.title, 'الإعدادات');
    assert.equal(settings.getAttribute('aria-label'), 'فتح إعدادات رفّ');
    const close = dom.window.document.getElementById('panel-close');
    assert.equal(close.title, 'إغلاق');
    assert.equal(close.getAttribute('aria-label'), 'إغلاق رفّ');
    const toast = dom.window.document.getElementById('toast');
    assert.equal(toast.getAttribute('role'), 'group');
    const announcer = dom.window.document.getElementById('feedback-announcer');
    assert.equal(announcer.getAttribute('role'), 'status');
    assert.equal(announcer.getAttribute('aria-live'), 'polite');
    assert.equal(announcer.getAttribute('aria-atomic'), 'true');
  });

  await t.test('the header actions are wired to their commands', async () => {
    const settingsBefore = fake.invokeCount('open_settings');
    click(dom, dom.window.document.getElementById('settings-btn'));
    await flush();
    assert.equal(
      fake.invokeCount('open_settings'),
      settingsBefore + 1,
      'الإعدادات opens the settings window'
    );

    const hidesBefore = fake.invokeCount('hide_panel');
    click(dom, dom.window.document.getElementById('panel-close'));
    await flush();
    assert.equal(fake.invokeCount('hide_panel'), hidesBefore + 1, 'the close dot hides the panel');
  });

  await t.test('⌘R re-initialises the data without reloading', async () => {
    fake.setState(loadedState([sampleItem('r3', { createdAt: minutesAgo(30) })]));
    pressCmdR(dom);
    await flush(6);

    assert.deepEqual(rowIds(dom), ['r1', 'r2', 'r3', 'pin1'], 'fresh data is on screen');
    assert.equal(reloads.length, 0, 'the soft path must not reload the frontend');
  });

  await t.test('⌘R never loses already-saved items', async () => {
    const before = rowIds(dom);
    pressCmdR(dom);
    await flush(6);
    assert.deepEqual(rowIds(dom), before, 'the same items are still there afterwards');
  });

  await t.test('a burst of ⌘R is collapsed by the busy state', async () => {
    const before = fake.getStateCallCount();
    for (let i = 0; i < 6; i++) pressCmdR(dom);
    await flush(6);
    assert.equal(
      fake.getStateCallCount() - before,
      1,
      'six rapid presses must produce exactly one fetch'
    );
  });

  await t.test('recovering does not re-subscribe the background events', () => {
    assert.equal(fake.listenCallCount('panel://shown'), 1);
    assert.equal(fake.listenCallCount('raff://changed'), 1);
  });

  await t.test('repeated show/recover cycles never trigger a reload loop', async () => {
    for (let i = 0; i < 5; i++) {
      fake.emit('panel://shown', null);
      await flush(4);
      pressCmdR(dom);
      await flush(6);
    }
    assert.equal(reloads.length, 0, 'nothing in the healthy path may reload the frontend');
    assert.equal(fake.listenCallCount('panel://shown'), 1, 'still exactly one subscription');
  });

  await t.test('an empty shelf reads as empty, never as an error', async () => {
    fake.setState({ pinned: [], history: [], settings: null, axTrusted: true });
    fake.emit('panel://shown', null);
    await flush(6);
    assert.match(listText(dom), EMPTY_SHELF_HEADLINE, 'the natural empty state is shown');
    assert.doesNotMatch(listText(dom), FAILURE_HEADLINE, 'and never the failure state');
    assert.equal(
      dom.window.document.querySelector('.state-view.is-failure'),
      null,
      'the empty shelf is not the failure view'
    );
    const empty = dom.window.document.querySelector('.state-view:not(.is-failure):not(.is-no-results)');
    assert.equal(empty.getAttribute('role'), 'status');
    assert.equal(empty.getAttribute('aria-live'), 'polite');
    assert.equal(empty.getAttribute('aria-atomic'), 'true');
    assert.equal(dom.window.document.getElementById('list').getAttribute('role'), 'region');
  });

  await t.test('the panel exposes no English "Reload" affordance', () => {
    const html = dom.window.document.body.innerHTML;
    assert.doesNotMatch(html, /reload/i, 'no English reload text anywhere in the panel UI');
  });

  await t.test('the native page menu is suppressed over inert areas', () => {
    const event = new dom.window.Event('contextmenu', { cancelable: true, bubbles: true });
    dom.window.document.getElementById('list').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'the English page menu must not open on the list');
  });

  await t.test('the search field keeps its native editing menu', () => {
    const event = new dom.window.Event('contextmenu', { cancelable: true, bubbles: true });
    dom.window.document.getElementById('search').dispatchEvent(event);
    assert.equal(
      event.defaultPrevented,
      false,
      'cut/copy/paste/select must keep working inside the search field'
    );
  });

  await t.test('selected text keeps its native copy menu', () => {
    // The brand lockup always exists, so this does not depend on list state.
    const range = dom.window.document.createRange();
    range.selectNodeContents(dom.window.document.querySelector('.brand .brand-name'));
    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const event = new dom.window.Event('contextmenu', { cancelable: true, bubbles: true });
    dom.window.document.getElementById('list').dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'copying a selection must stay possible');
    sel.removeAllRanges();
  });

  await t.test('typing or pasting into the search field still filters', async () => {
    fake.setState({
      pinned: [],
      history: [
        sampleItem('r1', {
          sourceApp: 'Notes',
          sourceAppBundleId: 'com.apple.Notes',
          createdAt: minutesAgo(10),
        }),
        sampleItem('r2', {
          sourceApp: 'Safari',
          sourceAppBundleId: 'com.apple.Safari',
          createdAt: minutesAgo(20),
        }),
      ],
      settings: null,
      axTrusted: true,
    });
    fake.emit('panel://shown', null);
    await flush(6);

    const search = dom.window.document.getElementById('search');
    search.value = 'r2'; // as if pasted with ⌘V or the editing menu
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.deepEqual(rowIds(dom), ['r2'], 'pasted text filters the list');

    search.value = 'Safari';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.deepEqual(
      rowIds(dom),
      ['r2'],
      'source application metadata stays in search after its artwork is removed'
    );

    search.value = '';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.deepEqual(rowIds(dom), ['r1', 'r2'], 'clearing restores the full list');
  });

  // ── the designed search-clear button (2:7700) ───────────────────────────
  await t.test('the search-clear button appears with a query and resets it', async () => {
    const search = dom.window.document.getElementById('search');
    const clear = dom.window.document.getElementById('search-clear');
    assert.equal(clear.hidden, true, 'hidden while the query is empty');
    assert.equal(clear.getAttribute('aria-label'), 'مسح البحث');

    search.value = 'r2';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.equal(clear.hidden, false, 'revealed as soon as there is a query');
    assert.deepEqual(rowIds(dom), ['r2']);

    click(dom, clear);
    await flush();
    assert.equal(search.value, '', 'the field is emptied');
    assert.equal(clear.hidden, true, 'and the button hides itself again');
    assert.deepEqual(rowIds(dom), ['r1', 'r2'], 'the full list is restored');
  });

  // ── the designed filter segments (2:7710) ───────────────────────────────
  await t.test('each filter segment narrows the list to its own kind', async () => {
    fake.setState({
      // `pin-old` is pinned AND the oldest, so it also proves the ordering.
      pinned: [sampleItem('pin-old', { isPinned: true, createdAt: minutesAgo(90), text: 'مثبّت قديم' })],
      history: [
        sampleItem('txt', { type: 'text', createdAt: minutesAgo(10), text: 'نص عادي' }),
        sampleItem('code', { type: 'code', createdAt: minutesAgo(20), text: 'const a = 1;' }),
        sampleItem('url', { type: 'link', createdAt: minutesAgo(30), text: 'https://example.com' }),
        sampleItem('img', {
          type: 'image',
          hasImage: true,
          createdAt: minutesAgo(40),
          text: 'صورة 20×20',
        }),
      ],
      settings: null,
      axTrusted: true,
    });
    fake.emit('panel://shown', null);
    await flush(6);

    assert.equal(activeFilter(dom), 'all', 'reopening resets to الكل');
    assert.deepEqual(rowIds(dom), ['txt', 'code', 'url', 'img', 'pin-old'], 'الكل shows everything');

    clickFilter(dom, 'text');
    assert.equal(activeFilter(dom), 'text');
    assert.deepEqual(rowIds(dom), ['txt', 'code', 'pin-old'], 'نص covers text and code');

    clickFilter(dom, 'link');
    assert.deepEqual(rowIds(dom), ['url'], 'روابط shows only links');

    clickFilter(dom, 'image');
    assert.deepEqual(rowIds(dom), ['img'], 'صور shows only images');
    assert.ok(
      dom.window.document.querySelector('.row[data-id="img"] .preview-thumb'),
      'an image row renders a thumbnail, not a text preview'
    );

    clickFilter(dom, 'pinned');
    assert.deepEqual(rowIds(dom), ['pin-old'], 'مثبّت shows only pinned items');

    clickFilter(dom, 'all');
    assert.deepEqual(rowIds(dom), ['txt', 'code', 'url', 'img', 'pin-old'], 'back to everything');
  });

  await t.test('the active segment is the only one marked selected', () => {
    clickFilter(dom, 'link');
    const segs = [...dom.window.document.querySelectorAll('#filters .segment')];
    const active = segs.filter((s) => s.classList.contains('is-active'));
    assert.equal(active.length, 1, 'exactly one segment is active at a time');
    assert.equal(active[0].dataset.filter, 'link');
    for (const seg of segs) {
      assert.equal(
        seg.getAttribute('aria-selected'),
        String(seg.classList.contains('is-active')),
        'aria-selected tracks the visual state'
      );
    }
    clickFilter(dom, 'all');
  });

  await t.test('a filter with no matches reads as «لا نتائج», never as an empty shelf', async () => {
    fake.setState({
      pinned: [],
      history: [sampleItem('only-text', { createdAt: minutesAgo(5) })],
      settings: null,
      axTrusted: true,
    });
    fake.emit('panel://shown', null);
    await flush(6);

    clickFilter(dom, 'image');
    assert.deepEqual(rowIds(dom), []);
    assert.match(listText(dom), /لا نتائج/);
    assert.equal(
      dom.window.document.querySelector('.state-view.is-no-results .state-art'),
      null,
      'search-empty is textual and never borrows the shelf illustration'
    );
    assert.doesNotMatch(listText(dom), EMPTY_SHELF_HEADLINE, 'a narrowed list is not an empty shelf');
    assert.doesNotMatch(listText(dom), FAILURE_HEADLINE, 'and never the failure state');
    const noResults = dom.window.document.querySelector('.state-view.is-no-results');
    assert.equal(noResults.getAttribute('role'), 'status');
    assert.equal(noResults.getAttribute('aria-live'), 'polite');
    assert.equal(noResults.getAttribute('aria-atomic'), 'true');
    assert.equal(dom.window.document.getElementById('list').getAttribute('role'), 'region');
    clickFilter(dom, 'all');
  });

  await t.test('the row icon represents content type while source metadata remains accessible', () => {
    const kind = dom.window.document.querySelector('.row .row-kind');
    const icon = kind?.querySelector('.content-type-icon');
    assert.ok(icon, 'the stable semantic icon slot remains in the row grid');
    assert.equal(icon.textContent, '', 'the local SVG mask stays visually quiet in text content');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.hidden, false, 'the approved content-type glyph is visible');
    const glyph = icon.querySelector('.content-type-glyph');
    assert.ok(glyph, 'the glyph comes from the Figma content-type set');
    assert.match(glyph.style.getPropertyValue('--figma-icon'), /content-types\/text\.svg/u);
    assert.equal(kind.getAttribute('role'), 'gridcell');
    assert.equal(kind.getAttribute('aria-label'), 'نوع المحتوى: نص. المصدر: Notes');
    assert.equal(kind.title, 'نص • المصدر: Notes');
    assert.equal(dom.window.document.querySelector('.row .row-source, .row .source-icon'), null);
  });

  await t.test('no uncaught errors during the whole session', () => {
    assert.deepEqual(uncaught, []);
  });
});
