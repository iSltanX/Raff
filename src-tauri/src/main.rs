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
mod updater;

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
    let mut app = tauri::Builder::default()
        // Must be the first plugin: a second launch exits immediately and this
        // callback runs in the surviving instance instead (no duplicate tray,
        // no second monitor thread writing the same JSON files).
        // `raff --settings` surfaces the settings window; any other relaunch
        // surfaces the panel.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("raff: relaunch forwarded, argv: {argv:?}");
            if argv.iter().any(|a| a == "--settings") {
                commands::open_settings_window(app);
            } else {
                panel::show(app);
            }
        }))
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // Official Tauri 2 auto-updater. Registered here so `app.updater()` is
        // available to the app's own audited update commands (added later);
        // the webview never talks to the plugin directly, so no `updater`
        // capability is granted — the update flow stays Rust-side.
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            updater::check_for_update,
            updater::download_and_install_update,
            updater::restart_to_update,
            updater::consume_update_intent,
        ])
        .on_window_event(|window, event| match event {
            // Keeps the Automatic app icon in sync while following the system
            // appearance (fires when a window's effective theme flips).
            tauri::WindowEvent::ThemeChanged(_) => {
                commands::apply_app_icon(window.app_handle());
            }
            // The update window is a singleton the tray reopens repeatedly —
            // hide instead of destroy so its in-progress state (or a staged
            // "restart" prompt) survives being closed and reshown, exactly
            // like the requirement to show the current operation on reopen.
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "update" => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = storage::Store::load(data_dir);
            let hotkey = store.settings.hotkey.clone();
            let first_run_pending = !store.settings.first_run_shown;
            // Applied directly on `App` (not a cloned AppHandle): at this point
            // in `setup`, `App::set_theme` takes the synchronous runtime path
            // and sets NSApp.appearance immediately, before any window below
            // is created. Going through AppHandle here would instead queue the
            // change onto the event loop, racing the panel/first-run windows'
            // creation and risking a system-appearance flash on cold launch.
            app.set_theme(commands::theme_for(&store.settings));
            app.manage(AppState {
                store: Mutex::new(store),
                skip_change_count: AtomicI64::new(-1),
                previous_app: Mutex::new(None),
            });
            app.manage(updater::UpdaterState::new());

            let handle = app.handle().clone();
            panel::init(&handle)?;
            tray::create(&handle)?;
            commands::apply_app_icon(&handle); // أيقونة التطبيق preference
            if let Err(err) = commands::register_hotkey(&handle, &hotkey) {
                eprintln!("raff: hotkey registration failed: {err}");
            }
            monitor::start(handle.clone());

            if first_run_pending && !macos::ax_trusted() {
                commands::open_firstrun_window(&handle);
            }
            // A controlled relaunch (icon/appearance change) forwards
            // --settings so the user returns to the window they were in.
            // Opening a window never triggers another relaunch, so this
            // cannot loop.
            if std::env::args().any(|a| a == "--settings") {
                commands::open_settings_window(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Raff");

    // Set the Accessory (menu-bar) activation policy on the *built* App, before
    // the run loop starts. At this point `App::set_activation_policy` writes
    // tao's launch-time activation policy, so `applicationDidFinishLaunching`
    // applies Accessory directly instead of tao's default Regular. The app is a
    // menu-bar agent from the first frame — no Dock icon, no ⌘Tab entry, and it
    // is never recorded in the Dock's "Recent Applications". Setting this inside
    // `setup` (which runs after didFinishLaunching) is too late: tao has already
    // applied Regular and activated the app, so the launch is logged in the Dock
    // before the app flips to Accessory. Reinforces the bundle's LSUIElement.
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    app.run(|_app_handle, _event| {});
}
