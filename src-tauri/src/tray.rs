//! Menu-bar (tray) presence: the identity's template icon, the last 5 items,
//! a capture toggle, and the app actions. Rebuilt whenever the store changes.

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::storage::ItemKind;
use crate::{commands, panel, paste, AppState};

const TRAY_ID: &str = "raff-tray";
const RECENT_IN_MENU: usize = 5;
const LABEL_MAX_CHARS: usize = 44;

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
        .icon_as_template(true)
        .tooltip("رفّ")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .build(app)?;
    Ok(())
}

/// Rebuilds the tray menu. Callable from any thread (menus are AppKit objects,
/// so the work is dispatched to the main thread).
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            if let Ok(menu) = build_menu(&handle) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    });
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let (recent, capture_enabled, hotkey): (Vec<(String, String, ItemKind)>, bool, String) = {
        let store = state.store.lock().unwrap();
        (
            store
                .history
                .iter()
                .take(RECENT_IN_MENU)
                .map(|i| (i.id.clone(), i.text.clone(), i.kind))
                .collect(),
            store.settings.capture_enabled,
            store.settings.hotkey.clone(),
        )
    };

    let mut builder = MenuBuilder::new(app);
    if recent.is_empty() {
        let empty = MenuItemBuilder::with_id("noop", "لا عناصر بعد")
            .enabled(false)
            .build(app)?;
        builder = builder.item(&empty);
    } else {
        for (id, text, kind) in &recent {
            let label = menu_label(text, *kind);
            let item = MenuItemBuilder::with_id(format!("clip:{id}"), label).build(app)?;
            builder = builder.item(&item);
        }
    }

    let capture = CheckMenuItemBuilder::with_id("capture", "الالتقاط")
        .checked(capture_enabled)
        .build(app)?;
    // The accelerator is display-only (the global shortcut does the work) and
    // must mirror the *configured* hotkey. If muda cannot parse the stored
    // accelerator string, fall back to a plain item rather than failing the menu.
    let open = MenuItemBuilder::with_id("open", "فتح رفّ")
        .accelerator(&hotkey)
        .build(app)
        .or_else(|_| MenuItemBuilder::with_id("open", "فتح رفّ").build(app))?;
    let settings = MenuItemBuilder::with_id("settings", "الإعدادات…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "إنهاء")
        .accelerator("Cmd+Q")
        .build(app)?;

    builder
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&capture)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&open)
        .item(&settings)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit)
        .build()
}

fn menu_label(text: &str, kind: ItemKind) -> String {
    if kind == ItemKind::Image {
        return text.to_string(); // already "صورة W×H"
    }
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut label: String = one_line.chars().take(LABEL_MAX_CHARS).collect();
    if one_line.chars().count() > LABEL_MAX_CHARS {
        label.push('…');
    }
    label
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open" => panel::toggle(app),
        "settings" => commands::open_settings_window(app),
        "quit" => app.exit(0),
        "capture" => {
            let state = app.state::<AppState>();
            {
                let mut store = state.store.lock().unwrap();
                store.settings.capture_enabled = !store.settings.capture_enabled;
                store.save_settings();
            }
            let _ = app.emit("raff://changed", ());
            refresh(app);
        }
        clip if clip.starts_with("clip:") => {
            let item_id = &clip["clip:".len()..];
            // Tray click copies to the clipboard. Images bypass the monitor's
            // dedupe via the skip counter, so suppress nothing for text: the
            // monitor's dedupe naturally bumps the item to the top.
            let is_image = paste::item_kind(app, item_id) == Some(ItemKind::Image);
            if is_image {
                paste::write_item_to_clipboard(app, item_id, false);
            } else {
                let state = app.state::<AppState>();
                let text = {
                    let store = state.store.lock().unwrap();
                    store.find(item_id).map(|i| i.text.clone())
                };
                if let Some(text) = text {
                    crate::macos::write_clip(Some(&text), None, None, None);
                }
            }
        }
        _ => {}
    }
}
