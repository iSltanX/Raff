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

    // Persist before any other side effect: whatever happens next — including
    // the controlled relaunch below — the chosen settings are already on disk
    // and survive into the next process.
    {
        let mut store = state.store.lock().unwrap();
        store.settings = settings.clone();
        store.trim_history(); // the cap may have shrunk — enforce it now
        store.save_settings();
        store.save_history();
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

    if settings.app_icon != old.app_icon
        || settings.follow_system != old.follow_system
        || settings.appearance != old.appearance
    {
        sync_appearance_and_icon(&app);
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

// ─── Appearance & app icon ────────────────────────────────────────────────────
//
// The theme itself is runtime-safe: `NSApp.appearance` is an AppKit-guaranteed
// override that every window, vibrancy layer, and webview media query follows
// synchronously. The *bundle icon* is not: `NSWorkspace.setIcon` writes the
// resource fork correctly, but what Finder/the Dock *display* for a running
// app goes through icon caches macOS gives no invalidation guarantee for.
// So a settings change that needs a different bundle icon triggers a controlled
// relaunch: the fresh launch applies the icon on one ordered path (before any
// window or theme event can interleave), which is the only moment macOS
// refreshes it dependably.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

/// Bundle-icon variant tags. `ICON_UNKNOWN` = never applied / last apply failed.
const ICON_UNKNOWN: u8 = 0;
const ICON_LIGHT: u8 = 1;
const ICON_DARK: u8 = 2;

/// The variant this process last wrote successfully onto the bundle.
static APPLIED_ICON: AtomicU8 = AtomicU8::new(ICON_UNKNOWN);
/// Set once a controlled relaunch is scheduled: every later icon path stands
/// down (the fresh launch owns the icon), and no second relaunch can start.
static RELAUNCH_PENDING: AtomicBool = AtomicBool::new(false);

/// Grace period between announcing the relaunch (the settings window shows
/// «سيُعاد تشغيل رفّ لتطبيق التغيير.») and performing it.
const RELAUNCH_NOTICE_MS: u64 = 1400;

/// The variant a settings snapshot asks for. Pure — `appearance_dark` is the
/// explicit setting, `system_dark` the effective appearance — so the relaunch
/// decision is unit-testable.
fn icon_variant(
    pref: AppIconPref,
    follow_system: bool,
    appearance_dark: bool,
    system_dark: bool,
) -> u8 {
    let dark = match pref {
        AppIconPref::Light => false,
        AppIconPref::Dark => true,
        AppIconPref::Auto => {
            if follow_system {
                system_dark
            } else {
                appearance_dark
            }
        }
    };
    if dark {
        ICON_DARK
    } else {
        ICON_LIGHT
    }
}

/// Main-thread only (reads `NSApp.effectiveAppearance` for the Auto+follow
/// case, which is current at launch, after `set_theme`, and at `ThemeChanged`).
fn wanted_icon_variant(app: &AppHandle) -> u8 {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    let s = &store.settings;
    icon_variant(
        s.app_icon,
        s.follow_system,
        s.appearance == Appearance::Dark,
        macos::app_appearance_is_dark(),
    )
}

/// Main-thread only: writes the variant's .icns onto the bundle unless the
/// bundle already shows it. On failure the guard returns to `ICON_UNKNOWN` so
/// the next call does not wrongly dedup-skip.
fn apply_icon_variant(app: &AppHandle, wanted: u8) {
    if APPLIED_ICON.swap(wanted, Ordering::SeqCst) == wanted {
        return; // already showing this variant
    }
    let file = if wanted == ICON_DARK {
        "icons/icon-dark.icns"
    } else {
        "icons/icon-light.icns"
    };
    match app
        .path()
        .resolve(file, tauri::path::BaseDirectory::Resource)
    {
        Ok(path) => {
            if !macos::set_bundle_icon(&path) {
                APPLIED_ICON.store(ICON_UNKNOWN, Ordering::SeqCst);
            }
        }
        Err(err) => {
            eprintln!("raff: icon resource missing ({file}): {err}");
            APPLIED_ICON.store(ICON_UNKNOWN, Ordering::SeqCst);
        }
    }
}

/// Runtime icon sync for the paths where a relaunch is impossible or needless:
/// cold launch (single ordered path — the reliable moment) and system
/// appearance flips in Auto+follow mode (`ThemeChanged`; the app cannot
/// restart itself every time macOS switches appearance). Deterministic and
/// dedup-guarded; stands down entirely once a relaunch is pending.
pub fn apply_app_icon(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if RELAUNCH_PENDING.load(Ordering::SeqCst) {
            return; // the fresh launch owns the icon from here
        }
        let wanted = wanted_icon_variant(&handle);
        apply_icon_variant(&handle, wanted);
    });
}

