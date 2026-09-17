//! Menu-bar presence, built directly on NSStatusItem.
//!
//!   * primary click   → toggle the panel
//!   * secondary click → the application menu
//!
//! The status item's own button receives the click through target/action.
//! macOS 27 no longer routes mouse events to overlay subviews inside a status
//! bar button, which is how the generic tray-icon crate listens — there the
//! left click never arrived and the panel could not be opened from the icon.
//! Target/action is the documented AppKit path and behaves the same on every
//! supported macOS release.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{define_class, msg_send, sel, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSEventMask, NSEventModifierFlags, NSEventType, NSImage, NSMenu, NSMenuItem,
    NSStatusBar, NSStatusItem, NSVariableStatusItemLength,
};
use objc2_foundation::{MainThreadMarker, NSData, NSPoint, NSSize, NSString};
use tauri::{AppHandle, Manager};

use crate::{commands, panel};

static APP: OnceLock<AppHandle> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "RaffStatusTarget"]
    struct StatusTarget;

    unsafe impl NSObjectProtocol for StatusTarget {}

    impl StatusTarget {
        #[unsafe(method(statusItemClicked:))]
        fn status_item_clicked(&self, _sender: Option<&AnyObject>) {
            let mtm = MainThreadMarker::from(self);
            let secondary = NSApplication::sharedApplication(mtm)
                .currentEvent()
                .is_some_and(|event| {
                    event.r#type() == NSEventType::RightMouseUp
                        || event.modifierFlags().contains(NSEventModifierFlags::Control)
                });
            if secondary {
                show_menu(mtm);
            } else if let Some(app) = APP.get() {
                crate::startup_trace::mark("TRAY_CLICK_RECEIVED");
                panel::toggle(app);
            }
        }

        #[unsafe(method(skipNextCopy:))]
        fn skip_next_copy(&self, _sender: Option<&AnyObject>) {
            set_pause(crate::Pause::SkipNext);
        }

        #[unsafe(method(pauseFifteen:))]
        fn pause_fifteen(&self, _sender: Option<&AnyObject>) {
            set_pause(crate::Pause::for_minutes(Some(15)));
        }

        #[unsafe(method(pauseHour:))]
        fn pause_hour(&self, _sender: Option<&AnyObject>) {
            set_pause(crate::Pause::for_minutes(Some(60)));
        }

        #[unsafe(method(pauseUntilRestart:))]
        fn pause_until_restart(&self, _sender: Option<&AnyObject>) {
            set_pause(crate::Pause::for_minutes(None));
        }

        #[unsafe(method(resumeCapture:))]
        fn resume_capture(&self, _sender: Option<&AnyObject>) {
            set_pause(crate::Pause::Off);
        }

        #[unsafe(method(openSettings:))]
        fn open_settings(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP.get() {
                commands::open_settings_window(app);
            }
        }

        #[unsafe(method(checkUpdates:))]
        fn check_updates(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP.get() {
                crate::updater::request_check_from_menu(app);
            }
        }

        #[unsafe(method(openAbout:))]
        fn open_about(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP.get() {
                commands::open_about_window(app);
            }
        }

        #[unsafe(method(quitApp:))]
        fn quit_app(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP.get() {
                app.exit(0);
            }
        }
    }
);

struct Native {
    item: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
    _capture_menu: Retained<NSMenu>,
    _target: Retained<StatusTarget>,
}

/// Applies a pause and lets the icon show it. The state lives in `AppState`,
/// never in the saved settings: it must not outlive the session.
fn set_pause(next: crate::Pause) {
    let Some(app) = APP.get() else { return };
    let state = app.state::<crate::AppState>();
    let active = {
        let mut pause = crate::lock_pause(&state.pause);
        *pause = next;
        pause.is_active()
    };
    note_paused(active);
}

