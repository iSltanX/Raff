// Thin IPC layer over the audited Rust commands (withGlobalTauri).
// Outside Tauri (plain browser, design review) a mock serves the identity's
// sample items; inside the app `window.__TAURI__` always exists.

import { mockInvoke } from './mock.js';

const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : mockInvoke;
const listen = window.__TAURI__ ? window.__TAURI__.event.listen : () => Promise.resolve(() => {});

export const api = {
  getState: () => invoke('get_state'),
  pasteItem: (id, plain = false) => invoke('paste_item', { id, plain }),
  copyItem: (id) => invoke('copy_item', { id }),
  togglePin: (id) => invoke('toggle_pin', { id }),
  deleteItem: (id) => invoke('delete_item', { id }),
  clearHistory: () => invoke('clear_history'),
  clearLearning: () => invoke('clear_learning'),
  learningSummary: () => invoke('learning_summary'),
  updateSettings: (settings) => invoke('update_settings', { settings }),
  getImage: (id) => invoke('get_image', { id }),
  hidePanel: () => invoke('hide_panel'),
  axStatus: () => invoke('ax_status'),
  requestAccessibility: () => invoke('request_accessibility'),
  openAccessibilitySettings: () => invoke('open_accessibility_settings'),
  firstrunDone: () => invoke('firstrun_done'),
  listRunningApps: () => invoke('list_running_apps'),
  checkForUpdate: () => invoke('check_for_update'),
  downloadAndInstallUpdate: () => invoke('download_and_install_update'),
  restartToUpdate: () => invoke('restart_to_update'),
  consumeUpdateIntent: () => invoke('consume_update_intent'),
};

export const on = (event, handler) => listen(event, handler);
