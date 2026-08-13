//! Paste flow: hide the panel, restore the previously-frontmost app, write the
//! item to the pasteboard, then synthesize ⌘V (Accessibility permitting).
//! Without the permission the item still lands on the clipboard.

use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::ManagerExt;

use crate::storage::{now_ms, ItemKind};
use crate::{macos, panel, AppState};

/// How long we give macOS to move focus back before synthesizing ⌘V.
const ACTIVATE_DELAY_MS: u64 = 150;

/// Writes an item to the pasteboard. `plain` drops rich representations
/// ("لصق كنص عادي"). Returns false when the id is unknown.
pub fn write_item_to_clipboard(app: &AppHandle, id: &str, plain: bool) -> bool {
    let state = app.state::<AppState>();
    let (kind, text, html, rtf, png) = {
        let store = state.store.lock().unwrap();
        let Some(item) = store.find(id) else {
            return false;
        };
        let png = item
            .image_file
            .as_ref()
            .and_then(|f| std::fs::read(store.images_dir().join(f)).ok());
        if plain {
            (item.kind, item.text.clone(), None, None, png)
        } else {
            let rtf = item
                .rtf
                .as_ref()
                .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
            (item.kind, item.text.clone(), item.html.clone(), rtf, png)
        }
    };

    // Never turn a missing image file into a successful copy of its Arabic
    // metadata label. The user asked to copy the image itself.
    if kind == ItemKind::Image && png.is_none() {
        return false;
    }

    let is_image = png.is_some();
    let Some(new_count) = macos::write_clip(
        if is_image { None } else { Some(&text) },
        html.as_deref(),
        rtf.as_deref(),
        png.as_deref(),
    ) else {
        return false;
    };
    state
        .skip_change_count
        .store(new_count as i64, Ordering::SeqCst);
    true
}

/// Full paste: clipboard write + focus restore + ⌘V + silent learning signals.
/// The boolean distinguishes a real synthesized paste from clipboard-only
/// fallback, using a fresh Accessibility check instead of stale panel state.
pub async fn paste_item(app: &AppHandle, id: &str, plain: bool) -> Result<bool, String> {
    crate::startup_trace::mark(&format!("PASTE row_click_invoke id={id}"));
    if !write_item_to_clipboard(app, id, plain) {
        crate::startup_trace::mark("PASTE write_item_to_clipboard FAILED (unknown id)");
        return Err("العنصر غير موجود".into());
    }
    crate::startup_trace::mark("PASTE NSPasteboard write completed");

    let trusted = macos::ax_trusted();
    crate::startup_trace::mark(&format!("PASTE ax_trusted={trusted}"));
    if !trusted {
        crate::startup_trace::mark("PASTE STOPPED HERE: no Accessibility trust — panel stays visible, no hide, no activate, no paste");
        bump_paste_signals(app, id);
        return Ok(false);
    }

    let state = app.state::<AppState>();
    let previous_pid = state.previous_app.lock().unwrap().take();
    crate::startup_trace::mark(&format!("PASTE previous_pid={previous_pid:?}"));

    let handle = app.clone();
    let id = id.to_string();
    let worker = handle.clone();
    let attempt = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        worker
            .run_on_main_thread(move || {
                crate::startup_trace::mark("PASTE panel_hide requested");
                panel::hide(&handle);
                crate::startup_trace::mark(&format!(
                    "PASTE panel_hide done; panel.is_visible()={:?}",
                    handle.get_webview_panel(panel::PANEL_LABEL).map(|p| p.is_visible())
                ));
                if let Some(pid) = previous_pid {
                    crate::startup_trace::mark(&format!("PASTE activate_app requested pid={pid}"));
                    macos::activate_app(pid);
                    crate::startup_trace::mark("PASTE activate_app call returned");
                } else {
                    crate::startup_trace::mark("PASTE NO previous_pid to activate — previous_app was never captured or already consumed");
                }
                let frontmost_now = macos::frontmost_app();
                crate::startup_trace::mark(&format!(
                    "PASTE frontmost immediately after activate: pid={} bundle={}",
                    frontmost_now.pid, frontmost_now.bundle_id
                ));
                let handle2 = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ACTIVATE_DELAY_MS));
                    let front_before_paste = macos::frontmost_app();
                    crate::startup_trace::mark(&format!(
                        "PASTE frontmost after {ACTIVATE_DELAY_MS}ms wait: pid={} bundle={}",
                        front_before_paste.pid, front_before_paste.bundle_id
                    ));
                    let still_trusted = macos::ax_trusted();
                    let sent = if still_trusted { macos::send_cmd_v() } else { false };
                    crate::startup_trace::mark(&format!(
                        "PASTE CGEvent cmd-v: still_trusted={still_trusted} sent={sent}"
                    ));
                    let pasted = still_trusted && sent;
                    bump_paste_signals(&handle2, &id);
                    crate::startup_trace::mark(&format!("PASTE COMPLETE pasted={pasted}"));
                    let _ = tx.send(pasted);
                });
            })
            .map_err(|err| err.to_string())?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("تعذّر تنفيذ اللصق: {err}"))
    .and_then(|result| result.map_err(|err| format!("تعذّر تنفيذ اللصق: {err}")));

    let pasted = match attempt {
        Ok(pasted) => pasted,
        Err(err) => {
            crate::startup_trace::mark(&format!("PASTE ERROR {err} — reshowing panel"));
            panel::show(app);
            return Err(err);
        }
    };

    if !pasted {
        crate::startup_trace::mark("PASTE not pasted — reshowing panel");
        panel::show(app);
    }
    Ok(pasted)
}

fn bump_paste_signals(app: &AppHandle, id: &str) {
    bump_signals(app, id, |item| item.paste_count += 1);
}

/// Copying through رفّ (panel ⌘C, tray item click) is a usage signal exactly
/// like pasting — recorded explicitly instead of re-capturing our own write.
pub fn bump_copy_signals(app: &AppHandle, id: &str) {
    bump_signals(app, id, |item| item.copy_count += 1);
}

fn bump_signals(app: &AppHandle, id: &str, bump: impl Fn(&mut crate::storage::ClipItem)) {
    let state = app.state::<AppState>();
    let mut store = state.store.lock().unwrap();
    if let Err(err) = store.finish_pending_pin() {
        eprintln!("raff: usage signal deferred: {err}");
        return;
    }
    if !store.settings.learning_enabled {
        return;
    }
    let mut pinned_touched = false;
    let mut found = false;
    if let Some(item) = store.find_mut(id) {
        bump(item);
        item.last_used_at = now_ms();
        pinned_touched = item.is_pinned;
        found = true;
    }
    if !found {
        return;
    }
    if pinned_touched {
        store.save_pinned();
    } else {
        store.save_history();
    }
    drop(store);
    let _ = app.emit("raff://changed", ());
}
