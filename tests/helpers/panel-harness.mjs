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

/** A timestamp `minutes` in the past — the list is sorted by `createdAt`
 *  descending, so ordering assertions state their expected order explicitly
 *  rather than leaning on the tie-break of equal timestamps. */
export const minutesAgo = (minutes) => now - minutes * 60_000;

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
export function createFakeTauri(initialState, { failTimes = 0, sourceAppIcons = {} } = {}) {
  let state = structuredClone(initialState);
  let remainingFailures = failTimes;
  const listeners = new Map();
  const listenCalls = new Map();
  const deletedIds = [];
  const invocations = [];
  const invokeCounts = new Map();
  const committedDeleteTokens = [];
  let pendingDelete = null;
  let deleteSequence = 0;
  let getStateCalls = 0;

  const notify = (event, payload = null) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler({ event, payload });
  };

  const tauri = {
    core: {
      invoke: (cmd, args) => {
        invocations.push({ cmd, args: structuredClone(args) });
        invokeCounts.set(cmd, (invokeCounts.get(cmd) || 0) + 1);
        if (cmd === 'get_state') {
          getStateCalls++;
          if (remainingFailures === Infinity || remainingFailures > 0) {
            if (remainingFailures !== Infinity) remainingFailures--;
            return Promise.reject(new Error('IPC unavailable'));
          }
          return Promise.resolve(structuredClone(state));
        }
        if (cmd === 'get_image') return Promise.resolve('data:image/png;base64,AAAA');
        // Every row asks for its source app's real icon. The real command may
        // legitimately answer `null` (no icon on disk) — the row then keeps
        // its initial. Answering explicitly keeps rows from producing
        // unhandled rejections that the uncaught-error assertions would see.
        if (cmd === 'source_app_icon') {
          const bundleId = args?.bundleId ?? '';
          const icon = Object.hasOwn(sourceAppIcons, bundleId) ? sourceAppIcons[bundleId] : null;
          return Promise.resolve(icon);
        }
        if (
          cmd === 'open_settings' ||
          cmd === 'open_about' ||
          cmd === 'open_repository' ||
          cmd === 'hide_panel' ||
          cmd === 'copy_item'
        ) {
          return Promise.resolve(null);
        }
        if (cmd === 'paste_item') return Promise.resolve(Boolean(state.axTrusted));
        if (cmd === 'toggle_pin') {
          const id = args?.id;
          const desired = args?.isPinned;
          const pinnedIndex = state.pinned.findIndex((item) => item.id === id);
          let isPinned;
          if (pinnedIndex >= 0 && desired === false) {
            const [item] = state.pinned.splice(pinnedIndex, 1);
            item.isPinned = false;
            state.history.push(item);
            state.history.sort((a, b) => b.createdAt - a.createdAt);
            isPinned = false;
          } else if (pinnedIndex < 0 && desired === true) {
            const historyIndex = state.history.findIndex((item) => item.id === id);
            if (historyIndex < 0) return Promise.reject(new Error('العنصر غير موجود'));
            const [item] = state.history.splice(historyIndex, 1);
            item.isPinned = true;
            state.pinned.push(item);
            isPinned = true;
          } else {
            isPinned = pinnedIndex >= 0;
          }
          return Promise.resolve(isPinned).then((result) => {
            notify('raff://changed');
            return result;
          });
        }
        if (cmd === 'delete_item') {
          const id = args?.id;
          deletedIds.push(id);
          if (pendingDelete) {
            committedDeleteTokens.push(pendingDelete.token);
            pendingDelete = null;
          }
          const layer = state.pinned.some((item) => item.id === id) ? 'pinned' : 'history';
          const index = state[layer].findIndex((item) => item.id === id);
          if (index < 0) return Promise.reject(new Error('العنصر غير موجود'));
          const [item] = state[layer].splice(index, 1);
          const token = `delete-${++deleteSequence}`;
          pendingDelete = { token, layer, index, item };
          return Promise.resolve({ token }).then((result) => {
            notify('raff://changed');
            return result;
          });
        }
        if (cmd === 'undo_delete') {
          if (pendingDelete?.token !== args?.token) {
            return Promise.reject(new Error('انتهت مهلة التراجع عن الحذف'));
          }
          state[pendingDelete.layer].splice(pendingDelete.index, 0, pendingDelete.item);
          pendingDelete = null;
          return Promise.resolve(null).then((result) => {
            notify('raff://changed');
            return result;
          });
        }
        if (cmd === 'commit_delete') {
          if (pendingDelete?.token === args?.token) {
            committedDeleteTokens.push(pendingDelete.token);
            pendingDelete = null;
          }
          return Promise.resolve(null);
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
    pendingDelete() {
      return pendingDelete ? structuredClone(pendingDelete) : null;
    },
    committedDeleteTokens() {
      return [...committedDeleteTokens];
    },
    listenCallCount(event) {
      return listenCalls.get(event) ?? 0;
    },
    invokeCount(cmd) {
      return invokeCounts.get(cmd) ?? 0;
    },
    invocationArgs(cmd) {
      return invocations.filter((call) => call.cmd === cmd).map((call) => structuredClone(call.args));
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

/** A real, bubbling click — the filter row listens on its container, so a
 *  non-bubbling Event would never reach the delegated handler. */
export function click(dom, el) {
  el.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
}

/**
 * In-place recovery is reached by ⌘R (and by the failure view's own button);
 * «08 — Product Screens» gives the header only the settings action, so there
 * is no refresh button to click any more. The recovery semantics behind it —
 * soft re-init first, a full reload only if that fails — are unchanged.
 */
export function pressCmdR(dom) {
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'r',
      code: 'KeyR',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
}

/** Clicks one of the designed filter segments (الكل / نص / روابط / صور / مثبّت). */
export function clickFilter(dom, name) {
  const seg = dom.window.document.querySelector(`#filters .segment[data-filter="${name}"]`);
  if (!seg) throw new Error(`no filter segment named ${name}`);
  click(dom, seg);
  return seg;
}

/** The `data-filter` of whichever segment is currently marked active. */
export function activeFilter(dom) {
  return dom.window.document.querySelector('#filters .segment.is-active')?.dataset.filter ?? null;
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

  // Timer bookkeeping is installed before the module runs. Repeating timers
  // catch lifecycle leaks; module-owned feedback durations are captured by
  // callback source so harness flush/retry timers do not pollute assertions.
  const feedbackTimers = [];
  const timers = {
    intervalsCreated: 0,
    feedbackTimeouts: [],
    fireFeedback(duration) {
      const entry = [...feedbackTimers].reverse().find((timer) => timer.ms === duration);
      if (!entry) throw new Error(`no feedback timer scheduled for ${duration}ms`);
      entry.fn();
    },
  };
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (fn, ms, ...rest) => {
    timers.intervalsCreated++;
    return realSetInterval(fn, ms, ...rest);
  };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const source = Function.prototype.toString.call(fn);
    if (source.includes('generation !== toastGeneration')) {
      timers.feedbackTimeouts.push(ms);
      feedbackTimers.push({ fn, ms });
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  await import('../../src/js/panel.js');
  await flush();
  return { dom, fake, reloads, uncaught, timers };
}
