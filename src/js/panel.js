// Floating panel behavior: instant filter, full keyboard control, paste.
// Clip content is ALWAYS rendered via textContent — never innerHTML.
//
// View structure adapts the approved Raff row language to production density:
// the copied preview owns the flexible space, one Raff semantic icon identifies
// its content type, and the paired Figma actions sit at the trailing edge.

import { api, on } from './store.js';
import { arabicDigits, filterItems } from './logic.js';
import {
  BRAND_MARK,
  SETTINGS,
  SEARCH,
  CLEAR,
  PIN,
  PIN_TOGGLE,
  TRASH,
  CHECK,
  ALERT,
  IMAGE,
  SHELF,
  contentTypeIcon,
  createIcon,
} from './icons.js';
import { diag, installGlobalTraps } from './diag.js';

diag('module:start');

const panelEl = document.getElementById('panel');
const panelHeaderEl = document.getElementById('panel-header');
const searchEl = document.getElementById('search');
const searchClearEl = document.getElementById('search-clear');
const listEl = document.getElementById('list');
const panelFeedbackEl = document.getElementById('panel-feedback');
const feedbackAnnouncerEl = document.getElementById('feedback-announcer');
const toastEl = document.getElementById('toast');
const toastIconEl = document.getElementById('toast-icon');
const toastMessageEl = document.getElementById('toast-message');
const toastUndoEl = document.getElementById('toast-undo');
const toastActionEl = document.getElementById('toast-action');
const footerHintEl = document.getElementById('footer-hint');
const filtersEl = document.getElementById('filters');
const settingsBtn = document.getElementById('settings-btn');
const closeBtn = document.getElementById('panel-close');

// Original, author-controlled exports from the approved Figma layers.
document.getElementById('brand-mark').replaceChildren(createIcon(BRAND_MARK));
document.getElementById('search-glyph').replaceChildren(createIcon(SEARCH));
settingsBtn.replaceChildren(createIcon(SETTINGS));
searchClearEl.replaceChildren(createIcon(CLEAR));

let state = { pinned: [], history: [], settings: null, axTrusted: false };
let query = '';
let filter = 'all';
let selectedId = null;
let visible = []; // flat filtered list, newest first
const thumbs = new Map(); // item id → data URL
const optimisticDeletedIds = new Set();
const optimisticPins = new Map(); // item id → { generation, value }
const optimisticRestores = new Map(); // item id → deleted-row snapshot during Undo IPC
let pinMutationGeneration = 0;
let toastTimer = null;
let toastExitTimer = null;
let toastGeneration = 0;
let activeDelete = null; // { token, snapshot }
const feedbackQueue = [];
let mutationQueue = Promise.resolve();

const PIN_TOAST_MS = 3000;
const DELETE_TOAST_MS = 5000;
/** Longer than PIN_TOAST_MS: this toast carries a button the user needs time
 * to read and act on, not just a status line to glance at. */
const ACCESS_TOAST_MS = 6000;
const TOAST_EXIT_MS = 120;

// The list area has three distinct states and they must never be confused:
//   'loading' — the first fetch has not answered yet
//   'ready'   — data is in hand (which may legitimately be zero items)
//   'error'   — data could not be fetched, or rendering threw
// Only 'ready' + zero items is the natural «الرفّ فارغ» empty shelf.
let phase = 'loading';

// ─── Rendering ────────────────────────────────────────────────────────────

/**
 * The search field keeps DOM focus so typing always remains instant. It is a
 * combobox whose active descendant points into this interactive grid; visual selection,
 * aria-selected, and the announced row therefore stay as one state.
 */
function setListStructure(hasOptions) {
  listEl.removeAttribute('aria-live');
  listEl.removeAttribute('aria-atomic');
  if (hasOptions) {
    listEl.setAttribute('role', 'grid');
    listEl.setAttribute('aria-label', 'عناصر الحافظة');
  } else {
    // Loading and empty/error views are status content, so expose the
    // container as a labelled region instead of an empty grid.
    listEl.setAttribute('role', 'region');
    listEl.setAttribute('aria-label', 'حالة عناصر الحافظة');
    listEl.removeAttribute('aria-rowcount');
  }
}

function syncActiveOption() {
  const selected = listEl.querySelector('.row.selected[role="row"]');
  if (selected) {
    searchEl.setAttribute('aria-activedescendant', selected.id);
    searchEl.setAttribute('aria-expanded', 'true');
  } else {
    searchEl.removeAttribute('aria-activedescendant');
    searchEl.setAttribute('aria-expanded', 'false');
  }
}

