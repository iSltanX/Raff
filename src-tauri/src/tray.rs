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
//!
//! The glyph says one thing: whether رفّ is saving what you copy (Figma «Menu
//! Bar/Glyph 18» 252:51). The leaning card is capture. It is replaced by a
//! pause mark while paused, by nothing while turned off, and by «!» when the
//! capture loop has failed — shapes, never alpha, because macOS already dims
//! status items on inactive displays. A missing Accessibility permission does
//! not touch the glyph: it never stops saving, and the icon must not say so.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, Sel};
use objc2::{define_class, msg_send, sel, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSControlStateValueOff, NSControlStateValueOn, NSEventMask,
    NSEventModifierFlags, NSEventType, NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem,
    NSVariableStatusItemLength,
};
use objc2_foundation::{MainThreadMarker, NSData, NSPoint, NSSize, NSString};
use tauri::{AppHandle, Emitter, Manager};

use crate::{commands, macos, panel, Pause};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// The four things the glyph can say, worst first.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Glyph {
    Capturing,
    Paused,
    Off,
    Fault,
}

/// Which glyph wins. A loop that died outranks capture the user turned off,
/// which outranks a pause: each one hides the next from mattering.
pub fn glyph_for(stopped: bool, disabled: bool, paused: bool) -> Glyph {
    if stopped {
        Glyph::Fault
    } else if disabled {
        Glyph::Off
    } else if paused {
        Glyph::Paused
    } else {
        Glyph::Capturing
    }
}

/// The status sentence — one wording for the menu header, the tooltip, the
/// panel strip and Settings (Figma «STATES • One status system» 279:651).
pub fn status_text(glyph: Glyph, pause: &crate::PauseView) -> String {
    match glyph {
        Glyph::Fault => "توقّف الالتقاط — أعد تشغيل رفّ".into(),
        Glyph::Off => "الالتقاط معطّل من الإعدادات".into(),
        Glyph::Paused => match pause.kind {
            "skipNext" => "سيتجاهل رفّ النسخة التالية".into(),
            "timed" => match pause.minutes_left {
                Some(n) => format!("الالتقاط موقوف — يُستأنف بعد {} د", arabic_digits(n)),
                None => "الالتقاط موقوف مؤقتًا".into(),
            },
            "untilRestart" => "الالتقاط موقوف حتى إعادة التشغيل".into(),
            _ => "الالتقاط موقوف مؤقتًا".into(),
        },
        Glyph::Capturing => "رفّ يحفظ ما تنسخه".into(),
    }
}

