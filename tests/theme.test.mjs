// theme.js sets `data-appearance` on every window, and every dark-mode rule
// keys off it. Nothing ran it before 2026-10-21: swapping its two answers left
// the whole suite green (mutation J1, audit T-3). These tests run the real
// file in a page with a system appearance they control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const THEME = readFileSync(path.join(src, 'theme.js'), 'utf8');

/** A page running theme.js under a system appearance the test can flip. */
function pageWith(dark) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
  });
  const listeners = new Set();
  const mq = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (type, fn) => type === 'change' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const queries = [];
  dom.window.matchMedia = (query) => {
    queries.push(query);
    return mq;
  };
  dom.window.eval(THEME);
  return {
    appearance: () => dom.window.document.documentElement.dataset.appearance,
    queries,
    /** The system appearance changes; `notify` is whether the event arrives. */
    setDark(next, { notify = true } = {}) {
      mq.matches = next;
      if (notify) for (const fn of listeners) fn({ matches: next });
    },
    focus: () => dom.window.dispatchEvent(new dom.window.Event('focus')),
  };
}

test('the page starts in the system appearance', () => {
  assert.equal(pageWith(true).appearance(), 'dark');
  assert.equal(pageWith(false).appearance(), 'light');
});

test('it asks the one query the backend override also answers', () => {
  assert.deepEqual(pageWith(false).queries, ['(prefers-color-scheme: dark)']);
});

test('a system change is followed while the window is open', () => {
  const page = pageWith(false);
  page.setDark(true);
  assert.equal(page.appearance(), 'dark');
  page.setDark(false);
  assert.equal(page.appearance(), 'light');
});

test('a change missed while hidden is caught up on focus', () => {
  const page = pageWith(false);
  page.setDark(true, { notify: false });
  assert.equal(page.appearance(), 'light', 'no event, no change yet');
  page.focus();
  assert.equal(page.appearance(), 'dark');
});

test('every window loads theme.js before its stylesheets', () => {
  const pages = readdirSync(src).filter((f) => f.endsWith('.html'));
  assert.equal(pages.length, 6);
  for (const page of pages) {
    const html = readFileSync(path.join(src, page), 'utf8');
    const script = html.indexOf('<script src="theme.js"></script>');
    const sheet = html.indexOf('<link rel="stylesheet"');
    assert.ok(script >= 0, `${page} loads theme.js`);
    assert.ok(sheet < 0 || script < sheet, `${page}: theme.js runs before the stylesheet parses`);
  }
});
