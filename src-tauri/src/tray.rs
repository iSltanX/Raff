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

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{define_class, msg_send, sel, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSEventMask, NSEventModifierFlags, NSEventType, NSImage, NSMenu, NSMenuItem,
    NSStatusBar, NSStatusItem, NSVariableStatusItemLength,
};
use objc2_foundation::{MainThreadMarker, NSData, NSPoint, NSSize, NSString};
use tauri::AppHandle;

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
    _target: Retained<StatusTarget>,
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
    entry("الإعدادات…", sel!(openSettings:), ",");
    entry("التحقق من التحديثات…", sel!(checkUpdates:), "");
    entry("عن رفّ", sel!(openAbout:), "");
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    entry("إنهاء", sel!(quitApp:), "q");

    NATIVE.with(|cell| {
        let _ = cell.set(Native {
            item,
            menu,
            _target: target,
        });
    });
    Ok(())
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
