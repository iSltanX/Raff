//! The floating panel: a non-activating NSPanel (Spotlight-style) that floats
//! above everything, joins all Spaces, never steals focus from the app the
//! user is working in, and hides when it loses key status.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
use tauri_nspanel::{panel_delegate, ManagerExt, WebviewWindowExt};

use crate::storage::PanelPlacement;
use crate::{macos, AppState};

pub const PANEL_LABEL: &str = "panel";
/// MUST stay in sync with `app.windows[0]` in tauri.conf.json.
const PANEL_WIDTH: f64 = 460.0;
const PANEL_HEIGHT: f64 = 540.0;
const PANEL_EDGE_MARGIN: f64 = 12.0;
/// NSWindowStyleMaskNonActivatingPanel — the panel can become key (receive
/// keyboard) without activating the app that owns it.
const STYLE_MASK_NON_ACTIVATING_PANEL: i32 = 1 << 7;
/// Just above NSMainMenuWindowLevel (24), like Spotlight.
const PANEL_LEVEL: i32 = 25;
/// The preview beside the panel (Figma «05 · التفاصيل» 45:5325): 340pt and a
/// 16pt gap. The panel window widens by this much towards the preview, so the
/// list never moves and hover, focus and keys stay in one page.
const PREVIEW_EXTRA: f64 = 356.0;

/// Where the preview opens: the reading end (left) when there is room.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewSide {
    Left,
    Right,
}

/// The side the window is widened to while the preview shows.
static PREVIEW: Mutex<Option<PreviewSide>> = Mutex::new(None);

fn preview_open() -> Option<PreviewSide> {
    *PREVIEW
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
/// Whether the panel is presented to the user. The window itself stays
/// ordered in (fully transparent and click-through) while "hidden" — see
/// `present` / `conceal` — so AppKit's `isVisible` no longer answers this.
static SHOWN: AtomicBool = AtomicBool::new(false);
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

/// Runs `work` on the AppKit main thread, as promptly as possible.
///
/// Every NSPanel call below has to happen on the main thread, and the callers
/// are split: the tray click handler and the NSPanel delegate are ALREADY on
/// it, while the clipboard monitor, the global-shortcut handler and the IPC
/// commands are not.
///
/// Handing the on-main callers to `run_on_main_thread` anyway is what made the
/// first tray click after a cold launch do nothing. That call always defers
/// through tao's event-loop proxy, which tao drains only while it is
/// processing events — and an accessory app showing no window is not. The
/// posted closure sat there until some unrelated event woke tao, at which
/// point everything that had piled up ran at once: the queued show, then the
/// next click's toggle, which promptly hid it again. Net effect on screen:
/// nothing, no matter how many times the icon was clicked.
///
/// So when we are already on the main thread, just do the work — correct and
/// immediate, with no queue in the path at all. Off-main callers go through
/// libdispatch, whose main queue AppKit always drains.
fn on_main<F: FnOnce() + Send + 'static>(work: F) {
    if macos::is_main_thread() {
        work();
    } else {
        macos::dispatch_to_main(work);
    }
}

fn clamp_origin(origin: (f64, f64), window: (f64, f64), area: Rect, margin: f64) -> (f64, f64) {
    let min_x = area.x + margin;
    let min_y = area.y + margin;
    let max_x = (area.x + area.width - window.0 - margin).max(min_x);
    let max_y = (area.y + area.height - window.1 - margin).max(min_y);
    (origin.0.clamp(min_x, max_x), origin.1.clamp(min_y, max_y))
}

/// The side with room for the preview beside `panel` (points), or none.
fn preview_side_for(panel: Rect, visible: Rect, extra: f64, margin: f64) -> Option<PreviewSide> {
    if panel.x - extra >= visible.x + margin {
        Some(PreviewSide::Left)
    } else if panel.x + panel.width + extra <= visible.x + visible.width - margin {
        Some(PreviewSide::Right)
    } else {
        None
    }
}

