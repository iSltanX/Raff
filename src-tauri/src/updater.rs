//! Official Tauri 2 auto-updater, driven entirely from Rust. The webview never
//! touches the updater plugin directly (no `updater` capability granted); it
//! only calls the three audited commands below, exactly like every other
//! behavior in the app. Kept self-contained in one module so the whole update
//! system can be lifted into the نَسَق app later.
//!
//! Flow — three explicit, user-gated steps:
//!   1. `check_for_update`            — finds an update, holds it, returns info.
//!   2. `download_and_install_update` — downloads + installs (progress events).
//!   3. `restart_to_update`           — relaunches, only after a good install.
//!
//! The plugin's official primitive is `download_and_install` (download then
//! install in one call). Its `download`/`install` split exists but would force
//! us to hold the multi-MB package buffer in app state between IPC calls — more
//! state, no real benefit — so we use the recommended combined call and expose
//! the *phases* through distinct progress events instead of splitting commands.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

// ─── State machine ────────────────────────────────────────────────────────────
//
// A tiny phase machine guards against overlapping operations. It is pure over
// `Phase` (it takes `has_pending` as a bool) so the whole thing is unit-tested
// without needing a real `Update` or `AppHandle`.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// Nothing in flight. There may still be a pending update from a prior check.
    Idle,
    /// A `check()` is running.
    Checking,
    /// A `download_and_install` is running.
    Installing,
    /// Install finished successfully; only a restart remains.
    Installed,
}

/// Outcome of asking to start an install.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum StartInstall {
    Ok,
    Busy,
    NoUpdate,
    AlreadyInstalled,
}

struct Machine {
    phase: Phase,
}

impl Machine {
    fn new() -> Self {
        Self { phase: Phase::Idle }
    }

    /// A check may only start from `Idle` — never while another op is in flight
    /// or after an install has already been staged (a restart is owed then).
    fn begin_check(&mut self) -> bool {
        if self.phase == Phase::Idle {
            self.phase = Phase::Checking;
            true
        } else {
            false
        }
    }

    /// A check always returns the machine to `Idle` (whether it found an update,
    /// found none, or errored — all are retryable).
    fn end_check(&mut self) {
        self.phase = Phase::Idle;
    }

    fn begin_install(&mut self, has_pending: bool) -> StartInstall {
        match self.phase {
            Phase::Checking | Phase::Installing => StartInstall::Busy,
            Phase::Installed => StartInstall::AlreadyInstalled,
            Phase::Idle => {
                if has_pending {
                    self.phase = Phase::Installing;
                    StartInstall::Ok
                } else {
                    StartInstall::NoUpdate
                }
            }
        }
    }

    /// Success stages the update for restart; failure returns to `Idle` so the
    /// held update can simply be retried (the check need not be repeated).
    fn end_install(&mut self, success: bool) {
        self.phase = if success {
            Phase::Installed
        } else {
            Phase::Idle
        };
    }

    fn can_restart(&self) -> bool {
        self.phase == Phase::Installed
    }
}

struct Inner {
    machine: Machine,
    /// The update returned by the last successful check, kept for the install
    /// step. `Update` is `Clone`, so the install clones it out and leaves this
    /// in place — a failed install stays retryable without re-checking.
    pending: Option<Update>,
}

/// Managed state. All update coordination lives behind this one mutex; it is
/// only ever locked for brief, synchronous transitions (never across `.await`).
pub struct UpdaterState {
    inner: Mutex<Inner>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                machine: Machine::new(),
                pending: None,
            }),
        }
    }
}

// ─── Frontend-facing result of a check ────────────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum UpdateErrorKind {
    /// Could not reach or read the update endpoint (connection / fetch failure).
    Network,
    /// The endpoint responded, but the update data was malformed or unusable.
    Invalid,
    /// Anything else.
    Other,
}

/// Structured check outcome. The frontend switches on `status`; the four cases
/// the spec calls for map to `available` / `upToDate` / `error{network|invalid}`.
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateCheck {
    Available {
        #[serde(rename = "currentVersion")]
        current_version: String,
        version: String,
        date: Option<String>,
        notes: Option<String>,
    },
    UpToDate {
        #[serde(rename = "currentVersion")]
        current_version: String,
    },
    Error {
        kind: UpdateErrorKind,
        message: String,
    },
}

