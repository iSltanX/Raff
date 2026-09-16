// Design-review mock. Used only when the pages are opened outside Tauri
// (window.__TAURI__ absent), so every screen can be compared side by side with
// the approved Figma frames in a plain browser.
//
// The sample content is neutral, realistic Arabic and Latin clipboard content,
// so README screenshots never carry anyone's real clipboard.

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

let pendingDelete = null;
let deleteSequence = 0;

const SETTINGS = {
  hotkey: 'shift+super+v',
  launchAtLogin: false,
  historyLimit: 500,
  captureEnabled: true,
  respectConcealed: true,
  excludedApps: ['com.1password.1password'],
  learningEnabled: true,
  firstRunShown: false,
  appearance: 'light',
  followSystem: true,
};

export function mockInvoke(cmd, args = {}) {
  switch (cmd) {
    case 'get_state':
      return Promise.resolve(structuredClone({
        pinned: PINNED,
        history: RECENT,
        settings: SETTINGS,
        axTrusted: true,
        version: '5.0.1',
      }));
    case 'paste_item':
      return Promise.resolve(true);
    case 'toggle_pin': {
      const pinnedIndex = PINNED.findIndex((entry) => entry.id === args.id);
      if (pinnedIndex >= 0 && args.isPinned === false) {
        const [entry] = PINNED.splice(pinnedIndex, 1);
        entry.isPinned = false;
        RECENT.push(entry);
        RECENT.sort((a, b) => b.createdAt - a.createdAt);
        return Promise.resolve(false);
      }
      const recentIndex = RECENT.findIndex((entry) => entry.id === args.id);
      if (recentIndex >= 0 && args.isPinned === true) {
        const [entry] = RECENT.splice(recentIndex, 1);
        entry.isPinned = true;
        PINNED.push(entry);
        return Promise.resolve(true);
      }
      if (pinnedIndex >= 0) return Promise.resolve(true);
      if (recentIndex >= 0) return Promise.resolve(false);
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
      pendingDelete = null;
      return Promise.resolve(null);
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
      return Promise.resolve(null);
    // Design-review sample thumbnail, so the image row renders the way it
    // does in the app (the real command returns the stored PNG).
    case 'get_image':
      return Promise.resolve('data:image/png;base64,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');
    case 'ax_status':
      return Promise.resolve(false);
    // Design-review sample: shows the richest "update available" state. Events
    // don't fire outside Tauri, so download resolves straight to "installed".
    case 'check_for_update':
      return Promise.resolve({
        status: 'available',
        currentVersion: '5.0.1',
        version: '5.1.0',
        date: '2026-10-01',
        notes: 'تحسينات في الأداء وإصلاحات متفرّقة.\nدعم إعادة التشغيل بعد التحديث.',
      });
    case 'download_and_install_update':
    case 'restart_to_update':
      return Promise.resolve(null);
    case 'consume_update_intent':
      return Promise.resolve(false); // no tray in the browser

    default:
      return Promise.resolve(null);
  }
}
