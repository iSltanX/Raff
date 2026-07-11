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
        version: '1.0.0',
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
    case 'get_image':
      return Promise.resolve(null);
    case 'ax_status':
      return Promise.resolve(false);
    default:
      return Promise.resolve(null);
  }
}
