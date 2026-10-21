// The splash (approved with the Najdi redesign, Figma «01 · الترحيب» 42:4060):
// the welcome opens on the mark, «رفّ» and its line, then gives way to the
// first step by itself — or at once, on any key or click. It is a curtain
// over step 1, not a step: the five steps, their buttons and their focus are
// exactly what they were, and nothing on it can be pressed or announced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const firstrunHtml = readFileSync(path.join(here, '../src/firstrun.html'), 'utf8');
const firstrunCss = readFileSync(path.join(here, '../src/firstrun.css'), 'utf8');

const flush = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(query, { duration } = {}) {
  const html = duration === undefined ? firstrunHtml : firstrunHtml.replace(/data-duration="\d+"/u, `data-duration="${duration}"`);
  const dom = new JSDOM(html, { url: 'http://localhost/firstrun.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'get_settings') return Promise.resolve({ settings: { captureEnabled: true }, axTrusted: false });
        if (command === 'ax_status') return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  await import(`../src/js/firstrun.js?${query}`);
  await flush();
  return dom;
}

test('the welcome opens on the splash: the mark, «رفّ» and its line, nothing to press', async () => {
  const dom = await mount('splash-content');
  const doc = dom.window.document;
  const splash = doc.getElementById('splash');

  assert.ok(splash, 'there is a splash');
  assert.equal(splash.classList.contains('is-done'), false, 'it is showing');
  assert.equal(splash.getAttribute('aria-hidden'), 'true', 'decorative: step 1 is what is announced');
  assert.ok(splash.querySelector('.mark-base') && splash.querySelector('.mark-card'), 'the mark, shelf and card');
  assert.equal(splash.querySelector('.splash-name').textContent.trim(), 'رفّ');
  assert.equal(splash.querySelector('.splash-tagline').textContent.trim(), 'كل ما نسخته، على رفٍّ قريب.');
  assert.equal(splash.querySelectorAll('button, a, input, [tabindex]').length, 0, 'nothing on it takes focus');

  assert.equal(doc.getElementById('step-idea').hidden, false, 'step 1 is already laid out beneath it');
  assert.equal(doc.activeElement?.id, 'idea-title', 'and holds the focus');
});

test('the splash gives way by itself', async () => {
  const dom = await mount('splash-timer', { duration: 30 });
  const splash = dom.window.document.getElementById('splash');
  assert.equal(splash.classList.contains('is-done'), false);
  await wait(80);
  assert.equal(splash.classList.contains('is-done'), true);
});

test('any key or click lifts it at once, without acting on anything else', async () => {
  for (const [query, event] of [
    ['splash-key', (w) => new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })],
    ['splash-click', (w) => new w.MouseEvent('pointerdown', { bubbles: true })],
  ]) {
    const dom = await mount(query);
    const doc = dom.window.document;
    const splash = doc.getElementById('splash');
    splash.dispatchEvent(event(dom.window));
    assert.equal(splash.classList.contains('is-done'), true, `${query}: lifted`);
    assert.equal(doc.getElementById('step-idea').hidden, false, `${query}: still step 1`);
  }
});

test('the click that lifts the splash does not land on the button beneath it', async () => {
  const dom = await mount('splash-click-through');
  const doc = dom.window.document;
  const splash = doc.getElementById('splash');
  // Pressed over «التالي»: the splash lifts on the press; the click that
  // completes it is the same gesture, not a second one.
  splash.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  doc.getElementById('next').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(doc.getElementById('step-idea').hidden, false, 'still the first step');
  doc.getElementById('next').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(doc.getElementById('step-open').hidden, false, 'the next click is an ordinary click');
});

test('the key that lifts the splash does nothing else', async () => {
  const dom = await mount('splash-key-swallowed');
  const press = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  dom.window.document.getElementById('idea-title').dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
});

test('a lifted splash is out of the way: hidden and click-through', () => {
  const done = firstrunCss.match(/\.splash\.is-done\s*\{([^}]*)\}/u)?.[1] ?? '';
  assert.match(done, /visibility:\s*hidden/u);
  assert.match(done, /pointer-events:\s*none/u);
  assert.match(firstrunCss, /\.splash\s*\{[^}]*position:\s*absolute;/u);
});

test('the permission step leads with «منح الإذن…» (Figma 1.4)', () => {
  const dom = new JSDOM(firstrunHtml);
  const grant = dom.window.document.getElementById('open-settings');
  assert.ok(grant.classList.contains('btn-primary'), 'the clay button');
  assert.equal(dom.window.document.getElementById('later').classList.contains('btn-primary'), false);
});
