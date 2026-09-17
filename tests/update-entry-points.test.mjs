// «التحقق» in Settings and About must lead somewhere when an update exists:
// the install flow lives in the update window, so both open it.
// store.js binds the Tauri bridge once per process, so each page mounts in its own file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));

function mount(page, check) {
  const html = readFileSync(path.join(here, `../src/${page}`), 'utf8');
  const dom = new JSDOM(html, { url: `http://localhost/${page}` });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const calls = [];
  dom.window.__TAURI__ = {
    core: {
      invoke(cmd) {
        calls.push(cmd);
        if (cmd === 'check_for_update') return Promise.resolve(check);
        if (cmd === 'get_state' || cmd === 'get_settings') {
          return Promise.resolve({ pinned: [], history: [], settings: {}, axTrusted: true, version: '5.0.0' });
        }
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return { dom, count: (cmd) => calls.filter((c) => c === cmd).length };
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('Settings opens the update window when a newer version exists', async () => {
  const { dom, count } = mount('settings.html', { status: 'available', version: '5.1.0' });
  await import('../src/js/settings.js');
  await flush();
  dom.window.document.getElementById('settings-update').click();
  await flush();
  assert.equal(count('check_for_update'), 1);
  assert.equal(count('open_updates'), 1);
});
