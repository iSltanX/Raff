// رفّ (Raff) — personal, local-only, keyboard-first clipboard manager for macOS.
// Background menu-bar app: no Dock icon, one global hotkey, zero network.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod macos;
mod monitor;
mod panel;
mod paste;
mod startup_trace;
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
    startup_trace::init();
    let mut app = tauri::Builder::default()
        // Must be the first plugin: a second launch exits immediately and this
        // callback runs in the surviving instance instead (no duplicate tray,
        // no second monitor thread writing the same JSON files).
        // `raff --settings` surfaces the settings window; any other relaunch
        // surfaces the panel.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("raff: relaunch forwarded, argv: {argv:?}");
            startup_trace::mark(&format!("SINGLE_INSTANCE_FORWARD argv={argv:?}"));
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
            commands::undo_delete,
            commands::commit_delete,
            commands::clear_history,
            commands::clear_learning,
            commands::learning_summary,
            commands::update_settings,
            commands::get_image,
            commands::hide_panel,
            commands::open_settings,
            commands::open_about,
            commands::open_repository,
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
            tauri::WindowEvent::Moved(_) if window.label() == panel::PANEL_LABEL => {
                panel::remember_position(window.app_handle());
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
            startup_trace::mark("setup_enter");
            let data_dir = app.path().app_data_dir()?;
            startup_trace::mark("app_data_dir_resolved");
            let store = storage::Store::load(data_dir);
            startup_trace::mark("storage_loaded");
            let hotkey = store.settings.hotkey.clone();
            let first_run_pending = !store.settings.first_run_shown;
            // Applied directly on `App` (not a cloned AppHandle): at this point
            // in `setup`, `App::set_theme` takes the synchronous runtime path
            // and sets NSApp.appearance immediately, before any window below
            // is created. Going through AppHandle here would instead queue the
            // change onto the event loop, racing the panel/first-run windows'
            // creation and risking a system-appearance flash on cold launch.
            app.set_theme(commands::theme_for(&store.settings));
            startup_trace::mark("theme_applied");
            app.manage(AppState {
                store: Mutex::new(store),
                skip_change_count: AtomicI64::new(-1),
                previous_app: Mutex::new(None),
            });
            app.manage(updater::UpdaterState::new());
            startup_trace::mark("state_managed");

            let handle = app.handle().clone();
            panel::init(&handle)?;
            startup_trace::mark("panel_init_done");
            tray::create(&handle)?;
            startup_trace::mark("tray_created_ICON_NOW_VISIBLE");
            if let Err(err) = commands::register_hotkey(&handle, &hotkey) {
                eprintln!("raff: hotkey registration failed: {err}");
            }
            startup_trace::mark("hotkey_registered");
            monitor::start(handle.clone());
            startup_trace::mark("monitor_started");

            if first_run_pending && !macos::ax_trusted() {
                commands::open_firstrun_window(&handle);
            }
            startup_trace::mark("firstrun_checked");
            // A relaunch carrying --settings (for example after an update)
            // returns the user to the window they were in.
            if std::env::args().any(|a| a == "--settings") {
                commands::open_settings_window(&handle);
            }
            startup_trace::start_stall_detector();
            startup_trace::mark("setup_exit");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Raff");
    startup_trace::mark("build_returned");

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
    startup_trace::mark("activation_policy_set__entering_run_loop");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Ready = event {
            startup_trace::mark("run_loop_READY__events_now_processed");
        }
    });
}
