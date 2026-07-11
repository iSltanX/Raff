//! Least-privilege IPC surface. The frontend can only do what these commands
//! allow; every mutation persists immediately and notifies all windows.

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

use crate::storage::{AppIconPref, Appearance, ItemKind, Settings};
use crate::{macos, panel, paste, tray, AppState};

const PREVIEW_MAX_CHARS: usize = 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemKind,
    pub text: String,
    pub source_app: String,
    pub source_app_bundle_id: String,
    pub created_at: u64,
    pub is_pinned: bool,
    pub copy_count: u32,
    pub paste_count: u32,
    pub last_used_at: u64,
    pub has_image: bool,
}

impl ItemDto {
    fn from(item: &crate::storage::ClipItem) -> Self {
        let mut text: String = item.text.chars().take(PREVIEW_MAX_CHARS).collect();
        if item.text.chars().count() > PREVIEW_MAX_CHARS {
            text.push('…');
        }
        Self {
            id: item.id.clone(),
            kind: item.kind,
            text,
            source_app: item.source_app.clone(),
            source_app_bundle_id: item.source_app_bundle_id.clone(),
            created_at: item.created_at,
            is_pinned: item.is_pinned,
            copy_count: item.copy_count,
            paste_count: item.paste_count,
            last_used_at: item.last_used_at,
            has_image: item.image_file.is_some(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub pinned: Vec<ItemDto>,
    pub history: Vec<ItemDto>,
    pub settings: Settings,
    pub ax_trusted: bool,
    pub version: String,
}

#[tauri::command]
pub fn get_state(app: AppHandle, state: State<AppState>) -> StatePayload {
    let store = state.store.lock().unwrap();
    let mut pinned: Vec<&crate::storage::ClipItem> = store.pinned.iter().collect();
    pinned.sort_by_key(|i| i.pinned_order.unwrap_or(u32::MAX));
    StatePayload {
        pinned: pinned.into_iter().map(ItemDto::from).collect(),
        history: store.history.iter().map(ItemDto::from).collect(),
        settings: store.settings.clone(),
        ax_trusted: macos::ax_trusted(),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
pub fn paste_item(app: AppHandle, id: String, plain: bool) -> Result<(), String> {
    if paste::paste_item(&app, &id, plain) {
        Ok(())
    } else {
        Err("العنصر غير موجود".into())
    }
}

#[tauri::command]
pub fn copy_item(app: AppHandle, id: String) -> Result<(), String> {
    if paste::write_item_to_clipboard(&app, &id, false) {
        paste::bump_copy_signals(&app, &id);
        Ok(())
    } else {
        Err("العنصر غير موجود".into())
    }
}

#[tauri::command]
pub fn toggle_pin(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut store = state.store.lock().unwrap();
        if store.toggle_pin(&id) {
            store.save_history();
            store.save_pinned();
        }
    }
    notify(&app);
}

#[tauri::command]
pub fn delete_item(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut store = state.store.lock().unwrap();
        if store.delete(&id) {
            store.save_history();
            store.save_pinned();
        }
    }
    notify(&app);
}

#[tauri::command]
pub fn clear_history(app: AppHandle, state: State<AppState>) {
    {
        let mut store = state.store.lock().unwrap();
        store.clear_history();
        store.save_history();
    }
    notify(&app);
}

#[tauri::command]
pub fn clear_learning(app: AppHandle, state: State<AppState>) {
    {
        let mut store = state.store.lock().unwrap();
        store.clear_learning();
        store.save_history();
        store.save_pinned();
    }
    notify(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnDto {
    pub text: String,
    #[serde(rename = "type")]
    pub kind: ItemKind,
    pub copy_count: u32,
    pub paste_count: u32,
    pub last_used_at: u64,
}

/// "عرض ما تعلّمه رفّ" — the plan requires the user can see what is being
/// learned. Returns the most-used items with their raw signals.
#[tauri::command]
pub fn learning_summary(state: State<AppState>) -> Vec<LearnDto> {
    let store = state.store.lock().unwrap();
    let mut items: Vec<&crate::storage::ClipItem> = store
        .pinned
        .iter()
        .chain(store.history.iter())
        .filter(|i| i.copy_count + i.paste_count > 1)
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.copy_count + i.paste_count));
    items
        .into_iter()
        .take(10)
        .map(|i| LearnDto {
            text: i.text.chars().take(80).collect(),
            kind: i.kind,
            copy_count: i.copy_count,
            paste_count: i.paste_count,
            last_used_at: i.last_used_at,
        })
        .collect()
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: Settings,
) -> Result<(), String> {
    let old = {
        let store = state.store.lock().unwrap();
        store.settings.clone()
    };

    // Hotkey first: if the new accelerator cannot be registered, fail without
    // persisting anything — and re-register the old one, because registration
    // starts with unregister_all (the app must never lose its entry point).
    if settings.hotkey != old.hotkey {
        if let Err(err) = register_hotkey(&app, &settings.hotkey) {
            let _ = register_hotkey(&app, &old.hotkey);
            return Err(err);
        }
    }
    if settings.launch_at_login != old.launch_at_login {
        let autolaunch = app.autolaunch();
        let result = if settings.launch_at_login {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        if let Err(e) = result {
            eprintln!("raff: autostart: {e}");
        }
    }

    if settings.follow_system != old.follow_system || settings.appearance != old.appearance {
        apply_appearance(&app, &settings);
    }
    if settings.app_icon != old.app_icon
        || settings.follow_system != old.follow_system
        || settings.appearance != old.appearance
    {
        // Queued after apply_appearance's main-thread task, so an Auto icon
        // reads the theme the appearance change just produced.
        apply_app_icon(&app);
    }

    {
        let mut store = state.store.lock().unwrap();
        store.settings = settings;
        store.trim_history(); // the cap may have shrunk — enforce it now
        store.save_settings();
        store.save_history();
    }
    notify(&app);
    Ok(())
}

#[tauri::command]
pub fn get_image(state: State<AppState>, id: String) -> Option<String> {
    let store = state.store.lock().unwrap();
    let item = store.find(&id)?;
    let file = item.thumb_file.as_ref().or(item.image_file.as_ref())?;
    let bytes = std::fs::read(store.images_dir().join(file)).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    panel::hide(&app);
}

#[tauri::command]
pub fn ax_status() -> bool {
    macos::ax_trusted()
}

#[tauri::command]
pub fn request_accessibility() -> bool {
    macos::ax_prompt()
}

#[tauri::command]
pub fn open_accessibility_settings() {
    macos::open_accessibility_pane();
}

#[tauri::command]
pub fn firstrun_done(app: AppHandle, state: State<AppState>) {
    {
        let mut store = state.store.lock().unwrap();
        store.settings.first_run_shown = true;
        store.save_settings();
    }
    if let Some(w) = app.get_webview_window("firstrun") {
        let _ = w.close();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub name: String,
    pub bundle_id: String,
}

#[tauri::command]
pub fn list_running_apps() -> Vec<RunningApp> {
    macos::running_apps()
        .into_iter()
        .map(|(name, bundle_id)| RunningApp { name, bundle_id })
        .collect()
}

// ─── helpers shared with main/tray ───────────────────────────────────────────

fn notify(app: &AppHandle) {
    let _ = app.emit("raff://changed", ());
    tray::refresh(app);
}

/// The native theme override for a settings snapshot: `None` means "follow
/// the system", matching `AppHandle::set_theme`'s own convention.
pub fn theme_for(settings: &Settings) -> Option<tauri::Theme> {
    if settings.follow_system {
        None
    } else {
        Some(match settings.appearance {
            Appearance::Dark => tauri::Theme::Dark,
            Appearance::Light => tauri::Theme::Light,
        })
    }
}

/// Applies the appearance preference natively: an explicit override drives the
/// window appearance (vibrancy, title bars, and the webviews' CSS media query
/// all follow it); `None` returns every window to the system appearance.
///
/// Used for runtime changes (settings updated while windows already exist),
/// where `AppHandle::set_theme`'s asynchronous main-thread dispatch is safe.
/// Cold-launch startup instead calls `App::set_theme` directly (synchronous)
/// — see `main.rs` — so the very first window is created with the right
/// appearance already in effect, with no race against window creation.
pub fn apply_appearance(app: &AppHandle, settings: &Settings) {
    let theme = theme_for(settings);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        handle.set_theme(theme);
    });
}

/// Applies the selected app-icon variant (أيقونة التطبيق) to the bundle.
/// `Auto` follows the app's *effective* appearance (the explicit theme, or the
/// system theme while following it) — read from the panel window, which always
/// exists. Queued on the main thread so it runs after any theme change queued
/// just before it, and deduplicated so repeated events don't rewrite the icon.
pub fn apply_app_icon(app: &AppHandle) {
    use std::sync::atomic::{AtomicU8, Ordering};
    /// Last applied variant: 0 unknown · 1 light · 2 dark.
    static APPLIED: AtomicU8 = AtomicU8::new(0);

    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let pref = {
            let state = handle.state::<AppState>();
            let store = state.store.lock().unwrap();
            store.settings.app_icon
        };
        let dark = match pref {
            AppIconPref::Light => false,
            AppIconPref::Dark => true,
            AppIconPref::Auto => handle
                .get_webview_window(panel::PANEL_LABEL)
                .and_then(|w| w.theme().ok())
                .map(|t| t == tauri::Theme::Dark)
                .unwrap_or(false),
        };
        let (tag, file) = if dark {
            (2, "icons/icon-dark.icns")
        } else {
            (1, "icons/icon-light.icns")
        };
        if APPLIED.swap(tag, Ordering::SeqCst) == tag {
            return; // already showing this variant
        }
        match handle
            .path()
            .resolve(file, tauri::path::BaseDirectory::Resource)
        {
            Ok(path) => {
                macos::set_bundle_icon(&path);
            }
            Err(err) => eprintln!("raff: icon resource missing ({file}): {err}"),
        }
    });
}

pub fn register_hotkey(app: &AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let shortcut: Shortcut = accel
        .parse()
        .map_err(|e| format!("اختصار غير صالح: {e}"))?;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.on_shortcut(shortcut, move |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            panel::toggle(app);
        }
    })
    .map_err(|e| e.to_string())
}

