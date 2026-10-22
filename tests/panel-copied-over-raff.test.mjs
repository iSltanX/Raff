// A paste from a panel opened over one of رفّ's own windows — Settings in
// front, or «افتح رفّ» at the end of the welcome — only copies (009): there
// is no other app to paste into. The panel says so, and why, rather than the
// message for a missing Accessibility permission, which would send the user
// to grant one they may already have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountPanel, sampleItem } from './helpers/panel-harness.mjs';

test('a copy made because رفّ was in front says so', async () => {
  const { dom, fake } = await mountPanel({
    pinned: [],
    history: [sampleItem('h1')],
    settings: null,
    axTrusted: true,
  });
  fake.respond('paste_item', () => 'copiedOverRaff');
  click(dom, dom.window.document.querySelector('.row[data-id="h1"]'));
  await flush(10);
  const message = dom.window.document.getElementById('toast-message').textContent;
  assert.match(message, /نُسخ إلى الحافظة/u);
  assert.match(message, /رفّ كان في الواجهة/u, `the reason: ${message}`);
  assert.match(message, /⁦⌘V⁩/u);
  assert.equal(fake.invokeCount('ax_status'), 0, 'not asked about a permission that is not the reason');
  assert.equal(fake.invokeCount('hide_panel'), 0);
});