impl UpdateCheck {
    fn available_from(u: &Update) -> Self {
        UpdateCheck::Available {
            current_version: u.current_version.clone(),
            version: u.version.clone(),
            // ISO `YYYY-MM-DD` from the announced publish date, when present.
            date: u.date.map(|d| d.date().to_string()),
            notes: u.body.clone().filter(|s| !s.trim().is_empty()),
        }
    }
}

fn classify_check_error(err: &tauri_plugin_updater::Error) -> UpdateErrorKind {
    use tauri_plugin_updater::Error as E;
    match err {
        // Endpoint could not be reached or a valid release JSON not fetched.
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound | E::Http(_) => UpdateErrorKind::Network,
        // The response existed but its data was malformed / unusable.
        E::Serialization(_)
        | E::Semver(_)
        | E::UrlParse(_)
        | E::TargetNotFound(_)
        | E::TargetsNotFound(_) => UpdateErrorKind::Invalid,
        _ => UpdateErrorKind::Other,
    }
}

fn message_for(kind: UpdateErrorKind) -> String {
    match kind {
        UpdateErrorKind::Network => "تعذّر الاتصال بمصدر التحديث. تحقّق من اتصال الإنترنت وحاول مجددًا.",
        UpdateErrorKind::Invalid => "بيانات التحديث غير صالحة.",
        UpdateErrorKind::Other => "تعذّر التحقق من التحديث.",
    }
    .to_string()
}

// ─── Progress event payloads (event names namespaced `raff://update/…`) ───────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedPayload {
    /// Total bytes if the server sent a Content-Length, else null.
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    downloaded: u64,
    total: Option<u64>,
    /// 0–100 when the total is known, else null.
    percent: Option<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    message: String,
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Step 1: check the configured GitHub endpoint. Holds the found `Update` for
/// the install step. Never downloads. Returns a structured `UpdateCheck`; only
/// a "busy" precondition (another op already running) surfaces as an `Err`.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateCheck, String> {
    {
        let state = app.state::<UpdaterState>();
        let mut inner = state.inner.lock().unwrap();
        if !inner.machine.begin_check() {
            return Err("هناك عملية تحديث جارية بالفعل.".into());
        }
        inner.pending = None; // a fresh check supersedes any prior result
    }

    let outcome = do_check(&app).await;

    let state = app.state::<UpdaterState>();
    let mut inner = state.inner.lock().unwrap();
    inner.machine.end_check();
    match outcome {
        Ok(Some(update)) => {
            let dto = UpdateCheck::available_from(&update);
            inner.pending = Some(update);
            Ok(dto)
        }
        Ok(None) => Ok(UpdateCheck::UpToDate {
            current_version: app.package_info().version.to_string(),
        }),
        Err(err) => {
            let kind = classify_check_error(&err);
            eprintln!("raff: update check failed ({kind:?}): {err}");
            Ok(UpdateCheck::Error {
                kind,
                message: message_for(kind),
            })
        }
    }
}

async fn do_check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater()?.check().await
}

