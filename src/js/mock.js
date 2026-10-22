// Design-review mock. Used only when the pages are opened outside Tauri
// (window.__TAURI__ absent), so every screen can be compared side by side with
// the approved Figma frames in a plain browser.
//
// The sample content is neutral, realistic Arabic and Latin clipboard content,
// so README screenshots never carry anyone's real clipboard.
//
// It answers the way Rust answers, `raff://changed` included: a page under
// review in a state the app never reaches is reviewing the wrong page.

import { normalizeArabic } from './logic.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();

const item = (id, type, text, sourceApp, bundleId, agoMs, isPinned = false) => ({
  id,
  type,
  text,
  sourceApp,
  sourceAppBundleId: bundleId,
  createdAt: now - agoMs,
  isPinned,
  copyCount: 3,
  pasteCount: 1,
  lastUsedAt: now - agoMs,
  hasImage: type === 'image',
});

const PINNED = [
  item('p1', 'text', 'عنوان المكتب: طريق الملك فهد، حي العليا، الرياض', 'الملاحظات', 'com.apple.Notes', 50 * HOUR, true),
];

const RECENT = [
  item('r1', 'text', 'الاجتماع يوم الأحد الساعة ١٠ صباحًا في قاعة الإبداع', 'التقويم', 'com.apple.iCal', 1 * MIN),
  item('r2', 'link', 'https://developer.apple.com/design/human-interface-guidelines', 'Safari', 'com.apple.Safari', 12 * MIN),
  item('r3', 'image', 'لقطة شاشة — تصميم رفّ الجديد', 'لقطة الشاشة', 'com.apple.screenshot', 40 * MIN),
  item('r4', 'code', 'const items = NSPasteboard.general.pasteboardItems', 'Xcode', 'com.apple.dt.Xcode', 2 * HOUR),
  item('r5', 'text', 'شكرًا لكم، تم استلام الطلب وسيتم الشحن خلال يومين.', 'البريد', 'com.apple.mail', 5 * HOUR),
  item('r6', 'text', 'Meeting notes — roadmap review: search speed and Arabic onboarding', 'الملاحظات', 'com.apple.Notes', 26 * HOUR),
  item('r7', 'link', 'https://github.com/iSltanX/Raff/releases/latest', 'Safari', 'com.apple.Safari', 30 * HOUR),
];

// Design review: `?pause=timed` (or skipNext / untilRestart) shows the
// capture strip; `?capture=off` shows capture turned off;
// `?settings=unreadable` shows a settings.json that did not parse.
const params = new URLSearchParams(globalThis.location?.search ?? '');
let MOCK_PAUSE = params.get('pause') ?? 'off';
let MOCK_UNREADABLE_SETTINGS = params.get('settings') === 'unreadable';

let pendingDelete = null;
let deleteSequence = 0;
// The only way into the update window is `request_check_from_menu`, which
// leaves one check for the window to claim before opening it (`updater.rs`):
// a freshly loaded update page always finds one.
let updateIntent = true;
// Set once the mock has "checked": `open_updates` then hands the window what
// was found, as Rust does.
let updateFound = false;

const listeners = new Map();

export function mockListen(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return Promise.resolve(() => listeners.get(event)?.delete(handler));
}

function announce(event = 'raff://changed') {
  for (const handler of [...(listeners.get(event) ?? [])]) handler({ event, payload: null });
}

// What Rust follows with `raff://changed` once it succeeds; a paste or copy
// announces only the use it counted (`count_use`).
const CHANGES = new Set([
  'import_backup',
  'set_label',
  'toggle_pin',
  'delete_item',
  'undo_delete',
  'reorder_pinned',
  'update_settings',
  'clear_history',
  'clear_learning',
  'resume_capture',
]);

function countUse(id, counter) {
  if (!SETTINGS.learningEnabled) return;
  const entry = [...PINNED, ...RECENT].find((candidate) => candidate.id === id);
  if (!entry) return;
  entry[counter] += 1;
  entry.lastUsedAt = Math.max(Date.now(), entry.lastUsedAt + 1);
  announce();
}

