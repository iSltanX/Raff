// The hotkey status line carried no role and no aria-live, so «اختصار غير
// صالح» was painted and never announced — while the update status a few rows
// down in the same file already used exactly the right pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsHtml = readFileSync(path.join(here, '../src/settings.html'), 'utf8');

test('settings: a refused hotkey is announced, not just painted', () => {
  const dom = new JSDOM(settingsHtml);
  const doc = dom.window.document;
  const status = doc.getElementById('hotkey-sub');
  const chip = doc.getElementById('hotkey-chip');

  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');

  assert.equal(
    chip.getAttribute('aria-describedby'),
    'hotkey-sub',
    'the control the message is about points at it'
  );

  // The pattern is the one already used in this file, not a new invention.
  const reference = doc.getElementById('settings-update-status');
  assert.equal(status.getAttribute('role'), reference.getAttribute('role'));
  assert.equal(status.getAttribute('aria-live'), reference.getAttribute('aria-live'));
});
