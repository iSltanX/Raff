// Audit 021 ج4: a screen reader moves through a window by its headings. The
// update window had none, and each Settings page hid its own heading with
// `display: none`, which takes it out of the accessibility tree as well. Both
// are read now and still not drawn: the visible design does not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');
const strip = (css) => css.replace(/\/\*[^]*?\*\//gu, '');

test('the update window has a heading a screen reader can reach', () => {
  const doc = new JSDOM(read('src/update.html')).window.document;
  const h1 = doc.querySelector('main h1');
  assert.ok(h1, 'a top-level heading in the window');
  assert.equal(h1.textContent.trim(), 'تحديث رفّ');
  assert.ok(h1.classList.contains('sr-only'), 'read, not drawn');
});

test('each Settings page keeps its heading for a screen reader, out of sight', () => {
  const doc = new JSDOM(read('src/settings.html')).window.document;
  const pages = [...doc.querySelectorAll('.page-heading')];
  assert.ok(pages.length >= 4);
  for (const page of pages) {
    assert.ok(page.querySelector('h2')?.textContent.trim(), 'a heading inside');
    assert.ok(page.classList.contains('sr-only'), 'visually hidden, not removed');
  }
  const rule = strip(read('src/settings.css')).match(/\.page-heading\s*\{([^}]*)\}/u);
  assert.ok(!rule || !/display:\s*none/u.test(rule[1]), 'no display: none, which hides it from VoiceOver too');
});