/// Western digits → Arabic-Indic, as the interface writes numbers.
fn arabic_digits(n: u64) -> String {
    n.to_string()
        .chars()
        .map(|c| char::from_u32(0x0660 + c.to_digit(10).unwrap_or(0)).unwrap_or(c))
        .collect()
}

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

        #[unsafe(method(openPanel:))]
        fn open_panel(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP.get() {
                panel::show(app);
            }
        }

        #[unsafe(method(skipNextCopy:))]
        fn skip_next_copy(&self, _sender: Option<&AnyObject>) {
            set_pause(Pause::SkipNext);
        }

        #[unsafe(method(pauseFifteen:))]
        fn pause_fifteen(&self, _sender: Option<&AnyObject>) {
            set_pause(Pause::for_minutes(Some(15)));
        }

        #[unsafe(method(pauseHour:))]
        fn pause_hour(&self, _sender: Option<&AnyObject>) {
            set_pause(Pause::for_minutes(Some(60)));
        }

        #[unsafe(method(pauseUntilRestart:))]
        fn pause_until_restart(&self, _sender: Option<&AnyObject>) {
            set_pause(Pause::for_minutes(None));
        }

        #[unsafe(method(resumeCapture:))]
        fn resume_capture(&self, _sender: Option<&AnyObject>) {
            set_pause(Pause::Off);
        }

        #[unsafe(method(enableCapture:))]
        fn enable_capture(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP.get() {
                if let Err(err) = commands::set_capture_enabled(app, true) {
                    eprintln!("raff: enabling capture from the menu failed: {err}");
                }
            }
        }

        #[unsafe(method(restartApp:))]
        fn restart_app(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP.get() {
                app.restart();
            }
        }

        #[unsafe(method(grantAccessibility:))]
        fn grant_accessibility(&self, _sender: Option<&AnyObject>) {
            macos::ax_prompt();
            macos::open_accessibility_pane();
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

/// The items whose title, visibility or availability follow the state.
struct MenuItems {
    header: Retained<NSMenuItem>,
    enable_capture: Retained<NSMenuItem>,
    restart: Retained<NSMenuItem>,
    grant: Retained<NSMenuItem>,
    capture: Retained<NSMenuItem>,
    skip_next: Retained<NSMenuItem>,
    fifteen: Retained<NSMenuItem>,
    hour: Retained<NSMenuItem>,
    until_restart: Retained<NSMenuItem>,
    resume: Retained<NSMenuItem>,
}

struct Native {
    item: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
    items: MenuItems,
    images: [Retained<NSImage>; 4],
    _capture_menu: Retained<NSMenu>,
    _target: Retained<StatusTarget>,
}

impl Native {
    fn image(&self, glyph: Glyph) -> &NSImage {
        &self.images[match glyph {
            Glyph::Capturing => 0,
            Glyph::Paused => 1,
            Glyph::Off => 2,
            Glyph::Fault => 3,
        }]
    }
}

/// Applies a pause and lets the icon show it. The state lives in `AppState`,
/// never in the saved settings: it must not outlive the session.
fn set_pause(next: Pause) {
    let Some(app) = APP.get() else { return };
    let state = app.state::<crate::AppState>();
    *crate::lock_pause(&state.pause) = next;
    sync_paused();
    let _ = app.emit("raff://changed", ());
    if let Pause::Until(Some(until)) = next {
        end_when_elapsed(until);
    }
}

/// A timed pause ends on its own: without this the icon and the panel would
/// keep saying «موقوف» until the next copy happened to clear it. Only that
/// exact pause is ended — a newer one, or a resume, leaves nothing to do.
fn end_when_elapsed(until: std::time::Instant) {
    std::thread::spawn(move || {
        std::thread::sleep(until.saturating_duration_since(std::time::Instant::now()));
        let Some(app) = APP.get() else { return };
        let state = app.state::<crate::AppState>();
        let ended = {
            let mut pause = crate::lock_pause(&state.pause);
            let ended = *pause == Pause::Until(Some(until));
            if ended {
                *pause = Pause::Off;
            }
            ended
        };
        if ended {
            sync_paused();
            let _ = app.emit("raff://changed", ());
        }
    });
}

/// Resumes capture from anywhere (the panel strip, Settings, the menu).
pub fn resume_capture() {
    set_pause(Pause::Off);
}

thread_local! {
    // Lives for the whole process on the main thread; AppKit objects are not Send.
    static NATIVE: std::cell::OnceCell<Native> = const { std::cell::OnceCell::new() };
}

fn template(mtm: MainThreadMarker, bytes: &'static [u8]) -> Retained<NSImage> {
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(mtm.alloc(), &data).expect("bundled tray glyph decodes");
    image.setTemplate(true);
    image.setSize(NSSize::new(18.0, 18.0));
    image
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
    let images = [
        template(mtm, include_bytes!("../icons/tray.png")),
        template(mtm, include_bytes!("../icons/tray-paused.png")),
        template(mtm, include_bytes!("../icons/tray-off.png")),
        template(mtm, include_bytes!("../icons/tray-fault.png")),
    ];

    if let Some(button) = item.button(mtm) {
        button.setImage(Some(&images[0]));
        button.setToolTip(Some(&NSString::from_str("رفّ")));
        unsafe {
            button.setTarget(Some(&target));
            button.setAction(Some(sel!(statusItemClicked:)));
        }
        button.sendActionOn(NSEventMask::LeftMouseUp | NSEventMask::RightMouseUp);
    }

    let new_item = |title: &str, action: Option<Sel>, key: &str| {
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc(),
                &NSString::from_str(title),
                action,
                &NSString::from_str(key),
            )
        };
        if action.is_some() {
            unsafe { item.setTarget(Some(&target)) };
        }
        item
    };

    // Pausing lives one level down: four choices and the way back.
    let capture_menu = NSMenu::new(mtm);
    capture_menu.setAutoenablesItems(false);
    let skip_next = new_item("تجاهل النسخة التالية", Some(sel!(skipNextCopy:)), "");
    let fifteen = new_item("إيقاف ١٥ دقيقة", Some(sel!(pauseFifteen:)), "");
    let hour = new_item("إيقاف ساعة", Some(sel!(pauseHour:)), "");
    let until_restart = new_item("إيقاف حتى إعادة التشغيل", Some(sel!(pauseUntilRestart:)), "");
    let resume = new_item("استئناف الالتقاط", Some(sel!(resumeCapture:)), "");
    for entry in [&skip_next, &fifteen, &hour, &until_restart] {
        capture_menu.addItem(entry);
    }
    capture_menu.addItem(&NSMenuItem::separatorItem(mtm));
    capture_menu.addItem(&resume);

    let menu = NSMenu::new(mtm);
    menu.setAutoenablesItems(false);
    // A line that says what رفّ is doing right now; it is not a command.
    let header = new_item("رفّ يحفظ ما تنسخه", None, "");
    header.setEnabled(false);
    let enable_capture = new_item("تفعيل الالتقاط", Some(sel!(enableCapture:)), "");
    let restart = new_item("إعادة تشغيل رفّ", Some(sel!(restartApp:)), "");
    let grant = new_item("تفعيل اللصق التلقائي…", Some(sel!(grantAccessibility:)), "");
    let capture = new_item("الالتقاط", None, "");
    capture.setSubmenu(Some(&capture_menu));

    menu.addItem(&header);
    menu.addItem(&enable_capture);
    menu.addItem(&restart);
    menu.addItem(&grant);
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&new_item("فتح رفّ", Some(sel!(openPanel:)), ""));
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&capture);
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&new_item("الإعدادات…", Some(sel!(openSettings:)), ","));
    menu.addItem(&new_item("التحقق من التحديثات…", Some(sel!(checkUpdates:)), ""));
    menu.addItem(&new_item("عن رفّ", Some(sel!(openAbout:)), ""));
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&new_item("إنهاء رفّ", Some(sel!(quitApp:)), "q"));

    NATIVE.with(|cell| {
        let _ = cell.set(Native {
            item,
            menu,
            items: MenuItems {
                header,
                enable_capture,
                restart,
                grant,
                capture,
                skip_next,
                fifteen,
                hour,
                until_restart,
                resume,
            },
            images,
            _capture_menu: capture_menu,
            _target: target,
        });
    });
    Ok(())
}

