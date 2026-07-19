//! The floating panel: a non-activating NSPanel (Spotlight-style) that floats
//! above everything, joins all Spaces, never steals focus from the app the
//! user is working in, and hides when it loses key status.

use tauri::{AppHandle, Emitter, LogicalPosition, Manager};
use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
use tauri_nspanel::{panel_delegate, ManagerExt, WebviewWindowExt};
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

use crate::{macos, AppState};

pub const PANEL_LABEL: &str = "panel";
const PANEL_WIDTH: f64 = 392.0;
/// NSWindowStyleMaskNonActivatingPanel — the panel can become key (receive
/// keyboard) without activating the app that owns it.
const STYLE_MASK_NON_ACTIVATING_PANEL: i32 = 1 << 7;
/// Just above NSMainMenuWindowLevel (24), like Spotlight.
const PANEL_LEVEL: i32 = 25;

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window(PANEL_LABEL)
        .expect("panel window missing from tauri.conf.json");

    // Native frosted glass behind the webview (the CSS tint sits on top).
    let _ = apply_vibrancy(
        &window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        Some(14.0),
    );

    let panel = window.to_panel()?;
    panel.set_level(PANEL_LEVEL);
    panel.set_style_mask(STYLE_MASK_NON_ACTIVATING_PANEL);
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary,
    );
    panel.set_hides_on_deactivate(false);

    let delegate = panel_delegate!(RaffPanelDelegate {
        window_did_resign_key
    });
    let handle = app.clone();
    delegate.set_listener(Box::new(move |delegate_name: String| {
        if delegate_name.as_str() == "window_did_resign_key" {
            hide(&handle);
        }
    }));
    panel.set_delegate(delegate);
    Ok(())
}

/// Shows the panel centered on the screen the cursor is on (Spotlight-style),
/// remembering the frontmost app so paste can restore focus to it.
/// Callable from any thread — NSPanel work runs on the main thread.
pub fn show(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let front = macos::frontmost_app();
        {
            let state = handle.state::<AppState>();
            *state.previous_app.lock().unwrap() = Some(front.pid);
        }

        if let Some(window) = handle.get_webview_window(PANEL_LABEL) {
            position_on_cursor_screen(&handle, &window);
        }
        if let Ok(panel) = handle.get_webview_panel(PANEL_LABEL) {
            panel.show();
        }
        let _ = handle.emit_to(PANEL_LABEL, "panel://shown", ());
    });
}

pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = handle.get_webview_panel(PANEL_LABEL) {
            if panel.is_visible() {
                panel.order_out(None);
            }
        }
    });
}

pub fn toggle(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || match handle.get_webview_panel(PANEL_LABEL) {
        Ok(panel) if panel.is_visible() => {
            panel.order_out(None);
        }
        _ => show(&handle),
    });
}

fn position_on_cursor_screen(app: &AppHandle, window: &tauri::WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|pos| app.monitor_from_point(pos.x, pos.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    let x = pos.x + (size.width - PANEL_WIDTH) / 2.0;
    let y = pos.y + size.height * 0.22;
    let _ = window.set_position(LogicalPosition::new(x, y));
}