/// The window frame with the preview open on `side`: the panel stays put.
fn widened(frame: Rect, side: PreviewSide, extra: f64) -> Rect {
    match side {
        PreviewSide::Left => Rect {
            x: frame.x - extra,
            width: frame.width + extra,
            ..frame
        },
        PreviewSide::Right => Rect {
            width: frame.width + extra,
            ..frame
        },
    }
}

/// The panel's own frame again, from the widened one.
fn narrowed(frame: Rect, side: PreviewSide, extra: f64) -> Rect {
    match side {
        PreviewSide::Left => Rect {
            x: frame.x + extra,
            width: frame.width - extra,
            ..frame
        },
        PreviewSide::Right => Rect {
            width: frame.width - extra,
            ..frame
        },
    }
}

/// The x to remember for a window at `window_x` (physical px): the panel's,
/// which starts `PREVIEW_EXTRA` further right while the preview is on its left.
fn remembered_x(window_x: f64, preview: Option<PreviewSide>, scale: f64) -> f64 {
    match preview {
        Some(PreviewSide::Left) => window_x + PREVIEW_EXTRA * scale,
        _ => window_x,
    }
}

fn centered_origin(window: (f64, f64), area: Rect) -> (f64, f64) {
    (
        area.x + (area.width - window.0) / 2.0,
        area.y + (area.height - window.1) / 2.0,
    )
}

/// Runs `work` on the main thread and waits for its answer. The preview's
/// commands are synchronous, so Tauri already runs them on the main thread and
/// `on_main` runs `work` inline; the timeout only bounds an off-main caller,
/// whose `None` then reads as "no room" rather than a hang.
fn on_main_sync<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(move || {
        let _ = tx.send(work());
    });
    rx.recv_timeout(Duration::from_secs(2)).ok()
}

fn ns_window(window: &tauri::WebviewWindow) -> Option<*mut AnyObject> {
    window
        .ns_window()
        .ok()
        .map(|pointer| pointer as *mut AnyObject)
        .filter(|pointer| !pointer.is_null())
}

fn rect_from(native: NSRect) -> Rect {
    Rect {
        x: native.origin.x,
        y: native.origin.y,
        width: native.size.width,
        height: native.size.height,
    }
}

/// The window's frame, in AppKit points. Only x and width ever change, so the
/// bottom-left origin needs no conversion.
fn native_frame(ns: *mut AnyObject) -> Rect {
    // SAFETY: `ns` is the panel's live NSWindow, used on the main thread.
    let frame: NSRect = unsafe { msg_send![&*ns, frame] };
    rect_from(frame)
}

/// The visible frame of the window's screen — needed to widen, never to
/// narrow back (a window between screens has none for a moment).
fn native_visible_frame(ns: *mut AnyObject) -> Option<Rect> {
    // SAFETY: as above.
    unsafe {
        let screen: *mut AnyObject = msg_send![&*ns, screen];
        if screen.is_null() {
            return None;
        }
        let visible: NSRect = msg_send![&*screen, visibleFrame];
        Some(rect_from(visible))
    }
}

/// One `setFrame:` — origin and width together — so the panel never jumps.
fn set_native_frame(ns: *mut AnyObject, frame: Rect) {
    let native = NSRect::new(
        NSPoint::new(frame.x, frame.y),
        NSSize::new(frame.width, frame.height),
    );
    // SAFETY: as above.
    unsafe {
        let _: () = msg_send![&*ns, setFrame: native, display: true];
    }
}

/// The side with room for the preview beside the panel, or none. While it is
/// open, the side it already has.
pub fn preview_side(app: &AppHandle) -> Option<PreviewSide> {
    let window = app.get_webview_window(PANEL_LABEL)?;
    on_main_sync(move || {
        // Hidden, the panel previews nothing: it is still under the pointer
        // (transparent), and the window must not widen unseen.
        if !SHOWN.load(Ordering::Acquire) {
            return None;
        }
        if let Some(open) = preview_open() {
            return Some(open);
        }
        let ns = ns_window(&window)?;
        preview_side_for(
            native_frame(ns),
            native_visible_frame(ns)?,
            PREVIEW_EXTRA,
            PANEL_EDGE_MARGIN,
        )
    })
    .flatten()
}

