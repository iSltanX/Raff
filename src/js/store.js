// Thin IPC layer over the audited Rust commands (withGlobalTauri).
// Outside Tauri (plain browser, design review) a mock serves the identity's
// sample items; inside the app `window.__TAURI__` always exists.

// Keep the design-review fixture out of production distributions. Plain-file
// browser previews load it on demand; Tauri always takes the native branch and
// never requests `mock.js` from the packaged asset protocol.
//
// The bridge is looked up on every call, not once at import: in the app it is
// the same object either way, but a test file that mounts several windows in
// turn must reach the one it is mounting now (audit 025).
const invoke = async (command, args) => {
  const bridge = window.__TAURI__;
  if (bridge) return bridge.core.invoke(command, args);
  const { mockInvoke } = await import('./mock.js');
  return mockInvoke(command, args);
};
const listen = async (event, handler) => {
  const bridge = window.__TAURI__;
  if (bridge) return bridge.event.listen(event, handler);
  const { mockListen } = await import('./mock.js');
  return mockListen(event, handler);
};

export const api = {
  getState: () => invoke('get_state'),
  // The Settings window's own read: preferences and states, no shelf.
  getSettings: () => invoke('get_settings'),
  // Ids of rows matching beyond the preview the panel holds.
  searchItems: (query) => invoke('search_items', { query }),
  // `true` pasted, `false` copied only, or a string naming why it was only
  // copied (`'copiedOverRaff'`, paste.rs `PasteOutcome`): a new reason must be
  // worded in panel.js, or it reads as the Accessibility fallback.
  // `bare`: «الصق بلا تشكيل» (IMP-06), the text without harakat or tatweel.
  // Sent only when asked for: every other paste is what it always was.
  pasteItem: (id, plain = false, bare = false) =>
    invoke('paste_item', bare ? { id, plain, bare } : { id, plain }),
  copyItem: (id) => invoke('copy_item', { id }),
  togglePin: (id, isPinned) => invoke('toggle_pin', { id, isPinned }),
  reorderPinned: (ids) => invoke('reorder_pinned', { ids }),
  // A pinned item's name (IMP-07); null or blank clears it.
  setLabel: (id, label) => invoke('set_label', { id, label }),
  deleteItem: (id) => invoke('delete_item', { id }),
  undoDelete: (token) => invoke('undo_delete', { token }),
  commitDelete: (token) => invoke('commit_delete', { token }),
  clearHistory: () => invoke('clear_history'),
  // IMP-05: Rust runs the native panels and handles the file.
  exportBackup: () => invoke('export_backup'),
  importBackup: () => invoke('import_backup'),
  clearLearning: () => invoke('clear_learning'),
  learningSummary: () => invoke('learning_summary'),
  // Only the fields being changed; the rest stay as the store holds them.
  updateSettings: (patch) => invoke('update_settings', { settings: patch }),
  getImage: (id) => invoke('get_image', { id }),
  // The original picture, for the preview (the thumbnail past 4 MB).
  getFullImage: (id) => invoke('get_image', { id, full: true }),
  hidePanel: () => invoke('hide_panel'),
  // The preview beside the panel: which side has room, then widen/narrow.
  panelPreviewSide: () => invoke('panel_preview_side'),
  setPanelPreview: (side) => invoke('set_panel_preview', { side }),
  showPanel: () => invoke('show_panel'),
  openSettings: () => invoke('open_settings'),
  openAbout: () => invoke('open_about'),
  openRepository: () => invoke('open_repository'),
  openPrivacyPolicy: () => invoke('open_privacy_policy'),
  axStatus: () => invoke('ax_status'),
  requestAccessibility: () => invoke('request_accessibility'),
  openAccessibilitySettings: () => invoke('open_accessibility_settings'),
  // `openPanel`: «افتح رفّ» — Rust opens the panel only once the welcome is
  // marked done, then closes it (026 ج3).
  firstrunDone: (openPanel = false) => invoke('firstrun_done', { openPanel }),
  listRunningApps: () => invoke('list_running_apps'),
  checkForUpdate: () => invoke('check_for_update'),
  downloadAndInstallUpdate: () => invoke('download_and_install_update'),
  restartToUpdate: () => invoke('restart_to_update'),
  consumeUpdateIntent: () => invoke('consume_update_intent'),
  openUpdates: () => invoke('open_updates'),
  // Capture status actions shared by the panel strip, Settings and the menu.
  resumeCapture: () => invoke('resume_capture'),
  // In-app problem report: Rust builds, freezes, sends and copies.
  openReport: () => invoke('open_report'),
  reportPrepare: (kind, category, description) => invoke('report_prepare', { kind, category, description }),
  reportSend: () => invoke('report_send'),
  reportCopy: () => invoke('report_copy'),
  reportCopyNumber: (id) => invoke('report_copy_number', { id }),
  reportPickImage: () => invoke('report_pick_image'),
  reportPasteImage: () => invoke('report_paste_image'),
  reportRemoveImage: () => invoke('report_remove_image'),
  diagnosticsCopy: () => invoke('diagnostics_copy'),
  restartApp: () => invoke('restart_app'),
};

export const on = (event, handler) => listen(event, handler);
