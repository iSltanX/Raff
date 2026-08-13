//! The floating panel: a non-activating NSPanel (Spotlight-style) that floats
//! above everything, joins all Spaces, never steals focus from the app the
//! user is working in, and hides when it loses key status.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
use tauri_nspanel::{panel_delegate, ManagerExt, WebviewWindowExt};

use crate::storage::PanelPlacement;
use crate::{macos, AppState};

pub const PANEL_LABEL: &str = "panel";
/// Production width after optical QA at normal macOS scale. The 360px Figma
/// frame documents hierarchy, not a usable physical width for real clipboard
/// content. MUST stay in sync with `app.windows[0].width` in tauri.conf.json.
const PANEL_WIDTH: f64 = 560.0;
const PANEL_HEIGHT: f64 = 640.0;
const PANEL_EDGE_MARGIN: f64 = 12.0;
/// NSWindowStyleMaskNonActivatingPanel — the panel can become key (receive
/// keyboard) without activating the app that owns it.
const STYLE_MASK_NON_ACTIVATING_PANEL: i32 = 1 << 7;
/// Just above NSMainMenuWindowLevel (24), like Spotlight.
const PANEL_LEVEL: i32 = 25;

// Ignore startup movement events until the panel has received its deliberate
// first position. A short generation-based debounce keeps live dragging fluid
// without rewriting the placement file for every mouse-move event.
static PLACEMENT_READY: AtomicBool = AtomicBool::new(false);
static PLACEMENT_DEBOUNCE: OnceLock<Mutex<Option<std::sync::mpsc::Sender<()>>>> = OnceLock::new();

/// Milliseconds since the epoch at which the panel last hid itself because it
/// resigned key status — 0 means "never". Clicking the tray icon to CLOSE an
/// open panel routes the mouse-down through the status item first, which
/// AppKit reports to the panel as losing key status before Tauri's own
/// click-up reaches `toggle` below. Without this guard, `toggle` re-checks
/// visibility after that resign-triggered `hide` has already run, finds the
/// panel hidden, and immediately shows it again — the close the click asked
/// for is undone in the same gesture, so the click appears to do nothing
/// (or a second click is needed to see any visible effect at all).
static LAST_RESIGN_HIDE_MS: AtomicU64 = AtomicU64::new(0);
/// Comfortably above the AppKit resign-key -> Tauri click-up delivery gap
/// (single-digit to low double-digit milliseconds in practice), while short
/// enough that a deliberate, separate reopen click — which takes a human
/// noticeably longer to land after watching the panel close — is unaffected.
const RESIGN_REOPEN_GUARD_MS: u64 = 250;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn clamp_origin(origin: (f64, f64), window: (f64, f64), area: Rect, margin: f64) -> (f64, f64) {
    let min_x = area.x + margin;
    let min_y = area.y + margin;
    let max_x = (area.x + area.width - window.0 - margin).max(min_x);
    let max_y = (area.y + area.height - window.1 - margin).max(min_y);
    (origin.0.clamp(min_x, max_x), origin.1.clamp(min_y, max_y))
}

fn centered_origin(window: (f64, f64), area: Rect) -> (f64, f64) {
    (
        area.x + (area.width - window.0) / 2.0,
        area.y + (area.height - window.1) / 2.0,
    )
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window(PANEL_LABEL)
        .expect("panel window missing from tauri.conf.json");

    // No vibrancy: the product panel is an opaque semantic surface with a
    // 1px border and a 16px radius in both appearances,
    // all painted by CSS. A frosted NSVisualEffectView underneath would only
    // be visible at the corners, where its own radius never matched the CSS
    // shell's. The window stays `transparent: true` so the rounded CSS corners
    // are not clipped by a square opaque backing, and macOS draws the window
    // shadow the design mocks as `0 12px 24px rgba(0,0,0,.15)`.
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
        window_did_resign_key,
        window_did_move
    });
    let handle = app.clone();
    delegate.set_listener(Box::new(move |delegate_name: String| {
        match delegate_name.as_str() {
            "window_did_resign_key" => {
                LAST_RESIGN_HIDE_MS.store(now_ms(), Ordering::Release);
                hide(&handle);
            }
            // Once a Tauri window becomes NSPanel, Tao's ordinary Moved event is
            // not consistently forwarded. The native delegate is authoritative.
            "window_did_move" => remember_position(&handle),
            _ => {}
        }
    }));
    panel.set_delegate(delegate);
    Ok(())
}

