// Floating panel behavior: instant filter, full keyboard control, paste.
// Clip content is ALWAYS rendered via textContent — never innerHTML.
//
// View structure adapts the approved Raff row language to production density:
// the copied preview owns the flexible space, one Raff semantic icon identifies
// its content type, and the paired Figma actions sit at the trailing edge.

import { api, on } from './store.js';
import { arabicCount, arabicDigits, filterItems, hotkeyDisplay, hotkeyRefusal, relativeTimeAr } from './logic.js';
import { createHoverIntent } from './hover-intent.js';
import {
  SETTINGS,
  CLOSE,
  SEARCH,
  CLEAR,
  PIN,
  PIN_TOGGLE,
  TRASH,
  CHECK,
  ALERT,
  IMAGE,
  MOVE_UP,
  MOVE_DOWN,
  PAUSE,
  CAPTURE_OFF,
  KEYBOARD,
  COPY,
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
const captureStripEl = document.getElementById('capture-strip');
const settingsBtn = document.getElementById('settings-btn');
const closeBtn = document.getElementById('panel-close');

document.getElementById('search-glyph').replaceChildren(createIcon(SEARCH));
settingsBtn.replaceChildren(createIcon(SETTINGS));
closeBtn.replaceChildren(createIcon(CLOSE));
searchClearEl.replaceChildren(createIcon(CLEAR));

/** Quick paste: ⌘1–⌘9 choose the first nine visible rows. */
const QUICK_SLOTS = 9;

let state = { pinned: [], history: [], settings: null, axTrusted: false };
let query = '';
let filter = 'all';
let selectedId = null;
let visible = []; // flat filtered list, newest first
const thumbs = new Map(); // item id → data URL, for the items still in the state
// Item id → why it has no picture, until the next refresh: 'missing' (the file
// is gone) or 'too-large' (it is there and still pastes, but has no thumbnail
// and is too large to send to the panel).
const missingThumbs = new Map();
const UNAVAILABLE_NOTE = { missing: 'الملف مفقود', 'too-large': 'المعاينة غير متاحة' };
const UNAVAILABLE_CLASS = { missing: 'is-image-missing', 'too-large': 'is-preview-unavailable' };
/** Rust's answer for a picture that is there but too large to send. */
const PREVIEW_TOO_LARGE = 'raff/preview-too-large';
const unavailableNote = (id) => UNAVAILABLE_NOTE[missingThumbs.get(id) ?? 'missing'];
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

/** Why an unpin left its row out of history, in the backend's words (ت٢٩). */
const UNPIN_REMOVAL_WORDS = Object.freeze({
  retention: 'أُلغي التثبيت، وحُذف العنصر لانتهاء مدة الاحتفاظ',
  olderThanHistory: 'أُلغي التثبيت، وحُذف العنصر لأنه أقدم من سجلّك',
  limit: 'أُلغي التثبيت، وحُذف العنصر لأن سجلّك بلغ حدّه',
});
/** Longer than PIN_TOAST_MS: this toast carries a button the user needs time
 * to read and act on, not just a status line to glance at. */
const ACCESS_TOAST_MS = 6000;
let offeredAccessibility = false;
const TOAST_EXIT_MS = 120;

// The list area has three distinct states and they must never be confused:
//   'loading' — the first fetch has not answered yet
//   'ready'   — data is in hand (which may legitimately be zero items)
//   'error'   — data could not be fetched, or rendering threw
// Only 'ready' + zero items is the natural «الرفّ فارغ» empty shelf.
let phase = 'loading';

// The webview is never destroyed — Rust orders the NSPanel in and out, and a
// concealed panel is still laid out on screen at alpha 0. So «hidden» means
// nobody can see it, not that its JavaScript stopped: every capture used to
// rebuild a thousand rows for an audience of no one.
let isShown = false;

/** Hides the panel and records it, so incoming events stop costing a rebuild. */
function hidePanel() {
  isShown = false;
  return api.hidePanel();
}

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
  if (selected) searchEl.setAttribute('aria-activedescendant', selected.id);
  else searchEl.removeAttribute('aria-activedescendant');
  // Expanded is whether the grid has rows to move into, selected or not
  // (audit 021 ج2).
  const hasRows = Boolean(listEl.querySelector('.row[role="row"][data-id]'));
  searchEl.setAttribute('aria-expanded', String(hasRows));
}

const BRAND = Symbol('brand-mark');
// The shelf without its card: nothing is arriving (the menu-bar glyph's off
// state, Figma «03 · الحالات الفارغة» 40:1823).
const BRAND_OFF = Symbol('brand-mark-off');