function stateView(art, title, sub, extraClass = '') {
  const view = document.createElement('div');
  view.className = `state-view ${extraClass}`.trim();
  const isFailure = extraClass.split(/\s+/).includes('is-failure');
  view.setAttribute('role', isFailure ? 'alert' : 'status');
  view.setAttribute('aria-live', isFailure ? 'assertive' : 'polite');
  view.setAttribute('aria-atomic', 'true');
  const text = document.createElement('div');
  text.className = 'state-text';
  const titleEl = document.createElement('div');
  titleEl.className = 'state-title';
  titleEl.textContent = title;
  const subEl = document.createElement('div');
  subEl.className = 'state-sub';
  subEl.textContent = sub;
  text.append(titleEl, subEl);
  if (art) {
    const artEl = document.createElement('div');
    artEl.className = 'state-art';
    if (Array.isArray(art)) {
      artEl.classList.add('shelf-illustration');
      artEl.replaceChildren(...art.map((line) => createIcon(line)));
    } else {
      artEl.replaceChildren(createIcon(art));
    }
    view.append(artEl);
  }
  view.append(text);
  return view;
}

/**
 * Loading is a structural state, not an empty-content state. Figma «07 —
 * Patterns & States» uses row skeletons here, keeping the eventual list
 * geometry stable while the first native-store read is in flight.
 */