/// Widens the panel window towards `side` for the preview, or narrows it back.
pub fn set_preview(app: &AppHandle, side: Option<PreviewSide>) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let _ = on_main_sync(move || apply_preview(&window, side));
}

fn apply_preview(window: &tauri::WebviewWindow, side: Option<PreviewSide>) {
    let current = preview_open();
    if current == side || (side.is_some() && !SHOWN.load(Ordering::Acquire)) {
        return;
    }
    let Some(ns) = ns_window(window) else {
        return;
    };
    let frame = native_frame(ns);
    let panel = match current {
        Some(open) => narrowed(frame, open, PREVIEW_EXTRA),
        None => frame,
    };
    let target = match side {
        Some(open) => widened(panel, open, PREVIEW_EXTRA),
        None => panel,
    };
    // Recorded before the frame changes: moving the window reaches
    // `remember_position`, which must already know where the panel is.
    *PREVIEW
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = side;
    set_native_frame(ns, target);
}

/// The panel closes with its preview; it always reopens at its own size.
fn collapse_preview(app: &AppHandle) {
    if preview_open().is_none() {
        return;
    }
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        apply_preview(&window, None);
    }
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window(PANEL_LABEL)
        .expect("panel window missing from tauri.conf.json");

    // Flat: no native material and no window shadow (tauri.conf.json). The
    // window is transparent only so the opaque CSS surface keeps its 16pt
    // corners; a 1px line, not a shadow, separates it from what is behind.
    let panel = window.to_panel()?;
    guard_key_status();
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
                let stamp = resign_stamp(
                    SHOWN.load(Ordering::Acquire),
                    now_ms(),
                    LAST_RESIGN_HIDE_MS.load(Ordering::Acquire),
                );
                LAST_RESIGN_HIDE_MS.store(stamp, Ordering::Release);
                hide(&handle);
            }
            // Once a Tauri window becomes NSPanel, Tao's ordinary Moved event is
            // not consistently forwarded. The native delegate is authoritative.
            "window_did_move" => remember_position(&handle),
            _ => {}
        }
    }));
    panel.set_delegate(delegate);

    // Keep the web content live between openings. An ordered-out window makes
    // WebKit suspend its content process; on macOS 27 the resumed process does
    // not composite again until some unrelated event arrives, so the panel
    // opened blank and only "appeared" after the next click. Instead the panel
    // stays ordered in, transparent and click-through, and WebKit is told not
    // to throttle it for being occluded. Opening is then a single alpha change.
    let _ = window.with_webview(|webview| unsafe {
        let view = webview.inner() as *mut objc2::runtime::AnyObject;
        if view.is_null() {
            return;
        }
        let selector = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
        let responds: bool = objc2::msg_send![view, respondsToSelector: selector];
        if responds {
            let _: () = objc2::msg_send![view, _setWindowOcclusionDetectionEnabled: false];
        }
    });
    conceal(&panel);
    panel.order_front_regardless();
    Ok(())
}

/// Whether the panel may take the key: only while it is shown (ت٤٧).
fn accepts_key(shown: bool) -> bool {
    shown
}

/// Hidden, the panel stays ordered in (see `init`), and `RawNSPanel` answers
/// `canBecomeKeyWindow` with YES whatever its state. So when another رفّ
/// window closed, AppKit handed the invisible panel the key, and what the
/// user typed next went into its search field. Its answer now follows
/// `SHOWN`. Only that class changes: its own method is replaced, never one
/// it inherits from NSPanel or NSWindow. Installing twice is harmless.
fn guard_key_status() {
    use objc2::runtime::{AnyClass, Bool, Imp, Sel};

    extern "C-unwind" fn can_become_key(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::new(accepts_key(SHOWN.load(Ordering::Acquire)))
    }
    let selector = objc2::sel!(canBecomeKeyWindow);
    let Some(class) = AnyClass::get(c"RawNSPanel") else {
        eprintln!("raff: RawNSPanel is not defined; the hidden panel can take the key");
        return;
    };
    let methods = class.instance_methods();
    let Some(method) = methods.iter().find(|method| method.name() == selector) else {
        eprintln!("raff: RawNSPanel has no canBecomeKeyWindow of its own; left as it is");
        return;
    };
    // SAFETY: the replacement has the replaced method's signature,
    // `- (BOOL)canBecomeKeyWindow` — (id, SEL) -> BOOL — and reads only an
    // atomic, so any thread AppKit asks from is fine.
    unsafe {
        let imp: Imp = std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel) -> Bool, Imp>(
            can_become_key,
        );
        method.set_implementation(imp);
    }
}

