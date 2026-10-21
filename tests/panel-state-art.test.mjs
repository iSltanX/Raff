// The empty states draw what they mean (Figma «03 · الحالات الفارغة» 40:1823):
// a shelf with no card when capture is off — nothing is arriving — with the
// way to turn it back on right there; and a search glass, never the shelf,
// when a search or a filter finds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, clickFilter, flush, mountPanel } from './helpers/panel-harness.mjs';

test('panel: empty-state art and actions follow their meaning', async (t) => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [],
    settings: { captureEnabled: false, hotkey: 'shift+super+v' },
    axTrusted: true,
  });
  const doc = dom.window.document;

  await t.test('capture off: the shelf without its card, and «تفعيل الالتقاط»', async () => {
    const view = doc.querySelector('#list .state-view');
    assert.match(view.textContent, /رفّك فارغ/u);
    const art = view.querySelector('.state-art.brand-art');
    assert.ok(art, 'the mark');
    assert.ok(art.classList.contains('is-off'), 'drawn as off');
    assert.ok(art.querySelector('.mark-base'), 'the shelf stays');
    assert.equal(art.querySelector('.mark-card'), null, 'the card is gone: nothing is arriving');
    const action = view.querySelector('#state-action');
    assert.ok(action, 'the way back is in the empty state itself');
    assert.equal(action.textContent, 'تفعيل الالتقاط');
    click(dom, action);
    await flush(6);
    assert.deepEqual(fake.invocationArgs('update_settings').at(-1), { settings: { captureEnabled: true } });
  });

  await t.test('no results: a search glass in its tile, not the shelf', () => {
    clickFilter(dom, 'image');
    const view = doc.querySelector('#list .state-view.is-no-results');
    assert.ok(view);
    const art = view.querySelector('.state-art');
    assert.ok(art, 'it has art');
    assert.equal(art.classList.contains('brand-art'), false, 'never the shelf');
    assert.match(art.querySelector('.icon')?.style.getPropertyValue('--icon') ?? '', /search\.svg/u);
    assert.equal(view.querySelector('#state-action'), null, 'and nothing to press');
  });
});