function loadingView() {
  const view = document.createElement('div');
  view.className = 'loading-state';

  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.textContent = 'جارٍ التحميل…';
  view.append(status);

  for (let index = 0; index < 4; index++) {
    const row = document.createElement('div');
    row.className = 'skeleton-row';
    row.setAttribute('aria-hidden', 'true');

    const preview = document.createElement('span');
    preview.className = 'skeleton-preview';
    const primary = document.createElement('span');
    primary.className = 'skeleton-block skeleton-line skeleton-line-primary';
    const secondary = document.createElement('span');
    secondary.className = 'skeleton-block skeleton-line skeleton-line-secondary';
    preview.append(primary, secondary);

    const kind = document.createElement('span');
    kind.className = 'skeleton-kind';
    const kindIcon = document.createElement('span');
    kindIcon.className = 'skeleton-block skeleton-kind-icon';
    kind.append(kindIcon);

    // No action placeholder: the live row reserves no space for its actions,
    // so a skeleton that drew one would promise a column that never arrives.
    row.append(preview, kind);
    view.append(row);
  }

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

function textScriptClass(value) {
  const text = String(value || '');
  const hasArabic = /[\u0600-\u06ff]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (hasArabic && hasLatin) return 'is-mixed';
  if (hasLatin) return 'is-latin';
  return 'is-arabic';
}

function buildRow(item, index) {
  const row = document.createElement('div');
  row.className = 'row';
  row.id = `raff-option-${index + 1}`;
  row.dataset.id = item.id;
  row.dataset.type = item.type;
  row.setAttribute('role', 'row');
  row.setAttribute('aria-selected', String(item.id === selectedId));
  row.setAttribute('aria-rowindex', String(index + 1));
  if (item.id === selectedId) row.classList.add('selected');
  // Pinned is a row STATE (quiet brand edge + resting flag), so the unpin
  // control can stay contextual instead of living permanently in the row.
  if (item.isPinned) row.classList.add('is-pinned');

  // ── flexible centre: the copied content is the row's primary information.
  const preview = document.createElement('div');
  preview.className = 'row-preview';
  preview.setAttribute('role', 'gridcell');

  if (item.type === 'image') {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';
    thumb.dataset.state = 'loading';
    thumb.setAttribute('role', 'img');
    thumb.setAttribute('aria-label', arabicDigits(item.text));
    const placeholder = document.createElement('span');
    placeholder.className = 'preview-thumb-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.append(createIcon(IMAGE, 'preview-thumb-icon'));
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => {
      thumb.dataset.state = 'ready';
    });
    img.addEventListener('error', () => {
      thumb.dataset.state = 'unavailable';
    });
    if (thumbs.has(item.id)) img.src = thumbs.get(item.id);
    else requestThumb(item.id, img, thumb);
    thumb.append(placeholder, img);
    preview.append(thumb);
  } else {
    // «08» renders text and code identically — Cairo Medium 12, right-aligned,
    // with dir=auto letting a Latin snippet read left-to-right in place. Only
    // links get their own treatment.
    const title = document.createElement('div');
    title.className = 'preview-title';
    if (item.type === 'link') title.classList.add('is-link');
    else {
      title.classList.add(textScriptClass(item.text));
      if (item.type === 'code') title.classList.add('is-code');
      title.dir = 'auto';
    }
    title.textContent = item.text; // clip content → textContent
    preview.append(title);
  }

  // ── content type: one synchronous local Figma asset. Source application
  // metadata remains available to search and assistive text, but it never
  // participates in icon selection or causes native icon resolution.
  const kind = document.createElement('div');
  kind.className = 'row-kind';
  kind.setAttribute('role', 'gridcell');
  const presentation = contentTypeIcon(item.type);
  const sourceName = item.sourceApp || 'تطبيق غير معروف';
  kind.title = `${presentation.label} • المصدر: ${sourceName}`;
  kind.setAttribute(
    'aria-label',
    `نوع المحتوى: ${presentation.label}. المصدر: ${sourceName}`
  );
  const icon = document.createElement('span');
  icon.className = 'content-type-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.replaceChildren(createIcon(presentation.asset, 'content-type-glyph'));
  kind.append(icon);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.setAttribute('role', 'gridcell');
  actions.setAttribute('aria-label', 'إجراءات العنصر');

  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'row-action pin-btn' + (item.isPinned ? ' is-pinned' : '');
  pinBtn.replaceChildren(createIcon(item.isPinned ? PIN_TOGGLE : PIN));
  pinBtn.title = item.isPinned ? 'إلغاء تثبيت العنصر' : 'تثبيت العنصر';
  pinBtn.setAttribute('aria-label', pinBtn.title);
  pinBtn.setAttribute('aria-pressed', String(item.isPinned));
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePinItem(item.id, { restoreFocus: document.activeElement === pinBtn });
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'row-action delete-btn';
  deleteBtn.title = 'حذف العنصر';
  deleteBtn.setAttribute('aria-label', 'حذف العنصر');
  deleteBtn.replaceChildren(createIcon(TRASH));
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteItem(item.id, { restoreFocus: document.activeElement === deleteBtn });
  });
  actions.append(pinBtn, deleteBtn);

  /* Choosing a row IS the product's primary action, and it is one action:
     the item goes to the clipboard, gets pasted into whatever app was in
     front before رفّ opened, and STAYS on the clipboard so ⌘V repeats it.
     `paste()` in Rust does all three; the clipboard is deliberately never
     rolled back afterwards.

     Mouse and keyboard must mean the same thing, so this is exactly what
     Enter does — with ⌥ carrying the same "paste as plain text" modifier.
     Selection is still updated first so the row a toast or an error refers
     to is the row that was clicked.

     There is deliberately NO dblclick handler: a double click fires `click`
     twice, which would paste twice. Copy-without-pasting stays available as
     the secondary action on ⌘C. */
  row.addEventListener('click', (e) => {
    selectedId = item.id;
    paste(item.id, e.altKey);
  });

  // Physical order is [ content | type ]; the action cluster is an overlay
  // (see .row-actions) so a resting row reserves no empty block for it.
  row.append(preview, kind, actions);

  if (item.isPinned) {
    const flag = document.createElement('span');
    flag.className = 'row-pin-flag';
    flag.setAttribute('aria-hidden', 'true');
    flag.append(createIcon(PIN));
    row.append(flag);
  }
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
  resetThumbRequests();
  if (phase === 'loading') {
    listEl.setAttribute('aria-busy', 'true');
    setListStructure(false);
    listEl.replaceChildren(loadingView());
    visible = [];
    syncActiveOption();
    syncChrome();
    return;
  }
  listEl.setAttribute('aria-busy', 'false');
  if (phase === 'error') {
    setListStructure(false);
    listEl.replaceChildren(failureView());
    visible = [];
    syncActiveOption();
    syncChrome();
    return;
  }

  // «08» shows one chronological list with pinned items marked in place —
  // there are no section headers. The مثبّت segment is how you isolate them.
  const all = [...state.pinned, ...state.history].sort((a, b) => b.createdAt - a.createdAt);
  visible = filterItems(all, query).filter(matchesFilter);

  const selectionIsVisible = visible.some((item) => item.id === selectedId);
  if (query && !selectionIsVisible) {
    // Search is a choose-from-results mode: its documented Enter action needs
    // one active result. Outside search, `null` is an intentional idle state
    // whose footer offers only Search and Settings.
    selectedId = visible[0]?.id ?? null;
  } else if (selectedId !== null && !selectionIsVisible) {
    selectedId = null;
  }

  listEl.replaceChildren();
  syncChrome();

  if (visible.length === 0) {
    setListStructure(false);
    syncActiveOption();
    if (query || filter !== 'all') {
      // Search-empty is text-only in «07 — Patterns & States»; the shelf
      // illustration belongs exclusively to a genuinely empty collection.
      listEl.append(stateView(null, 'لا نتائج', 'جرّب كلمة أخرى أو صنفًا مختلفًا', 'is-no-results'));
    } else {
      // Genuinely nothing saved yet — never shown for a failed fetch.
      // Copy is «08» COMPONENT 69:397 "State=Empty" verbatim; v4.0 had drifted
      // to its own wording, which the approved composition never carried.
      listEl.append(
        stateView(SHELF, 'لا يوجد شيء هنا بعد', 'سيظهر سجل الحافظة هنا فور نسخ أول عنصر')
      );
    }
    return;
  }

  setListStructure(true);
  listEl.setAttribute('aria-rowcount', String(visible.length));
  const fragment = document.createDocumentFragment();
  visible.forEach((item, index) => fragment.append(buildRow(item, index)));
  if (query) {
    const end = document.createElement('div');
    end.className = 'results-end';
    end.textContent = `نهاية نتائج البحث عن «${query}»`;
    fragment.append(end);
  }
  listEl.append(fragment);
  syncActiveOption();
  scrollSelectedIntoView();
}