/// Step 2: download and install the update found by step 1. Emits progress
/// events throughout. Requires a prior successful check; refuses to run twice
/// or alongside another operation. On failure the machine returns to a
/// retryable state (the held update is preserved).
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    let update = {
        let state = app.state::<UpdaterState>();
        let mut inner = state.inner.lock().unwrap();
        let has_pending = inner.pending.is_some();
        match inner.machine.begin_install(has_pending) {
            StartInstall::Ok => inner
                .pending
                .clone()
                .expect("pending is Some when begin_install returns Ok"),
            StartInstall::Busy => return Err("هناك عملية تحديث جارية بالفعل.".into()),
            StartInstall::AlreadyInstalled => {
                return Err("التحديث مثبَّت بالفعل — أعد تشغيل رفّ لتطبيقه.".into())
            }
            StartInstall::NoUpdate => return Err("لا يوجد تحديث جاهز — افحص التحديثات أولًا.".into()),
        }
    };

    // Download progress. `on_chunk` is FnMut, so it carries its own running
    // counter; `on_download_finish` marks the switch from download to install.
    let mut downloaded: u64 = 0;
    let mut announced = false;
    let chunk_app = app.clone();
    let on_chunk = move |chunk_len: usize, content_len: Option<u64>| {
        downloaded += chunk_len as u64;
        if !announced {
            announced = true;
            let _ = chunk_app.emit(
                "raff://update/started",
                StartedPayload { total: content_len },
            );
        }
        let (total, percent) = match content_len {
            Some(t) if t > 0 => (Some(t), Some((downloaded.min(t) * 100 / t) as u8)),
            _ => (None, None),
        };
        let _ = chunk_app.emit(
            "raff://update/progress",
            ProgressPayload {
                downloaded,
                total,
                percent,
            },
        );
    };
    let finish_app = app.clone();
    let on_finish = move || {
        // Download done; install begins immediately after this callback returns.
        let _ = finish_app.emit("raff://update/installing", ());
    };

    let result = update.download_and_install(on_chunk, on_finish).await;

    let state = app.state::<UpdaterState>();
    let mut inner = state.inner.lock().unwrap();
    match result {
        Ok(()) => {
            inner.machine.end_install(true);
            drop(inner);
            let _ = app.emit("raff://update/installed", ());
            Ok(())
        }
        Err(err) => {
            inner.machine.end_install(false);
            drop(inner);
            eprintln!("raff: update install failed: {err}");
            let message = "تعذّر تنزيل التحديث أو تثبيته. حاول مجددًا.".to_string();
            let _ = app.emit(
                "raff://update/error",
                ErrorPayload {
                    message: message.clone(),
                },
            );
            Err(message)
        }
    }
}

/// Step 3: relaunch to run the freshly installed version. Only valid after a
/// successful install; user data in `app_data_dir` is untouched.
///
/// Not `app.restart()`: that spawns the new process *before* this one exits, so
/// the new process meets the still-held single-instance socket, forwards its
/// argv and exits — leaving nothing running (the exact hazard documented on
/// `macos::spawn_relauncher`). We reuse the app's proven pid-waiting relauncher,
/// same as the icon-change relaunch: it `open`s the (updater-replaced) bundle
/// only after this process has fully exited and released the socket.
#[tauri::command]
pub fn restart_to_update(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<UpdaterState>();
        let inner = state.inner.lock().unwrap();
        if !inner.machine.can_restart() {
            return Err("لا يوجد تحديث مثبَّت لإعادة التشغيل.".into());
        }
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || match crate::macos::app_bundle_path() {
        // Packaged app: pid-waiting relaunch, then a clean exit that releases
        // the single-instance socket for the relauncher's `open`.
        Some(bundle) => {
            crate::macos::spawn_relauncher(&bundle, std::process::id());
            handle.exit(0);
        }
        // Dev mode: no .app bundle to hand to LaunchServices; the official
        // primitive is the only option (and single-instance is not bundled the
        // same way in `tauri dev`).
        None => handle.restart(),
    });
    Ok(())
}

// ─── Menu entry point ─────────────────────────────────────────────────────────
//
// The tray's «التحقق من وجود تحديثات…» must run the *same* manual check the
// update window's flow runs — never a parallel path, and it no longer opens
// Settings at all. It opens/focuses the small standalone "update" window and
// asks it to run its own check. Delivery is reliable without any arbitrary
// delay: a consume-once flag is claimed by whichever arrives first — the
// update window's on-load poll (freshly created window) or the event
// (already-open window) — so the request is never lost and the check never
// runs twice.

/// Set while a menu-driven "check for updates" is pending delivery to the
/// update window. Cleared by the first `consume_update_intent` caller.
static PENDING_MENU_CHECK: AtomicBool = AtomicBool::new(false);

/// Tray menu handler: route the request to the standalone update window.
pub fn request_check_from_menu(app: &AppHandle) {
    PENDING_MENU_CHECK.store(true, Ordering::SeqCst);
    // Create-or-focus the update window (existing helper; never duplicates).
    crate::commands::open_update_window(app);
    // Covers the already-open case (a live listener receives this). For a
    // freshly created window the event lands before the listener exists and is
    // simply dropped — the on-load poll below claims the flag instead.
    let _ = app.emit("raff://open-updates", ());
}