function stateView(art, title, sub, extraClass = '', action = null) {
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
    if (art === BRAND || art === BRAND_OFF) {
      artEl.classList.add('brand-art');
      artEl.classList.toggle('is-off', art === BRAND_OFF);
      const base = document.createElement('span');
      base.className = 'mark-base';
      artEl.replaceChildren(base);
      if (art === BRAND) {
        const card = document.createElement('span');
        card.className = 'mark-card';
        artEl.append(card);
      }
    } else {
      artEl.replaceChildren(createIcon(art));
    }
    view.append(artEl);
  }
  view.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.id = 'state-action';
    button.textContent = action.label;
    button.addEventListener('click', () => void action.run());
    view.append(button);
  }
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
  action.className = 'btn';
  action.id = 'failure-reload';
  action.textContent = 'إعادة تحميل الواجهة';
  action.addEventListener('click', () => hardReload('failure-view'));
  const hint = document.createElement('div');
  hint.className = 'state-hint';
  hint.textContent = 'أو \u2066⌘R\u2069';
  view.append(action, hint);
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

  if (isGrid()) return buildCard(row, item, index);

  if (item.type === 'image') {
    const thumb = buildThumb(row, item);
    const media = document.createElement('div');
    media.className = 'preview-media';
    const missing = document.createElement('span');
    missing.className = 'preview-missing';
    missing.textContent = unavailableNote(item.id);
    media.append(thumb, missing);
    preview.append(media);
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
  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = relativeTimeAr(item.createdAt);
  preview.append(time);

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
  if (index < QUICK_SLOTS) {
    const slot = document.createElement('kbd');
    slot.className = 'row-index';
    slot.setAttribute('aria-hidden', 'true');
    slot.textContent = String(index + 1);
    kind.append(slot);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.setAttribute('role', 'gridcell');
  actions.setAttribute('aria-label', 'إجراءات العنصر');

  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'row-action pin-btn' + (item.isPinned ? ' is-pinned' : '');
  pinBtn.replaceChildren(createIcon(item.isPinned ? PIN_TOGGLE : PIN));
  pinBtn.title = item.isPinned ? 'إلغاء تثبيت العنصر' : 'تثبيت العنصر';
  // A toggle: one name, its state in aria-pressed (ت٤٠). The tooltip may say
  // what a click will do; the accessible name must not flip with the state.
  pinBtn.setAttribute('aria-label', 'تثبيت العنصر');
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

  // Only where the pinned items stand as a group they arranged. In the default
  // list they are marked in place inside one timeline, and a timeline is not
  // something to rearrange.
  if (item.isPinned && filter === 'pinned') {
    // Four actions float over the time slot here, not two: reserve their room.
    row.classList.add('has-reorder');
    const shelf = pinnedShelfIds();
    const at = shelf.indexOf(item.id);
    actions.prepend(
      moveButton(item.id, -1, MOVE_UP, 'move-up', 'نقل لأعلى', at <= 0),
      moveButton(item.id, 1, MOVE_DOWN, 'move-down', 'نقل لأسفل', at < 0 || at >= shelf.length - 1)
    );
  }

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
    // Through `setSelection`, not behind the list's back: when the panel
    // stays open after the paste, the row shown as chosen must be this one
    // (audit 012).
    setSelection(item.id);
    // The search field holds the active descendant: a click on a row must not
    // leave it without focus when the panel stays open after the paste.
    searchEl.focus({ preventScroll: true });
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

/** An image's thumbnail, loaded when it comes into view. */
function buildThumb(row, item) {
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
  // A picture that arrived but does not decode is there, just not showable.
  img.addEventListener('error', () => markThumbUnavailable(thumb, 'too-large'));
  if (thumbs.has(item.id)) img.src = thumbs.get(item.id);
  else if (missingThumbs.has(item.id)) {
    thumb.dataset.state = 'unavailable';
    row.classList.add(UNAVAILABLE_CLASS[missingThumbs.get(item.id)]);
  } else requestThumb(item.id, img, thumb);
  thumb.append(placeholder, img);
  return thumb;
}

/** The Images filter draws pictures as cards in a grid of three (Figma Item
 *  Card 35:301): the picture, then its time and kind. The same row in every
 *  other respect — selection, click, ⌘1–9, the accessible list. No buttons
 *  on a card; its actions are the keyboard's and the preview's. */
function isGrid() {
  return filter === 'image';
}

function buildCard(row, item, index) {
  row.classList.add('is-card');
  const media = document.createElement('div');
  media.className = 'card-media';
  media.setAttribute('role', 'gridcell');
  const missing = document.createElement('span');
  missing.className = 'preview-missing';
  missing.textContent = unavailableNote(item.id);
  media.append(buildThumb(row, item), missing);
  if (index < QUICK_SLOTS) {
    const slot = document.createElement('kbd');
    slot.className = 'row-index';
    slot.setAttribute('aria-hidden', 'true');
    slot.textContent = String(index + 1);
    media.append(slot);
  }

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const time = document.createElement('span');
  time.className = 'row-time';
  time.setAttribute('role', 'gridcell');
  time.textContent = relativeTimeAr(item.createdAt);
  if (item.isPinned) {
    // The flag is drawn for the eye; this says it to a screen reader.
    const pinned = document.createElement('span');
    pinned.className = 'sr-only';
    pinned.textContent = 'مثبّت، ';
    time.prepend(pinned);
  }
  const kind = document.createElement('span');
  kind.className = 'row-kind';
  kind.setAttribute('role', 'gridcell');
  const presentation = contentTypeIcon(item.type);
  const sourceName = item.sourceApp || 'تطبيق غير معروف';
  kind.setAttribute('aria-label', `نوع المحتوى: ${presentation.label}. المصدر: ${sourceName}`);
  kind.append(createIcon(presentation.asset, 'content-type-glyph'));
  foot.append(kind, time);

  row.addEventListener('click', (e) => {
    // Through `setSelection`, not behind the list's back: when the panel
    // stays open after the paste, the row shown as chosen must be this one
    // (audit 012).
    setSelection(item.id);
    // The search field holds the active descendant: a click on a row must not
    // leave it without focus when the panel stays open after the paste.
    searchEl.focus({ preventScroll: true });
    paste(item.id, e.altKey);
  });
  row.append(media, foot);
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
/** The pinned shelf in the order the user arranged it — the whole shelf, not
 *  whatever a search has narrowed the view to, because that is what the
 *  backend checks the reorder against. */
function pinnedShelfIds() {
  return [...state.pinned]
    .sort((a, b) => pinnedRank(a) - pinnedRank(b))
    .map((item) => item.id);
}

const pinnedRank = (item) => item.pinnedOrder ?? Number.MAX_SAFE_INTEGER;

function moveButton(id, delta, icon, className, label, disabled) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `row-action ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.replaceChildren(createIcon(icon));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    movePinned(id, delta);
  });
  return button;
}

/**
 * Moves one pinned row and persists the whole resulting order.
 *
 * The backend takes the complete shelf and refuses anything that is not
 * exactly it, so the swap happens in the full arrangement rather than in the
 * rows currently on screen — a narrowed search must not be able to send a
 * shorter shelf.
 */
function movePinned(id, delta) {
  const ids = pinnedShelfIds();
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];

  // Painted before the round trip, like every other row action here; the
  // authoritative refresh below is what settles it.
  ids.forEach((pinnedId, order) => {
    const item = state.pinned.find((candidate) => candidate.id === pinnedId);
    if (item) item.pinnedOrder = order;
  });
  render();

  enqueueMutation(async () => {
    try {
      await api.reorderPinned(ids);
      await refresh();
    } catch (err) {
      await refresh();
      // Through the one lane: drawn over a delete's receipt it would clear
      // the receipt's timer and leave that delete pending (audit 010).
      deliverFeedback(errorMessage(err), { duration: PIN_TOAST_MS, kind: 'error' });
    }
  });
}

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
  const deepIds = deepMatches.query === query ? deepMatches.ids : null;
  visible = filterItems(all, query, deepIds).filter(matchesFilter);
  if (filter === 'pinned') {
    // The one view where the pinned items stand as a group: theirs to order.
    visible = [...visible].sort((a, b) => pinnedRank(a) - pinnedRank(b));
  }

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
  listEl.classList.toggle('is-grid', isGrid() && visible.length > 0);
  syncChrome();

  if (visible.length === 0) {
    setListStructure(false);
    syncActiveOption();
    if (query || filter !== 'all') {
      // A search glass (Figma 40:1823); the shelf illustration belongs
      // exclusively to a genuinely empty collection.
      listEl.append(stateView(SEARCH, 'لا نتائج', 'جرّب كلمة أخرى أو صنفًا مختلفًا', 'is-no-results'));
    } else if (state.unreadableLayer) {
      // The list is empty because a layer did not parse, not because nothing
      // was ever saved. Saying «رفّك جاهز» here would report the user's clips
      // as gone, which is the opposite of what happened.
      listEl.append(
        stateView(
          ALERT,
          'تعذّرت قراءة سجلّك',
          'محتواك لم يُفقد، واحتفظ رفّ بنسخة منه جانبًا. ما تنسخه من الآن يُحفظ كالمعتاد.',
          'is-unreadable'
        )
      );
    } else if (captureStatus()?.blocking) {
      // Empty AND not saving: «سيظهر هنا فورًا» would be a promise رفّ is not
      // keeping right now. The strip above names the cause; the way back is
      // here as well, under the shelf with no card (Figma 40:1823).
      const { action } = captureStatus();
      listEl.append(
        stateView(
          BRAND_OFF,
          'رفّك فارغ',
          'الالتقاط لا يعمل الآن، فلن يظهر هنا ما تنسخه حتى يعود.',
          '',
          action && { label: action.stateLabel ?? action.label, run: action.run }
        )
      );
    } else {
      // Genuinely nothing saved yet — never shown for a failed fetch.
      listEl.append(
        stateView(BRAND, 'رفّك جاهز', 'انسخ أي نص أو رابط أو صورة، وسيظهر هنا فورًا.')
      );
    }
    return;
  }

  setListStructure(true);
  listEl.setAttribute('aria-rowcount', String(visible.length + (query.trim() ? 1 : 0)));
  const fragment = document.createDocumentFragment();
  visible.forEach((item, index) => fragment.append(buildRow(item, index)));
  if (query.trim()) {
    // A grid owns rows and nothing else: the closing line is a row of its
    // own, after the results (audit 021 ج2). It has no id, so the keyboard
    // and the selection, which move over `.row`, never land on it.
    const end = document.createElement('div');
    end.className = 'results-end';
    end.setAttribute('role', 'row');
    end.setAttribute('aria-rowindex', String(visible.length + 1));
    const cell = document.createElement('span');
    cell.setAttribute('role', 'gridcell');
    // Isolated: a Latin query must not reorder the Arabic around it.
    cell.textContent = `نهاية نتائج البحث عن «\u2068${query.trim()}\u2069»`;
    end.append(cell);
    fragment.append(end);
  }
  listEl.append(fragment);
  syncActiveOption();
  scrollSelectedIntoView();
}

// ─── Capture status (Figma Panel Status Strip 283:402) ────────────────────

/**
 * What the panel says when رفّ is not saving, or null when it is. Same order,
 * tone and wording as the menu bar and Settings: a capture loop that died
 * outranks capture the user turned off, which outranks a pause.
 * `blocking` is false for «skip the next copy» — everything after it saves.
 */
function captureStatus() {
  if (state.captureAlive === false) {
    return {
      tone: 'danger',
      icon: ALERT,
      text: 'توقّف الالتقاط — لا يُحفظ ما تنسخه',
      action: { label: 'إعادة تشغيل رفّ', run: () => api.restartApp() },
      blocking: true,
    };
  }
  if (state.unreadableSettings) {
    // The defaults stand in for settings.json, the exclusions list among them,
    // so capture waits for the user to look before it comes back. Review comes
    // first: «تفعيل» here would skip past the very list that was lost.
    return {
      tone: 'danger',
      icon: ALERT,
      text: 'تعذّرت قراءة الإعدادات — الالتقاط معطّل حتى تراجعها',
      action: { label: 'مراجعة', run: () => api.openSettings() },
      blocking: true,
    };
  }
  if (state.settings && state.settings.captureEnabled === false) {
    return {
      tone: 'info',
      icon: CAPTURE_OFF,
      text: 'الالتقاط معطّل — لا يُحفظ ما تنسخه',
      action: { label: 'تفعيل', stateLabel: 'تفعيل الالتقاط', run: enableCapture },
      blocking: true,
    };
  }
  const pause = state.capturePause;
  if (pause && pause.kind && pause.kind !== 'off') {
    const text =
      pause.kind === 'skipNext'
        ? 'سيتجاهل رفّ النسخة التالية'
        : pause.kind === 'timed'
          ? pause.minutesLeft
            ? `الالتقاط موقوف — يُستأنف بعد ${arabicDigits(pause.minutesLeft)} د`
            : 'الالتقاط موقوف مؤقتًا'
          : 'الالتقاط موقوف حتى إعادة التشغيل';
    return {
      tone: 'warning',
      icon: PAUSE,
      text,
      action: { label: 'استئناف', run: () => api.resumeCapture().then(() => refresh()) },
      blocking: pause.kind !== 'skipNext',
    };
  }
  return null;
}

/**
 * A hotkey saved before its kind was refused (ت٢٢) still opens رفّ — and so
 * takes that command from every app. The panel is what it opens, so the
 * panel says so, after anything about capture itself (ت٣١).
 */
function hotkeyStatus() {
  const accel = state.settings?.hotkey;
  const refusal = accel ? hotkeyRefusal(accel) : null;
  if (!refusal) return null;
  const keys = `\u2066${hotkeyDisplay(accel)}\u2069`;
  return {
    tone: 'warning',
    icon: KEYBOARD,
    text:
      refusal === 'shared'
        ? `اختصار رفّ ${keys} يأخذ هذا الأمر من كل التطبيقات`
        : `اختصار رفّ ${keys} يأخذ حرفًا من كل كتابة`,
    action: { label: 'تغيير', run: () => api.openSettings() },
    blocking: false,
  };
}

function enableCapture() {
  if (!state.settings) return Promise.resolve();
  return api
    .updateSettings({ captureEnabled: true })
    .then(() => refresh())
    .catch((err) => showToast(errorMessage(err), PIN_TOAST_MS, 'error'));
}

let shownStripText = null;

function renderCaptureStrip() {
  if (!captureStripEl) return;
  const status = phase === 'ready' ? (captureStatus() ?? hotkeyStatus()) : null;
  if (!status) {
    captureStripEl.hidden = true;
    shownStripText = null;
    return;
  }
  // render() runs on every keystroke; a live region rewritten each time would
  // re-announce. Touch it only when what it says changes.
  if (status.text === shownStripText && !captureStripEl.hidden) return;
  shownStripText = status.text;
  captureStripEl.hidden = false;
  captureStripEl.dataset.tone = status.tone;
  captureStripEl.setAttribute('role', status.tone === 'danger' ? 'alert' : 'status');
  document.getElementById('capture-strip-icon').replaceChildren(createIcon(status.icon));
  document.getElementById('capture-strip-text').textContent = status.text;
  const action = document.getElementById('capture-strip-action');
  action.textContent = status.action.label;
  action.onclick = () => {
    action.disabled = true;
    Promise.resolve(status.action.run())
      .catch((err) => deliverFeedback(errorMessage(err), { duration: PIN_TOAST_MS, kind: 'error' }))
      .finally(() => {
        action.disabled = false;
        searchEl.focus({ preventScroll: true });
      });
  };
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

/** The row control holding focus, as what to find again after a rebuild:
 * its row and its classes. `null` when focus is anywhere else. */
function heldListFocus() {
  const el = document.activeElement;
  if (!el || el === searchEl || !listEl.contains(el)) return null;
  return {
    id: el.closest('.row[data-id]')?.dataset.id ?? null,
    // What the control is, not its state: `is-pinned` flips with the pin.
    classes: [...el.classList].filter((name) => !name.startsWith('is-')),
    // A state view's own button (retry, enable capture) has an id.
    elementId: el.id || null,
  };
}

/** At the end of the shelf a move button turns off; its opposite does not. */
const OPPOSITE_MOVE = { 'move-up': 'move-down', 'move-down': 'move-up' };

/** Puts focus back on the same control of the same row — or on search, when
 * that row is gone or the control can no longer be pressed. Left alone when
 * something else has focus by now. */
function restoreListFocus(held) {
  if (!held || (document.activeElement && document.activeElement !== document.body)) return;
  const byId = held.elementId && document.getElementById(held.elementId);
  if (byId && listEl.contains(byId) && !byId.disabled) {
    byId.focus({ preventScroll: true });
    return;
  }
  const row = [...listEl.querySelectorAll('.row[data-id]')].find((r) => r.dataset.id === held.id);
  const find = (classes) =>
    row &&
    classes.length > 0 &&
    [...row.querySelectorAll('button, [tabindex]')].find((el) =>
      classes.every((name) => el.classList.contains(name))
    );
  let target = find(held.classes);
  const move = held.classes.find((name) => OPPOSITE_MOVE[name]);
  if (target?.disabled && move) {
    target = find(held.classes.map((name) => OPPOSITE_MOVE[name] ?? name));
  }
  if (target && !target.disabled) target.focus({ preventScroll: true });
  else searchEl.focus({ preventScroll: true });
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
      ...(visible.length > 0 ? [['⌘1–9', 'لصق سريع']] : []),
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
  // Every render rebuilds the rows, so a row control holding focus is
  // replaced and focus would fall to <body> (audit 020 ج1).
  const held = heldListFocus();
  try {
    renderCaptureStrip();
    renderList();
    // The preview shows what is listed: refilled, or closed if it is gone.
    if (previewWant) requestPreview(previewWant);
    restoreListFocus(held);
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
      markThumbUnavailable(thumb, 'missing');
    }
  } catch (err) {
    markThumbUnavailable(thumb, err === PREVIEW_TOO_LARGE ? 'too-large' : 'missing');
  }
}

/** An image with no picture to show says why beside its placeholder: its
 *  file is gone, or only the preview is. A class, not :has() — WebKit 15 on
 *  macOS 12 has no :has(). */
function markThumbUnavailable(thumb, reason) {
  thumb.dataset.state = 'unavailable';
  const row = thumb.closest('.row');
  row?.classList.add(UNAVAILABLE_CLASS[reason]);
  const note = row?.querySelector('.preview-missing');
  if (note) note.textContent = UNAVAILABLE_NOTE[reason];
  if (row?.dataset.id) missingThumbs.set(row.dataset.id, reason);
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

/**
 * After a pin change redraws the list, focus and selection stay with the row.
 * When the row has left the list — unpinned inside «مثبّت», or not taken back
 * by history — they move as for a delete: the selection to the row beside
 * it, focus to search, never to the page.
 */
function followPinnedRow(id, { neighbour, wasSelected, restoreFocus }) {
  if (visible.some((item) => item.id === id)) {
    if (restoreFocus) focusRowAction(id, '.pin-btn');
    return false;
  }
  if (wasSelected && selectedId !== neighbour && visible.some((item) => item.id === neighbour)) {
    selectedId = neighbour;
    render();
  }
  if (restoreFocus) searchEl.focus({ preventScroll: true });
  return restoreFocus;
}

/** Focus went with a row that is no longer drawn. */
function focusIsLost() {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

function togglePinItem(id, { restoreFocus = false } = {}) {
  const location = locateStateItem(id);
  if (!location) return;
  const previous = location.item.isPinned;
  const next = !previous;
  const generation = ++pinMutationGeneration;
  const at = visible.findIndex((item) => item.id === id);
  const follow = {
    neighbour: visible[at + 1]?.id ?? visible[at - 1]?.id ?? null,
    wasSelected: selectedId === id,
    restoreFocus,
  };
  optimisticPins.set(id, { generation, value: next });
  location.item.isPinned = next;
  // Leaving «مثبّت»: the selection moves before the one redraw, not after.
  const selectionLeaves = follow.wasSelected && filter === 'pinned' && !next;
  if (selectionLeaves && follow.neighbour) selectedId = follow.neighbour;
  render();
  // Whether focus went to search because of this change, not the user.
  let movedFocus = followPinnedRow(id, follow);

  enqueueMutation(async () => {
    if (!locateStateItem(id) && !optimisticDeletedIds.has(id)) {
      // An earlier change in the queue took the row away (an unpin history
      // did not take back): there is nothing left to pin. A row only on its
      // way out by a delete is still the backend's, and still gets the pin.
      if (optimisticPins.get(id)?.generation === generation) optimisticPins.delete(id);
      return;
    }
    try {
      const result = await api.togglePin(id, next);
      const isPinned = typeof result?.isPinned === 'boolean' ? result.isPinned : next;
      if (optimisticPins.get(id)?.generation === generation) optimisticPins.delete(id);
      const selectedBefore = selectedId;
      await refresh();
      // Only what the user has not moved on from meanwhile: the selection
      // the refresh cleared because the row went, and focus that went with it.
      movedFocus =
        followPinnedRow(id, {
          neighbour: follow.neighbour,
          wasSelected: selectedBefore === id && selectedId === null,
          restoreFocus: follow.restoreFocus && focusIsLost(),
        }) || movedFocus;
      if (result?.removed === true) {
        // History did not take it back, and the backend says why (ت٢٩).
        deliverFeedback(UNPIN_REMOVAL_WORDS[result.reason] ?? UNPIN_REMOVAL_WORDS.olderThanHistory, {
          duration: DELETE_TOAST_MS,
          kind: 'delete',
        });
        return;
      }
      deliverFeedback(isPinned ? 'تم تثبيت العنصر' : 'تم إلغاء تثبيت العنصر', {
        duration: PIN_TOAST_MS,
        kind: isPinned ? 'pin' : 'unpin',
      });
    } catch (err) {
      if (optimisticPins.get(id)?.generation === generation) optimisticPins.delete(id);
      const current = locateStateItem(id);
      if (current) current.item.isPinned = previous;
      // Back to the row only from where this change put things.
      if (selectionLeaves && (selectedId === null || selectedId === follow.neighbour)) selectedId = id;
      render();
      const focusUntouched = movedFocus && document.activeElement === searchEl && !query;
      if (restoreFocus && (focusIsLost() || focusUntouched)) focusRowAction(id, '.pin-btn');
      deliverFeedback(errorMessage(err), { duration: PIN_TOAST_MS, kind: 'error' });
    }
  });
}

// What the backend can say, and what رفّ says about it. Anything else gets
// the last line: a sentence the user can act on beats a string they cannot.
const ERROR_MESSAGES = {
  'raff/not-found': 'لم يعد هذا العنصر موجودًا.',
  'raff/save-failed': 'تعذّر حفظ التغيير. حاول مرة أخرى.',
  'raff/paste-failed': 'تعذّر اللصق. المحتوى على الحافظة، الصقه بـ \u2066⌘V\u2069.',
  'raff/undo-no-room': 'لم يعد في سجلّك متّسع لهذا العنصر، فلم يُستعد.',
  'raff/undo-retention': 'انتهت مدة الاحتفاظ بهذا العنصر، فلم يُستعد.',
  'raff/clipboard-off': 'هذه نسخة تجربة من رفّ، فلا تصل إلى الحافظة.',
};

/**
 * Turns a backend failure into something worth reading.
 *
 * The raw string could be anything the process produced — a local path, an OS
 * error, a message in English — rendered verbatim in an Arabic interface. The
 * backend names a kind; the wording lives here.
 */
function errorMessage(err) {
  return ERROR_MESSAGES[String(err)] ?? 'تعذّر إتمام العملية. حاول مرة أخرى.';
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
      // The row stays marked deleted through its own refresh (Rust no longer
      // lists it either) and becomes the undo receipt in the same step, so no
      // refresh ever finds it neither — and drops its picture before «تراجع».
      await refresh();
      optimisticDeletedIds.delete(id);
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
      presentToast(errorMessage(err), { duration: PIN_TOAST_MS, kind: 'error' });
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
      const standing = await api.undoDelete(pending.token);
      // From here the backend is the authority: it may have folded the row
      // into a newer copy of it (017) rather than bring it back as it was, so
      // the painted-back snapshot must not outlive the refresh — and the
      // selection follows to the row that now stands for it (ت٤٥ ب٦).
      optimisticRestores.delete(pending.snapshot.item.id);
      if (typeof standing === 'string' && selectedId === pending.snapshot.item.id) {
        selectedId = standing;
      }
      await refresh();
    } catch (err) {
      optimisticRestores.delete(pending.snapshot.item.id);
      removeLocalItem(pending.snapshot.item.id);
      render();
      presentToast(errorMessage(err), { duration: PIN_TOAST_MS, kind: 'error' });
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
      if (pasted === true) return;
      // Copied only because رفّ itself was in front — Settings, or the
      // welcome's «افتح رفّ» (009): say that, not «grant Accessibility».
      if (pasted === 'copiedOverRaff') {
        showToast('نُسخ إلى الحافظة، ولم يُلصق لأن رفّ كان في الواجهة. الصقه بـ \u2066⌘V\u2069 حيث تريد.');
        return;
      }
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
      // The permission is optional: offer it once per session, not on every
      // paste — after that the toast only says where the item is.
      if (!trusted && !offeredAccessibility) {
        offeredAccessibility = true;
        showToast(
          'نُسخ إلى الحافظة — الصقه بـ \u2066⌘V\u2069. للصق التلقائي، فعّل إذن تسهيل الوصول.',
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
        showToast('نُسخ إلى الحافظة — الصقه بـ \u2066⌘V\u2069');
      }
    })
    .catch((err) => showToast(errorMessage(err), PIN_TOAST_MS, 'error'));
}

/** The search caret sits after the last character (or the field is empty). */
function caretAtEnd() {
  const end = searchEl.value.length;
  return searchEl.selectionStart === end && searchEl.selectionEnd === end;
}

function copyItem(id) {
  api
    .copyItem(id)
    .then(() => showToast('نُسخ إلى الحافظة'))
    .catch((err) => showToast(errorMessage(err), PIN_TOAST_MS, 'error'));
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
  setSelection(visible[next].id);
}

/**
 * Moves the selection by touching the two rows that change.
 *
 * `renderList` is deliberately not involved: rebuilding every row to move a
 * highlight one line is what made arrow keys lag on a full shelf. The three
 * things that must stay in step with the selection — the announced row, the
 * shortcut bar and the scroll position — are synced explicitly instead.
 */
function setSelection(id) {
  if (selectedId === id) return;
  selectedId = id;
  const previous = listEl.querySelector('.row.selected[role="row"]');
  if (previous) {
    previous.classList.remove('selected');
    previous.setAttribute('aria-selected', 'false');
  }
  const next = [...listEl.querySelectorAll('.row[role="row"]')].find(
    (row) => row.dataset.id === id
  );
  if (next) {
    next.classList.add('selected');
    next.setAttribute('aria-selected', 'true');
  }
  syncActiveOption();
  syncShortcutBar();
  scrollSelectedIntoView();
  // An open preview follows the selection — and from now on, the keyboard.
  if (previewWant && id) requestPreview({ id, mode: 'held' });
}

// Rows whose match lives past `PREVIEW_MAX_CHARS`, for the query that found
// them. Kept beside the query so an answer that arrives after the user has
// typed on can never widen the wrong result.
let deepMatches = { query: '', ids: null };
let deepSearchToken = 0;

/**
 * Asks Rust about the text the panel was never sent.
 *
 * The local filter has already painted; this only widens what it found. A
 * superseded answer is dropped rather than rendered, and a failure leaves the
 * local result standing — searching less is a far better failure than an
 * empty shelf.
 */
async function askForDeepMatches(forQuery) {
  const token = ++deepSearchToken;
  if (!forQuery.trim()) {
    deepMatches = { query: '', ids: null };
    return;
  }
  try {
    const ids = await api.searchItems(forQuery);
    if (token !== deepSearchToken) return;
    deepMatches = { query: forQuery, ids: new Set(ids) };
    render();
  } catch (err) {
    diag('search:deep-failed', err);
  }
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

/** Pictures of items no longer in Rust's state (deleted, trimmed by the
 *  history limit or retention) are dropped, so what the list keeps is bounded
 *  by what it shows rather than by everything it showed this session. An item
 *  that can still come back keeps its picture: one in its delete's undo
 *  window, or one whose delete or undo is still on its way to Rust. */
function forgetPicturesOfGoneItems(next) {
  const ids = new Set([...(next.pinned ?? []), ...(next.history ?? [])].map((item) => item.id));
  for (const id of optimisticDeletedIds) ids.add(id);
  for (const snapshot of optimisticRestores.values()) ids.add(snapshot.item.id);
  if (activeDelete) ids.add(activeDelete.snapshot.item.id);
  for (const cache of [thumbs, fullImages]) {
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
  }
}

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
      forgetPicturesOfGoneItems(next);
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
closeBtn.addEventListener('click', () => hidePanel());
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

// ─── Preview (Figma «05 · التفاصيل» 45:5325; decisions ت٣٢) ─────────────────

const previewEl = document.getElementById('preview');
const previewKindEl = document.getElementById('preview-kind');
const previewWhenEl = document.getElementById('preview-when');
const previewSizeEl = document.getElementById('preview-size');
const previewBodyEl = document.getElementById('preview-body');
const previewNotesEl = document.getElementById('preview-notes');
const previewPinLabelEl = document.getElementById('preview-pin-label');
const previewAnnouncerEl = document.getElementById('preview-announcer');
const PREVIEW_TEXT_LIMIT = 1000; // what Rust sends of a long text (PREVIEW_MAX_CHARS)
const GRID_COLUMNS = 3;

for (const slot of previewEl.querySelectorAll('.preview-icon')) {
  slot.replaceWith(createIcon({ copy: COPY, pin: PIN, trash: TRASH }[slot.dataset.icon]));
}

/** What the preview should show — `{ id, mode }`, `mode` 'hover' (it closes
 *  when the pointer leaves) or 'held' (keys or a right-click: it stays). */
let previewWant = null;
/** The side the window is widened to while the preview is on screen. */
let previewSide = null;
let previewSync = Promise.resolve();

/** Asks for `want` (or none); applied in order, latest request wins. */
function requestPreview(want) {
  previewWant = want;
  previewSync = previewSync.then(applyPreview).catch((err) => diag('preview:failed', err));
  return previewSync;
}

async function applyPreview() {
  const want = previewWant;
  const item = want && visible.find((candidate) => candidate.id === want.id);
  if (!item) {
    if (want) previewWant = null;
    return closePreviewWindow();
  }
  if (!previewSide) {
    const side = await api.panelPreviewSide();
    if (previewWant !== want) return; // superseded while measuring
    if (side !== 'left' && side !== 'right') {
      previewWant = null; // no room beside the panel on this screen
      // Asked for by a key or a right-click: say why nothing happened.
      if (want.mode === 'held') showToast('لا متّسع للمعاينة بجانب اللوحة على هذه الشاشة');
      return;
    }
    // The panel is pinned to its edge before the window widens away from it.
    document.documentElement.dataset.preview = side;
    previewSide = side;
    fillPreview(item);
    previewEl.hidden = false;
    // Keys keep the focus in the search, so a screen reader hears it opened.
    if (want.mode === 'held') announcePreview(`معاينة ${previewKindEl.textContent} — Esc يغلقها`);
    await api.setPanelPreview(side);
    return;
  }
  fillPreview(item);
}

function announcePreview(message) {
  previewAnnouncerEl.textContent = '';
  queueMicrotask(() => {
    previewAnnouncerEl.textContent = message;
  });
}

async function closePreviewWindow() {
  if (!previewSide) return;
  previewSide = null;
  previewEl.hidden = true;
  delete previewEl.dataset.id;
  await api.setPanelPreview(null);
  if (!previewSide) delete document.documentElement.dataset.preview;
}

/** Closed by Esc, Space or ⌘Y: hover may not reopen it until the pointer moves. */
function closePreviewByHand() {
  hoverIntent.cancel();
  disarmHover();
  requestPreview(null);
}

/** Enter (⌥ for plain), ⌘C, ⌥P and ⌘⌫ — the keys that act on one item. */
function actsOnItem(e) {
  if (e.ctrlKey || e.shiftKey) return false;
  if (e.key === 'Enter' && !e.metaKey) return true;
  if (e.metaKey && !e.altKey && (e.code === 'KeyC' || e.key === 'Backspace')) return true;
  return e.altKey && !e.metaKey && e.code === 'KeyP';
}

/** The panel was hidden, and Rust narrowed its window with it. */
function resetPreview() {
  hoverIntent.cancel();
  disarmHover();
  previewWant = null;
  previewSide = null;
  previewEl.hidden = true;
  delete previewEl.dataset.id;
  delete document.documentElement.dataset.preview;
}

function togglePreviewFromKeys() {
  if (previewWant) {
    closePreviewByHand();
    return;
  }
  if (!selectedId && visible[0]) setSelection(visible[0].id);
  if (selectedId) requestPreview({ id: selectedId, mode: 'held' });
}

let previewBodyText = null;
const CHARS = ['حرف واحد', 'حرفان', 'أحرف', 'حرفًا'];
const TIMES = ['مرة', 'مرتين', 'مرات', 'مرة'];
const DAYS = ['يوم', 'يومين', 'أيام', 'يومًا'];

function fillPreview(item) {
  const sameItem = previewEl.dataset.id === item.id;
  previewEl.dataset.id = item.id;
  previewEl.dataset.type = item.type;
  previewKindEl.textContent = item.type === 'code' ? 'شفرة' : contentTypeIcon(item.type).label;
  previewWhenEl.textContent = [
    relativeTimeAr(item.createdAt),
    item.sourceApp ? `من \u2068${item.sourceApp}\u2069` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const chars = [...item.text].length;
  previewSizeEl.hidden = item.type === 'image';
  previewSizeEl.textContent =
    chars > PREVIEW_TEXT_LIMIT
      ? `أكثر من ${arabicDigits(PREVIEW_TEXT_LIMIT)} حرف`
      : arabicCount(chars, CHARS);

  // Re-rendering the list refills the preview; rebuild only what changed.
  if (!sameItem || previewBodyText !== item.text) {
    previewBodyText = item.text;
    previewBodyEl.replaceChildren(previewContent(item));
  }
  previewBodyEl.scrollTop = sameItem ? previewBodyEl.scrollTop : 0;

  const notes = [];
  const counts = [
    item.copyCount > 0 ? `نُسخ ${arabicCount(item.copyCount, TIMES)}` : null,
    item.pasteCount > 0 ? `لُصق ${arabicCount(item.pasteCount, TIMES)}` : null,
  ].filter(Boolean);
  if (counts.length > 0) notes.push(`${counts.join(' · ')} (التعلّم)`);
  const retentionDays = state.settings?.retentionDays ?? 0;
  if (item.isPinned) {
    notes.push('مثبّت: لا يُحذف بمرور الوقت');
  } else if (retentionDays > 0) {
    const left = Math.ceil((item.createdAt + retentionDays * 86_400_000 - Date.now()) / 86_400_000);
    notes.push(left < 1 ? 'يُحذف اليوم ما لم يُثبَّت' : `يُحذف بعد ${arabicCount(left, DAYS)} ما لم يُثبَّت`);
  }
  previewNotesEl.replaceChildren(
    ...notes.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    })
  );
  previewPinLabelEl.textContent = item.isPinned ? 'إلغاء التثبيت' : 'تثبيت';
}

/** Originals already fetched for the preview, the latest few. */
const fullImages = new Map();
const FULL_IMAGE_CACHE = 4;
const FULL_IMAGE_SETTLE_MS = 150;

function rememberFullImage(id, url) {
  fullImages.delete(id);
  fullImages.set(id, url);
  while (fullImages.size > FULL_IMAGE_CACHE) fullImages.delete(fullImages.keys().next().value);
}

function previewContent(item) {
  if (item.type === 'image') {
    const frame = document.createElement('div');
    frame.className = 'preview-picture';
    const img = document.createElement('img');
    img.alt = arabicDigits(item.text);
    img.decoding = 'async';
    const show = (src) => {
      if (src && previewEl.dataset.id === item.id) img.src = src;
    };
    const note = (reason) => {
      if (previewEl.dataset.id !== item.id) return;
      const missing = document.createElement('p');
      missing.className = 'preview-missing-note';
      missing.textContent = UNAVAILABLE_NOTE[reason];
      frame.replaceChildren(missing);
    };
    img.addEventListener('error', () => note('too-large'));
    // The thumbnail at once if the list has it, then the original (sharper
    // at 308pt) in its place — fetched only once the preview has settled on
    // this picture, and kept for the next few.
    if (fullImages.has(item.id)) {
      show(fullImages.get(item.id));
    } else {
      if (thumbs.has(item.id)) show(thumbs.get(item.id));
      setTimeout(() => {
        if (previewEl.dataset.id !== item.id) return; // moved on
        api
          .getFullImage(item.id)
          .then((url) => {
            if (!url) {
              if (!thumbs.has(item.id)) note('missing');
              return;
            }
            rememberFullImage(item.id, url);
            show(url);
          })
          .catch((err) => {
            if (err === PREVIEW_TOO_LARGE) note('too-large');
            else diag('preview:image-failed', err);
          });
      }, FULL_IMAGE_SETTLE_MS);
    }
    frame.append(img);
    return frame;
  }
  const text = document.createElement('div');
  text.className = 'preview-text';
  if (item.type === 'link') text.classList.add('is-link');
  else if (item.type === 'code') text.classList.add('is-code');
  text.dir = 'auto';
  text.textContent = item.text; // clip content → textContent
  return text;
}

// Pressing a preview button never takes the focus from the search.
previewEl.addEventListener('mousedown', (e) => e.preventDefault());
previewEl.addEventListener('click', (e) => {
  const button = e.target.closest?.('[data-action]');
  const id = previewEl.dataset.id;
  if (!button || !id) return;
  switch (button.dataset.action) {
    case 'paste':
      paste(id, false);
      return;
    case 'plain':
      paste(id, true);
      return;
    case 'copy':
      copyItem(id);
      return;
    case 'pin':
      togglePinItem(id);
      return;
    case 'delete':
      deleteItem(id);
      return;
  }
});

// Hover previews only: it never selects, focuses, copies or pastes.
const hoverIntent = createHoverIntent({
  isOpen: () => Boolean(previewWant),
  onRest(id) {
    if (previewWant?.mode === 'held') return; // keys or a right-click own it now
    requestPreview({ id, mode: 'hover' });
  },
  onAway() {
    if (previewWant?.mode === 'hover') requestPreview(null);
  },
});

// A panel that appears under a resting pointer has not been pointed at: WebKit
// re-sends the pointer where it already is when content changes under it.
// Hover counts again once the pointer has actually moved.
let hoverArmed = true;
let armedFrom = null;

function disarmHover() {
  hoverArmed = false;
  armedFrom = null;
}

// Rows that move under a parked pointer (a keystroke re-rendering the list,
// an arrow scrolling it) are reported at the point the pointer already had;
// only a new point is someone pointing.
let lastPointer = null;

function onPointer(e) {
  const target = e.target;
  if (!target?.closest) return;
  const point = { x: e.clientX, y: e.clientY };
  const still = lastPointer && lastPointer.x === point.x && lastPointer.y === point.y;
  lastPointer = point;
  if (still) {
    if (previewEl.contains(target)) hoverIntent.hold();
    return;
  }
  if (!hoverArmed) {
    if (!armedFrom) armedFrom = { x: e.clientX, y: e.clientY };
    if (Math.hypot(e.clientX - armedFrom.x, e.clientY - armedFrom.y) < 4) return;
    hoverArmed = true;
  }
  if (previewEl.contains(target)) {
    hoverIntent.hold();
    return;
  }
  const row = target.closest('#list .row[data-id]');
  if (row) hoverIntent.over(row.dataset.id, e.clientX, e.clientY);
  else if (panelEl.contains(target)) hoverIntent.between();
}
document.addEventListener('mouseover', onPointer);
document.addEventListener('mousemove', onPointer);
document.addEventListener('mouseout', (e) => {
  const to = e.relatedTarget;
  if (to && (panelEl.contains(to) || previewEl.contains(to))) return;
  hoverIntent.away();
});

// ─── Keyboard (full control — mouse optional) ─────────────────────────────

function setQuickSlotsVisible(on) {
  panelEl.classList.toggle('show-slots', on);
}

window.addEventListener('keyup', (e) => {
  if (e.key === 'Meta' || !e.metaKey) setQuickSlotsVisible(false);
});
window.addEventListener('blur', () => setQuickSlotsVisible(false));

window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta') {
    setQuickSlotsVisible(true);
    return;
  }
  // Esc closes the preview before it closes anything else — and it stays
  // closed: a pointer still resting on the row has to move to ask again.
  if (e.key === 'Escape' && previewWant) {
    e.preventDefault();
    closePreviewByHand();
    return;
  }
  // ⌘Y toggles the preview of the selection (Quick Look's key); so does Space
  // while there is nothing typed — with a query, Space is a space. A held key
  // repeats; it is still one press.
  const previewKey =
    (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyY') ||
    (e.key === ' ' && !e.metaKey && !e.altKey && !e.ctrlKey && !query && !isIndependentControl(e.target));
  if (previewKey) {
    e.preventDefault();
    if (!e.repeat) togglePreviewFromKeys();
    return;
  }
  // The keys the preview shows (↵ ⌥↵ ⌘C ⌥P ⌘⌫) act on the item it shows: an
  // item previewed by hover or a right-click becomes the selection first.
  if (previewWant && previewWant.id !== selectedId && actsOnItem(e)) {
    setSelection(previewWant.id);
  }
  if (e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    const item = visible[Number(e.code.slice(5)) - 1];
    e.preventDefault();
    if (item) {
      setSelection(item.id);
      paste(item.id, e.altKey);
    }
    return;
  }
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
        hidePanel();
      }
    }
    return;
  }

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      moveSelection(isGrid() ? GRID_COLUMNS : 1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      moveSelection(isGrid() ? -GRID_COLUMNS : -1);
      return;
    case 'ArrowLeft':
    case 'ArrowRight':
      // Across the grid; RTL, so ← is the next card. A typed query keeps its
      // caret, except at the end of the text, where it has nowhere to go.
      if (!isGrid() || (isWritable(document.activeElement) && !caretAtEnd())) return;
      e.preventDefault();
      moveSelection(e.key === 'ArrowLeft' ? 1 : -1);
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
        hidePanel();
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
    if (selectedId) copyItem(selectedId);
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
  void askForDeepMatches(query);
});

// A focused row action or filter owns Enter/arrow keys natively. Refresh the
// legend on focus transitions so it never advertises those keys while the
// browser correctly routes them to that control.
window.addEventListener('focusin', syncShortcutBar);
window.addEventListener('focusout', () => queueMicrotask(syncShortcutBar));

// ─── Events from Rust ─────────────────────────────────────────────────────

on('raff://changed', () => {
  // A re-copied image heals its row; ask for missing thumbnails again.
  missingThumbs.clear();
  if (!isShown) {
    // The show path below refreshes before the panel appears, so a capture
    // nobody can see costs nothing until it is worth something.
    diag('changed:deferred-while-hidden');
    return;
  }
  refresh();
}).catch((err) => diag('listen:failed', err));
on('panel://shown', async () => {
  diag('event:panel-shown');
  isShown = true;
  query = '';
  searchEl.value = '';
  selectedId = null;
  resetPreview();
  setFilter('all');
  setQuickSlotsVisible(false);
  searchEl.focus();
  // The webview stays live while hidden, so the list is already painted;
  // this only reconciles anything that changed while no event arrived.
  await refresh({ retry: true });
  listEl.scrollTop = 0;
}).catch((err) => diag('listen:failed', err));

// Rust conceals the panel on a paste, a click outside it, the hotkey and the
// menu-bar icon without the page seeing anything but a blur — which also
// happens with the panel still on screen. Rust knows, and says so.
on('panel://hidden', () => {
  diag('event:panel-hidden');
  isShown = false;
}).catch((err) => diag('listen:failed', err));

// Belt-and-suspenders alongside panel://shown: if the panel ever regains
// focus without that IPC event landing (native window activation is a more
// reliable signal than a webview message), this still resyncs the list
// through the same guarded refresh() path — without resetting the search.
window.addEventListener('focus', () => {
  // Native activation is the more reliable signal of the two; if the IPC event
  // was ever missed, this is what puts the panel back on the refresh path.
  isShown = true;
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
  // The panel has no menu of its own to keep: a right-click on an item opens
  // its preview at once — which carries every action — without selecting it.
  const row = e.target.closest?.('#list .row[data-id]');
  if (row) {
    hoverIntent.cancel();
    requestPreview({ id: row.dataset.id, mode: 'held' });
  }
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