const SETTINGS = {
  hotkey: 'shift+super+v',
  launchAtLogin: false,
  historyLimit: 500,
  captureEnabled: params.get('capture') !== 'off' && !MOCK_UNREADABLE_SETTINGS,
  respectConcealed: true,
  skipSecrets: false,
  ocrEnabled: false,
  excludedApps: ['com.1password.1password'],
  learningEnabled: true,
  firstRunShown: false,
  appearance: 'light',
  followSystem: true,
  retentionDays: 0,
};

const MOCK_DIAGNOSTICS = {
  schema: 1,
  build: 'debug',
  accessibility: 'granted',
  capture: { enabled: true, alive: true, paused: 'off' },
  settings: {
    historyLimit: 500,
    retentionDays: 0,
    appearance: 'system',
    launchAtLogin: false,
    learningEnabled: true,
    respectConcealed: true,
    excludedCount: 1,
    hotkeyIsDefault: true,
  },
  counts: { history: 7, pinned: 1 },
  storage: { unreadableLayer: false },
  recent: [{ op: 'paste', result: 'ok', ms: 180, agoS: 40 }],
  uptimeS: 5400,
};

const MOCK_SEND = {
  sent: { status: 'sent', id: 128 },
  failed: { status: 'failed', reason: 'network' },
  limited: { status: 'rateLimited', retryAfterS: 1500 },
  rejected: { status: 'rejected', code: 400, error: 'invalid_field', field: 'os_version' },
};

// A neutral grey square, so the attachment states can be reviewed.
const MOCK_IMAGE = {
  mime: 'image/png',
  bytes: 284_312,
  width: 1280,
  height: 800,
  thumb:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#d9d9d9"/></svg>'),
};
let mockImage = null;

export function mockInvoke(cmd, args = {}) {
  return Promise.resolve()
    .then(() => answer(cmd, args))
    .then((result) => {
      if (CHANGES.has(cmd)) announce();
      return result;
    });
}