/// Shows the panel at its last safe origin, or centred on first launch, while
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
            restore_or_center(&handle, &window);
            PLACEMENT_READY.store(true, Ordering::Release);
        }
        if let Ok(panel) = handle.get_webview_panel(PANEL_LABEL) {
            panel.show();
        }
        let _ = handle.emit_to(PANEL_LABEL, "panel://shown", ());
    });
}

/// Records a user drag without changing any NSPanel flags or window sizing.
/// Called by the NSPanel's native move delegate (and the ordinary Tauri event
/// stream as a fallback) after WebKit/Tauri has moved the panel.
pub fn remember_position(app: &AppHandle) {
    if !PLACEMENT_READY.load(Ordering::Acquire) {
        return;
    }
    let slot = PLACEMENT_DEBOUNCE.get_or_init(|| Mutex::new(None));
    let mut slot = slot.lock().unwrap();
    if slot.is_none() {
        let (tx, rx) = std::sync::mpsc::channel();
        *slot = Some(tx);
        let handle = app.clone();
        std::thread::spawn(move || loop {
            match rx.recv_timeout(Duration::from_millis(180)) {
                Ok(()) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let main_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || constrain_and_save(&main_handle));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        });
    }
    if let Some(tx) = slot.as_ref() {
        let _ = tx.send(());
    }
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
    let _ = app.run_on_main_thread(move || {
        let panel = match handle.get_webview_panel(PANEL_LABEL) {
            Ok(panel) => panel,
            Err(_) => return show(&handle),
        };
        if panel.is_visible() {
            panel.order_out(None);
            return;
        }
        // The panel is already hidden. If that happened moments ago because
        // it resigned key status, THIS click is almost certainly the same
        // gesture that caused it — the click landed on the tray icon while
        // the panel was open, closing it. Showing it again here would undo
        // that close instead of completing it. See `LAST_RESIGN_HIDE_MS`.
        if !was_just_dismissed_by_resign(now_ms(), LAST_RESIGN_HIDE_MS.load(Ordering::Acquire)) {
            show(&handle);
        }
    });
}

fn was_just_dismissed_by_resign(now_ms: u64, last_resign_hide_ms: u64) -> bool {
    last_resign_hide_ms != 0 && now_ms.saturating_sub(last_resign_hide_ms) < RESIGN_REOPEN_GUARD_MS
}