/** Footer copy and the clear button follow the current view state. */
function syncChrome() {
  searchClearEl.hidden = query.length === 0;
  syncShortcutBar();
}

function shortcutHint(keys, label) {
  const hint = document.createElement('span');
  hint.className = 'shortcut-hint';
  const keycap = document.createElement('kbd');
  keycap.textContent = keys;
  const text = document.createElement('span');
  text.className = 'shortcut-label';
  text.textContent = label;
  hint.append(keycap, text);
  return hint;
}

/** Contextual keyboard legend. It advertises only actions that can run in the
 * current state, and uses the selected item's real pin state for the label. */
function syncShortcutBar() {
  const selected = visible.find((item) => item.id === selectedId) ?? null;
  const independentFocus = isIndependentControl(document.activeElement);
  let actions;

  if (query) {
    actions = selected && !independentFocus
      ? [
          ['↑↓', 'تنقّل'],
          ['↵', 'اختيار'],
          ['Esc', 'مسح البحث'],
        ]
      : [['Esc', 'مسح البحث']];
  } else if (selected) {
    actions = [
      ...(!independentFocus ? [['↵', 'لصق']] : []),
      ...(!independentFocus ? [['⌘C', 'نسخ']] : []),
      ['⌥P', selected.isPinned ? 'إلغاء التثبيت' : 'تثبيت'],
      ['⌘⌫', 'حذف'],
    ];
  } else {
    actions = [
      ['⌘F', 'بحث'],
      ['⌘,', 'الإعدادات'],
    ];
  }

  footerHintEl.replaceChildren(...actions.map(([keys, label]) => shortcutHint(keys, label)));
  footerHintEl.hidden = false;
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
      setListStructure(false);
      listEl.replaceChildren(failureView());
      syncActiveOption();
    } catch {
      // Last resort: the failure view itself could not be built.
      listEl.textContent = 'تعذّر عرض محتوى رفّ';
      listEl.setAttribute('role', 'alert');
      listEl.setAttribute('aria-live', 'assertive');
      listEl.setAttribute('aria-atomic', 'true');
      syncActiveOption();
    }
  }
}

/* Thumbnails are fetched over IPC as base64 data URLs, and Tauri hands every
   IPC reply back by evaluating script ON THE MAIN THREAD. Asking for one per
   image row the moment the row is built therefore queues a large main-thread
   injection per image — with a few hundred saved images that measured as
   SECONDS of frozen main thread immediately after launch, during which the
   menu-bar icon could not be serviced at all: the icon was up, but the first
   clicks went nowhere until the backlog drained.

   The panel is hidden at launch and shows about eight rows at a time, so
   nearly all of that work was for pixels nobody could see. Rows now ask for
   their thumbnail only once they are actually near the viewport. */
let thumbObserver = null;
const pendingThumbs = new Map();

function requestThumb(id, img, thumb) {
  // jsdom and any other environment without the observer keeps the original
  // eager behaviour, which is also the correct fallback: better a slow list
  // than a list with no images.
  if (typeof IntersectionObserver !== 'function') {
    loadThumb(id, img, thumb);
    return;
  }
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target;
          thumbObserver.unobserve(target);
          const pending = pendingThumbs.get(target);
          if (!pending) continue;
          pendingThumbs.delete(target);
          loadThumb(pending.id, pending.img, target);
        }
      },
      // A screen of lead time, so a thumbnail is already resolving by the
      // time a scrolling user reaches it.
      { root: listEl, rootMargin: '300px 0px' }
    );
  }
  pendingThumbs.set(thumb, { id, img });
  thumbObserver.observe(thumb);
}

/* `renderList` rebuilds every row, orphaning whatever the observer was still
   watching. Dropping those registrations keeps it from pinning detached nodes
   and from firing for rows that no longer exist. */
function resetThumbRequests() {
  if (thumbObserver) thumbObserver.disconnect();
  pendingThumbs.clear();
}

async function loadThumb(id, img, thumb) {
  try {
    const url = await api.getImage(id);
    if (url) {
      thumbs.set(id, url);
      img.src = url;
    } else {
      thumb.dataset.state = 'unavailable';
    }
  } catch {
    thumb.dataset.state = 'unavailable';
  }
}