/// How long a hidden window may stay unrevealed before the watchdog shows it
/// anyway (a lost page-load event must never leave the window invisible).
const WINDOW_REVEAL_FALLBACK_MS: u64 = 1500;

/// Builds a secondary window *hidden* and reveals it only once its content has
/// actually loaded. Showing at build time raced the WKWebView's first paint
/// and could present a permanently white window (especially when triggered
/// from the tray menu, whose tracking run loop is still unwinding).
fn open_window_when_ready(app: &AppHandle, label: &str, page: &str, title: &str, size: (f64, f64)) {
    if let Some(w) = app.get_webview_window(label) {
        // Visible → just focus it. Hidden → it is still loading; the
        // page-load handler (or the watchdog below) will reveal it.
        if w.is_visible().unwrap_or(false) {
            let _ = w.set_focus();
        }
        return;
    }
    let result = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .visible(false)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build();
    match result {
        Ok(w) => {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(WINDOW_REVEAL_FALLBACK_MS));
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
        }
        Err(err) => eprintln!("raff: failed to open {label} window: {err}"),
    }
}

pub fn open_settings_window(app: &AppHandle) {
    // Deferred one event-loop tick: never build a webview synchronously
    // inside the tray-menu callback (see open_window_when_ready).
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        open_window_when_ready(&handle, "settings", "settings.html", "إعدادات رفّ", (560.0, 540.0));
    });
}

pub fn open_firstrun_window(app: &AppHandle) {
    open_window_when_ready(app, "firstrun", "firstrun.html", "رفّ", (480.0, 620.0));
}
