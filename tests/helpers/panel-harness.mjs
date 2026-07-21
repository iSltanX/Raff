// Shared harness for the panel recovery suites.
//
// `src/js/panel.js` is a long-lived singleton in production (the webview is
// never destroyed — Rust just orders the NSPanel in and out) and ES modules
// are cached per process, so a module can only be mounted once per test file.
// Each recovery scenario that needs a *fresh* first load therefore lives in
// its own file, and they share this harness instead of duplicating it.
//
// `tests/panel.test.mjs` deliberately keeps its own inline copy: it is the
// passing regression suite for the v2.1.2 fix and is left untouched.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(here, '../../src/index.html'), 'utf8');

const now = Date.now();

export function sampleItem(id, overrides = {}) {
  return {
    id,
    type: 'text',
    text: `item ${id}`,
    sourceApp: 'Notes',
    sourceAppBundleId: 'com.apple.Notes',
    createdAt: now - 5 * 60_000,
    isPinned: false,
    copyCount: 1,
    pasteCount: 0,
    lastUsedAt: now - 5 * 60_000,
    hasImage: false,
    ...overrides,
  };
}

export function emptyState() {
  return { pinned: [], history: [], settings: null, axTrusted: true };
}

/**
 * A fake Tauri bridge whose `get_state` can be made to fail a set number of
 * times (or forever), so the retry / failure paths are driven exactly the way
 * a flaky or wedged IPC channel would drive them.
 */
export function createFakeTauri(initialState, { failTimes = 0 } = {}) {
  let state = structuredClone(initialState);
  let remainingFailures = failTimes;
  const listeners = new Map();
  const listenCalls = new Map();
  const deletedIds = [];
  let getStateCalls = 0;

  const notify = (event, payload = null) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler({ event, payload });
  };

  const tauri = {
    core: {
      invoke: (cmd, args) => {
        if (cmd === 'get_state') {
          getStateCalls++;
          if (remainingFailures === Infinity || remainingFailures > 0) {
            if (remainingFailures !== Infinity) remainingFailures--;
            return Promise.reject(new Error('IPC unavailable'));
          }
          return Promise.resolve(structuredClone(state));
        }
        if (cmd === 'get_image') return Promise.resolve('data:image/png;base64,AAAA');
        if (cmd === 'delete_item') {
          // Mirrors the real `delete_item` command: mutate the store, persist
          // (there is no disk here, but the mutation is permanent within this
          // fake's `state`), then notify — so a later get_state (a refresh)
          // never brings the deleted item back.
          const id = args?.id;
          deletedIds.push(id);
          state = {
            ...state,
            pinned: state.pinned.filter((i) => i.id !== id),
            history: state.history.filter((i) => i.id !== id),
          };
          return Promise.resolve(null).then((result) => {
            notify('raff://changed');
            return result;
          });
        }
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (event, handler) => {
        listenCalls.set(event, (listenCalls.get(event) || 0) + 1);
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return Promise.resolve(() => listeners.get(event)?.delete(handler));
      },
    },
  };

  return {
    tauri,
    emit(event, payload) {
      notify(event, payload);
    },
    setState(next) {
      state = next;
    },
    getState() {
      return structuredClone(state);
    },
    failForever() {
      remainingFailures = Infinity;
    },
    stopFailing() {
      remainingFailures = 0;
    },
    deletedIds() {
      return [...deletedIds];
    },
    listenCallCount(event) {
      return listenCalls.get(event) ?? 0;
    },
    getStateCallCount() {
      return getStateCalls;
    },
  };
}

export function flush(times = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Long enough for both retry backoffs (250ms + 750ms) plus slack. */
export const RETRIES_EXHAUSTED_MS = 1400;

export function rowIds(dom) {
  return [...dom.window.document.querySelectorAll('.row')].map((r) => r.dataset.id);
}

export function listText(dom) {
  return dom.window.document.getElementById('list').textContent;
}

/**
 * Boots the real panel module once, with `location.reload` stubbed so the
 * fallback path is observable instead of tearing the test env down.
 */
export async function mountPanel(initialState, options = {}) {
  // jsdom locks `location` and `location.reload` down, so rather than stubbing
  // the production call we observe it: jsdom reports an attempted reload as a
  // `jsdomError` on the virtual console. Nothing in `panel.js` is altered for
  // the sake of the tests.
  const reloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (/not implemented: navigation/i.test(err.message)) reloads.push(err.message);
  });

  const dom = new JSDOM(indexHtml, { url: 'http://localhost/index.html', virtualConsole });
  dom.window.Element.prototype.scrollIntoView = () => {};
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const fake = createFakeTauri(initialState, options);
  dom.window.__TAURI__ = fake.tauri;

  const uncaught = [];
  dom.window.addEventListener('error', (e) => uncaught.push(String(e.error ?? e.message)));
  dom.window.addEventListener('unhandledrejection', (e) => uncaught.push(String(e.reason)));

  // Real timer bookkeeping, installed before the module runs. Repeating timers
  // are the leak-prone kind: one extra interval per show/hide cycle would go
  // unnoticed for a whole session. `panel.js` calls the bare global (a browser
  // global in production), so the counter must sit on `globalThis`, not on the
  // jsdom window — instrumenting the window would silently count nothing.
  // Timeouts are deliberately not counted: the harness's own waits use them,
  // so the number would say nothing about the module.
  const timers = { intervalsCreated: 0 };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...rest) => {
    timers.intervalsCreated++;
    return realSetInterval(fn, ms, ...rest);
  };
  await import('../../src/js/panel.js');
  await flush();
  return { dom, fake, reloads, uncaught, timers };
}
