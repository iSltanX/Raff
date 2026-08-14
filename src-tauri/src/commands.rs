//! Least-privilege IPC surface. The frontend can only do what these commands
//! allow; every mutation persists immediately and notifies all windows.

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

use crate::storage::{Appearance, ItemKind, Settings, Store};
use crate::{macos, panel, paste, AppState};

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
    pub pinned_order: Option<u32>,
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
            pinned_order: item.pinned_order,
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
    crate::startup_trace::mark("FRONTEND_CALLED_get_state");
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
pub async fn paste_item(app: AppHandle, id: String, plain: bool) -> Result<bool, String> {
    paste::paste_item(&app, &id, plain).await
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
pub fn toggle_pin(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    is_pinned: bool,
) -> Result<bool, String> {
    let is_pinned = {
        let mut store = state.store.lock().unwrap();
        store.set_pin_persisted(&id, is_pinned)?
    };
    notify(&app);
    Ok(is_pinned)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReceiptDto {
    pub token: String,
}

#[tauri::command]
pub fn delete_item(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<DeleteReceiptDto, String> {
    let token = {
        let mut store = state.store.lock().unwrap();
        store.delete_reversible(&id)?
    };
    notify(&app);
    Ok(DeleteReceiptDto { token })
}

#[tauri::command]
pub fn undo_delete(app: AppHandle, state: State<AppState>, token: String) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        store.undo_delete(&token)?;
    }
    notify(&app);
    Ok(())
}

#[tauri::command]
pub fn commit_delete(state: State<AppState>, token: String) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    store.commit_delete(&token)
}

#[tauri::command]
pub fn clear_history(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        store.clear_history_persisted()?;
    }
    notify(&app);
    Ok(())
}

#[tauri::command]
pub fn clear_learning(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        store.clear_learning_persisted()?;
    }
    notify(&app);
    Ok(())
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
    validate_settings(&settings)?;
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

    let mut autostart_changed = false;
    if settings.launch_at_login != old.launch_at_login {
        let autolaunch = app.autolaunch();
        let result = if settings.launch_at_login {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        result.map_err(|err| {
            if settings.hotkey != old.hotkey {
                let _ = register_hotkey(&app, &old.hotkey);
            }
            format!("تعذّر تحديث التشغيل عند تسجيل الدخول: {err}")
        })?;
        autostart_changed = true;
    }

    // Persist only after fallible system integration succeeds. If storage
    // fails, restore both external side effects so Settings cannot claim a
    // configuration macOS or the next launch will not actually honor.
    if let Err(err) = state
        .store
        .lock()
        .unwrap()
        .update_settings_persisted(settings.clone())
    {
        if autostart_changed {
            let autolaunch = app.autolaunch();
            let _ = if old.launch_at_login {
                autolaunch.enable()
            } else {
                autolaunch.disable()
            };
        }
        if settings.hotkey != old.hotkey {
            let _ = register_hotkey(&app, &old.hotkey);
        }
        return Err(err);
    }

    if settings.follow_system != old.follow_system || settings.appearance != old.appearance {
        sync_appearance(&app);
    }

    notify(&app);
    Ok(())
}

