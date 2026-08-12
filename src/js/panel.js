// Floating panel behavior: instant filter, full keyboard control, paste.
// Clip content is ALWAYS rendered via textContent — never innerHTML.
//
// View structure follows Figma «08 — Product Screens» (2:7684 / 2:7791 / 2:7880):
// timestamp on the left, preview in the centre, source app on the right, with
// a filter row above the list and a hint footer below it.

import { api, on } from './store.js';
import { arabicDigits, filterItems, relativeTimeAr } from './logic.js';
import { BRAND_MARK, SETTINGS, SEARCH, CLEAR, PIN, PIN_TOGGLE, ALERT, SHELF } from './icons.js';
import { diag, installGlobalTraps } from './diag.js';

diag('module:start');

const panelEl = document.getElementById('panel');
const searchEl = document.getElementById('search');
const searchClearEl = document.getElementById('search-clear');
const listEl = document.getElementById('list');
const toastEl = document.getElementById('toast');
const footerHintEl = document.getElementById('footer-hint');
const filtersEl = document.getElementById('filters');
const settingsBtn = document.getElementById('settings-btn');
const closeBtn = document.getElementById('panel-close');

// Static, author-controlled SVG constants — safe as innerHTML.
document.getElementById('brand-mark').innerHTML = BRAND_MARK;
document.getElementById('search-glyph').innerHTML = SEARCH;
settingsBtn.innerHTML = SETTINGS;
searchClearEl.innerHTML = CLEAR;

let state = { pinned: [], history: [], settings: null, axTrusted: false };
let query = '';
let filter = 'all';
let selectedId = null;
let visible = []; // flat filtered list, newest first
const thumbs = new Map(); // item id → data URL
const appIcons = new Map(); // bundle id → data URL | null
let toastTimer = null;

// The list area has three distinct states and they must never be confused:
//   'loading' — the first fetch has not answered yet
//   'ready'   — data is in hand (which may legitimately be zero items)
//   'error'   — data could not be fetched, or rendering threw
// Only 'ready' + zero items is the natural «الرفّ فارغ» empty shelf.
let phase = 'loading';

// ─── Rendering ────────────────────────────────────────────────────────────

function stateView(art, title, sub, extraClass = '') {
  const view = document.createElement('div');
  view.className = `state-view ${extraClass}`.trim();
  const artEl = document.createElement('div');
  artEl.className = 'state-art';
  artEl.innerHTML = art; // static SVG constant
  const text = document.createElement('div');
  text.className = 'state-text';
  const titleEl = document.createElement('div');
  titleEl.className = 'state-title';
  titleEl.textContent = title;
  const subEl = document.createElement('div');
  subEl.className = 'state-sub';
  subEl.textContent = sub;
  text.append(titleEl, subEl);
  view.append(artEl, text);
  return view;
}

/** The Arabic failure state — shown instead of a silently blank list.
 *  Deliberately carries no technical detail; the cause goes to `diag` only. */
function failureView() {
  const view = stateView(
    ALERT,
    'تعذّر عرض محتوى رفّ',
    'حدث خلل مؤقت في العرض. يمكنك إعادة تحميل الواجهة دون فقدان محتواك.',
    'is-failure'
  );
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'state-action';
  action.id = 'failure-reload';
  action.textContent = 'إعادة تحميل الواجهة';
  action.addEventListener('click', () => hardReload('failure-view'));
  view.append(action);
  return view;
}

/** Lazily resolve the source app's real icon; fall back to its initial. */
async function loadAppIcon(bundleId, host) {
  if (!bundleId) return;
  if (appIcons.has(bundleId)) {
    const cached = appIcons.get(bundleId);
    if (cached) paintAppIcon(host, cached);
    return;
  }
  try {
    const url = await api.sourceAppIcon(bundleId);
    appIcons.set(bundleId, url || null);
    if (url) paintAppIcon(host, url);
  } catch {
    appIcons.set(bundleId, null); // the initial stays — decorative either way
  }
}

