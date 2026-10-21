// `store.js` is evaluated once per process, but a test file may mount several
// windows in turn, each with its own fake bridge. A module that captured the
// first window's `invoke` at import would send every later window's calls to
// a fake nobody is watching any more, and a test asserting that nothing was
// saved would pass for that reason alone (audit 025).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

function bridge(name) {
  const calls = [];
  const listened = [];
  return {
    calls,
    listened,
    tauri: {
      core: {
        invoke(command, args) {
          calls.push({ command, args });
          return Promise.resolve(`${name}:${command}`);
        },
      },
      event: {
        listen(event) {
          listened.push(event);
          return Promise.resolve(() => {});
        },
      },
    },
  };
}

function useWindow(tauri) {
  const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/index.html' });
  if (tauri) dom.window.__TAURI__ = tauri;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

test('every call reaches the bridge of the window that is current now', async () => {
  const first = bridge('first');
  useWindow(first.tauri);
  const { api, on } = await import('../src/js/store.js');

  assert.equal(await api.getState(), 'first:get_state');
  await on('raff://changed', () => {});

  const second = bridge('second');
  useWindow(second.tauri);
  assert.equal(await api.getState(), 'second:get_state', 'the second window answers');
  await on('raff://changed', () => {});

  assert.deepEqual(first.calls.map((call) => call.command), ['get_state']);
  assert.deepEqual(second.calls.map((call) => call.command), ['get_state']);
  assert.deepEqual(first.listened, ['raff://changed']);
  assert.deepEqual(second.listened, ['raff://changed']);
});

test('arguments pass through unchanged', async () => {
  const live = bridge('live');
  useWindow(live.tauri);
  const { api } = await import('../src/js/store.js');
  await api.togglePin('a', false);
  assert.deepEqual(live.calls.at(-1), { command: 'toggle_pin', args: { id: 'a', isPinned: false } });
});
