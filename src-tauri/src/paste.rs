//! Paste flow: hide the panel, restore the previously-frontmost app, write the
//! item to the pasteboard, then synthesize ⌘V (Accessibility permitting).
//! Without the permission the item still lands on the clipboard.

use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{now_ms, ItemKind};
use crate::{macos, panel, AppState};

/// How long we give macOS to move focus back before synthesizing ⌘V.
const ACTIVATE_DELAY_MS: u64 = 150;

/// Writes an item to the pasteboard. `plain` drops rich representations
/// ("لصق كنص عادي"). Returns false when the id is unknown.
pub fn write_item_to_clipboard(app: &AppHandle, id: &str, plain: bool) -> bool {
    let state = app.state::<AppState>();
    let (text, html, rtf, png) = {
        let store = state.store.lock().unwrap();
        let Some(item) = store.find(id) else {
            return false;
        };
        let png = item
            .image_file
            .as_ref()
            .and_then(|f| std::fs::read(store.images_dir().join(f)).ok());
        if plain {
            (item.text.clone(), None, None, png)
        } else {
            let rtf = item
                .rtf
                .as_ref()
                .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
            (item.text.clone(), item.html.clone(), rtf, png)
        }
    };

    let is_image = png.is_some();
    let new_count = macos::write_clip(
        if is_image { None } else { Some(&text) },
        html.as_deref(),
        rtf.as_deref(),
        png.as_deref(),
    );
    state
        .skip_change_count
        .store(new_count as i64, Ordering::SeqCst);
    true
}

/// Full paste: clipboard write + focus restore + ⌘V + silent learning signals.
pub fn paste_item(app: &AppHandle, id: &str, plain: bool) {
    if !write_item_to_clipboard(app, id, plain) {
        return;
    }

    let state = app.state::<AppState>();
    let previous_pid = state.previous_app.lock().unwrap().take();

    let handle = app.clone();
    let id = id.to_string();
    // AppKit work (panel + activation) belongs on the main thread; the delay
    // and keystroke happen on a background thread so nothing blocks the UI.
    let _ = app.run_on_main_thread(move || {
        panel::hide(&handle);
        if let Some(pid) = previous_pid {
            macos::activate_app(pid);
        }
        let handle2 = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ACTIVATE_DELAY_MS));
            if macos::ax_trusted() {
                macos::send_cmd_v();
            }
            bump_paste_signals(&handle2, &id);
        });
    });
}

fn bump_paste_signals(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let mut store = state.store.lock().unwrap();
    if !store.settings.learning_enabled {
        return;
    }
    let mut pinned_touched = false;
    if let Some(item) = store.find_mut(id) {
        item.paste_count += 1;
        item.last_used_at = now_ms();
        pinned_touched = item.is_pinned;
    }
    if pinned_touched {
        store.save_pinned();
    } else {
        store.save_history();
    }
    drop(store);
    let _ = app.emit("raff://changed", ());
}

/// Kind of a stored item, used by the tray to label image entries.
pub fn item_kind(app: &AppHandle, id: &str) -> Option<ItemKind> {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    store.find(id).map(|i| i.kind)
}