/// Claimed once by the update window (on load, and on `raff://open-updates`).
/// Returns true to exactly one caller; every later caller gets false, so the
/// menu can never trigger two checks.
#[tauri::command]
pub fn consume_update_intent() -> bool {
    PENDING_MENU_CHECK.swap(false, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Phase machine / concurrency ──────────────────────────────────────────

    #[test]
    fn fresh_machine_is_idle() {
        let m = Machine::new();
        assert_eq!(m.phase, Phase::Idle);
        assert!(!m.can_restart());
    }

    #[test]
    fn second_concurrent_check_is_rejected() {
        let mut m = Machine::new();
        assert!(m.begin_check());
        assert_eq!(m.phase, Phase::Checking);
        assert!(!m.begin_check()); // already checking → rejected
        m.end_check();
        assert_eq!(m.phase, Phase::Idle);
        assert!(m.begin_check()); // retryable after the first finishes
    }

    #[test]
    fn install_without_a_pending_update_is_rejected() {
        let mut m = Machine::new();
        assert_eq!(m.begin_install(false), StartInstall::NoUpdate);
        assert_eq!(m.phase, Phase::Idle); // stays idle, still retryable
    }

    #[test]
    fn install_needs_check_not_in_flight() {
        let mut m = Machine::new();
        assert!(m.begin_check());
        assert_eq!(m.begin_install(true), StartInstall::Busy); // check in flight
    }

    #[test]
    fn second_concurrent_install_is_rejected() {
        let mut m = Machine::new();
        assert_eq!(m.begin_install(true), StartInstall::Ok);
        assert_eq!(m.phase, Phase::Installing);
        assert_eq!(m.begin_install(true), StartInstall::Busy); // already installing
        assert!(!m.begin_check()); // and no check may interleave
    }

    #[test]
    fn successful_install_stages_restart_and_blocks_reinstall() {
        let mut m = Machine::new();
        assert_eq!(m.begin_install(true), StartInstall::Ok);
        m.end_install(true);
        assert_eq!(m.phase, Phase::Installed);
        assert!(m.can_restart());
        // No second install and no check once staged.
        assert_eq!(m.begin_install(true), StartInstall::AlreadyInstalled);
        assert!(!m.begin_check());
    }

    #[test]
    fn failed_install_returns_to_retryable_idle() {
        let mut m = Machine::new();
        assert_eq!(m.begin_install(true), StartInstall::Ok);
        m.end_install(false);
        assert_eq!(m.phase, Phase::Idle);
        assert!(!m.can_restart());
        // The held update can be installed again without re-checking.
        assert_eq!(m.begin_install(true), StartInstall::Ok);
    }

    #[test]
    fn menu_intent_is_consumed_once() {
        // A menu click sets the flag; exactly one claimer sees it, so the tray
        // entry point can never trigger two checks for one click.
        PENDING_MENU_CHECK.store(true, Ordering::SeqCst);
        assert!(consume_update_intent());
        assert!(!consume_update_intent());
        assert!(!consume_update_intent());
    }

    #[test]
    fn restart_requires_a_completed_install() {
        let mut m = Machine::new();
        assert!(!m.can_restart()); // idle
        m.begin_check();
        assert!(!m.can_restart()); // checking
        m.end_check();
        m.begin_install(true);
        assert!(!m.can_restart()); // installing
        m.end_install(true);
        assert!(m.can_restart()); // installed
    }

    // ── Check-result → payload conversion ────────────────────────────────────

    #[test]
    fn available_payload_shape() {
        let dto = UpdateCheck::Available {
            current_version: "1.2.1".into(),
            version: "1.3.0".into(),
            date: Some("2026-07-15".into()),
            notes: Some("ملاحظات".into()),
        };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["status"], "available");
        assert_eq!(v["currentVersion"], "1.2.1");
        assert_eq!(v["version"], "1.3.0");
        assert_eq!(v["date"], "2026-07-15");
        assert_eq!(v["notes"], "ملاحظات");
    }

    #[test]
    fn up_to_date_payload_shape() {
        let dto = UpdateCheck::UpToDate {
            current_version: "1.2.1".into(),
        };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["status"], "upToDate");
        assert_eq!(v["currentVersion"], "1.2.1");
    }

    #[test]
    fn error_payload_shape() {
        let dto = UpdateCheck::Error {
            kind: UpdateErrorKind::Network,
            message: message_for(UpdateErrorKind::Network),
        };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["status"], "error");
        assert_eq!(v["kind"], "network");
        assert!(v["message"].as_str().unwrap().contains("مصدر التحديث"));
    }
}