function scrollSelectedIntoView() {
  const row = listEl.querySelector('.row.selected');
  if (!row) return;

  // `Element.scrollIntoView()` may choose the WebView document as an ancestor
  // in WebKit even though the list is the intended scroller. That shifts the
  // entire fixed panel upward and visually drops the header/filters. Adjust
  // only the list's own scroll position so chrome can never move.
  const listRect = listEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.top < listRect.top) {
    listEl.scrollTop -= listRect.top - rowRect.top;
  } else if (rowRect.bottom > listRect.bottom) {
    listEl.scrollTop += rowRect.bottom - listRect.bottom;
  }
}

function enqueueMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch((err) => diag('mutation:failed', err));
  return run;
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

function dismissFeedback({ animate = false } = {}) {
  clearTimeout(toastTimer);
  clearTimeout(toastExitTimer);
  toastTimer = null;
  toastExitTimer = null;
  const generation = ++toastGeneration;

  const finish = () => {
    if (generation !== toastGeneration) return;
    toastEl.classList.remove('is-leaving');
    panelFeedbackEl.hidden = true;
    toastEl.hidden = true;
    toastMessageEl.textContent = '';
    toastUndoEl.hidden = true;
    toastUndoEl.disabled = false;
    toastActionEl.hidden = true;
    toastActionEl.onclick = null;
  };

  if (animate && !panelFeedbackEl.hidden && !reducedMotion()) {
    toastEl.classList.add('is-leaving');
    toastExitTimer = setTimeout(finish, TOAST_EXIT_MS);
  } else {
    finish();
  }
}

function presentToast(
  message,
  { duration = PIN_TOAST_MS, undo = false, kind = 'success', action = null } = {}
) {
  clearTimeout(toastTimer);
  clearTimeout(toastExitTimer);
  toastEl.classList.remove('is-leaving');
  const generation = ++toastGeneration;
  toastEl.dataset.kind = kind;
  const icon =
    kind === 'delete'
      ? TRASH
      : kind === 'error'
        ? ALERT
        : kind === 'pin'
          ? PIN
          : kind === 'unpin'
            ? PIN_TOGGLE
            : CHECK;
  toastIconEl.replaceChildren(createIcon(icon));
  toastMessageEl.textContent = message;
  toastUndoEl.hidden = !undo;
  toastUndoEl.disabled = false;
  // Independent of `undo`: a toast may offer neither, either, or (rare, but
  // not disallowed) both — Delete's five-second Undo and "grant Accessibility"
  // never occur on the same toast today, but nothing here assumes that.
  if (action) {
    toastActionEl.textContent = action.label;
    toastActionEl.setAttribute('aria-label', action.label);
    toastActionEl.onclick = () => {
      action.onClick();
      // The offer was acted on; let the toast finish on its own timer rather
      // than yanking it away mid-click.
    };
    toastActionEl.hidden = false;
  } else {
    toastActionEl.hidden = true;
    toastActionEl.onclick = null;
  }
  toastEl.hidden = false;
  panelFeedbackEl.hidden = false;
  // Clear then insert in a microtask so even identical consecutive feedback
  // produces a fresh live-region mutation while the announcer stays mounted.
  feedbackAnnouncerEl.textContent = '';
  queueMicrotask(() => {
    if (generation === toastGeneration) feedbackAnnouncerEl.textContent = message;
  });

  toastTimer = setTimeout(() => {
    if (generation !== toastGeneration) return;
    const pending = undo ? activeDelete : null;
    if (pending) {
      activeDelete = null;
      enqueueMutation(async () => {
        try {
          await api.commitDelete(pending.token);
        } catch (err) {
          // A stale expiry is harmless (a newer delete or Undo owns the only
          // receipt); keep technical detail out of the user-facing live region.
          diag('delete:commit-failed', err);
        }
      });
    }
    dismissFeedback({ animate: true });
    scheduleFeedbackDrain();
  }, duration);
}

function scheduleFeedbackDrain() {
  if (feedbackQueue.length === 0 || activeDelete) return;
  const drain = () => {
    if (activeDelete || feedbackQueue.length === 0) return;
    const next = feedbackQueue.shift();
    presentToast(next.message, next.options);
  };
  if (reducedMotion()) queueMicrotask(drain);
  else setTimeout(drain, TOAST_EXIT_MS);
}

function deliverFeedback(message, options = {}) {
  if (activeDelete) {
    feedbackQueue.push({ message, options });
    return;
  }
  presentToast(message, options);
}

async function finalizeActiveDelete() {
  const pending = activeDelete;
  if (!pending) return;
  activeDelete = null;
  dismissFeedback();
  try {
    await api.commitDelete(pending.token);
  } catch (err) {
    diag('delete:commit-failed', err);
  }
}

/** General feedback waits behind an active five-second delete receipt. All
 * callers share the serialized lane, so one toast is visible at a time without
 * shortening the user's Undo protection. */
