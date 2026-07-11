// رفّ (Raff) — personal, local-only, keyboard-first clipboard manager for macOS.
// Background menu-bar app: no Dock icon, one global hotkey, zero network.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod macos;
mod monitor;
mod panel;
mod paste;
mod storage;
mod tray;

use std::sync::atomic::AtomicI64;
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

pub struct AppState {
    pub store: Mutex<storage::Store>,
    /// Pasteboard change count produced by our own writes; the monitor skips it.
    pub skip_change_count: AtomicI64,
    /// pid of the app that was frontmost when the panel opened (focus restore).
    pub previous_app: Mutex<Option<i32>>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::paste_item,
            commands::copy_item,
            commands::toggle_pin,
            commands::delete_item,
            commands::clear_history,
            commands::clear_learning,
            commands::learning_summary,
            commands::update_settings,
            commands::get_image,
            commands::hide_panel,
            commands::ax_status,
            commands::request_accessibility,
            commands::open_accessibility_settings,
            commands::firstrun_done,
            commands::list_running_apps,
        ])
        .setup(|app| {
            // Menu-bar app: never show a Dock icon.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir()?;
            let store = storage::Store::load(data_dir);
            let hotkey = store.settings.hotkey.clone();
            let first_run_pending = !store.settings.first_run_shown;
            app.manage(AppState {
                store: Mutex::new(store),
                skip_change_count: AtomicI64::new(-1),
                previous_app: Mutex::new(None),
            });

            let handle = app.handle().clone();
            panel::init(&handle)?;
            tray::create(&handle)?;
            if let Err(err) = commands::register_hotkey(&handle, &hotkey) {
                eprintln!("raff: hotkey registration failed: {err}");
            }
            monitor::start(handle.clone());

            if first_run_pending && !macos::ax_trusted() {
                commands::open_firstrun_window(&handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Raff");
}