static CAPTURE_STOPPED: AtomicBool = AtomicBool::new(false);
static CAPTURE_DISABLED: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);
static PERMISSION_MISSING: AtomicBool = AtomicBool::new(false);

/// The capture loop gave up and will not come back this session.
pub fn note_capture_stopped() {
    if !CAPTURE_STOPPED.swap(true, Ordering::SeqCst) {
        apply_quiet_state();
    }
}

/// The capture setting: the user's own «off» is a state the icon shows.
pub fn note_capture_enabled(enabled: bool) {
    if CAPTURE_DISABLED.swap(!enabled, Ordering::SeqCst) == enabled {
        apply_quiet_state();
    }
}

/// Capture is being held off on purpose, or is not any more — read from the
/// pause itself, so a newer pause set a moment earlier is never overwritten
/// by a stale answer.
pub fn sync_paused() {
    let paused = current_pause().kind != "off";
    if PAUSED.swap(paused, Ordering::SeqCst) != paused {
        apply_quiet_state();
    }
}

/// The current Accessibility answer. It changes the tooltip and the menu,
/// never the glyph.
pub fn note_permission(trusted: bool) {
    if PERMISSION_MISSING.swap(!trusted, Ordering::SeqCst) == trusted {
        apply_quiet_state();
    }
}

fn current_glyph() -> Glyph {
    glyph_for(
        CAPTURE_STOPPED.load(Ordering::SeqCst),
        CAPTURE_DISABLED.load(Ordering::SeqCst),
        PAUSED.load(Ordering::SeqCst),
    )
}

fn current_pause() -> crate::PauseView {
    APP.get()
        .map(|app| {
            let state = app.state::<crate::AppState>();
            let pause = *crate::lock_pause(&state.pause);
            pause.view()
        })
        .unwrap_or_default()
}

/// Reflects the worst standing condition in the menu bar.
fn apply_quiet_state() {
    let glyph = current_glyph();
    // The tooltip is written on state changes only, so it carries no count
    // that would go stale; the menu header is rebuilt on every open.
    let pause = crate::PauseView { minutes_left: None, ..current_pause() };
    let mut tooltip = format!("رفّ — {}", status_text(glyph, &pause));
    if PERMISSION_MISSING.load(Ordering::SeqCst) {
        tooltip.push_str(" · اللصق التلقائي معطّل");
    }
    macos::dispatch_to_main(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        NATIVE.with(|cell| {
            let Some(native) = cell.get() else { return };
            let Some(button) = native.item.button(mtm) else {
                return;
            };
            button.setImage(Some(native.image(glyph)));
            button.setAlphaValue(1.0);
            button.setToolTip(Some(&NSString::from_str(&tooltip)));
        });
    });
}

