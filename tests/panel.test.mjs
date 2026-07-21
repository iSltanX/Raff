// Regression coverage for the floating panel's show/hide lifecycle — the
// webview is never destroyed (Rust just orders the NSPanel in/out), so
// `src/js/panel.js` is a single long-lived module, imported exactly once per
// session. These tests boot that real module (not a reimplementation) once
// and drive it through a fake Tauri bridge that mimics actual async IPC/event
// timing, walking it through one continuous session — matching production —
// to catch state-sync regressions like a panel that reopens with an empty
// list until the whole app restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(here, '../src/index.html'), 'utf8');

const now = Date.now();
const MIN = 60_000;

function sampleItem(id, overrides = {}) {
  return {
    id,
    type: 'text',
    text: `item ${id}`,
    sourceApp: 'Notes',
    sourceAppBundleId: 'com.apple.Notes',
    createdAt: now - 5 * MIN,
    isPinned: false,
    copyCount: 1,
    pasteCount: 0,
    lastUsedAt: now - 5 * MIN,
    hasImage: false,
    ...overrides,
  };
}

/** A fake `window.__TAURI__` that mirrors real async IPC/event timing closely
 * enough to expose ordering bugs: `invoke` always resolves async (or later,
 * when a delay is requested), `listen` registers real handlers and reports
 * how many times each event was subscribed to (duplicate-listener
 * detection). */
