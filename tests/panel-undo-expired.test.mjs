// ت٤٥ ب٣: a delete made final elsewhere while its «تراجع» was still on screen
// — «مسح السجل» in Settings within the five seconds. The receipt leaves as
// soon as the panel learns of it, and an undo that still reaches Rust is told
// the window is over, in words, not «تعذّر حفظ التغيير».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('a receipt made final elsewhere leaves, and a late undo says why', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1'), sampleItem('h2')],
    settings: null,
    axTrusted: true,
  });
  const doc = dom.window.document;
  // Shown: a hidden panel defers what it is told until it is opened.
  fake.emit('panel://shown');
  await flush(10);
  const toast = () => ({
    message: doc.getElementById('toast-message').textContent,
    undo: !doc.getElementById('toast-undo').hidden,
    kind: doc.getElementById('toast').dataset.kind,
  });

  click(dom, doc.querySelector('#list .row[data-id="h1"] .delete-btn'));
  await flush(10);
  assert.deepEqual(toast(), { message: 'تم حذف العنصر', undo: true, kind: 'delete' });

  // A refresh that knows of the same receipt keeps it.
  fake.setState({ ...fake.getState(), undoToken: 'delete-1' });
  fake.emit('raff://changed');
  await flush(10);
  assert.equal(toast().undo, true, 'still the receipt');

  // History cleared in Settings: Rust holds no receipt any more.
  fake.setState({ ...fake.getState(), history: [], undoToken: null });
  fake.emit('raff://changed');
  await flush(10);
  assert.equal(toast().undo, false, 'no «تراجع» for what cannot come back');
});

test('the late undo’s words', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../src/js/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /'raff\/undo-expired': 'انتهت مهلة التراجع، وحُذف العنصر نهائيًا\.'/u);
  // Information about a delete, not a failure: the trash, not the alert.
  assert.match(panel, /String\(err\) === 'raff\/undo-expired' \? 'delete' : 'error'/u);
});