/// Settings-driven appearance/icon change, as ONE main-thread task so nothing
/// can interleave between its steps:
///   1. `set_theme` — runtime-safe, applied immediately (AppKit-native).
///   2. Decide the icon: `NSApp.effectiveAppearance` now already reflects the
///      theme set in step 1, and the `ThemeChanged` events that theme change
///      produces are delivered only after this task returns — by then either
///      the relaunch is pending (they stand down) or the variant is unchanged
///      (they dedup to a no-op). The old two-task version left exactly this
///      window open, which is where the remaining desyncs lived.
///   3. If the bundle must change icon → controlled relaunch (packaged app);
///      in dev mode there is no bundle icon to show, so best-effort apply.
fn sync_appearance_and_icon(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let theme = {
            let state = handle.state::<AppState>();
            let store = state.store.lock().unwrap();
            theme_for(&store.settings)
        };
        handle.set_theme(theme);

        let wanted = wanted_icon_variant(&handle);
        if wanted == APPLIED_ICON.load(Ordering::SeqCst) {
            return; // bundle already shows it — nothing needs a full refresh
        }
        if macos::app_bundle_path().is_some() {
            begin_relaunch(&handle);
        } else {
            apply_icon_variant(&handle, wanted); // dev mode: no bundle, best effort
        }
    });
}

/// The controlled relaunch: announce → grace period → close windows cleanly →
/// spawn the pid-waiting relauncher → normal quit. The `RELAUNCH_PENDING`
/// swap makes the whole sequence run at most once per process, so no relaunch
/// loop and no duplicate instance is possible even if more settings writes
/// land during the grace period (they are already on disk and simply ride
/// along into the next launch).
fn begin_relaunch(app: &AppHandle) {
    if RELAUNCH_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("raff://relaunching", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(RELAUNCH_NOTICE_MS));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            panel::hide(&inner);
            for (label, window) in inner.webview_windows() {
                if label != panel::PANEL_LABEL {
                    let _ = window.close();
                }
            }
            if let Some(bundle) = macos::app_bundle_path() {
                macos::spawn_relauncher(&bundle, std::process::id());
            }
            // Normal quit: RunEvent::Exit runs (single-instance socket is
            // released), the store is already saved, the monitor thread dies
            // with the process. The relauncher waits for the pid to vanish
            // before `open`ing the bundle again.
            inner.exit(0);
        });
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
        open_window_when_ready(&handle, "update", "update.html", "تحديث رفّ", (360.0, 280.0));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_variants_ignore_both_appearances() {
        for follow in [false, true] {
            for app_dark in [false, true] {
                for sys_dark in [false, true] {
                    assert_eq!(
                        icon_variant(AppIconPref::Light, follow, app_dark, sys_dark),
                        ICON_LIGHT
                    );
                    assert_eq!(
                        icon_variant(AppIconPref::Dark, follow, app_dark, sys_dark),
                        ICON_DARK
                    );
                }
            }
        }
    }

    #[test]
    fn auto_follows_explicit_appearance_when_not_following_system() {
        assert_eq!(icon_variant(AppIconPref::Auto, false, true, false), ICON_DARK);
        assert_eq!(icon_variant(AppIconPref::Auto, false, false, true), ICON_LIGHT);
    }

    #[test]
    fn auto_follows_system_when_following_system() {
        assert_eq!(icon_variant(AppIconPref::Auto, true, false, true), ICON_DARK);
        assert_eq!(icon_variant(AppIconPref::Auto, true, true, false), ICON_LIGHT);
    }

    #[test]
    fn variant_is_never_unknown() {
        for pref in [AppIconPref::Auto, AppIconPref::Light, AppIconPref::Dark] {
            for follow in [false, true] {
                assert_ne!(icon_variant(pref, follow, false, false), ICON_UNKNOWN);
                assert_ne!(icon_variant(pref, follow, true, true), ICON_UNKNOWN);
            }
        }
    }
}
