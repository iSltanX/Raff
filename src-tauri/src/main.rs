// رفّ (Raff) — personal, keyboard-first clipboard manager for macOS.
// Background menu-bar app: no Dock icon, one global hotkey. Clipboard content
// never leaves the machine; the network is used only for update checks and
// for a problem report the user previews and confirms.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod diagnostics;
mod macos;
mod monitor;
mod panel;
mod paste;
mod report;
mod report_image;
mod startup_trace;
mod storage;
mod tray;
mod updater;

use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

pub struct AppState {
    pub store: Mutex<storage::Store>,
    /// Pasteboard change count produced by our own writes; the monitor skips it.
    pub skip_change_count: AtomicI64,
    /// pid of the app that was frontmost when the panel opened (focus restore).
    pub previous_app: Mutex<Option<i32>>,
    /// False once the capture loop has given up. `capture_enabled` is a
    /// setting — what the user asked for — and cannot answer whether capture
    /// is actually running, which is why a silent death used to look exactly
    /// like a healthy app.
    pub capture_alive: AtomicBool,
    /// Capture held off on purpose.
    pub pause: Mutex<Pause>,
}

/// Capture deliberately held off — the answer to «نسختُ سرًّا للتو» in the
/// second it happens.
///
/// Not a setting: it must not survive a restart, and it must never look like
/// the user turned capture off for good. Nothing about a change skipped this
/// way is recorded anywhere — not its text, not its source, not its length.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Pause {
    #[default]
    Off,
    /// Skip the next clipboard change, then clear.
    SkipNext,
    /// Skip everything until this time of day; `None` means until Raff
    /// restarts.
    ///
    /// Wall-clock time, not `Instant`: on macOS `Instant` is
    /// `CLOCK_UPTIME_RAW`, which stops while the Mac sleeps, so «١٥ دقيقة»
    /// followed by a closed lid used to come back still paused for whatever
    /// was left. The price is that moving the clock by hand moves the end too.
    Until(Option<SystemTime>),
}

/// What is left of a pause that ends at `until`, or zero once it has passed.
pub fn pause_left(until: SystemTime) -> Duration {
    until
        .duration_since(SystemTime::now())
        .unwrap_or(Duration::ZERO)
}

impl Pause {
    /// Starts a pause of `minutes`, or until restart when `None`.
    pub fn for_minutes(minutes: Option<u64>) -> Self {
        Pause::Until(minutes.map(|m| SystemTime::now() + Duration::from_secs(m * 60)))
    }

    /// Whether the change being looked at must be skipped, advancing the
    /// state: a one-shot skip is spent here, and an elapsed pause ends here.
    pub fn consume(&mut self) -> bool {
        match *self {
            Pause::Off => false,
            Pause::SkipNext => {
                *self = Pause::Off;
                true
            }
            Pause::Until(None) => true,
            Pause::Until(Some(until)) => {
                if !pause_left(until).is_zero() {
                    true
                } else {
                    *self = Pause::Off;
                    false
                }
            }
        }
    }

    pub fn is_active(&self) -> bool {
        *self != Pause::Off
    }

    /// What the interface may say about the pause: its kind and, for a timed
    /// one, the whole minutes left. A timed pause that has run out is off,
    /// even before the next copy or the expiry timer clears it.
    pub fn view(&self) -> PauseView {
        match *self {
            Pause::Off => PauseView::default(),
            Pause::SkipNext => PauseView {
                kind: "skipNext",
                ..PauseView::default()
            },
            Pause::Until(None) => PauseView {
                kind: "untilRestart",
                ..PauseView::default()
            },
            Pause::Until(Some(until)) => {
                let left = pause_left(until);
                if left.is_zero() {
                    return PauseView::default();
                }
                PauseView {
                    kind: "timed",
                    minutes_left: Some(left.as_secs().div_ceil(60).max(1)),
                }
            }
        }
    }
}

/// A pause as the panel, Settings and the menu describe it. Nothing about
/// what was skipped — only that, and until when.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseView {
    /// "off" | "skipNext" | "timed" | "untilRestart"
    pub kind: &'static str,
    pub minutes_left: Option<u64>,
}

impl Default for PauseView {
    fn default() -> Self {
        Self {
            kind: "off",
            minutes_left: None,
        }
    }
}