fn validate_settings(settings: &Settings) -> Result<(), String> {
    if !matches!(settings.history_limit, 200 | 500 | 1000) {
        return Err("حد السجل غير صالح".into());
    }
    if settings.hotkey.is_empty() || settings.hotkey.len() > 128 {
        return Err("اختصار لوحة المفاتيح غير صالح".into());
    }
    if settings.excluded_apps.len() > 128
        || settings.excluded_apps.iter().any(|bundle| {
            bundle.is_empty()
                || bundle.len() > 255
                || bundle.chars().any(char::is_control)
                || bundle.chars().any(char::is_whitespace)
        })
    {
        return Err("قائمة التطبيقات المستثناة غير صالحة".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_image(state: State<AppState>, id: String) -> Option<String> {
    let store = state.store.lock().unwrap();
    image_data_url(&store, &id)
}

/// Prefer the compact preview, but recover from an interrupted/failed
/// thumbnail write by reading the original image. Older history files can
/// legitimately contain a stale `thumbFile`, so fallback happens on read
/// failure rather than only when the field is absent.
fn image_data_url(store: &Store, id: &str) -> Option<String> {
    let item = store.find(id)?;
    let bytes = item
        .thumb_file
        .iter()
        .chain(item.image_file.iter())
        .find_map(|file| std::fs::read(store.images_dir().join(file)).ok())?;
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
pub fn firstrun_done(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        store.mark_first_run_shown_persisted()?;
    }
    if let Some(w) = app.get_webview_window("firstrun") {
        w.close().map_err(|err| err.to_string())?;
    }
    Ok(())
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

// ─── Appearance ───────────────────────────────────────────────────────────────

/// Applies the native appearance override on the main thread. Raff v4 has one
/// approved application icon, so appearance changes never rewrite the bundle
/// icon or relaunch the process.
fn sync_appearance(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let theme = {
            let state = handle.state::<AppState>();
            let store = state.store.lock().unwrap();
            theme_for(&store.settings)
        };
        handle.set_theme(theme);
    });
}

pub fn register_hotkey(app: &AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let shortcut: Shortcut = accel.parse().map_err(|e| format!("اختصار غير صالح: {e}"))?;
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
/// Whether a secondary window draws its own chrome.
///
/// Settings and About are designed in Figma with their own title bar — a warm
/// surface, a 1px rule, a centred Cairo Bold title and the traffic lights on
/// the left — inside a 16px rounded shell. A native macOS title bar would sit
/// *above* all of that, so those windows are built undecorated and transparent
/// and paint the whole window themselves. Windows with no designed chrome
/// (first-run, update) keep the native frame.
#[derive(Clone, Copy, PartialEq)]
enum Chrome {
    Native,
    Designed,
}

fn open_window_when_ready(
    app: &AppHandle,
    label: &str,
    page: &str,
    title: &str,
    size: (f64, f64),
    chrome: Chrome,
) {
    if let Some(w) = app.get_webview_window(label) {
        // Visible → just focus it. Hidden → it is still loading; the
        // page-load handler (or the watchdog below) will reveal it.
        if w.is_visible().unwrap_or(false) {
            let _ = w.set_focus();
        }
        return;
    }
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .visible(false);
    if chrome == Chrome::Designed {
        builder = builder.decorations(false).transparent(true).shadow(true);
    }
    let result = builder
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

/// Opens the official Raff repository in the user's browser. Takes no
/// argument — the URL lives in Rust, so this can only ever open that one page.
#[tauri::command]
pub fn open_repository() {
    macos::open_repository();
}

/// The panel header's gear (Figma «08», Header-Actions 2:7695).
#[tauri::command]
pub fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

/// «عن رفّ» from the Settings window's own action.
#[tauri::command]
pub fn open_about(app: AppHandle) {
    open_about_window(&app);
}

pub fn open_settings_window(app: &AppHandle) {
    // Deferred one event-loop tick: never build a webview synchronously
    // inside the tray-menu callback (see open_window_when_ready).
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        open_window_when_ready(
            &handle,
            "settings",
            "settings.html",
            "إعدادات رفّ",
            // Compact macOS preferences shell: the five page tabs expose one
            // settings group at a time, so the window never becomes a tall
            // scrolling document or a two-column dashboard.
            (600.0, 520.0),
            Chrome::Designed,
        );
    });
}

/// «عن رفّ» — the About window from Figma «08 — Product Screens», screen ٦.
/// Opened from the menu bar's contextual menu. Deferred to the main thread for
/// the same reason as settings: never build a webview inside the menu's
/// tracking run loop.
pub fn open_about_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        open_window_when_ready(
            &handle,
            "about",
            "about.html",
            "عن رفّ",
            // Figma's 400pt height is sufficient for the transient status
            // line and removes the dead lower band found in the live 460pt
            // translation. The width stays optically widened for Arabic text.
            (360.0, 400.0),
            Chrome::Designed,
        );
    });
}

pub fn open_firstrun_window(app: &AppHandle) {
    open_window_when_ready(
        app,
        "firstrun",
        "firstrun.html",
        "رفّ",
        (480.0, 620.0),
        Chrome::Native,
    );
}

/// Small, tab-less window dedicated to the update cycle (opened by the tray's
/// «التحقق من وجود تحديثات…»). Unlike settings/firstrun, this window is
/// hidden — not destroyed — when the user closes it (see main.rs's
/// `CloseRequested` handler), so "exists but hidden" here usually means "the
/// user closed it earlier", not "still loading". Reusing
/// `open_window_when_ready`'s existing-window branch as-is would leave it
/// hidden forever in that case (it only re-focuses *visible* windows), so an
/// existing window is shown + focused unconditionally instead.
///
/// Built at the *compact* height: the window always opens on the brief
/// "جارٍ التحقق…" state, and `update.js` grows it once (to the taller
/// "available/downloading" size) only if that turns out to be needed —
/// matching this same 280px default avoids a visible resize on first paint.
pub fn open_update_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("update") {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        open_window_when_ready(
            &handle,
            "update",
            "update.html",
            "تحديث رفّ",
            (360.0, 280.0),
            Chrome::Native,
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_store(original: &[u8], thumb: Option<(&str, &[u8])>) -> (Store, String) {
        let root = std::env::temp_dir().join(format!("raff-image-test-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(root);
        std::fs::write(store.images_dir().join("original.png"), original).unwrap();
        if let Some((name, bytes)) = thumb {
            std::fs::write(store.images_dir().join(name), bytes).unwrap();
        }
        store.capture(
            ItemKind::Image,
            "image".into(),
            None,
            None,
            Some("original.png".into()),
            Some("preview.thumb.png".into()),
            Some("hash".into()),
            ("Test".into(), "com.test".into()),
        );
        let id = store.history[0].id.clone();
        (store, id)
    }

    #[test]
    fn get_image_prefers_the_persisted_thumbnail() {
        let (store, id) = image_store(b"original", Some(("preview.thumb.png", b"thumbnail")));
        let expected = base64::engine::general_purpose::STANDARD.encode(b"thumbnail");
        assert_eq!(
            image_data_url(&store, &id),
            Some(format!("data:image/png;base64,{expected}"))
        );
    }

    #[test]
    fn get_image_falls_back_when_the_recorded_thumbnail_is_missing() {
        let (store, id) = image_store(b"original", None);
        let expected = base64::engine::general_purpose::STANDARD.encode(b"original");
        assert_eq!(
            image_data_url(&store, &id),
            Some(format!("data:image/png;base64,{expected}"))
        );
    }
}
