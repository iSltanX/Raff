// Design-review mock. Used only when the pages are opened outside Tauri
// (window.__TAURI__ absent), so every screen can be compared side by side with
// the approved Figma frames in a plain browser.
//
// The sample content is the content drawn in Figma «08 — Product Screens»
// (2:7684 / 2:7791 / 2:7880), so a screenshot here lines up with the design.

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
  item(
    'p1',
    'text',
    'قائمة المهام اليومية للفريق البرمجي ومراجعة ملاحظات الإصدار قبل الاجتماع الأسبوعي مع فريق المنتج',
    'الملاحظات',
    'com.apple.Notes',
    15 * MIN,
    true
  ),
];

const RECENT = [
  item(
    'r1',
    'text',
    'مراجعة تصميم واجهة المستخدم للتطبيق الجديد — Raff v4 final visual QA at normal desktop scale',
    'ChatGPT Classic',
    'com.openai.chat',
    2 * MIN
  ),
  item(
    'r2',
    'link',
    'https://developer.apple.com/design/human-interface-guidelines/menus-and-actions/context-menus?language=objc',
    'Safari',
    'com.apple.Safari',
    HOUR
  ),
  item('r3', 'image', 'صورة 420×315', 'الصور', 'com.apple.Photos', 2 * HOUR),
  item(
    'r4',
    'text',
    'Meeting notes: Q3 roadmap — focus on Arabic onboarding, retrieval speed, and retention.',
    'Notion Calendar',
    'notion.id',
    4 * HOUR
  ),
  item('r5', 'code', "git commit -m 'feat: add native RTL panel support'", 'الطرفية', 'com.apple.Terminal', 25 * HOUR),
  item(
    'r6',
    'text',
    'هذه فقرة عربية طويلة لاختبار قابلية القراءة والاقتطاع عند اختلاف طول المحتوى واسم التطبيق وبيانات الوقت في العرض الحقيقي.',
    'معاينة',
    'com.apple.Preview',
    48 * HOUR
  ),
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
        version: '4.1.1',
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
      return Promise.resolve('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANIAAACbCAIAAACYrFKxAAAENUlEQVR42u3dzW9VRRjH8ZmrtqiliSQl0YWgG8F/hm7cASv/iVphBeWfsKzctRsTlq50hS/BBe1FjL31BS7RpJi+IC2xx4VG3Gjae885c2fO55uzo/e8zPx4fjPzPGdO3PrlpwC0y4tVVWkFtExPEyBBtAuiHRKYrDYAkwWTBUQ7FDS2E+2QwGQ1ApgsOhHthDukSI5pBIh2MLYDzGRh3Q5gspCTBUQ7qLcDmCyYLGQpADlZMFmAyeIovLS+8F//9OzdG23eSRxu3tMfhautv3D0P352vg39xYebfR1TKlP9D0b74cH5JWM7tKq5MX97tGg3EO1K1Ny9GnRzcG6pOdmt66TiNLdY16kOzl1vRHYPyK4spuvT3F/sN6C8+GBjTVeVo7lvP2zitPvvXDOlQKuaa+LM8WfRrghONKa5f3haX8xT+IQjU59UmGwRoe7+lbyuIieL40U8hU/I1WaZbPa8/N3V7K7FZJHAZ21GgQSjO5tR4Liqq4ztEOz4BCZrSoGJnVIQHdpfL5aTRYIlY1OK7Nl7+2p21yI7+Ho2Jt1gK9EOf7P71pW8rmIBBW1XPYUQ4mb/a81ZBjOb15o7+e7ZOovm44DsCuJkM8rbOVv3KzyD/ld6qyzlXa9bc4u132QcrJNdccr7oTbl7ZxZbOIO42D9S/1UovKW6tBcUxvwxA2yK5TZ8ZS3fabBTZ/ixhrZlau8H0dU3vabDW80trH2he4pXXw3jiO4hRZuiezorz21PZfd93dv6w8EHwgA2QFB4RNEO0DhE7wnC3hhEUwWTFYjQLSDsR3AZMFkgSBLATlZQLQD2YHJ2lYR1u1gAQWwXAxTCsDHn8BkAVMKGNsBPtoOJgsmC8jJQk4WYLLorMk+XLmoNdvhjfc+zv0R4t3bn455iiHBpeD1nMXXC6Ea56C5VAxXLo7ZdwmP3jg/H65c0v1JlXcpU+GNPqUYrtLcBCgvz15Q+BTy/8hrleHYbqQg+Wj1sv6eEB6tXs7OZOVkfdfacjGCwifkEusqhU9gskwWCp/AZRU+sVgmi9CheruqGuE4PX9T200Ip+dvjtaJCQ/RDimi3ciKnZtf1nzJmZtfrrKLdWMWPs1doLykmruw3LnCp+dPjlSay5b4zee3ajnRr5+8TwptCe6j3B8h3vnslo5EkJOF92QB2yrCJrIAk4XCJ+B/Z7I18MfUTBca64WDXYqZiHq7w24I7t//u3rEl9ZkD6dPdrDJDqdmevs7pJNmStFNzXl2CyjBFhDdWi6uTsx2XXbTs/HpNgFZt4NSAG9swWYUXk4V7UQ7Y7vR+P23rrecFlD4JNJ1Zt3uyeP4ymsdldyTx6STbAGlm61Pc+kLn6q9rRBCfPVUJwS3t0UxE1T4pD9gozGoLgbkZCFLATlZgMmCyQJysvAuBWBsByYLmFJAThZysoApBcrmT+F01xQ/M8/kAAAAAElFTkSuQmCC');
    // The browser has no NSWorkspace — rows keep their app-initial fallback.
    case 'source_app_icon':
      return Promise.resolve(null);
    case 'ax_status':
      return Promise.resolve(false);
    // Design-review sample: shows the richest "update available" state. Events
    // don't fire outside Tauri, so download resolves straight to "installed".
    case 'check_for_update':
      return Promise.resolve({
        status: 'available',
        currentVersion: '4.1.1',
        version: '4.2.0',
        date: '2026-08-12',
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
