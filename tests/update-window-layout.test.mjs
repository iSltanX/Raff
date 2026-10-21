// The update window as Figma «08 · نوافذ أخرى» 45:6180 draws it: the icon and
// a two-line head (what is happening, then what it means), the progress bar
// under it, and the actions at the end of the row — with «لاحقًا» beside an
// offered update or a pending restart, so putting it off is one press.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const updateHtml = readFileSync(path.join(here, '../src/update.html'), 'utf8');
const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('update window: a head of icon and two lines, and «لاحقًا» where it can wait', async () => {
  const dom = new JSDOM(updateHtml, { url: 'http://localhost/update.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const listeners = new Map();
  let closed = 0;
  let check;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'consume_update_intent') return Promise.resolve(true);
        if (command === 'check_for_update') return new Promise((resolve) => (check = resolve));
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (name, handler) => {
        listeners.set(name, [...(listeners.get(name) ?? []), handler]);
        return Promise.resolve(() => {});
      },
    },
    window: { getCurrentWindow: () => ({ close: () => ((closed += 1), Promise.resolve()), setSize: () => Promise.resolve() }) },
    dpi: { LogicalSize: class {} },
  };
  await import('../src/js/update.js?update-window-layout');
  await flush();
  const byId = (id) => dom.window.document.getElementById(id);

  const head = dom.window.document.querySelector('.update-head');
  assert.ok(head, 'a head row');
  assert.equal(head.firstElementChild.classList.contains('update-icon'), true, 'the icon leads it (the reading start)');
  assert.ok(head.contains(byId('u-status')) && head.contains(byId('u-sub')), 'with the status and its explanation');

  assert.equal(byId('u-status').textContent, 'جارٍ التحقق من وجود تحديثات…');
  assert.equal(byId('u-sub').textContent, 'يتصل رفّ بإصدارات المستودع فقط.');
  assert.equal(byId('u-later').hidden, true, 'nothing to put off yet');

  check({ status: 'available', version: '6.1.0', notes: 'ملاحظات' });
  await flush();
  assert.equal(byId('u-status').textContent, 'إصدار جديد متاح', 'an offered update has a title, not an empty line');
  assert.match(byId('u-sub').textContent, /موقّع/u, 'and says the package is checked');
  assert.equal(byId('u-later').hidden, false, '«لاحقًا» beside «تنزيل وتثبيت»');
  assert.equal(byId('u-download').hidden, false);

  for (const handler of listeners.get('raff://update/installed') ?? []) handler({ payload: null });
  await flush();
  assert.equal(byId('u-status').textContent, 'اكتمل التثبيت');
  assert.match(byId('u-sub').textContent, /أعد تشغيل رفّ/u);
  assert.equal(byId('u-later').hidden, false, '«لاحقًا» beside «إعادة التشغيل»');

  byId('u-later').click();
  assert.equal(closed, 1, '«لاحقًا» closes the window');
});