/// Whether to open the welcome on launch. Only whether it was ever shown
/// matters: the capture question has nothing to do with the paste
/// permission, so a permission already granted (a reinstall, say) must not
/// skip it.
pub fn should_open_welcome(first_run_shown: bool) -> bool {
    !first_run_shown
}

/// The store guard, recovering a poisoned lock instead of propagating the panic.
///
/// One panic anywhere that holds this lock would otherwise turn every later
/// `lock().unwrap()` into a second panic — ending the capture thread for the
/// rest of the session, with the menu-bar icon and the settings toggle both
/// still saying everything is fine. The durable JSON files are the reference
/// either way, so the model in memory stays usable and recovering is strictly
/// better than spreading the failure.
pub fn lock_pause(pause: &Mutex<Pause>) -> MutexGuard<'_, Pause> {
    pause
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn lock_store(store: &Mutex<storage::Store>) -> MutexGuard<'_, storage::Store> {
    store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The remembered front app, under the same policy: a panic while it was held
/// must not cost every later panel open and paste a panic of its own.
pub fn lock_previous_app(previous_app: &Mutex<Option<i32>>) -> MutexGuard<'_, Option<i32>> {
    previous_app
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts رفّ again — the one path every restart takes: the update window,
/// «إعادة تشغيل رفّ» in the panel and Settings, and the menu item.
///
/// Not `AppHandle::restart`: that spawns the new process *before* this one
/// exits, so the new process meets the still-held single-instance socket,
/// forwards its argv and exits — and then this one exits too, leaving nothing
/// running. The detached relauncher (`macos::spawn_relauncher`) waits for this
/// pid to be gone first. `reopen_settings` brings Settings back in the new
/// process.
pub fn relaunch(app: &tauri::AppHandle, reopen_settings: bool) -> Result<(), String> {
    let handle = app.clone();
    let Some(bundle) = macos::app_bundle_path() else {
        // Dev mode has no packaged bundle for LaunchServices.
        return app
            .run_on_main_thread(move || handle.restart())
            .map_err(|err| format!("تعذّر جدولة إعادة تشغيل Raff: {err}"));
    };
    // Do not exit unless the detached relauncher really exists.
    macos::spawn_relauncher(&bundle, std::process::id(), reopen_settings)?;
    app.run_on_main_thread(move || handle.exit(0))
        .map_err(|err| format!("تعذّر جدولة إعادة تشغيل Raff: {err}"))
}

/// Debug builds only: `RAFF_DATA_DIR` points the store somewhere else, so a
/// development run never reads or writes the installed رفّ's history.
fn dev_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("RAFF_DATA_DIR").filter(|d| !d.is_empty()) {
        return Some(std::path::PathBuf::from(dir));
    }
    None
}

/// Debug builds only: `RAFF_DEV_ISOLATED=1` runs beside the installed رفّ
/// instead of handing the launch over to it (same bundle identifier).
fn dev_isolated() -> bool {
    cfg!(debug_assertions) && std::env::var("RAFF_DEV_ISOLATED").is_ok_and(|v| v == "1")
}