function paintAppIcon(host, url) {
  const img = document.createElement('img');
  img.alt = '';
  img.width = 14;
  img.height = 14;
  img.src = url;
  host.replaceChildren(img);
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = item.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(item.id === selectedId));
  if (item.id === selectedId) row.classList.add('selected');

  // ── left: timestamp, and the pin marker when the item is pinned
  const timeWrap = document.createElement('div');
  timeWrap.className = 'row-time';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = relativeTimeAr(item.createdAt);
  timeWrap.append(time);
  if (item.isPinned) {
    const pin = document.createElement('span');
    pin.className = 'pin-indicator';
    pin.title = 'مثبّت';
    pin.innerHTML = PIN; // static SVG constant
    timeWrap.append(pin);
  }

  // ── centre: the clip preview
  const preview = document.createElement('div');
  preview.className = 'row-preview';

  if (item.type === 'image') {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';
    const img = document.createElement('img');
    img.alt = arabicDigits(item.text); // "صورة ٤٢٠×٣١٥"
    if (thumbs.has(item.id)) img.src = thumbs.get(item.id);
    else loadThumb(item.id, img);
    thumb.append(img);
    preview.append(thumb);
  } else {
    // «08» renders text and code identically — Cairo Medium 12, right-aligned,
    // with dir=auto letting a Latin snippet read left-to-right in place. Only
    // links get their own treatment.
    const title = document.createElement('div');
    title.className = 'preview-title';
    if (item.type === 'link') title.classList.add('is-link');
    else title.dir = 'auto';
    title.textContent = item.text; // clip content → textContent
    preview.append(title);
  }

  // ── right: the source application
  const source = document.createElement('div');
  source.className = 'row-source';
  const name = document.createElement('span');
  name.className = 'source-name';
  name.textContent = item.sourceApp || '';
  const icon = document.createElement('span');
  icon.className = 'source-icon';
  icon.textContent = (item.sourceApp || '؟').trim().charAt(0);
  loadAppIcon(item.sourceAppBundleId, icon);
  source.append(name, icon);

  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'pin-btn' + (item.isPinned ? ' is-pinned' : '');
  pinBtn.innerHTML = PIN_TOGGLE; // static SVG constant
  pinBtn.title = item.isPinned ? 'إلغاء التثبيت' : 'تثبيت';
  pinBtn.tabIndex = -1;
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    api.togglePin(item.id);
  });

  row.addEventListener('click', () => {
    selectedId = item.id;
    render();
  });
  row.addEventListener('dblclick', () => paste(item.id, false));

  row.append(timeWrap, preview, source, pinBtn);
  return row;
}

/** The designed type filters, backed by the item's own kind + pin flag. */
function matchesFilter(item) {
  switch (filter) {
    case 'text':
      return item.type === 'text' || item.type === 'code';
    case 'link':
      return item.type === 'link';
    case 'image':
      return item.type === 'image';
    case 'pinned':
      return item.isPinned;
    default:
      return true;
  }
}

