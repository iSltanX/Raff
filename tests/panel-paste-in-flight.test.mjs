// One paste at a time (DS-001). With Accessibility, a paste writes the
// clipboard, hides the panel, brings the old app forward and presses ⌘V; a
// second request that reaches Rust before the first is answered — a double
// click, another row, ⌘1–9 — writes the clipboard again (perhaps another
// item, under the first ⌘V) and finds the remembered app already taken.
// The panel sends no second paste while one is under way; the next one, after
// an answer or a failure, goes as before. And should Rust still answer that a
// paste under way took the target, the panel says where the item is — on the
// clipboard — without blaming a missing Accessibility permission.
//
// One `mountPanel()` per file (see the harness header comment); every
// scenario is a `t.test()` under the shared mount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem, wait } from './helpers/panel-harness.mjs';

test('paste in flight: one at a time, and the next one after it goes', async (t) => {
  const { dom, fake, uncaught } = await mountPanel({
    pinned: [],
    history: [sampleItem('a'), sampleItem('b')],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  const row = (id) => doc.querySelector(`.row[data-id="${id}"]`);
  // Rust takes about this long to answer a paste it carried out (hide,
  // activate, 150ms, ⌘V).
  let answer = () => true;
  fake.respond('paste_item', () => new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(answer());
      } catch (err) {
        reject(err);
      }
    }, 300);
  }));

  await t.test('a second click, another row and ⌘1 send nothing while one is under way', async () => {
    click(dom, row('a'));
    await wait(80);
    click(dom, row('a'));
    await wait(60);
    click(dom, row('b'));
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: '1', code: 'Digit1', metaKey: true, bubbles: true, cancelable: true })
    );
    await wait(400);
    await flush(10);
    assert.equal(fake.invokeCount('paste_item'), 1);
    assert.equal(fake.invocationArgs('paste_item')[0].id, 'a');
  });

  await t.test('once it is answered, the next paste goes', async () => {
    click(dom, row('b'));
    await wait(400);
    await flush(10);
    assert.equal(fake.invokeCount('paste_item'), 2);
    assert.equal(fake.invocationArgs('paste_item').at(-1).id, 'b');
  });

  await t.test('a paste whose target another paste took says only where the item is', async () => {
    answer = () => 'targetTaken';
    click(dom, row('a'));
    await wait(400);
    await flush(10);
    assert.equal(fake.invokeCount('paste_item'), 3);
    assert.equal(fake.invokeCount('ax_status'), 0, 'not asked about a permission that is not the reason');
    const message = doc.getElementById('toast-message').textContent;
    assert.match(message, /نُسخ إلى الحافظة/u);
    assert.equal(/تسهيل الوصول/u.test(message), false, 'and no permission offer');
  });

  await t.test('after a failure, the next paste goes too', async () => {
    answer = () => {
      throw 'raff/paste-failed';
    };
    click(dom, row('a'));
    await wait(400);
    await flush(10);
    assert.match(doc.getElementById('toast-message').textContent, /تعذّر اللصق/u);
    answer = () => true;
    click(dom, row('b'));
    await wait(400);
    await flush(10);
    assert.equal(fake.invokeCount('paste_item'), 5);
  });

  assert.deepEqual(uncaught, []);
});