function showToast(message, duration = PIN_TOAST_MS, kind = 'success', action = null) {
  enqueueMutation(async () => {
    deliverFeedback(message, { duration, kind, action });
  });
}

function locateStateItem(id) {
  for (const layer of ['pinned', 'history']) {
    const index = state[layer].findIndex((item) => item.id === id);
    if (index >= 0) return { layer, index, item: state[layer][index] };
  }
  return null;
}

function removeLocalItem(id) {
  const location = locateStateItem(id);
  if (!location) return null;
  const layer = state[location.layer];
  const before = layer[location.index - 1];
  const after = layer[location.index + 1];
  const [item] = state[location.layer].splice(location.index, 1);
  return {
    layer: location.layer,
    index: location.index,
    before: before ? { id: before.id, createdAt: before.createdAt } : null,
    after: after ? { id: after.id, createdAt: after.createdAt } : null,
    item: { ...item },
  };
}

function restoreSnapshot(target, snapshot) {
  if (!snapshot) return;
  if ([...(target.pinned ?? []), ...(target.history ?? [])].some((item) => item.id === snapshot.item.id)) {
    return;
  }
  const layer = target[snapshot.layer];
  const order = snapshot.item.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
  let index;
  if (snapshot.layer === 'history') {
    // Equal-millisecond captures retain their exact stable order, but only
    // while the anchor itself has not been re-captured and moved. Otherwise
    // createdAt remains the authoritative chronological order.
    const stableAfter =
      snapshot.after?.createdAt === snapshot.item.createdAt
        ? layer.findIndex(
            (item) => item.id === snapshot.after.id && item.createdAt === snapshot.after.createdAt
          )
        : -1;
    const stableBefore =
      snapshot.before?.createdAt === snapshot.item.createdAt
        ? layer.findIndex(
            (item) => item.id === snapshot.before.id && item.createdAt === snapshot.before.createdAt
          )
        : -1;
    index = stableAfter >= 0 ? stableAfter : stableBefore >= 0 ? stableBefore + 1 : -1;
    if (index < 0) index = layer.findIndex((item) => item.createdAt < snapshot.item.createdAt);
  } else {
    index = layer.findIndex((item) => (item.pinnedOrder ?? Number.MAX_SAFE_INTEGER) > order);
  }
  if (index < 0) index = Math.min(snapshot.index, layer.length);
  layer.splice(index, 0, { ...snapshot.item });
}

function restoreLocalItem(snapshot) {
  restoreSnapshot(state, snapshot);
}

function focusRowAction(id, selector) {
  [...listEl.querySelectorAll('.row')]
    .find((row) => row.dataset.id === id)
    ?.querySelector(selector)
    ?.focus({ preventScroll: true });
}

function togglePinItem(id, { restoreFocus = false } = {}) {
  const location = locateStateItem(id);
  if (!location) return;
  const previous = location.item.isPinned;
  const next = !previous;
  const generation = ++pinMutationGeneration;
  optimisticPins.set(id, { generation, value: next });
  location.item.isPinned = next;
  render();
  if (restoreFocus) focusRowAction(id, '.pin-btn');

  enqueueMutation(async () => {
    try {
      const result = await api.togglePin(id, next);
      const isPinned = typeof result === 'boolean' ? result : next;
      if (optimisticPins.get(id)?.generation === generation) optimisticPins.delete(id);
      await refresh();
      if (restoreFocus) focusRowAction(id, '.pin-btn');
      deliverFeedback(isPinned ? 'تم تثبيت العنصر' : 'تم إلغاء تثبيت العنصر', {
        duration: PIN_TOAST_MS,
        kind: isPinned ? 'pin' : 'unpin',
      });
    } catch (err) {
      if (optimisticPins.get(id)?.generation === generation) optimisticPins.delete(id);
      const current = locateStateItem(id);
      if (current) current.item.isPinned = previous;
      render();
      if (restoreFocus) focusRowAction(id, '.pin-btn');
      deliverFeedback(String(err), { duration: PIN_TOAST_MS, kind: 'error' });
    }
  });
}

function deleteItem(id, { restoreFocus = false } = {}) {
  if (!id || optimisticDeletedIds.has(id)) return;
  const visibleIndex = visible.findIndex((item) => item.id === id);
  const snapshot = removeLocalItem(id);
  if (!snapshot) return;

  optimisticDeletedIds.add(id);
  if (selectedId === id) {
    selectedId = visible[visibleIndex + 1]?.id ?? visible[visibleIndex - 1]?.id ?? null;
  }
  render();
  if (restoreFocus) searchEl.focus({ preventScroll: true });

  enqueueMutation(async () => {
    await finalizeActiveDelete();
    try {
      const receipt = await api.deleteItem(id);
      if (!receipt?.token) throw new Error('تعذّر إنشاء مهلة التراجع');
      optimisticDeletedIds.delete(id);
      await refresh();
      activeDelete = { token: receipt.token, snapshot };
      presentToast('تم حذف العنصر', {
        duration: DELETE_TOAST_MS,
        undo: true,
        kind: 'delete',
      });
      if (restoreFocus) toastUndoEl.focus({ preventScroll: true });
    } catch (err) {
      optimisticDeletedIds.delete(id);
      restoreLocalItem(snapshot);
      selectedId = id;
      render();
      presentToast(String(err), { duration: PIN_TOAST_MS, kind: 'error' });
    }
  });
}