function createFakeTauri(initialState) {
  let state = structuredClone(initialState);
  const listeners = new Map();
  const listenCalls = new Map();
  const getStateCalls = [];
  let getStateDelayMs = 0;

  const tauri = {
    core: {
      invoke: (cmd) => {
        switch (cmd) {
          case 'get_state': {
            const delay = getStateDelayMs;
            getStateCalls.push({ delay });
            // Snapshot NOW (real IPC serializes the response at call time,
            // not whenever the promise happens to settle) so a slow request
            // genuinely represents a stale view if the store changes before
            // it resolves.
            const snapshot = structuredClone(state);
            return new Promise((resolve) => setTimeout(() => resolve(snapshot), delay));
          }
          case 'get_image':
            return Promise.resolve('data:image/png;base64,AAAA');
          case 'paste_item':
          case 'copy_item':
          case 'toggle_pin':
          case 'delete_item':
          case 'hide_panel':
            return Promise.resolve(null);
          default:
            return Promise.resolve(null);
        }
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
      for (const handler of [...(listeners.get(event) ?? [])]) handler({ event, payload });
    },
    setState(next) {
      state = next;
    },
    getState() {
      return state;
    },
    listenCallCount(event) {
      return listenCalls.get(event) ?? 0;
    },
    getStateCallCount() {
      return getStateCalls.length;
    },
    setGetStateDelay(ms) {
      getStateDelayMs = ms;
    },
  };
}

function flush(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

function rowIds(dom) {
  return [...dom.window.document.querySelectorAll('.row')].map((r) => r.dataset.id);
}

function listText(dom) {
  return dom.window.document.getElementById('list').textContent;
}

/** Boots the real panel.js module exactly once — matching the app's actual
 * lifecycle, where the webview (and its module state) persists for the whole
 * session and is never re-imported. `store.js`'s Tauri bindings are captured
 * at first import, so every subsequent "fake mount" in the same process
 * would silently keep using this same bridge — the suite below leans into
 * that instead of fighting it, by mounting once and telling one continuous
 * story through it. */
async function mountPanelOnce(initialState) {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost/index.html' });
  // jsdom has no layout engine, so it doesn't implement scrollIntoView.
  dom.window.Element.prototype.scrollIntoView = () => {};
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const fake = createFakeTauri(initialState);
  dom.window.__TAURI__ = fake.tauri;

  dom.window.__uncaughtErrors = [];
  dom.window.addEventListener('error', (e) => dom.window.__uncaughtErrors.push(String(e.error ?? e.message)));
  dom.window.addEventListener('unhandledrejection', (e) =>
    dom.window.__uncaughtErrors.push(String(e.reason))
  );

  await import('../src/js/panel.js');
  // Let the fire-and-forget `listen()` calls (and the initial refresh) land.
  await flush();
  return { dom, fake };
}

test('panel lifecycle: copy/paste an old item, hide, reopen — the list must survive', async (t) => {
  const { dom, fake } = await mountPanelOnce({
    pinned: [sampleItem('pin1', { isPinned: true, text: 'kept pinned' })],
    history: [
      sampleItem('newest', { text: 'newest clip' }),
      sampleItem('old-text', { text: 'an older clip' }),
    ],
    settings: null,
    axTrusted: true,
  });

  await t.test('initial load renders pinned and recent items', () => {
    assert.deepEqual(rowIds(dom), ['pin1', 'newest', 'old-text']);
  });

  await t.test('reopening after copying an OLD TEXT item still shows the full list', async () => {
    // 1) User pastes the OLD item — Rust hides the panel (no JS signal for
    //    that; the webview keeps running) and ~150ms later bumps signals and
    //    broadcasts raff://changed while the panel is still hidden.
    fake.emit('raff://changed', null);
    await flush();
    assert.deepEqual(rowIds(dom), ['pin1', 'newest', 'old-text'], 'still populated while hidden');

    // 2) User reopens via hotkey/tray → Rust emits panel://shown.
    fake.emit('panel://shown', null);
    await flush();
    assert.deepEqual(rowIds(dom), ['pin1', 'newest', 'old-text'], 'list must repopulate, not go blank');
    assert.doesNotMatch(listText(dom), /رفّك فارغ/, 'must not fall back to the empty state');
  });

  await t.test('reopening after copying an OLD IMAGE item still shows the full list', async () => {
    fake.setState({
      pinned: [sampleItem('pin1', { isPinned: true, text: 'kept pinned' })],
      history: [
        sampleItem('newest-img', { type: 'image', text: 'صورة 5×5', hasImage: true }),
        sampleItem('old-image', { type: 'image', text: 'صورة 20×20', hasImage: true }),
      ],
      settings: null,
      axTrusted: true,
    });
    fake.emit('raff://changed', null); // paste's delayed signal bump
    await flush();
    fake.emit('panel://shown', null); // reopen
    await flush();
    assert.deepEqual(rowIds(dom), ['pin1', 'newest-img', 'old-image']);
  });

  await t.test('reopening after copying a PINNED item preserves pin placement', async () => {
    fake.setState({
      pinned: [sampleItem('pin1', { isPinned: true, text: 'kept pinned' })],
      history: [sampleItem('r1')],
      settings: null,
      axTrusted: true,
    });
    fake.emit('raff://changed', null);
    await flush();
    fake.emit('panel://shown', null);
    await flush();
    assert.deepEqual(rowIds(dom), ['pin1', 'r1']);
  });

  await t.test('search text is cleared on reopen but does not lose items', async () => {
    fake.setState({
      pinned: [],
      history: [sampleItem('alpha-item', { text: 'alpha' }), sampleItem('beta-item', { text: 'beta' })],
      settings: null,
      axTrusted: true,
    });
    fake.emit('panel://shown', null); // pick up the new state first
    await flush();

    const search = dom.window.document.getElementById('search');
    search.value = 'alpha';
    search.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.deepEqual(rowIds(dom), ['alpha-item'], 'filtered down while typing');

    // Paste flow: hide (no JS signal), then reopen.
    fake.emit('panel://shown', null);
    await flush();
    assert.equal(search.value, '', 'search box resets on reopen');
    assert.deepEqual(rowIds(dom), ['alpha-item', 'beta-item'], 'full list is back, nothing lost');
  });

  await t.test('repeated hide/show cycles (10x) never duplicate rows', async () => {
    fake.setState({
      pinned: [sampleItem('p1', { isPinned: true })],
      history: [sampleItem('r1'), sampleItem('r2', { type: 'image', hasImage: true })],
      settings: null,
      axTrusted: true,
    });
    for (let i = 0; i < 10; i++) {
      fake.emit('raff://changed', null);
      await flush();
      fake.emit('panel://shown', null);
      await flush();
      assert.deepEqual(rowIds(dom), ['p1', 'r1', 'r2'], `cycle ${i} kept exactly one row per item`);
    }
  });

  await t.test('each event was subscribed to exactly once for the whole session', () => {
    assert.equal(fake.listenCallCount('panel://shown'), 1, 'panel://shown must be subscribed exactly once');
    assert.equal(fake.listenCallCount('raff://changed'), 1, 'raff://changed must be subscribed exactly once');
  });

  await t.test('a slow, stale get_state response cannot overwrite a newer one (race safety)', async () => {
    fake.setState({
      pinned: [],
      history: [sampleItem('race-r1'), sampleItem('race-r2')],
      settings: null,
      axTrusted: true,
    });
    fake.setGetStateDelay(0);
    fake.emit('panel://shown', null);
    await flush();

    // A slow refresh starts (e.g. the delayed raff://changed after a paste)...
    fake.setGetStateDelay(60);
    fake.emit('raff://changed', null);

    // ...then the item is deleted and the panel reopens with a *fast* fetch
    // that resolves before the slow one.
    fake.setState({ pinned: [], history: [sampleItem('race-r1')], settings: null, axTrusted: true });
    fake.setGetStateDelay(5);
    fake.emit('panel://shown', null);

    // Wait past BOTH the fast (5ms) and slow (60ms) responses so the
    // assertion reflects the final settled state, not an intermediate one.
    await new Promise((r) => setTimeout(r, 150));
    fake.setGetStateDelay(0);
    assert.deepEqual(
      rowIds(dom),
      ['race-r1'],
      'the later request (fresh data) must win even though the earlier one resolves last'
    );
  });

  await t.test('a rejected get_state on panel://shown does not leave the panel permanently blank', async () => {
    fake.setState({
      pinned: [],
      history: [sampleItem('err-r1'), sampleItem('err-r2')],
      settings: null,
      axTrusted: true,
    });
    const realInvoke = dom.window.__TAURI__.core.invoke;
    let fail = true;
    dom.window.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === 'get_state' && fail) {
        fail = false;
        return Promise.reject(new Error('IPC hiccup'));
      }
      return realInvoke(cmd, args);
    };

    fake.emit('panel://shown', null);
    await flush(5);
    // The failed attempt must not crash the module or leave a dangling
    // duplicate listener — a later, successful trigger must still repopulate.
    fake.emit('raff://changed', null);
    await flush(5);
    dom.window.__TAURI__.core.invoke = realInvoke;
    assert.deepEqual(rowIds(dom), ['err-r1', 'err-r2']);
  });

  await t.test('regaining window focus also resyncs the list through the official refresh path', async () => {
    fake.setState({ pinned: [], history: [sampleItem('focus-r1')], settings: null, axTrusted: true });
    fake.emit('panel://shown', null);
    await flush();

    // Data changed while the panel was hidden and unfocused (e.g. deleted
    // from the tray) — the panel never got a dedicated event for it.
    fake.setState({
      pinned: [],
      history: [sampleItem('focus-r1'), sampleItem('focus-r2')],
      settings: null,
      axTrusted: true,
    });
    const before = fake.getStateCallCount();
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await flush(5);
    assert.ok(fake.getStateCallCount() > before, 'focus must trigger a fresh get_state call');
    assert.deepEqual(rowIds(dom), ['focus-r1', 'focus-r2']);
  });

  await t.test('no console/uncaught errors happened during the whole session', () => {
    assert.deepEqual(dom.window.__uncaughtErrors ?? [], []);
  });
});