/// Whether, after a رفّ window other than the panel closed, the app the user
/// came from should take the front back: رفّ is still the active app, no
/// window of it has the key, and the panel is not open. Typing would
/// otherwise go nowhere (ت٤٧).
fn should_hand_back(app_active: bool, has_key_window: bool, panel_shown: bool) -> bool {
    app_active && !has_key_window && !panel_shown
}

/// Called when a رفّ window other than the panel leaves the screen. AppKit
/// gives the key to another رفّ window if one is left; the panel no longer
/// takes it while hidden. With none left, the app the user was in takes the
/// front back, so the next keystroke lands where they can see it.
pub fn after_window_closed() {
    // The next turn of the main queue: the close has finished by then, and
    // AppKit has picked the next key window, if any.
    macos::dispatch_to_main(|| {
        let (active, has_key_window) = macos::app_focus();
        if should_hand_back(active, has_key_window, SHOWN.load(Ordering::Acquire)) {
            crate::startup_trace::mark("FOCUS_HANDED_BACK");
            macos::hand_focus_back();
        }
    });
}

/// Presents the (already ordered-in) panel and gives it keyboard focus.
fn present(panel: &tauri_nspanel::raw_nspanel::RawNSPanel) {
    // Before `show`, which makes the panel key: it may take the key only
    // while shown (`guard_key_status`).
    SHOWN.store(true, Ordering::Release);
    panel.set_ignore_mouse_events(false);
    panel.set_alpha_value(1.0);
    panel.show();
}

/// Hides the panel without ordering it out: transparent, click-through, and
/// no longer key, so keystrokes return to the app underneath.
fn conceal(panel: &tauri_nspanel::raw_nspanel::RawNSPanel) {
    SHOWN.store(false, Ordering::Release);
    panel.set_alpha_value(0.0);
    panel.set_ignore_mouse_events(true);
    // orderOut drops key status; ordering straight back in keeps the window on
    // screen (invisible) so WebKit never suspends it.
    panel.order_out(None);
    panel.order_front_regardless();
}