fn restore_or_center(app: &AppHandle, window: &tauri::WebviewWindow) {
    let saved = {
        let state = app.state::<AppState>();
        let placement = state.store.lock().unwrap().load_panel_placement();
        placement
    };
    let size = window
        .outer_size()
        .unwrap_or_else(|_| PhysicalSize::new(PANEL_WIDTH as u32, PANEL_HEIGHT as u32));
    let window_size = (size.width as f64, size.height as f64);

    // A saved window belongs to the monitor containing its centre. If that
    // monitor no longer exists, use the cursor's screen and clamp there.
    let saved_monitor = saved.and_then(|p| {
        app.monitor_from_point(p.x + window_size.0 / 2.0, p.y + window_size.1 / 2.0)
            .ok()
            .flatten()
    });
    let monitor = saved_monitor
        .or_else(|| {
            app.cursor_position()
                .ok()
                .and_then(|pos| app.monitor_from_point(pos.x, pos.y).ok().flatten())
        })
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };
    let work = monitor.work_area();
    let area = Rect {
        x: work.position.x as f64,
        y: work.position.y as f64,
        width: work.size.width as f64,
        height: work.size.height as f64,
    };
    let scale = monitor.scale_factor();
    let margin = PANEL_EDGE_MARGIN * scale;
    let requested = saved
        .map(|p| (p.x, p.y))
        .unwrap_or_else(|| centered_origin(window_size, area));
    let (x, y) = clamp_origin(requested, window_size, area, margin);
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn constrain_and_save(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let size = window
        .outer_size()
        .unwrap_or_else(|_| PhysicalSize::new(PANEL_WIDTH as u32, PANEL_HEIGHT as u32));
    let window_size = (size.width as f64, size.height as f64);

    // Prefer the monitor under the window centre; when the user releases the
    // pointer beyond a display edge, the pointer's monitor is the best target.
    let monitor = app
        .monitor_from_point(
            position.x as f64 + window_size.0 / 2.0,
            position.y as f64 + window_size.1 / 2.0,
        )
        .ok()
        .flatten()
        .or_else(|| {
            app.cursor_position()
                .ok()
                .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        })
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };

    let work = monitor.work_area();
    let area = Rect {
        x: work.position.x as f64,
        y: work.position.y as f64,
        width: work.size.width as f64,
        height: work.size.height as f64,
    };
    let corrected = clamp_origin(
        (position.x as f64, position.y as f64),
        window_size,
        area,
        PANEL_EDGE_MARGIN * monitor.scale_factor(),
    );
    let corrected = PhysicalPosition::new(corrected.0.round() as i32, corrected.1.round() as i32);
    if corrected != position {
        let _ = window.set_position(corrected);
    }

    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    store.save_panel_placement(PanelPlacement {
        x: corrected.x as f64,
        y: corrected.y as f64,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_first_position_in_visible_area() {
        let area = Rect {
            x: 0.0,
            y: 25.0,
            width: 1440.0,
            height: 875.0,
        };
        assert_eq!(centered_origin((560.0, 640.0), area), (440.0, 142.5));
    }

    #[test]
    fn restored_position_is_clamped_inside_positive_screen() {
        let area = Rect {
            x: 0.0,
            y: 25.0,
            width: 1440.0,
            height: 875.0,
        };
        assert_eq!(
            clamp_origin((1400.0, -80.0), (560.0, 640.0), area, 12.0),
            (868.0, 37.0)
        );
    }

    #[test]
    fn clamp_supports_monitors_left_of_primary() {
        let area = Rect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(
            clamp_origin((-2400.0, 900.0), (560.0, 640.0), area, 12.0),
            (-1908.0, 428.0)
        );
    }

    // A tray click that closes an open panel makes it resign key status
    // before the click-up reaches `toggle`; without this guard that same
    // click's `toggle` call sees the panel already hidden and reopens it,
    // so the close is silently undone and the click appears to do nothing.
    #[test]
    fn reopen_is_suppressed_immediately_after_a_resign_triggered_hide() {
        assert!(was_just_dismissed_by_resign(1_000, 900));
    }

    #[test]
    fn reopen_is_suppressed_right_up_to_the_guard_boundary() {
        assert!(was_just_dismissed_by_resign(
            900 + RESIGN_REOPEN_GUARD_MS - 1,
            900
        ));
    }

    #[test]
    fn reopen_proceeds_once_the_guard_window_has_fully_elapsed() {
        assert!(!was_just_dismissed_by_resign(
            900 + RESIGN_REOPEN_GUARD_MS,
            900
        ));
    }

    #[test]
    fn reopen_proceeds_for_an_unrelated_click_long_after_any_resign() {
        assert!(!was_just_dismissed_by_resign(50_000, 900));
    }

    #[test]
    fn reopen_is_never_suppressed_before_any_resign_has_happened() {
        // 0 is the static's initial value — "never resigned" — not a real
        // timestamp, so a fresh panel must be openable on its very first click.
        assert!(!was_just_dismissed_by_resign(50, 0));
    }
}