function answer(cmd, args) {
  switch (cmd) {
    case 'get_state':
      return Promise.resolve(structuredClone({
        pinned: PINNED,
        history: RECENT,
        settings: SETTINGS,
        axTrusted: true,
        version: '6.0.1',
        captureAlive: true,
        capturePause: { kind: MOCK_PAUSE, minutesLeft: MOCK_PAUSE === 'timed' ? 12 : null },
        unreadableLayer: false,
        unreadableSettings: MOCK_UNREADABLE_SETTINGS,
      }));
    case 'get_settings':
      return Promise.resolve(structuredClone({
        settings: SETTINGS,
        axTrusted: false,
        version: '6.0.1',
        unreadableSettings: MOCK_UNREADABLE_SETTINGS,
        captureAlive: true,
        capturePause: { kind: MOCK_PAUSE, minutesLeft: MOCK_PAUSE === 'timed' ? 12 : null },
      }));
    case 'resume_capture':
      MOCK_PAUSE = 'off';
      return Promise.resolve(null);
    case 'restart_app':
      return Promise.resolve(null);
    case 'paste_item':
      countUse(args.id, 'pasteCount');
      return Promise.resolve(true);
    case 'copy_item':
      countUse(args.id, 'copyCount');
      return Promise.resolve(null);
    // The full text, folded and trimmed the way the panel's own filter does.
    case 'search_items': {
      const needle = normalizeArabic(String(args.query ?? '').trim());
      if (!needle) return Promise.resolve([]);
      return Promise.resolve(
        [...PINNED, ...RECENT]
          .filter((entry) => normalizeArabic(entry.text).includes(needle))
          .map((entry) => entry.id)
      );
    }
    // IMP-05: the browser has no save or open panel; a sample answer.
    case 'export_backup':
      return Promise.resolve({ saved: true, items: PINNED.length, pictures: 0 });
    // As Rust, it announces when it added something: the sample adds one.
    case 'import_backup':
      PINNED.push({ ...PINNED[0], id: `imported-${PINNED.length}`, text: 'عنصر مستورد', label: undefined });
      return Promise.resolve({ imported: true, added: 1, skipped: 0, settings: { ...SETTINGS } });
    // IMP-07, as Rust: pinned items only, trimmed, capped, blank clears.
    case 'set_label': {
      const entry = PINNED.find((item) => item.id === args.id);
      if (!entry) return Promise.reject('raff/label-not-pinned');
      const label = String(args.label ?? '').trim();
      if ([...label].length > 40) return Promise.reject('raff/label-too-long');
      if (label) entry.label = label;
      else delete entry.label;
      return Promise.resolve(null);
    }
    case 'reorder_pinned': {
      const ids = args.ids ?? [];
      const matchesShelf =
        ids.length === PINNED.length &&
        new Set(ids).size === ids.length &&
        ids.every((id) => PINNED.some((entry) => entry.id === id));
      if (!matchesShelf) return Promise.reject(new Error('ترتيب المثبتات لا يطابق المحفوظ'));
      const reordered = ids.map((id, order) => ({
        ...PINNED.find((entry) => entry.id === id),
        pinnedOrder: order,
      }));
      PINNED.splice(0, PINNED.length, ...reordered);
      return Promise.resolve(null);
    }
    case 'clear_history':
      pendingDelete = null;
      RECENT.length = 0;
      return Promise.resolve(null);
    case 'clear_learning':
      for (const entry of [...PINNED, ...RECENT]) {
        entry.copyCount = 0;
        entry.pasteCount = 0;
        entry.lastUsedAt = entry.createdAt;
      }
      return Promise.resolve(null);
    case 'toggle_pin': {
      const pinnedIndex = PINNED.findIndex((entry) => entry.id === args.id);
      if (pinnedIndex >= 0 && args.isPinned === false) {
        const [entry] = PINNED.splice(pinnedIndex, 1);
        entry.isPinned = false;
        // As the backend does: back to its place in time with its date.
        // Older than every row in history, it is not taken back; into an
        // empty history, it is.
        const older =
          RECENT.length > 0 && RECENT.every((other) => entry.createdAt < other.createdAt);
        // Past the retention period the age limit is the reason (ت٢٩).
        const pastRetention =
          SETTINGS.retentionDays > 0 &&
          entry.createdAt < Date.now() - SETTINGS.retentionDays * 86_400_000;
        if (pastRetention || older) {
          return Promise.resolve({
            isPinned: false,
            removed: true,
            reason: pastRetention ? 'retention' : 'olderThanHistory',
          });
        }
        RECENT.push(entry);
        RECENT.sort((a, b) => b.createdAt - a.createdAt);
        return Promise.resolve({ isPinned: false, removed: false });
      }
      const recentIndex = RECENT.findIndex((entry) => entry.id === args.id);
      if (recentIndex >= 0 && args.isPinned === true) {
        const [entry] = RECENT.splice(recentIndex, 1);
        entry.isPinned = true;
        PINNED.push(entry);
        return Promise.resolve({ isPinned: true, removed: false });
      }
      if (pinnedIndex >= 0) return Promise.resolve({ isPinned: true, removed: false });
      if (recentIndex >= 0) return Promise.resolve({ isPinned: false, removed: false });
      return Promise.reject(new Error('العنصر غير موجود'));
    }
    case 'delete_item': {
      const layer = PINNED.some((entry) => entry.id === args.id) ? PINNED : RECENT;
      const index = layer.findIndex((entry) => entry.id === args.id);
      if (index < 0) return Promise.reject(new Error('العنصر غير موجود'));
      const [entry] = layer.splice(index, 1);
      const token = `mock-delete-${++deleteSequence}`;
      pendingDelete = { token, layer, index, entry };
      return Promise.resolve({ token });
    }
    case 'undo_delete':
      if (pendingDelete?.token !== args.token) {
        return Promise.reject(new Error('انتهت مهلة التراجع عن الحذف'));
      }
      pendingDelete.layer.splice(pendingDelete.index, 0, pendingDelete.entry);
      {
        const standing = pendingDelete.entry.id;
        pendingDelete = null;
        return Promise.resolve(standing);
      }
    case 'commit_delete':
      if (pendingDelete?.token === args.token) pendingDelete = null;
      return Promise.resolve(null);
    case 'learning_summary':
      return Promise.resolve(
        [...PINNED, ...RECENT].slice(0, 5).map((i) => ({
          text: i.text,
          type: i.type,
          copyCount: i.copyCount,
          pasteCount: i.pasteCount,
          lastUsedAt: i.lastUsedAt,
        }))
      );
    case 'list_running_apps':
      return Promise.resolve([
        { name: 'Safari', bundleId: 'com.apple.Safari' },
        { name: 'Notes', bundleId: 'com.apple.Notes' },
      ]);
    case 'update_settings':
      Object.assign(SETTINGS, args.settings);
      if (SETTINGS.captureEnabled) MOCK_UNREADABLE_SETTINGS = false;
      return Promise.resolve(null);
    // Design-review sample thumbnail, so the image row renders the way it
    // does in the app (the real command returns the stored PNG).
    case 'get_image':
      return Promise.resolve('data:image/png;base64,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');
    case 'ax_status':
      return Promise.resolve(false);
    // The browser has no window to widen: the preview opens on the left of a
    // page wide enough for both (gallery frames are 816 wide).
    case 'panel_preview_side':
      return Promise.resolve(window.innerWidth >= 816 ? 'left' : null);
    case 'set_panel_preview':
      return Promise.resolve(null);
    // Design-review sample: shows the richest "update available" state. Events
    // don't fire outside Tauri, so download resolves straight to "installed".
    case 'check_for_update':
      updateFound = true;
      return Promise.resolve({
        status: 'available',
        currentVersion: '6.0.1',
        version: '6.0.2',
        date: '2026-10-01',
        notes: 'تحسينات في الأداء وإصلاحات متفرّقة.\nدعم إعادة التشغيل بعد التحديث.',
      });
    case 'download_and_install_update':
    case 'restart_to_update':
      return Promise.resolve(null);
    // As in Rust: what a check found is handed to the window, not asked again.
    case 'open_updates':
      updateIntent = updateFound ? 'found' : true;
      return Promise.resolve(null);
    case 'consume_update_intent': {
      const claimed = updateIntent;
      updateIntent = false;
      if (claimed === 'found') return mockInvoke('check_for_update');
      return Promise.resolve(claimed);
    }

    // Report window. `?send=sent|failed|limited|rejected` picks the answer.
    case 'report_prepare':
      return Promise.resolve({
        kind: args.kind,
        category: args.category,
        description: args.description.trim(),
        appVersion: '6.0.1',
        os: 'macos',
        osVersion: '15.4',
        arch: 'arm64',
        locale: 'ar',
        test: true,
        idempotencyKey: '3f6c1a52-8e0b-4c7d-9a14-2b5e7d90c831',
        diagnosticsJson: JSON.stringify(MOCK_DIAGNOSTICS, null, 2),
        image: mockImage,
        endpointHost: 'app-reports.isultantf.workers.dev',
      });
    case 'report_send':
      return new Promise((resolve) =>
        setTimeout(() => resolve(MOCK_SEND[params.get('send') ?? 'sent'] ?? MOCK_SEND.sent), 600)
      );
    case 'report_pick_image':
    case 'report_paste_image':
      mockImage = MOCK_IMAGE;
      return new Promise((resolve) => setTimeout(() => resolve(MOCK_IMAGE), 400));
    case 'report_remove_image':
      mockImage = null;
      return Promise.resolve(null);

    default:
      return Promise.resolve(null);
  }
}