/// Brings titles, visibility and availability up to date before the menu
/// opens. Items that cannot work right now are disabled, not hidden, so the
/// menu's shape stays the same; the state-specific remedies appear only when
/// they apply.
fn refresh_menu(items: &MenuItems) {
    let glyph = current_glyph();
    let pause = current_pause();
    items
        .header
        .setTitle(&NSString::from_str(&status_text(glyph, &pause)));
    items.enable_capture.setHidden(glyph != Glyph::Off);
    items.restart.setHidden(glyph != Glyph::Fault);
    items
        .grant
        .setHidden(!PERMISSION_MISSING.load(Ordering::SeqCst));
    let can_pause = matches!(glyph, Glyph::Capturing | Glyph::Paused);
    items.capture.setEnabled(can_pause);
    // A timed pause's length is not kept, only its end: the header says how
    // long is left, and only the two open-ended choices carry a checkmark.
    for (entry, kind) in [
        (&items.skip_next, "skipNext"),
        (&items.fifteen, ""),
        (&items.hour, ""),
        (&items.until_restart, "untilRestart"),
    ] {
        entry.setEnabled(can_pause);
        let on = !kind.is_empty() && pause.kind == kind;
        entry.setState(if on { NSControlStateValueOn } else { NSControlStateValueOff });
    }
    items.resume.setEnabled(glyph == Glyph::Paused);
}

fn show_menu(mtm: MainThreadMarker) {
    NATIVE.with(|cell| {
        let Some(native) = cell.get() else { return };
        let Some(button) = native.item.button(mtm) else { return };
        // Close the panel first so the menu never stacks over it.
        if let Some(app) = APP.get() {
            panel::hide(app);
            // Fresh permission answer, so the grant item is never stale.
            note_permission(macos::ax_trusted());
        }
        refresh_menu(&native.items);
        let height = button.bounds().size.height;
        let below = if button.isFlipped() { height + 6.0 } else { -6.0 };
        button.highlight(true);
        native
            .menu
            .popUpMenuPositioningItem_atLocation_inView(None, NSPoint::new(0.0, below), Some(&button));
        button.highlight(false);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_loop_outranks_everything() {
        assert_eq!(glyph_for(true, true, true), Glyph::Fault);
        assert_eq!(glyph_for(true, false, false), Glyph::Fault);
    }

    #[test]
    fn capture_the_user_turned_off_is_shown_and_outranks_a_pause() {
        assert_eq!(glyph_for(false, true, false), Glyph::Off);
        assert_eq!(glyph_for(false, true, true), Glyph::Off);
    }

    #[test]
    fn a_pause_is_its_own_shape() {
        assert_eq!(glyph_for(false, false, true), Glyph::Paused);
        assert_eq!(glyph_for(false, false, false), Glyph::Capturing);
    }

    #[test]
    fn the_status_sentence_names_the_state_without_mentioning_the_permission() {
        let none = crate::PauseView::default();
        assert_eq!(status_text(Glyph::Capturing, &none), "رفّ يحفظ ما تنسخه");
        assert_eq!(status_text(Glyph::Off, &none), "الالتقاط معطّل من الإعدادات");
        assert!(status_text(Glyph::Fault, &none).contains("أعد تشغيل رفّ"));
        let timed = crate::PauseView { kind: "timed", minutes_left: Some(12), ..Default::default() };
        assert_eq!(status_text(Glyph::Paused, &timed), "الالتقاط موقوف — يُستأنف بعد ١٢ د");
        for glyph in [Glyph::Capturing, Glyph::Paused, Glyph::Off, Glyph::Fault] {
            assert!(!status_text(glyph, &timed).contains("اللصق"), "{glyph:?}");
        }
    }

    #[test]
    fn every_state_has_its_own_bundled_glyph() {
        for bytes in [
            &include_bytes!("../icons/tray.png")[..],
            &include_bytes!("../icons/tray-paused.png")[..],
            &include_bytes!("../icons/tray-off.png")[..],
            &include_bytes!("../icons/tray-fault.png")[..],
        ] {
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            // 36×36 @2x of the 18pt template.
            assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 36);
        }
    }
}