fn main() {
    startup_trace::init();
    let mut builder = tauri::Builder::default();
    if !dev_isolated() {
        // Must be the first plugin: a second launch exits immediately and this
        // callback runs in the surviving instance instead (no duplicate tray,
        // no second monitor thread writing the same JSON files).
        // `raff --settings` surfaces the settings window; any other relaunch
        // surfaces the panel.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("raff: relaunch forwarded, argv: {argv:?}");
            startup_trace::mark("SINGLE_INSTANCE_FORWARD");
            if argv.iter().any(|a| a == "--settings") {
                commands::open_settings_window(app);
            } else {
                panel::show(app);
            }
        }));
    }
    let mut app = builder
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
            commands::get_settings,
            commands::search_items,
            commands::paste_item,
            commands::copy_item,
            commands::toggle_pin,
            commands::reorder_pinned,
            commands::delete_item,
            commands::undo_delete,
            commands::commit_delete,
            commands::clear_history,
            commands::clear_learning,
            commands::learning_summary,
            commands::update_settings,
            commands::get_image,
            commands::hide_panel,
            commands::panel_preview_side,
            commands::set_panel_preview,
            commands::show_panel,
            commands::open_settings,
            commands::open_about,
            commands::open_repository,
            commands::open_privacy_policy,
            commands::ax_status,
            commands::request_accessibility,
            commands::open_accessibility_settings,
            commands::firstrun_done,
            commands::list_running_apps,
            commands::resume_capture,
            commands::restart_app,
            commands::open_report,
            report::report_prepare,
            report::report_send,
            report::report_copy,
            report::report_copy_number,
            report::report_pick_image,
            report::report_paste_image,
            report::report_remove_image,
            report::diagnostics_copy,
            updater::check_for_update,
            updater::download_and_install_update,
            updater::restart_to_update,
            updater::consume_update_intent,
            updater::open_updates,
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
            // A report is forgotten with its window: the frozen payload, its
            // key and the image never outlive what the user was looking at.
            tauri::WindowEvent::Destroyed if window.label() == "report" => report::reset(),
            // Closing the welcome is an answer too: it does not come back on
            // every launch. «تم» marks it the same way, before closing.
            tauri::WindowEvent::Destroyed if window.label() == "firstrun" => {
                let state = window.state::<AppState>();
                let mut store = lock_store(&state.store);
                if !store.settings.first_run_shown {
                    if let Err(err) = store.mark_first_run_shown_persisted() {
                        eprintln!("raff: could not record the welcome as shown: {err}");
                    }
                }
            }
            _ => {}
        })
        .setup(|app| {
            startup_trace::mark("setup_enter");
            diagnostics::init();
            report::warm();
            let data_dir = match dev_data_dir() {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
            startup_trace::set_dir(&data_dir);
            startup_trace::mark("app_data_dir_resolved");
            let store = storage::Store::load(data_dir);
            startup_trace::mark("storage_loaded");
            let hotkey = store.settings.hotkey.clone();
            let open_welcome = should_open_welcome(store.settings.first_run_shown);
            let capture_enabled = store.settings.capture_enabled;
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
                capture_alive: AtomicBool::new(true),
                pause: Mutex::new(Pause::default()),
            });
            app.manage(updater::UpdaterState::new());
            startup_trace::mark("state_managed");

            let handle = app.handle().clone();
            panel::init(&handle)?;
            startup_trace::mark("panel_init_done");
            tray::create(&handle)?;
            // So the icon is truthful from the first frame, not from whenever
            // something first happens to ask.
            tray::note_permission(macos::ax_trusted());
            tray::note_capture_enabled(capture_enabled);
            startup_trace::mark("tray_created_ICON_NOW_VISIBLE");
            if let Err(err) = commands::register_hotkey(&handle, &hotkey) {
                eprintln!("raff: hotkey registration failed: {err}");
            }
            startup_trace::mark("hotkey_registered");
            monitor::start(handle.clone());
            startup_trace::mark("monitor_started");

            if open_welcome {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_next_spends_itself_on_exactly_one_change() {
        let mut pause = Pause::SkipNext;
        assert!(pause.consume(), "the copy the user is worried about");
        assert!(
            !pause.consume(),
            "and the one after it is captured normally"
        );
        assert_eq!(pause, Pause::Off);
    }

    #[test]
    fn a_pause_until_restart_never_lets_anything_through() {
        let mut pause = Pause::Until(None);
        for _ in 0..5 {
            assert!(pause.consume());
        }
        assert!(pause.is_active());
    }

    #[test]
    fn a_timed_pause_holds_until_it_elapses_and_then_clears_itself() {
        let mut pause = Pause::for_minutes(Some(15));
        assert!(pause.consume());

        let mut elapsed = Pause::Until(Some(SystemTime::now() - Duration::from_secs(1)));
        assert!(!elapsed.consume(), "an elapsed pause stops skipping");
        assert!(!elapsed.is_active(), "and stops calling itself a pause");
    }

    #[test]
    fn the_welcome_opens_until_it_was_shown_whatever_the_permission() {
        assert!(should_open_welcome(false));
        assert!(!should_open_welcome(true));
    }

    #[test]
    fn a_pause_is_described_without_anything_it_skipped() {
        assert_eq!(Pause::Off.view().kind, "off");
        assert_eq!(Pause::SkipNext.view().kind, "skipNext");
        assert_eq!(Pause::Until(None).view().kind, "untilRestart");
        let timed = Pause::for_minutes(Some(15)).view();
        assert_eq!(timed.kind, "timed");
        assert_eq!(timed.minutes_left, Some(15));
        let json = serde_json::to_value(Pause::for_minutes(Some(60)).view()).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["kind", "minutesLeft"]);
    }

    #[test]
    fn a_timed_pause_that_ran_out_reads_as_off_before_anything_clears_it() {
        let elapsed = Pause::Until(Some(SystemTime::now() - Duration::from_secs(1)));
        assert_eq!(elapsed.view(), PauseView::default());
    }

    /// H10: the end of a timed pause is a time of day, so hours the Mac spent
    /// asleep count towards it. `Instant` (`CLOCK_UPTIME_RAW` on macOS) would
    /// not have moved through them. The sleep itself cannot happen in a unit
    /// test; scenario 10 of the manual checklist covers it on a real Mac.
    #[test]
    fn a_timed_pause_ends_at_a_time_of_day() {
        let before = SystemTime::now();
        let Pause::Until(Some(until)) = Pause::for_minutes(Some(15)) else {
            panic!("a timed pause has an end");
        };
        let after = SystemTime::now();
        assert!(until >= before + Duration::from_secs(15 * 60));
        assert!(until <= after + Duration::from_secs(15 * 60));

        // A Mac that slept through the end finds it over, on the first look.
        let mut slept_through = Pause::Until(Some(before - Duration::from_secs(2 * 60 * 60)));
        assert_eq!(slept_through.view(), PauseView::default());
        assert!(!slept_through.consume());
        assert_eq!(slept_through, Pause::Off);
    }

    #[test]
    fn a_poisoned_store_lock_still_yields_a_usable_guard() {
        let store = Mutex::new(storage::Store::load(
            std::env::temp_dir().join(format!("raff-poison-test-{}", uuid::Uuid::new_v4())),
        ));

        // Poison it exactly the way a panic in any command handler would.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = store.lock().unwrap();
            panic!("a command handler panicked while holding the store");
        }));
        assert!(store.is_poisoned(), "the lock really is poisoned");
        assert!(
            store.lock().is_err(),
            "so the old `lock().unwrap()` would have panicked here"
        );

        // The durable JSON files are the reference either way, so the model in
        // memory stays usable and capture must not die with the panic.
        let guard = lock_store(&store);
        assert!(guard.history.is_empty());
    }

    /// The policy above, held in every module rather than only for the store
    /// (RAFF-AUD-004): production code never unwraps a lock it takes.
    #[test]
    fn no_production_code_unwraps_a_lock() {
        let modules = [
            ("commands.rs", include_str!("commands.rs")),
            ("diagnostics.rs", include_str!("diagnostics.rs")),
            ("macos.rs", include_str!("macos.rs")),
            ("main.rs", include_str!("main.rs")),
            ("monitor.rs", include_str!("monitor.rs")),
            ("panel.rs", include_str!("panel.rs")),
            ("paste.rs", include_str!("paste.rs")),
            ("report.rs", include_str!("report.rs")),
            ("report_image.rs", include_str!("report_image.rs")),
            ("startup_trace.rs", include_str!("startup_trace.rs")),
            ("storage.rs", include_str!("storage.rs")),
            ("tray.rs", include_str!("tray.rs")),
            ("updater.rs", include_str!("updater.rs")),
        ];
        for (name, source) in modules {
            // Up to the first test module — not the first `#[cfg(test)]`, which
            // may be a one-line test hook inside production code.
            let production = source.split("\n#[cfg(test)]\nmod ").next().unwrap();
            assert!(
                production.len() < source.len(),
                "{name} has a test module to stop at"
            );
            let compact: String = production.chars().filter(|c| !c.is_whitespace()).collect();
            for raw in [".lock().unwrap()", ".lock().expect("] {
                assert!(
                    !compact.contains(raw),
                    "{name} still takes a lock with `{raw}`"
                );
            }
        }
    }

    #[test]
    fn a_poisoned_previous_app_lock_still_yields_a_usable_guard() {
        let previous_app = Mutex::new(Some(7));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = previous_app.lock().unwrap();
            panic!("a panel show panicked while holding the front app");
        }));
        assert!(previous_app.is_poisoned());
        assert_eq!(lock_previous_app(&previous_app).take(), Some(7));
    }
}
