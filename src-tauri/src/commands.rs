//! Least-privilege IPC surface. The frontend can only do what these commands
//! allow; every mutation persists immediately and notifies all windows.

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

use crate::storage::{ItemKind, Settings};
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
pub fn paste_item(app: AppHandle, id: String, plain: bool) {
    paste::paste_item(&app, &id, plain);
}

#[tauri::command]
pub fn copy_item(app: AppHandle, id: String) {
    paste::write_item_to_clipboard(&app, &id, false);
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
    // persisting anything.
    if settings.hotkey != old.hotkey {
        register_hotkey(&app, &settings.hotkey)?;
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

    {
        let mut store = state.store.lock().unwrap();
        store.settings = settings;
        store.save_settings();
        store.save_history(); // history_limit may have shrunk
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

pub fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("إعدادات رفّ")
        .inner_size(560.0, 540.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .build();
    if let Ok(w) = result {
        let _ = w.set_focus();
    }
}

pub fn open_firstrun_window(app: &AppHandle) {
    if app.get_webview_window("firstrun").is_some() {
        return;
    }
    let result = WebviewWindowBuilder::new(app, "firstrun", WebviewUrl::App("firstrun.html".into()))
        .title("رفّ")
        .inner_size(480.0, 620.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .build();
    if let Ok(w) = result {
        let _ = w.set_focus();
    }
}