thread_local! {
    // Lives for the whole process on the main thread; AppKit objects are not Send.
    static NATIVE: std::cell::OnceCell<Native> = const { std::cell::OnceCell::new() };
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Ok(());
    };
    if APP.set(app.clone()).is_err() {
        return Ok(()); // exactly one status item per process
    }

    let target: Retained<StatusTarget> = unsafe { msg_send![mtm.alloc::<StatusTarget>(), init] };
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);

    if let Some(button) = item.button(mtm) {
        let data = NSData::with_bytes(include_bytes!("../icons/tray.png"));
        if let Some(image) = NSImage::initWithData(mtm.alloc(), &data) {
            image.setTemplate(true);
            image.setSize(NSSize::new(18.0, 18.0));
            button.setImage(Some(&image));
        }
        button.setToolTip(Some(&NSString::from_str("رفّ")));
        unsafe {
            button.setTarget(Some(&target));
            button.setAction(Some(sel!(statusItemClicked:)));
        }
        button.sendActionOn(NSEventMask::LeftMouseUp | NSEventMask::RightMouseUp);
    }

    let menu = NSMenu::new(mtm);
    let entry = |title: &str, action, key: &str| {
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc(),
                &NSString::from_str(title),
                Some(action),
                &NSString::from_str(key),
            )
        };
        unsafe { item.setTarget(Some(&target)) };
        menu.addItem(&item);
    };
    // Pausing lives one level down: it is four choices, and the menu is four
    // items. The icon is what says a pause is running, not this list.
    let capture_menu = NSMenu::new(mtm);
    let capture_entry = |title: &str, action| {
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc(),
                &NSString::from_str(title),
                Some(action),
                &NSString::from_str(""),
            )
        };
        unsafe { item.setTarget(Some(&target)) };
        capture_menu.addItem(&item);
    };
    capture_entry("تجاهل النسخة التالية", sel!(skipNextCopy:));
    capture_entry("إيقاف ١٥ دقيقة", sel!(pauseFifteen:));
    capture_entry("إيقاف ساعة", sel!(pauseHour:));
    capture_entry("إيقاف حتى إعادة التشغيل", sel!(pauseUntilRestart:));
    capture_menu.addItem(&NSMenuItem::separatorItem(mtm));
    capture_entry("استئناف الالتقاط", sel!(resumeCapture:));

    let capture_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str("الالتقاط"),
            None,
            &NSString::from_str(""),
        )
    };
    capture_item.setSubmenu(Some(&capture_menu));
    menu.addItem(&capture_item);
    menu.addItem(&NSMenuItem::separatorItem(mtm));

    entry("الإعدادات…", sel!(openSettings:), ",");
    entry("التحقق من التحديثات…", sel!(checkUpdates:), "");
    entry("عن رفّ", sel!(openAbout:), "");
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    entry("إنهاء", sel!(quitApp:), "q");

    NATIVE.with(|cell| {
        let _ = cell.set(Native {
            item,
            menu,
            _capture_menu: capture_menu,
            _target: target,
        });
    });
    Ok(())
}

/// Full strength. Anything lower has to stay readable as "still here, just not
/// doing its job" — a template image at 0.45 reads as inactive the way a
/// disabled menu item does, without adding a glyph, a colour or a badge.
const MUTED_ALPHA: f64 = 0.45;

/// What the icon has to say about itself, worst first. Capture being dead
/// outranks a missing permission: one means nothing is saved at all, the other
/// only that the last step is manual.
static CAPTURE_STOPPED: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);
static PERMISSION_MISSING: AtomicBool = AtomicBool::new(false);

/// The capture loop gave up and will not come back this session.
pub fn note_capture_stopped() {
    if !CAPTURE_STOPPED.swap(true, Ordering::SeqCst) {
        apply_quiet_state();
    }
}

/// Capture is being held off on purpose, or is not any more.
pub fn note_paused(paused: bool) {
    if PAUSED.swap(paused, Ordering::SeqCst) != paused {
        apply_quiet_state();
    }
}

/// The current Accessibility answer. Cheap to call repeatedly: it touches the
/// menu bar only when the answer actually changed.
pub fn note_permission(trusted: bool) {
    if PERMISSION_MISSING.swap(!trusted, Ordering::SeqCst) == trusted {
        apply_quiet_state();
    }
}

/// Quietly reflects the worst standing condition in the menu bar.
///
/// The icon is the only surface a menu-bar app always has. A capture that died
/// or a permission that was never granted is otherwise invisible until the
/// user opens Settings and thinks to look — which is exactly what nobody does.
fn apply_quiet_state() {
    let reason = if CAPTURE_STOPPED.load(Ordering::SeqCst) {
        Some("الالتقاط متوقف".to_string())
    } else if PAUSED.load(Ordering::SeqCst) {
        Some("الالتقاط موقوف مؤقتًا".to_string())
    } else if PERMISSION_MISSING.load(Ordering::SeqCst) {
        Some("اللصق التلقائي معطّل".to_string())
    } else {
        None
    };
    crate::macos::dispatch_to_main(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        NATIVE.with(|cell| {
            let Some(native) = cell.get() else { return };
            let Some(button) = native.item.button(mtm) else {
                return;
            };
            match &reason {
                Some(reason) => {
                    button.setAlphaValue(MUTED_ALPHA);
                    button.setToolTip(Some(&NSString::from_str(&format!("رفّ — {reason}"))));
                }
                None => {
                    button.setAlphaValue(1.0);
                    button.setToolTip(Some(&NSString::from_str("رفّ")));
                }
            }
        });
    });
}

fn show_menu(mtm: MainThreadMarker) {
    NATIVE.with(|cell| {
        let Some(native) = cell.get() else { return };
        let Some(button) = native.item.button(mtm) else { return };
        // Close the panel first so the menu never stacks over it.
        if let Some(app) = APP.get() {
            panel::hide(app);
        }
        let height = button.bounds().size.height;
        let below = if button.isFlipped() { height + 6.0 } else { -6.0 };
        button.highlight(true);
        native
            .menu
            .popUpMenuPositioningItem_atLocation_inView(None, NSPoint::new(0.0, below), Some(&button));
        button.highlight(false);
    });
}
