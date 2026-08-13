//! Menu-bar (tray) presence.
//!
//! Interaction model (Figma «08 — Product Screens», screen ٤):
//!   * primary click   → open رفّ immediately (the panel is the product)
//!   * secondary click → the contextual application menu
//!
//! The menu is deliberately static — four actions and one separator, exactly
//! as designed. Reaching a clipboard item is the panel's job, so the menu is
//! never rebuilt and never mirrors store state.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::{commands, panel};

const TRAY_ID: &str = "raff-tray";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    // The menu-bar item must exist exactly once, no matter how often this is
    // called (setup re-entry, future callers): a second build would put a
    // duplicate رفّ icon in the menu bar.
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let menu = build_menu(app)?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        // Figma «14 — App & Content Icons», final 18pt Raff mark (14:234):
        // the final Direction 3 identity mark is a monochrome template image.
        // AppKit owns light/dark, active and inactive tinting; Raff never does.
        .icon_as_template(true)
        .tooltip("رفّ")
        .menu(&menu)
        // Left click must NOT drop the menu — it opens the panel instead.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::startup_trace::mark("TRAY_CLICK_RECEIVED");
                panel::toggle(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .build(app)?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = MenuItemBuilder::with_id("settings", "الإعدادات…").build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", "التحقق من التحديثات…").build(app)?;
    let about = MenuItemBuilder::with_id("about", "عن رفّ").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "إنهاء")
        .accelerator("Cmd+Q")
        .build(app)?;

    MenuBuilder::new(app)
        .item(&settings)
        .item(&check_updates)
        .item(&about)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit)
        .build()
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "settings" => commands::open_settings_window(app),
        "check-updates" => crate::updater::request_check_from_menu(app),
        "about" => commands::open_about_window(app),
        "quit" => app.exit(0),
        _ => {}
    }
}