function renderList() {
  if (phase === 'loading') {
    listEl.replaceChildren(stateView(SHELF, 'جارٍ التحميل…', 'لحظة من فضلك'));
    visible = [];
    syncChrome();
    return;
  }
  if (phase === 'error') {
    listEl.replaceChildren(failureView());
    visible = [];
    syncChrome();
    return;
  }

  // «08» shows one chronological list with pinned items marked in place —
  // there are no section headers. The مثبّت segment is how you isolate them.
  const all = [...state.pinned, ...state.history].sort((a, b) => b.createdAt - a.createdAt);
  visible = filterItems(all, query).filter(matchesFilter);

  if (!visible.some((i) => i.id === selectedId)) {
    selectedId = visible[0]?.id ?? null;
  }

  listEl.replaceChildren();
  syncChrome();

  if (visible.length === 0) {
    if (query || filter !== 'all') {
      listEl.append(stateView(SHELF, 'لا نتائج', 'جرّب كلمة أخرى أو صنفًا مختلفًا'));
    } else {
      // Genuinely nothing saved yet — never shown for a failed fetch.
      listEl.append(
        stateView(SHELF, 'الرفّ فارغ', 'انسخ أي شيء وسيظهر بشكل آمن وجميل على رفّك القريب')
      );
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  visible.forEach((item) => fragment.append(buildRow(item)));
  if (query) {
    const end = document.createElement('div');
    end.className = 'results-end';
    end.textContent = `نهاية نتائج البحث عن «${query}»`;
    fragment.append(end);
  }
  listEl.append(fragment);
  scrollSelectedIntoView();
}

/** Footer copy and the clear button follow the current view state. */
function syncChrome() {
  searchClearEl.hidden = query.length === 0;
  if (toastEl.hidden) {
    footerHintEl.hidden = false;
    if (phase !== 'ready') {
      footerHintEl.textContent = '';
    } else if (query) {
      footerHintEl.textContent = 'اضغط ↵ للصق النتيجة المحددة';
    } else if (visible.length === 0) {
      footerHintEl.textContent = 'في انتظار نسخك الأول…';
    } else {
      footerHintEl.replaceChildren();
      const kbd = document.createElement('kbd');
      kbd.textContent = '⌘V';
      footerHintEl.append(kbd, document.createTextNode(' للصق الفوري'));
    }
  }
}

/**
 * The error boundary. `renderList` clears the list before refilling it, so a
 * throw partway through would otherwise leave the panel permanently blank
 * with no way back — exactly the silent-blank-screen failure we must never
 * ship. Catching here converts any render fault into the Arabic failure
 * state, and the technical cause goes to `diag` only.
 */
function render() {
  try {
    renderList();
  } catch (err) {
    diag('render:threw', err);
    if (phase === 'error') return; // already showing the failure state
    phase = 'error';
    try {
      listEl.replaceChildren(failureView());
    } catch {
      // Last resort: the failure view itself could not be built.
      listEl.textContent = 'تعذّر عرض محتوى رفّ';
    }
  }
}

async function loadThumb(id, img) {
  try {
    const url = await api.getImage(id);
    if (url) {
      thumbs.set(id, url);
      img.src = url;
    }
  } catch {
    /* thumbnail is decorative */
  }
}

function scrollSelectedIntoView() {
  listEl.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  footerHintEl.hidden = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    syncChrome();
  }, 2200);
}

// ─── Actions ──────────────────────────────────────────────────────────────

function paste(id, plain) {
  if (!id) return;
  api.pasteItem(id, plain).catch((err) => showToast(String(err)));
  if (!state.axTrusted) {
    showToast('نُسخ إلى الحافظة — الصقه بـ ⌘V');
  }
}

function moveSelection(delta) {
  if (visible.length === 0) return;
  const index = visible.findIndex((i) => i.id === selectedId);
  const next = Math.min(visible.length - 1, Math.max(0, index + delta));
  selectedId = visible[next].id;
  render();
}

function setFilter(next) {
  if (filter === next) return;
  filter = next;
  for (const seg of filtersEl.querySelectorAll('.segment')) {
    const on = seg.dataset.filter === next;
    seg.classList.toggle('is-active', on);
    seg.setAttribute('aria-selected', String(on));
  }
  render();
}

// Bumped on every refresh() call so a slower in-flight request can never
// clobber a fresher one, and a failed request just leaves this refresh a
// no-op instead of corrupting `state` — the next trigger (panel://shown,
// raff://changed, window focus) retries cleanly.
let refreshToken = 0;

/** Two retries, then stop. Bounded on purpose — never a reload loop. */
const RETRY_DELAYS_MS = [250, 750];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches state and re-renders. With `retry`, a failed fetch is attempted up
 * to two more times with a short backoff before the failure state is
 * considered.
 *
 * Resolves to one of:
 *   'ok'         — fresh data landed and was rendered
 *   'superseded' — a newer refresh took over; that one owns the outcome
 *   'failed'     — every attempt failed
 * 'superseded' must stay distinct from 'failed': a `panel://shown` arriving
 * mid-refresh is a normal race, not a fault, and must never be mistaken for
 * one and answered with a reload.
 */
