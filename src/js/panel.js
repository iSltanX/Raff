// Floating panel behavior: instant filter, full keyboard control, paste.
// Clip content is ALWAYS rendered via textContent — never innerHTML.

import { api, on } from './store.js';
import { arabicDigits, filterItems, metaLine } from './logic.js';
import {
  TYPE_ICONS,
  PIN_ICON,
  PIN_ICON_FILLED,
  SEARCH_ICON,
  EMPTY_ICON,
  NO_RESULTS_ICON,
} from './icons.js';

const searchEl = document.getElementById('search');
const listEl = document.getElementById('list');
const escChip = document.getElementById('esc-chip');
const toastEl = document.getElementById('toast');
document.getElementById('search-icon').innerHTML = SEARCH_ICON;

let state = { pinned: [], history: [], settings: null, axTrusted: false };
let query = '';
let selectedId = null;
let visible = []; // flat filtered list, pinned first
const thumbs = new Map(); // id → data URL
let toastTimer = null;

// ─── Rendering ────────────────────────────────────────────────────────────

function stateView(icon, title, sub, extraClass = '') {
  const view = document.createElement('div');
  view.className = `state-view ${extraClass}`;
  const box = document.createElement('div');
  box.className = 'state-icon-box';
  box.innerHTML = icon; // static SVG constant
  const textWrap = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'state-title';
  titleEl.textContent = title;
  const subEl = document.createElement('div');
  subEl.className = 'state-sub';
  subEl.textContent = sub;
  textWrap.append(titleEl, subEl);
  view.append(box, textWrap);
  return view;
}

function sectionHeader(label) {
  const el = document.createElement('div');
  el.className = 'section-header';
  el.textContent = label;
  return el;
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = item.id;
  row.setAttribute('role', 'option');
  if (item.id === selectedId) row.classList.add('selected');

  const icon = document.createElement('span');
  icon.className = 'row-icon';
  icon.innerHTML = TYPE_ICONS[item.type] || TYPE_ICONS.text; // static SVG constant

  const content = document.createElement('div');
  content.className = 'row-content';
  const title = document.createElement('div');
  title.className = 'row-title';

  if (item.type === 'link') {
    const chip = document.createElement('span');
    chip.className = 'link-chip';
    chip.textContent = item.text; // clip content → textContent
    title.append(chip);
  } else if (item.type === 'image') {
    const wrap = document.createElement('span');
    wrap.className = 'image-preview';
    const img = document.createElement('img');
    img.className = 'image-thumb';
    img.alt = '';
    if (thumbs.has(item.id)) img.src = thumbs.get(item.id);
    else loadThumb(item.id, img);
    const label = document.createElement('span');
    label.className = 'image-label';
    label.textContent = arabicDigits(item.text); // bidi-stable dimensions
    wrap.append(img, label);
    title.append(wrap);
  } else {
    if (item.type === 'code') title.classList.add('code');
    title.dir = 'auto';
    title.textContent = item.text; // clip content → textContent
  }

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = metaLine(item);
  content.append(title, meta);

  const pin = document.createElement('button');
  pin.className = 'pin-btn' + (item.isPinned ? ' pinned' : '');
  pin.innerHTML = item.isPinned ? PIN_ICON_FILLED : PIN_ICON; // static SVG constant
  pin.title = item.isPinned ? 'إلغاء التثبيت' : 'تثبيت';
  pin.tabIndex = -1;
  pin.addEventListener('click', (e) => {
    e.stopPropagation();
    api.togglePin(item.id);
  });

  row.addEventListener('click', () => {
    selectedId = item.id;
    render();
  });
  row.addEventListener('dblclick', () => paste(item.id, false));

  row.append(icon, content, pin);
  return row;
}

function render() {
  const pinned = filterItems(state.pinned, query);
  const recent = filterItems(state.history, query);
  visible = [...pinned, ...recent];

  if (!visible.some((i) => i.id === selectedId)) {
    selectedId = visible[0]?.id ?? null;
  }

  listEl.replaceChildren();
  escChip.hidden = query.length === 0;

  if (visible.length === 0) {
    if (query) {
      listEl.append(stateView(NO_RESULTS_ICON, 'لا نتائج', 'جرّب كلمة أخرى', 'no-results'));
    } else {
      listEl.append(stateView(EMPTY_ICON, 'رفّك فارغ', 'انسخ أي شيء ليظهر هنا'));
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  if (pinned.length > 0) {
    fragment.append(sectionHeader('مثبّت'));
    pinned.forEach((item) => fragment.append(buildRow(item)));
  }
  if (recent.length > 0) {
    fragment.append(sectionHeader('الأخير'));
    recent.forEach((item) => fragment.append(buildRow(item)));
  }
  listEl.append(fragment);
  scrollSelectedIntoView();
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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
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

async function refresh() {
  state = await api.getState();
  render();
}

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
  if (e.metaKey && e.key === 'Backspace') {
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
      api.copyItem(selectedId)
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

on('raff://changed', refresh);
on('panel://shown', async () => {
  query = '';
  searchEl.value = '';
  selectedId = null;
  await refresh();
  searchEl.focus();
});

window.addEventListener('focus', () => searchEl.focus());

// Keep relative times fresh while the panel is open.
setInterval(() => {
  if (document.visibilityState === 'visible' && visible.length > 0) render();
}, 30000);

refresh().then(() => searchEl.focus());
