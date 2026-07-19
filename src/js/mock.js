// Design-review mock: the sample items from R/'s FloatingPanel reference.
// Used only when the pages are opened outside Tauri (window.__TAURI__ absent).

const MIN = 60_000;
const now = Date.now();

const item = (id, type, text, sourceApp, agoMs, isPinned = false) => ({
  id,
  type,
  text,
  sourceApp,
  sourceAppBundleId: '',
  createdAt: now - agoMs,
  isPinned,
  copyCount: 3,
  pasteCount: 1,
  lastUsedAt: now - agoMs,
  hasImage: type === 'image',
});

const PINNED = [
  item('p1', 'text', 'أكتب خطابًا رسميًا باللغة العربية يطلب فيه تمديد الموعد النهائي…', 'ChatGPT', 60 * MIN, true),
  item('p2', 'code', 'const fetchUser = async (id: string) => await api.get(`/users/${id}`)', 'VS Code', 26 * 60 * MIN, true),
  item('p3', 'link', 'https://developer.apple.com/documentation/swiftui', 'Safari', 2 * 24 * 60 * MIN, true),
];

const RECENT = [
  item('r1', 'text', 'نص المراجعة: يُعدّ هذا المنتج من أفضل ما جرّبته في إدارة الحافظة…', 'Notes', 3 * MIN),
  item('r2', 'image', 'صورة 420×315', 'Finder', 12 * MIN),
  item('r3', 'code', "SELECT * FROM users WHERE created_at > NOW() - INTERVAL '7 days'", 'TablePlus', 30 * MIN),
  item('r4', 'text', 'Meeting notes: Q3 roadmap — focus on onboarding flow and retention.', 'Notion', 65 * MIN),
];

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
  appIcon: 'auto',
};

export function mockInvoke(cmd, args = {}) {
  switch (cmd) {
    case 'get_state':
      return Promise.resolve({
        pinned: PINNED,
        history: RECENT,
        settings: SETTINGS,
        axTrusted: true,
        version: '1.2.1',
      });
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
    case 'ax_status':
      return Promise.resolve(false);
    // Design-review sample: shows the richest "update available" state. Events
    // don't fire outside Tauri, so download resolves straight to "installed".
    case 'check_for_update':
      return Promise.resolve({
        status: 'available',
        currentVersion: '2.1.0',
        version: '2.2.0',
        date: '2026-07-19',
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
