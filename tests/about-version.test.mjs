// «عن رفّ» shows the version, and reads only that: it used to ask for the
// whole state — every pinned and recent clip, up to a thousand rows — to read
// one field the settings payload already carries (live UI audit of
// 2026-10-20, issue 9; roadmap IMP-04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '../src/about.html'), 'utf8');

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('about: the version comes from the settings payload, not from the clips', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost/about.html' });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const calls = [];
  dom.window.__TAURI__ = {
    core: {
      invoke(cmd) {
        calls.push(cmd);
        if (cmd === 'get_settings') return Promise.resolve({ settings: {}, axTrusted: true, version: '6.0.1' });
        if (cmd === 'get_state') {
          return Promise.resolve({
            pinned: [{ id: 'p', text: 'نص منسوخ لا شأن لنافذة «عن رفّ» به' }],
            history: [],
            settings: {},
            axTrusted: true,
            version: '6.0.1',
          });
        }
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  await import('../src/js/about.js?about-version');
  await flush();

  assert.equal(dom.window.document.getElementById('app-version').textContent, 'الإصدار ⁦6.0.1⁩');
  assert.equal(calls.filter((cmd) => cmd === 'get_state').length, 0, 'no clip crosses into this window');
});