function undoLastDelete() {
  const pending = activeDelete;
  if (!pending) return;
  activeDelete = null;
  dismissFeedback();

  // Paint the exact receipt position immediately; native storage remains the
  // authority and the refresh below verifies the durable restoration.
  restoreLocalItem(pending.snapshot);
  optimisticRestores.set(pending.snapshot.item.id, pending.snapshot);
  selectedId = pending.snapshot.item.id;
  render();
  // Undo removes its own focused button from the accessibility tree. Return
  // focus to the persistent combobox, whose active descendant now points at
  // the restored selected row, instead of leaving focus on a hidden element.
  searchEl.focus({ preventScroll: true });
  scheduleFeedbackDrain();

  enqueueMutation(async () => {
    try {
      await api.undoDelete(pending.token);
      await refresh();
      optimisticRestores.delete(pending.snapshot.item.id);
    } catch (err) {
      optimisticRestores.delete(pending.snapshot.item.id);
      removeLocalItem(pending.snapshot.item.id);
      render();
      presentToast(String(err), { duration: PIN_TOAST_MS, kind: 'error' });
    }
  });
}

toastUndoEl.addEventListener('click', undoLastDelete);

// ─── Actions ──────────────────────────────────────────────────────────────

function paste(id, plain) {
  if (!id) return;
  api
    .pasteItem(id, plain)
    .then(async (pasted) => {
      if (pasted) return;
      // `pasted: false` always means the item is safely on the clipboard —
      // Rust writes it before attempting anything else — but tells us
      // nothing about WHY the automatic paste half didn't happen. Missing
      // Accessibility is by far the common case (and the only one with a
      // concrete fix the user can act on), so ask which one this is instead
      // of leaving every fallback looking identical and unexplained.
      let trusted = true;
      try {
        trusted = await api.axStatus();
      } catch {
        // Treat an unknown status as "assume trusted" — the plain fallback
        // below still lands the item on the clipboard either way.
      }
      if (!trusted) {
        showToast(
          'نُسخ إلى الحافظة — الصقه بـ ⌘V. للصق التلقائي مستقبلًا، امنح رفّ إذن تسهيل الوصول.',
          ACCESS_TOAST_MS,
          'success',
          {
            label: 'منح الإذن',
            onClick: () => {
              api.requestAccessibility().catch(() => {});
              api.openAccessibilitySettings().catch(() => {});
            },
          }
        );
      } else {
        showToast('نُسخ إلى الحافظة — الصقه بـ ⌘V');
      }
    })
    .catch((err) => showToast(String(err), PIN_TOAST_MS, 'error'));
}

function moveSelection(delta) {
  if (visible.length === 0) return;
  const index = visible.findIndex((i) => i.id === selectedId);
  const next =
    index < 0
      ? delta < 0
        ? visible.length - 1
        : 0
      : Math.min(visible.length - 1, Math.max(0, index + delta));
  selectedId = visible[next].id;
  render();
}

function setFilter(next) {
  const segments = [...filtersEl.querySelectorAll('.segment')];
  if (!segments.some((segment) => segment.dataset.filter === next)) return;
  const changed = filter !== next;
  filter = next;
  for (const seg of segments) {
    const on = seg.dataset.filter === next;
    seg.classList.toggle('is-active', on);
    seg.setAttribute('aria-selected', String(on));
    seg.tabIndex = on ? 0 : -1;
  }
  if (changed) render();
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
      // Keep local, immediately-painted mutations stable while their serialized
      // native commands are still in flight. The authoritative refresh after
      // each command clears these overlays.
      state = {
        ...next,
        pinned: (next.pinned ?? []).filter((item) => !optimisticDeletedIds.has(item.id)),
        history: (next.history ?? []).filter((item) => !optimisticDeletedIds.has(item.id)),
      };
      for (const item of [...state.pinned, ...state.history]) {
        const optimistic = optimisticPins.get(item.id);
        if (optimistic) item.isPinned = optimistic.value;
      }
      for (const snapshot of optimisticRestores.values()) restoreSnapshot(state, snapshot);
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

// Tauri's declarative drag-region listener is unreliable after this Webview
// window is promoted to a non-activating NSPanel. Start the native drag
// explicitly from the painted header instead. Interactive descendants remain
// ordinary controls, and no resize API or NSPanel style flag is touched.
panelHeaderEl.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('button, input, select, textarea, a')) return;
  const nativeWindow = window.__TAURI__?.window;
  nativeWindow
    ?.getCurrentWindow()
    .startDragging()
    .catch((err) => diag('panel:drag-failed', err));
});