/// Shows the panel at its last safe origin, or centred on first launch, while
/// remembering the frontmost app so paste can restore focus to it.
/// Callable from any thread — NSPanel work runs on the main thread.
pub fn show(app: &AppHandle) {
    crate::startup_trace::mark("panel_show_called");
    let handle = app.clone();
    on_main(move || {
        crate::startup_trace::mark("panel_show_ON_MAIN_THREAD");
        let front = macos::frontmost_app();
        {
            let state = handle.state::<AppState>();
            *crate::lock_previous_app(&state.previous_app) = Some(front.pid);
        }

        collapse_preview(&handle);
        if let Some(window) = handle.get_webview_window(PANEL_LABEL) {
            restore_or_center(&handle, &window);
            PLACEMENT_READY.store(true, Ordering::Release);
        }
        if let Ok(panel) = handle.get_webview_panel(PANEL_LABEL) {
            present(&panel);
            crate::startup_trace::mark("PANEL_VISIBLE");
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
    let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        let (tx, rx) = std::sync::mpsc::channel();
        *slot = Some(tx);
        let handle = app.clone();
        std::thread::spawn(move || loop {
            match rx.recv_timeout(Duration::from_millis(180)) {
                Ok(()) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let main_handle = handle.clone();
                    on_main(move || constrain_and_save(&main_handle));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        });
    }
    if let Some(tx) = slot.as_ref() {
        let _ = tx.send(());
    }
}

/// Hides a shown panel and tells its page. The page cannot tell a concealed
/// panel from a blurred one by itself, so without `panel://hidden` it kept
/// fetching and rebuilding the list on every copy, for nobody (F-HIDDEN).
fn hide_shown(handle: &AppHandle, panel: &tauri_nspanel::raw_nspanel::RawNSPanel) {
    collapse_preview(handle);
    conceal(panel);
    let _ = handle.emit_to(PANEL_LABEL, "panel://hidden", ());
}

pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    on_main(move || {
        if let Ok(panel) = handle.get_webview_panel(PANEL_LABEL) {
            if SHOWN.load(Ordering::Acquire) {
                hide_shown(&handle, &panel);
            }
        }
    });
}

pub fn toggle(app: &AppHandle) {
    let handle = app.clone();
    on_main(move || {
        let panel = match handle.get_webview_panel(PANEL_LABEL) {
            Ok(panel) => panel,
            Err(_) => return show(&handle),
        };
        if SHOWN.load(Ordering::Acquire) {
            hide_shown(&handle, &panel);
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

/// When the panel resigns key status, the moment to remember — only if that
/// resignation hid a visible panel. Hidden, it used to become key when
/// another رفّ window closed and lose it to the very click on the icon; that
/// click closed nothing and must open the panel. It no longer takes the key
/// while hidden (`guard_key_status`); the stamp stays the second guard.
fn resign_stamp(shown: bool, now_ms: u64, previous_ms: u64) -> u64 {
    if shown {
        now_ms
    } else {
        previous_ms
    }
}

fn was_just_dismissed_by_resign(now_ms: u64, last_resign_hide_ms: u64) -> bool {
    last_resign_hide_ms != 0 && now_ms.saturating_sub(last_resign_hide_ms) < RESIGN_REOPEN_GUARD_MS
}

fn restore_or_center(app: &AppHandle, window: &tauri::WebviewWindow) {
    let saved = {
        let state = app.state::<AppState>();
        let placement = crate::lock_store(&state.store).load_panel_placement();
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
    let store = crate::lock_store(&state.store);
    store.save_panel_placement(PanelPlacement {
        x: remembered_x(corrected.x as f64, preview_open(), monitor.scale_factor()),
        y: corrected.y as f64,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ت٤٧ ─────────────────────────────────────────────────────────────────

    #[test]
    fn the_hidden_panel_cannot_take_the_key() {
        use objc2::runtime::{AnyClass, Bool};
        use tauri_nspanel::objc_foundation::INSObject;
        // `to_panel` defines the class the same way, on first use.
        let _ = tauri_nspanel::raw_nspanel::RawNSPanel::class();
        let window = AnyClass::get(c"NSWindow").unwrap();
        let window_answer = window
            .instance_method(objc2::sel!(canBecomeKeyWindow))
            .unwrap()
            .implementation();
        guard_key_status();
        guard_key_status(); // installing twice changes nothing

        let class = AnyClass::get(c"RawNSPanel").unwrap();
        // Never initialised: only its answer is asked, which reads no state.
        let panel: *mut AnyObject = unsafe { msg_send![class, alloc] };
        let asks = |shown: bool| {
            SHOWN.store(shown, Ordering::Release);
            let answer: Bool = unsafe { msg_send![panel, canBecomeKeyWindow] };
            answer.as_bool()
        };
        assert!(!asks(false), "hidden, it does not take the key");
        assert!(asks(true), "shown, it does");
        SHOWN.store(false, Ordering::Release);
        // Runtime IMPs, not Rust functions: their addresses are the identity.
        let window_answer_now = window
            .instance_method(objc2::sel!(canBecomeKeyWindow))
            .unwrap()
            .implementation();
        assert!(
            std::ptr::fn_addr_eq(window_answer_now, window_answer),
            "no other window class is touched"
        );
    }

    #[test]
    fn the_key_follows_whether_the_panel_is_shown() {
        assert!(accepts_key(true));
        assert!(!accepts_key(false));
    }

    #[test]
    fn rff_steps_aside_only_when_nothing_of_it_is_left_to_type_into() {
        // (active, a window has the key, panel shown) → hand back
        assert!(
            should_hand_back(true, false, false),
            "active, nothing to type into"
        );
        assert!(
            !should_hand_back(true, true, false),
            "another رفّ window took the key"
        );
        assert!(!should_hand_back(true, false, true), "the panel is open");
        assert!(
            !should_hand_back(false, false, false),
            "the front is already elsewhere"
        );
    }

    #[test]
    fn centers_first_position_in_visible_area() {
        let area = Rect {
            x: 0.0,
            y: 25.0,
            width: 1440.0,
            height: 875.0,
        };
        assert_eq!(centered_origin((460.0, 540.0), area), (490.0, 192.5));
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

    // The preview (Figma «05 · التفاصيل» 45:5325) opens at the reading end —
    // the left — when there is room, otherwise on the right, otherwise not.
    #[test]
    fn the_preview_prefers_the_left_and_falls_back_to_the_right() {
        let visible = Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 875.0,
        };
        let centred = Rect {
            x: 490.0,
            y: 167.0,
            width: 460.0,
            height: 540.0,
        };
        assert_eq!(
            preview_side_for(centred, visible, PREVIEW_EXTRA, 12.0),
            Some(PreviewSide::Left)
        );
        let at_left_edge = Rect { x: 12.0, ..centred };
        assert_eq!(
            preview_side_for(at_left_edge, visible, PREVIEW_EXTRA, 12.0),
            Some(PreviewSide::Right)
        );
        let narrow = Rect {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 875.0,
        };
        let middle = Rect {
            x: 170.0,
            ..centred
        };
        assert_eq!(preview_side_for(middle, narrow, PREVIEW_EXTRA, 12.0), None);
    }

    #[test]
    fn widening_keeps_the_panel_where_it_is() {
        let frame = Rect {
            x: 490.0,
            y: 167.0,
            width: 460.0,
            height: 540.0,
        };
        let left = widened(frame, PreviewSide::Left, PREVIEW_EXTRA);
        assert_eq!(
            left,
            Rect {
                x: 134.0,
                y: 167.0,
                width: 816.0,
                height: 540.0
            }
        );
        assert_eq!(
            left.x + left.width,
            frame.x + frame.width,
            "the panel's right edge stays put"
        );
        let right = widened(frame, PreviewSide::Right, PREVIEW_EXTRA);
        assert_eq!(
            right,
            Rect {
                width: 816.0,
                ..frame
            }
        );
        for side in [PreviewSide::Left, PreviewSide::Right] {
            assert_eq!(
                narrowed(widened(frame, side, PREVIEW_EXTRA), side, PREVIEW_EXTRA),
                frame
            );
        }
    }

    // Dragged while the preview is open, the window starts left of the panel;
    // the place to remember is the panel's own.
    #[test]
    fn the_remembered_place_is_the_panel_not_the_widened_window() {
        assert_eq!(remembered_x(268.0, Some(PreviewSide::Left), 2.0), 980.0);
        assert_eq!(remembered_x(980.0, Some(PreviewSide::Right), 2.0), 980.0);
        assert_eq!(remembered_x(980.0, None, 2.0), 980.0);
    }

    // The guard exists for the click that closes an OPEN panel. A panel that
    // was already hidden and merely lost key status (it can become key while
    // invisible, e.g. when Settings closes) closed nothing — the next click
    // on the icon must open it (live review, 2026-10-21).
    #[test]
    fn only_a_visible_panel_resigning_arms_the_reopen_guard() {
        assert_eq!(resign_stamp(true, 5_000, 900), 5_000);
        assert_eq!(resign_stamp(false, 5_000, 900), 900);
        assert!(!was_just_dismissed_by_resign(
            5_010,
            resign_stamp(false, 5_000, 0)
        ));
        assert!(was_just_dismissed_by_resign(
            5_010,
            resign_stamp(true, 5_000, 0)
        ));
    }

    #[test]
    fn reopen_is_never_suppressed_before_any_resign_has_happened() {
        // 0 is the static's initial value — "never resigned" — not a real
        // timestamp, so a fresh panel must be openable on its very first click.
        assert!(!was_just_dismissed_by_resign(50, 0));
    }
}