async function refresh({ retry = false } = {}) {
  const token = ++refreshToken;
  const attempts = retry ? RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
      if (token !== refreshToken) return 'superseded'; // superseded while backing off
      diag('refresh:retry', attempt);
    }
    try {
      const next = await api.getState();
      if (token !== refreshToken) return 'superseded'; // a newer refresh already won
      state = next;
      phase = 'ready';
      diag('refresh:ok', {
        items: (next?.pinned?.length ?? 0) + (next?.history?.length ?? 0),
      });
      render();
      return 'ok';
    } catch (err) {
      if (token !== refreshToken) return 'superseded';
      diag('refresh:failed', err);
    }
  }

  if (token !== refreshToken) return 'superseded';
  // Only escalate to the failure state when there is nothing on screen. If an
  // earlier fetch succeeded, keep the last good list rather than blanking a
  // working panel over a transient hiccup.
  if (phase !== 'ready') {
    phase = 'error';
    render();
  }
  return 'failed';
}

/**
 * Forces WebKit to emit a fresh layer-tree update.
 *
 * While the panel is hidden macOS suspends its WebContent process: the layer
 * tree is frozen, rendering resources are destroyed and the layer backing
 * stores are marked volatile (all visible in
 * `log show --predicate 'process == "raff"'`). On the way back the UI process
 * keeps the old content hidden until the resumed web process delivers a new
 * layer-tree update — so when that update is slow, or the volatile backing
 * stores were purged under memory pressure, the panel is presented blank.
 * Dirtying a compositing property guarantees the update lands. This is the
 * repaint a manual reload was incidentally forcing.
 */
function forceRepaint() {
  if (!panelEl) return;
  panelEl.style.opacity = '0.999';
  void panelEl.offsetHeight; // synchronous layout flush
  const restore = () => {
    panelEl.style.opacity = '';
  };
  // rAF fires on the first frame after the web process resumes — exactly when
  // the repaint is due. Falling back to a timer keeps this safe in any host
  // without rAF; either way the worst case is opacity stuck at 0.999, which is
  // visually identical to 1.
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore);
  else setTimeout(restore, 0);
  diag('repaint');
}

/** Full frontend reload — the fallback, never the primary cure. */
function hardReload(reason) {
  diag('reload:manual', reason);
  window.location.reload();
}

/**
 * In-place recovery. «08» gives the header only the settings action, so this
 * is reached by ⌘R (and by the failure view's own button) rather than by a
 * toolbar button — the capability is preserved, the chrome stays as designed.
 */
let recovering = false;

async function recover() {
  if (recovering) return;
  recovering = true;
  diag('recover:start');
  try {
    const outcome = await refresh({ retry: true });
    if (outcome !== 'failed') {
      // 'superseded' means a concurrent refresh is already delivering fresh
      // data — recovered either way, so no reload.
      forceRepaint();
      diag('recover:soft-ok', outcome);
      return;
    }
    diag('recover:fallback-reload');
    hardReload('recover-fallback');
  } finally {
    recovering = false;
  }
}

// ─── Chrome actions ───────────────────────────────────────────────────────

settingsBtn.addEventListener('click', () => api.openSettings());
closeBtn.addEventListener('click', () => api.hidePanel());
searchClearEl.addEventListener('click', () => {
  query = '';
  searchEl.value = '';
  searchEl.focus();
  render();
});
filtersEl.addEventListener('click', (e) => {
  const seg = e.target.closest('.segment');
  if (seg) setFilter(seg.dataset.filter);
});