settingsBtn.addEventListener('click', () => api.openSettings());
closeBtn.addEventListener('click', () => api.hidePanel());
searchClearEl.addEventListener('click', () => {
  query = '';
  selectedId = null;
  searchEl.value = '';
  searchEl.focus();
  render();
});
filtersEl.addEventListener('click', (e) => {
  const seg = e.target.closest('.segment');
  if (seg) setFilter(seg.dataset.filter);
});

filtersEl.addEventListener('keydown', (e) => {
  const segments = [...filtersEl.querySelectorAll('.segment')];
  const current = e.target.closest?.('.segment');
  const index = segments.indexOf(current);
  if (index < 0) return;

  let nextIndex = null;
  // The tablist is RTL: ArrowLeft advances through the visually leftward
  // sequence, while ArrowRight returns toward the right edge.
  if (e.key === 'ArrowLeft') nextIndex = (index + 1) % segments.length;
  else if (e.key === 'ArrowRight') nextIndex = (index - 1 + segments.length) % segments.length;
  else if (e.key === 'Home') nextIndex = 0;
  else if (e.key === 'End') nextIndex = segments.length - 1;

  if (nextIndex === null) return;
  e.preventDefault();
  e.stopPropagation();
  const next = segments[nextIndex];
  setFilter(next.dataset.filter);
  next.focus();
});

// ─── Keyboard (full control — mouse optional) ─────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.metaKey && (e.code === 'Comma' || e.key === ',')) {
    e.preventDefault();
    api.openSettings();
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
  if (
    e.metaKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    e.code === 'KeyZ' &&
    activeDelete
  ) {
    e.preventDefault();
    undoLastDelete();
    return;
  }
  if (
    !query &&
    selectedId &&
    e.altKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    e.code === 'KeyP'
  ) {
    e.preventDefault();
    togglePinItem(selectedId);
    return;
  }
  if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === 'Backspace') {
    // A text field (the search input) owns ⌘⌫ for native delete-to-start while
    // it contains a query. With an empty query, the contextual selected-row
    // delete is genuinely enabled even while search retains DOM focus.
    if (query || (isWritable(document.activeElement) && searchEl.value.length > 0)) return;
    e.preventDefault();
    if (selectedId) deleteItem(selectedId, { restoreFocus: true });
    return;
  }

  // Buttons and the roving filter tabs own their native activation keys. The
  // search input is the one exception: Arrow/Page/Enter intentionally operate
  // the active grid row while its text caret keeps DOM focus.
  if (isIndependentControl(e.target)) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        query = '';
        selectedId = null;
        searchEl.value = '';
        render();
      } else {
        api.hidePanel();
      }
    }
    return;
  }

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
        selectedId = null;
        searchEl.value = '';
        render();
      } else {
        api.hidePanel();
      }
      return;
  }
  if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyC') {
    // Search mode deliberately exposes only navigation, Choose and Clear.
    // Do not leave an undisclosed row-copy action live behind that toolbar.
    if (query) return;
    // Preserve native copy for an actual text selection in the search field.
    // With no selection, ⌘C remains Raff's fast copy-item shortcut even though
    // the panel deliberately keeps search focused while it is open.
    if (isWritable(document.activeElement)) {
      const start = searchEl.selectionStart;
      const end = searchEl.selectionEnd;
      if (start !== null && end !== null && start !== end) return;
    }
    e.preventDefault();
    if (selectedId) {
      api
        .copyItem(selectedId)
        .then(() => showToast('نُسخ إلى الحافظة'))
        .catch((err) => showToast(String(err), PIN_TOAST_MS, 'error'));
    }
    return;
  }
  // Route actual printable input only. Modifier keys, navigation keys, dead
  // keys and IME composition must keep their native macOS behaviour.
  if (
    !e.metaKey &&
    !e.ctrlKey &&
    !e.isComposing &&
    e.key.length === 1 &&
    !isWritable(document.activeElement)
  ) {
    searchEl.focus();
  }
});

searchEl.addEventListener('input', () => {
  query = searchEl.value;
  render();
});

// A focused row action or filter owns Enter/arrow keys natively. Refresh the
// legend on focus transitions so it never advertises those keys while the
// browser correctly routes them to that control.
window.addEventListener('focusin', syncShortcutBar);
window.addEventListener('focusout', () => queueMicrotask(syncShortcutBar));

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

function isIndependentControl(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const control = el?.closest('button, select, textarea, [role="tab"]');
  return Boolean(control && control !== searchEl);
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