// ─── Keyboard (full control — mouse optional) ─────────────────────────────

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      moveSelection(1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      moveSelection(-1);
      return;
    case 'PageDown':
      e.preventDefault();
      moveSelection(6);
      return;
    case 'PageUp':
      e.preventDefault();
      moveSelection(-6);
      return;
    case 'Enter':
      e.preventDefault();
      paste(selectedId, e.altKey); // ⌥⏎ = لصق كنص عادي
      return;
    case 'Escape':
      e.preventDefault();
      if (query) {
        query = '';
        searchEl.value = '';
        render();
      } else {
        api.hidePanel();
      }
      return;
  }
  if (e.altKey && e.code === 'KeyP') {
    e.preventDefault();
    if (selectedId) api.togglePin(selectedId);
    return;
  }
  if (e.metaKey && e.code === 'KeyF') {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }
  if (e.metaKey && e.code === 'KeyR') {
    e.preventDefault();
    recover();
    return;
  }
  if (e.metaKey && e.key === 'Backspace') {
    // A text field (the search input) owns ⌘⌫ for its own native editing —
    // delete-to-start-of-line, or a no-op when empty. Item deletion must
    // never steal that away while the user is typing.
    if (isWritable(document.activeElement)) return;
    e.preventDefault();
    if (selectedId) {
      // Keep the selection at the same list position instead of snapping
      // back to the first row after the refresh.
      const index = visible.findIndex((i) => i.id === selectedId);
      const doomed = selectedId;
      selectedId = visible[index + 1]?.id ?? visible[index - 1]?.id ?? null;
      api.deleteItem(doomed);
    }
    return;
  }
  if (e.metaKey && e.code === 'KeyC') {
    e.preventDefault();
    if (selectedId) {
      api
        .copyItem(selectedId)
        .then(() => showToast('نُسخ إلى الحافظة'))
        .catch((err) => showToast(String(err)));
    }
    return;
  }
  // Any printable key goes to the search field.
  if (!e.metaKey && !e.ctrlKey && document.activeElement !== searchEl) {
    searchEl.focus();
  }
});

searchEl.addEventListener('input', () => {
  query = searchEl.value;
  render();
});

// ─── Events from Rust ─────────────────────────────────────────────────────

on('raff://changed', () => refresh()).catch((err) => diag('listen:failed', err));
on('panel://shown', async () => {
  diag('event:panel-shown');
  query = '';
  searchEl.value = '';
  selectedId = null;
  setFilter('all');
  // Repaint before and after the fetch: the first invalidates whatever frozen
  // frame the suspended web process left behind, the second guarantees the
  // freshly rendered list is actually composited.
  forceRepaint();
  await refresh({ retry: true });
  forceRepaint();
  searchEl.focus();
  // Measured on this app: `panel://shown` is delivered ~30ms BEFORE WebKit
  // marks the view visible ("UIProcess is taking a foreground assertion
  // because the view is visible"). A repaint that lands entirely inside that
  // window leaves the layer tree clean again just as WebKit unhides it and
  // waits for an update that never comes. One bounded, one-shot nudge after
  // the gap closes covers that — it is not a timer loop.
  setTimeout(forceRepaint, 120);
}).catch((err) => diag('listen:failed', err));

// Belt-and-suspenders alongside panel://shown: if the panel ever regains
// focus without that IPC event landing (native window activation is a more
// reliable signal than a webview message), this still resyncs the list
// through the same guarded refresh() path — without resetting the search.
window.addEventListener('focus', () => {
  searchEl.focus();
  forceRepaint();
  refresh();
});

// Keep relative times fresh while the panel is open.
setInterval(() => {
  if (document.visibilityState === 'visible' && visible.length > 0) render();
}, 30000);

// The native WKWebView page menu is English and offers a technical reload that
// has no place in an Arabic panel. But it is suppressed ONLY over inert areas:
// inside a writable field, or when text is selected, WebKit shows the editing
// menu (cut / copy / paste / select) instead, and that must keep working.
function isWritable(node) {
  // nodeType 1 = element; text nodes are asked via their parent. Checked by
  // nodeType rather than `instanceof Element` so this never depends on a
  // global that only exists inside a browser realm.
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
}

window.addEventListener('contextmenu', (e) => {
  if (isWritable(e.target)) return; // editing menu — leave it alone
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) return; // text is selected → allow copy
  e.preventDefault();
});

// Anything that escapes every local handler must not leave a silent blank
// window. Only escalate when nothing is on screen — a stray rejection (a
// decorative thumbnail, say) must not tear down a working list.
installGlobalTraps(() => {
  if (phase === 'ready') return;
  phase = 'error';
  render();
});

diag('mount:ok');

refresh({ retry: true }).then(() => {
  forceRepaint();
  searchEl.focus();
});
