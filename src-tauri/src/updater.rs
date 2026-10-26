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
//! Step 2 runs the plugin's `download` and `install` back to back in one
//! command — the package buffer never sits in app state between IPC calls —
//! and exposes the *phases* through distinct progress events. They are two
//! calls, not `download_and_install`, so the install can be guarded
//! (`guarded_install`): on macOS the plugin's install moves the running
//! bundle into a temporary directory that is deleted when an error returns.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

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

    /// The state guard, recovering a poisoned lock as `lock_store` does: one
    /// panic mid-update must not turn every later check into a panic too.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
pub async fn check_for_update(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<UpdateCheck, String> {
    crate::access::require(&window, "check_for_update")?;
    {
        let state = app.state::<UpdaterState>();
        let mut inner = state.lock();
        if !inner.machine.begin_check() {
            return Err("هناك عملية تحديث جارية بالفعل.".into());
        }
        inner.pending = None; // a fresh check supersedes any prior result
    }

    let began = std::time::Instant::now();
    let outcome = do_check(&app).await;
    crate::diagnostics::record(
        "update-check",
        match &outcome {
            Ok(Some(_)) => "available",
            Ok(None) => "ok",
            Err(_) => "error",
        },
        began,
    );

    let state = app.state::<UpdaterState>();
    let mut inner = state.lock();
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
pub async fn download_and_install_update(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    crate::access::require(&window, "download_and_install_update")?;
    let update = {
        let state = app.state::<UpdaterState>();
        let mut inner = state.lock();
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

    // The download verifies the package's signature before it returns.
    let result = match update.download(on_chunk, on_finish).await {
        Ok(bytes) => install_bundle(&update, &bytes),
        Err(err) => Err(err.to_string()),
    };

    let state = app.state::<UpdaterState>();
    let mut inner = state.lock();
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
/// Through `crate::relaunch`, which `open`s the updater-replaced bundle only
/// after this process has fully exited and released the single-instance
/// socket, and brings the user back to Settings.
#[tauri::command]
pub async fn restart_to_update(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    crate::access::require(&window, "restart_to_update")?;
    {
        let state = app.state::<UpdaterState>();
        let inner = state.lock();
        if !inner.machine.can_restart() {
            return Err("لا يوجد تحديث مثبَّت لإعادة التشغيل.".into());
        }
    }
    crate::relaunch(&app, true)
}

// ─── Install guard ────────────────────────────────────────────────────────────
//
// The plugin (2.10.1, `install_inner` on macOS) unpacks the new bundle into a
// temporary directory, moves the running bundle into a second one, then the
// new bundle into its place. Should that last move fail, it returns the error
// and the second temporary directory — the working رفّ inside — is deleted
// as it goes out of scope: nothing is left where رفّ was. So before the
// plugin runs, رفّ clones its own bundle beside it (APFS, copy on write);
// after, the bundle in place is checked, and the clone goes back unless it is
// the complete new version. A good install leaves the clone for the new
// version to remove when it starts (`sweep_rollback`): by then the
// replacement has run. Only the bundle is touched; settings and history live
// in Application Support, which no step here reaches.

extern "C" {
    /// libSystem (`sys/clonefile.h`): a copy-on-write clone of a file or a
    /// whole directory tree, on the same APFS volume.
    fn clonefile(
        src: *const std::ffi::c_char,
        dst: *const std::ffi::c_char,
        flags: u32,
    ) -> std::ffi::c_int;
}
const CLONE_NOFOLLOW: u32 = 0x0001;

fn clone_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let src = std::ffi::CString::new(src.as_os_str().as_bytes())?;
    let dst = std::ffi::CString::new(dst.as_os_str().as_bytes())?;
    // SAFETY: two NUL-terminated paths that outlive the call.
    if unsafe { clonefile(src.as_ptr(), dst.as_ptr(), CLONE_NOFOLLOW) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// The bundle the plugin replaces, found the way the plugin finds it; `None`
/// outside an app bundle.
fn installed_bundle() -> Option<PathBuf> {
    let exe = tauri::utils::platform::current_exe().ok()?;
    let bundle = tauri_plugin_updater::extract_path_from_executable(&exe).ok()?;
    (bundle.extension()? == "app").then_some(bundle)
}

/// Where the clone waits: beside the bundle, so it is copy-on-write and the
/// way back is a rename, under a name that is not an app's — nothing takes it
/// for a second رفّ.
fn rollback_path(bundle: &Path) -> Option<PathBuf> {
    let name = bundle.file_name()?.to_str()?;
    Some(bundle.with_file_name(format!(".{name}.update-rollback")))
}

/// A whole app's identifier and version: an Info.plist that reads, naming an
/// executable that is there.
fn bundle_identity(bundle: &Path) -> Option<(String, String)> {
    use std::os::unix::fs::PermissionsExt;
    let info = plist::Value::from_file(bundle.join("Contents/Info.plist")).ok()?;
    let info = info.as_dictionary()?;
    let text = |key: &str| info.get(key).and_then(plist::Value::as_string);
    let exe = bundle
        .join("Contents/MacOS")
        .join(text("CFBundleExecutable")?);
    let exe = std::fs::metadata(exe).ok()?;
    if !exe.is_file() || exe.permissions().mode() & 0o111 == 0 {
        return None;
    }
    Some((
        text("CFBundleIdentifier")?.to_owned(),
        text("CFBundleShortVersionString")?.to_owned(),
    ))
}

/// Removes `path` only if it is a directory holding a whole app with this
/// identifier — a rollback copy of رفّ's — and says whether it did.
fn remove_owned(path: &Path, id: &str) -> bool {
    let is_dir = std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir());
    is_dir
        && bundle_identity(path).is_some_and(|(owner, _)| owner == id)
        && std::fs::remove_dir_all(path).is_ok()
}

/// The clone of `bundle`, with the identifier it carries. `None` — the install
/// then runs as the plugin alone would — when there is no whole bundle to
/// clone, or the clone cannot be made (another file system, no room, no
/// permission), or something not رفّ's sits where it would go.
fn prepare_rollback(bundle: &Path) -> Option<(PathBuf, (String, String))> {
    let identity = bundle_identity(bundle)?;
    let rollback = rollback_path(bundle)?;
    // One left by an install that never finished.
    if std::fs::symlink_metadata(&rollback).is_ok() && !remove_owned(&rollback, &identity.0) {
        eprintln!("raff: no rollback copy for this update: its place is taken");
        return None;
    }
    match clone_tree(bundle, &rollback) {
        Ok(()) => Some((rollback, identity)),
        Err(err) => {
            eprintln!("raff: no rollback copy for this update: {err}");
            None
        }
    }
}

/// Puts the clone back as `bundle`, moving aside whatever the install left.
/// On failure the clone stays where it is, and the error says where.
fn restore(bundle: &Path, rollback: &Path) -> Result<(), String> {
    let kept = |err: std::io::Error| format!("{err}; رفّ's copy stays at {}", rollback.display());
    let name = bundle
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Raff.app");
    let failed = bundle.with_file_name(format!(".{name}.update-failed"));
    if std::fs::symlink_metadata(bundle).is_ok() {
        let _ = std::fs::remove_dir_all(&failed);
        std::fs::rename(bundle, &failed).map_err(kept)?;
    }
    std::fs::rename(rollback, bundle).map_err(kept)?;
    let _ = std::fs::remove_dir_all(&failed);
    Ok(())
}

fn same_version(a: &str, b: &str) -> bool {
    a.trim_start_matches('v') == b.trim_start_matches('v')
}

/// Runs `install` over `bundle` with a way back. The bundle in place is the
/// new `version` on success; on any error it is the one that ran before.
fn guarded_install<E: std::fmt::Display>(
    bundle: &Path,
    version: &str,
    install: impl FnOnce() -> Result<(), E>,
) -> Result<(), String> {
    let guard = prepare_rollback(bundle);
    let result = install().map_err(|err| err.to_string());
    let Some((rollback, (id, before))) = guard else {
        return result;
    };
    let in_place = bundle_identity(bundle);
    let is = |wanted: &str| {
        in_place
            .as_ref()
            .is_some_and(|(current, installed)| *current == id && same_version(installed, wanted))
    };
    match result {
        Ok(()) if is(version) => Ok(()),
        Ok(()) => {
            let undone = restore(bundle, &rollback)
                .map_or_else(|err| format!(", and {err}"), |()| String::new());
            Err(format!("the installed bundle is not {version}{undone}"))
        }
        // Failed before the bundle was touched: the clone has no use.
        Err(err) if is(&before) => {
            remove_owned(&rollback, &id);
            Err(err)
        }
        Err(err) => match restore(bundle, &rollback) {
            Ok(()) => Err(err),
            Err(kept) => Err(format!("{err}, and {kept}")),
        },
    }
}

/// The plugin's install of a downloaded, verified package — guarded where
/// رفّ runs from an app bundle.
fn install_bundle(update: &Update, bytes: &[u8]) -> Result<(), String> {
    match installed_bundle() {
        Some(bundle) => guarded_install(&bundle, &update.version, || update.install(bytes)),
        None => update.install(bytes).map_err(|err| err.to_string()),
    }
}

fn sweep_rollback_at(bundle: &Path) {
    let (Some(rollback), Some((id, _))) = (rollback_path(bundle), bundle_identity(bundle)) else {
        return;
    };
    if std::fs::symlink_metadata(&rollback).is_ok() && !remove_owned(&rollback, &id) {
        eprintln!(
            "raff: left {} in place: not a copy of this رفّ",
            rollback.display()
        );
    }
}

/// At launch. A rollback copy beside this bundle is from an update that put
/// this very process in place, or from one that never finished and left this
/// bundle whole: either way it has served.
pub fn sweep_rollback() {
    if let Some(bundle) = installed_bundle() {
        sweep_rollback_at(&bundle);
    }
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

/// What the update window is asked to do when it next looks: check, or show
/// a version Settings or About already found (audit 022 ج2).
enum Intent {
    Check,
    Show(UpdateCheck),
}

/// Set while a request is pending delivery to the update window. Taken by the
/// first `consume_update_intent` caller.
static PENDING_INTENT: Mutex<Option<Intent>> = Mutex::new(None);

fn set_intent(intent: Intent) {
    *PENDING_INTENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(intent);
}

/// What `consume_update_intent` answers: `true` to check, `false` for
/// nothing, or the found version itself to show.
#[derive(Serialize, Debug)]
#[serde(untagged)]
pub enum Claimed {
    Flag(bool),
    Found(UpdateCheck),
}

/// Tray menu handler: route the request to the standalone update window.
pub fn request_check_from_menu(app: &AppHandle) {
    set_intent(Intent::Check);
    show_update_window(app);
}

fn show_update_window(app: &AppHandle) {
    // Create-or-focus the update window (existing helper; never duplicates).
    crate::commands::open_update_window(app);
    // Covers the already-open case (a live listener receives this). For a
    // freshly created window the event lands before the listener exists and is
    // simply dropped — the on-load poll below claims the flag instead.
    let _ = app.emit("raff://open-updates", ());
}

/// «التحقق» in Settings or About found a newer version: open the same update
/// window the menu opens, so the user can install it from there — showing the
/// version that check is holding. Asking the server again would have dropped
/// it (a fresh check clears `pending`) for the same answer, or a different one
/// than the user was just shown. With nothing held, the window checks.
#[tauri::command]
pub fn open_updates(app: AppHandle) {
    let held = {
        let state = app.state::<UpdaterState>();
        let inner = state.lock();
        inner.pending.as_ref().map(UpdateCheck::available_from)
    };
    set_intent(held.map_or(Intent::Check, Intent::Show));
    show_update_window(&app);
}

/// Claimed once by the update window (on load, and on `raff://open-updates`).
/// Returns true to exactly one caller; every later caller gets false, so the
/// menu can never trigger two checks.
#[tauri::command]
pub fn consume_update_intent(window: tauri::WebviewWindow) -> Result<Claimed, String> {
    crate::access::require(&window, "consume_update_intent")?;
    Ok(take_update_intent())
}

fn take_update_intent() -> Claimed {
    match PENDING_INTENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        None => Claimed::Flag(false),
        Some(Intent::Check) => Claimed::Flag(true),
        Some(Intent::Show(found)) => Claimed::Found(found),
    }
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
        let claim = || serde_json::to_value(take_update_intent()).unwrap();
        set_intent(Intent::Check);
        assert_eq!(claim(), serde_json::json!(true));
        assert_eq!(claim(), serde_json::json!(false));
        assert_eq!(claim(), serde_json::json!(false));

        // What Settings found is handed over as it is, once (022 ج2).
        set_intent(Intent::Show(UpdateCheck::Available {
            current_version: "6.0.1".into(),
            version: "6.1.0".into(),
            date: None,
            notes: None,
        }));
        let found = claim();
        assert_eq!(found["status"], "available");
        assert_eq!(found["version"], "6.1.0");
        assert_eq!(claim(), serde_json::json!(false));
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

    // ── Install guard ────────────────────────────────────────────────────────

    use std::collections::BTreeMap;
    use std::fs;

    const ID: &str = "com.raff.app";

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("raff-guard-{label}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A whole bundle as far as `bundle_identity` and a launch can see one.
    fn fake_bundle(at: &Path, id: &str, version: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(at.join("Contents/MacOS")).unwrap();
        fs::create_dir_all(at.join("Contents/Resources")).unwrap();
        fs::write(
            at.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
                 <key>CFBundleExecutable</key><string>raff</string>\
                 <key>CFBundleIdentifier</key><string>{id}</string>\
                 <key>CFBundleShortVersionString</key><string>{version}</string>\
                 </dict></plist>"
            ),
        )
        .unwrap();
        let exe = at.join("Contents/MacOS/raff");
        fs::write(&exe, format!("raff {version}")).unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            at.join("Contents/Resources/THIRD-PARTY-NOTICES.md"),
            version,
        )
        .unwrap();
    }

    /// Every file under `root` with its bytes, to compare trees.
    fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    out.insert(
                        path.strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(&path).unwrap(),
                    );
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    /// Where the plugin goes wrong, the way it goes there: the new bundle
    /// unpacked into one temporary directory, the running one moved into a
    /// second; then the final move fails, and the second directory is deleted
    /// as `tempfile::TempDir` is dropped (2.10.1 `install_inner`, macOS).
    fn plugin_install(bundle: &Path, new: &Path, fail_after_move_out: bool) -> Result<(), String> {
        let backup =
            std::env::temp_dir().join(format!("tauri_current_app{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&backup).unwrap();
        fs::rename(bundle, backup.join("current_app")).map_err(|e| e.to_string())?;
        let moved_in = if fail_after_move_out {
            Err("Operation not permitted (os error 1)".to_string())
        } else {
            fs::rename(new, bundle).map_err(|e| e.to_string())
        };
        fs::remove_dir_all(&backup).unwrap();
        moved_in
    }

    #[test]
    fn a_failed_final_move_leaves_the_running_bundle_in_place() {
        let s = Scratch::new("final-move");
        let bundle = s.0.join("Raff.app");
        let new = s.0.join("unpacked");
        fake_bundle(&bundle, ID, "7.0.0");
        fake_bundle(&new, ID, "7.0.1");
        let before = tree(&bundle);

        let result = guarded_install(&bundle, "7.0.1", || plugin_install(&bundle, &new, true));

        assert!(result.is_err());
        assert_eq!(
            tree(&bundle),
            before,
            "the running رفّ is back, byte for byte"
        );
        assert!(
            !rollback_path(&bundle).unwrap().exists(),
            "the clone went back as the bundle"
        );
    }

    #[test]
    fn a_good_install_keeps_the_clone_until_the_new_version_runs() {
        let s = Scratch::new("good");
        let bundle = s.0.join("Raff.app");
        let new = s.0.join("unpacked");
        fake_bundle(&bundle, ID, "7.0.0");
        fake_bundle(&new, ID, "7.0.1");
        let old = tree(&bundle);
        // Settings and history live elsewhere, and stay as they are.
        let data = s.0.join("Application Support/com.raff.app");
        fs::create_dir_all(data.join("images")).unwrap();
        fs::write(data.join("settings.json"), br#"{"launchAtLogin":true}"#).unwrap();
        fs::write(data.join("history.json"), b"[]").unwrap();
        fs::write(data.join("images/a.png"), b"png").unwrap();
        let data_before = tree(&data);

        guarded_install(&bundle, "7.0.1", || plugin_install(&bundle, &new, false)).unwrap();

        assert_eq!(bundle_identity(&bundle), Some((ID.into(), "7.0.1".into())));
        let rollback = rollback_path(&bundle).unwrap();
        assert_eq!(
            tree(&rollback),
            old,
            "the way back stays until the new version has run"
        );
        // The new version's first launch.
        sweep_rollback_at(&bundle);
        assert!(!rollback.exists());
        assert_eq!(bundle_identity(&bundle), Some((ID.into(), "7.0.1".into())));
        assert_eq!(tree(&data), data_before);
    }

    #[test]
    fn a_failure_before_the_bundle_is_touched_drops_the_clone() {
        let s = Scratch::new("early");
        let bundle = s.0.join("Raff.app");
        fake_bundle(&bundle, ID, "7.0.0");
        let before = tree(&bundle);
        let result = guarded_install(&bundle, "7.0.1", || Err::<(), _>("failed to unpack entry"));
        assert_eq!(result, Err("failed to unpack entry".into()));
        assert_eq!(tree(&bundle), before);
        assert!(!rollback_path(&bundle).unwrap().exists());
    }

    #[test]
    fn an_install_that_leaves_another_version_is_undone() {
        let s = Scratch::new("wrong");
        let bundle = s.0.join("Raff.app");
        let new = s.0.join("unpacked");
        fake_bundle(&bundle, ID, "7.0.0");
        fake_bundle(&new, ID, "6.0.1");
        let before = tree(&bundle);
        let result = guarded_install(&bundle, "7.0.1", || plugin_install(&bundle, &new, false));
        assert!(result.is_err());
        assert_eq!(tree(&bundle), before);
        assert!(!rollback_path(&bundle).unwrap().exists());
        assert!(!s.0.join(".Raff.app.update-failed").exists());
    }

    #[test]
    fn an_install_that_leaves_half_a_bundle_is_undone() {
        let s = Scratch::new("half");
        let bundle = s.0.join("Raff.app");
        fake_bundle(&bundle, ID, "7.0.0");
        let before = tree(&bundle);
        let result = guarded_install(&bundle, "7.0.1", || {
            fs::remove_file(bundle.join("Contents/MacOS/raff")).unwrap();
            Ok::<(), String>(())
        });
        assert!(result.is_err());
        assert_eq!(tree(&bundle), before);
    }

    #[test]
    fn a_failed_install_that_left_the_new_version_in_part_is_undone() {
        // The admin path's `rm -rf` then a `mv` cut short: the new Info.plist
        // and executable are there, the rest is not.
        let s = Scratch::new("partial-new");
        let bundle = s.0.join("Raff.app");
        fake_bundle(&bundle, ID, "7.0.0");
        let before = tree(&bundle);
        let result = guarded_install(&bundle, "7.0.1", || {
            fs::remove_dir_all(&bundle).unwrap();
            fake_bundle(&bundle, ID, "7.0.1");
            fs::remove_file(bundle.join("Contents/Resources/THIRD-PARTY-NOTICES.md")).unwrap();
            Err::<(), _>("mv: No space left on device")
        });
        assert!(result.is_err());
        assert_eq!(tree(&bundle), before, "the earlier version is back");
        assert!(!rollback_path(&bundle).unwrap().exists());
    }

    #[test]
    fn a_way_back_that_cannot_be_taken_stays_and_is_named() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("stuck");
        let apps = s.0.join("Applications");
        let bundle = apps.join("Raff.app");
        fake_bundle(&bundle, ID, "7.0.0");
        let before = tree(&bundle);
        let result = guarded_install(&bundle, "7.0.1", || {
            fs::remove_dir_all(&bundle).unwrap();
            // Whatever stops the plugin's last move stops the way back too.
            fs::set_permissions(&apps, fs::Permissions::from_mode(0o555)).unwrap();
            Err::<(), _>("Operation not permitted (os error 1)")
        });
        fs::set_permissions(&apps, fs::Permissions::from_mode(0o755)).unwrap();
        let rollback = rollback_path(&bundle).unwrap();
        let err = result.unwrap_err();
        assert!(err.contains(&rollback.display().to_string()), "{err}");
        assert_eq!(
            tree(&rollback),
            before,
            "the copy is whole, where the error says"
        );
    }

    #[test]
    fn a_rollback_copy_left_by_an_interrupted_install_is_swept_only_if_ours() {
        let s = Scratch::new("sweep");
        let bundle = s.0.join("Raff.app");
        fake_bundle(&bundle, ID, "7.0.1");
        let rollback = rollback_path(&bundle).unwrap();

        // Ours: a clone of رفّ.
        fake_bundle(&rollback, ID, "7.0.0");
        sweep_rollback_at(&bundle);
        assert!(!rollback.exists());

        // Not ours: another app's bundle, a plain folder, a link.
        fake_bundle(&rollback, "com.example.other", "1.0");
        sweep_rollback_at(&bundle);
        assert!(rollback.exists(), "another identifier");
        fs::remove_dir_all(&rollback).unwrap();
        fs::create_dir_all(rollback.join("notes")).unwrap();
        sweep_rollback_at(&bundle);
        assert!(
            rollback.join("notes").exists(),
            "a folder that is not a bundle"
        );
        fs::remove_dir_all(&rollback).unwrap();
        let target = s.0.join("target");
        fake_bundle(&target, ID, "7.0.0");
        std::os::unix::fs::symlink(&target, &rollback).unwrap();
        sweep_rollback_at(&bundle);
        assert!(
            target.join("Contents/Info.plist").exists(),
            "a link is not followed"
        );
    }

    #[test]
    fn something_else_in_the_rollback_place_is_left_and_the_install_runs() {
        let s = Scratch::new("taken");
        let bundle = s.0.join("Raff.app");
        let new = s.0.join("unpacked");
        fake_bundle(&bundle, ID, "7.0.0");
        fake_bundle(&new, ID, "7.0.1");
        let rollback = rollback_path(&bundle).unwrap();
        fs::create_dir_all(rollback.join("keep")).unwrap();
        guarded_install(&bundle, "7.0.1", || plugin_install(&bundle, &new, false)).unwrap();
        assert_eq!(bundle_identity(&bundle), Some((ID.into(), "7.0.1".into())));
        assert!(rollback.join("keep").exists());
    }

    #[test]
    fn the_rollback_copy_is_not_an_app() {
        let path = rollback_path(Path::new("/Applications/Raff.app")).unwrap();
        assert_eq!(path, Path::new("/Applications/.Raff.app.update-rollback"));
        assert_ne!(path.extension().and_then(|e| e.to_str()), Some("app"));
    }

    #[test]
    fn versions_compare_with_or_without_a_v() {
        assert!(same_version("7.0.1", "v7.0.1"));
        assert!(!same_version("7.0.1", "7.0.10"));
    }

    // ── End to end: the real plugin ──────────────────────────────────────────

    /// Files at paths, over plain HTTP on 127.0.0.1 (debug builds of the
    /// plugin allow it), one request per connection. `files` is given the
    /// server's address, for the manifests that point back at it.
    fn serve(files: impl FnOnce(&str) -> Vec<(String, Vec<u8>)>) -> String {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let files = files(&base);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(&stream);
                let mut request = String::new();
                if reader.read_line(&mut request).is_err() {
                    continue;
                }
                let mut header = String::new();
                while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
                    header.clear();
                }
                let path = request.split_whitespace().nth(1).unwrap_or_default();
                let (status, body) = files
                    .iter()
                    .find(|(p, _)| p == path)
                    .map_or((404, &[][..]), |(_, body)| (200, &body[..]));
                let mut out = &stream;
                let _ = write!(
                    out,
                    "HTTP/1.1 {status} R\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = out.write_all(body);
            }
        });
        base
    }

    fn untar(archive: &Path, into: &Path) {
        fs::create_dir_all(into).unwrap();
        let ok = std::process::Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(into)
            .status()
            .unwrap()
            .success();
        assert!(ok, "untar {}", archive.display());
    }

    fn codesign_ok(bundle: &Path) -> bool {
        std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .status()
            .is_ok_and(|s| s.success())
    }

    /// The plugin's leftovers in the temporary directory, by its prefixes.
    fn plugin_staging(tmp: &Path) -> Vec<String> {
        fs::read_dir(tmp)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with("tauri_current_app") || n.starts_with("tauri_updated_app"))
            .collect()
    }

    /// The real updater plugin, start to finish, over a copy of an earlier
    /// رفّ: `RAFF_E2E_OLD` (the 7.0.0 that was published) unpacked as the
    /// installed app under `RAFF_E2E_DIR`, `RAFF_E2E_NEW` (this build) served
    /// from 127.0.0.1 and signed with a throwaway key, `RAFF_E2E_BAD` a
    /// truncated copy signed the same way. Nothing is launched, and nothing
    /// outside `RAFF_E2E_DIR` is touched; `TMPDIR` must be inside it, on the
    /// same volume, as the plugin stages there. `scripts/e2e-upgrade.mjs`
    /// prepares all of it.
    #[test]
    #[ignore = "needs the archives scripts/e2e-upgrade.mjs prepares"]
    fn e2e_the_real_plugin_upgrades_an_earlier_release() {
        let env = |key: &str| {
            PathBuf::from(std::env::var_os(key).unwrap_or_else(|| panic!("{key} is not set")))
        };
        let (dir, old, new, bad) = (
            env("RAFF_E2E_DIR"),
            env("RAFF_E2E_OLD"),
            env("RAFF_E2E_NEW"),
            env("RAFF_E2E_BAD"),
        );
        let pubkey = std::env::var("RAFF_E2E_PUBKEY").expect("RAFF_E2E_PUBKEY");
        let tmp = std::env::temp_dir();
        assert!(tmp.starts_with(&dir), "TMPDIR inside RAFF_E2E_DIR");
        let sig =
            |archive: &Path| fs::read_to_string(format!("{}.sig", archive.display())).unwrap();

        // The installed copy, its data beside it, and what the new one must be.
        let install = dir.join("Applications");
        untar(&old, &install);
        let bundle = install.join("Raff.app");
        assert!(codesign_ok(&bundle), "the earlier release as published");
        let old_tree = tree(&bundle);
        let old_identity = bundle_identity(&bundle).unwrap();
        untar(&new, &dir.join("expected"));
        let new_tree = tree(&dir.join("expected/Raff.app"));
        let new_identity = bundle_identity(&dir.join("expected/Raff.app")).unwrap();
        assert_ne!(old_tree, new_tree);
        let data = dir.join("Application Support/com.raff.app");
        fs::create_dir_all(data.join("images")).unwrap();
        fs::write(
            data.join("settings.json"),
            br#"{"launchAtLogin":true,"hotkey":"shift+super+v"}"#,
        )
        .unwrap();
        fs::write(data.join("history.json"), br#"[{"id":"a","text":"e2e"}]"#).unwrap();
        fs::write(data.join("images/a.png"), b"png").unwrap();
        let data_before = tree(&data);

        let manifest = |url: String, sig: String| {
            serde_json::to_vec(&serde_json::json!({
                "version": new_identity.1,
                "notes": "e2e",
                "pub_date": "2026-10-26T00:00:00Z",
                "platforms": {
                    "darwin-aarch64": { "signature": sig, "url": url },
                    "darwin-aarch64-app": { "signature": sig, "url": url },
                },
            }))
            .unwrap()
        };
        let base = serve(|base| {
            vec![
                (
                    "/good.json".into(),
                    manifest(format!("{base}/good.tar.gz"), sig(&new)),
                ),
                ("/good.tar.gz".into(), fs::read(&new).unwrap()),
                (
                    "/bad.json".into(),
                    manifest(format!("{base}/bad.tar.gz"), sig(&bad)),
                ),
                ("/bad.tar.gz".into(), fs::read(&bad).unwrap()),
            ]
        });

        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), serde_json::json!({ "pubkey": pubkey }));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let fetch = |manifest: &str| {
            let updater = app
                .updater_builder()
                .executable_path(bundle.join("Contents/MacOS/raff"))
                .endpoints(vec![format!("{base}/{manifest}").parse().unwrap()])
                .unwrap()
                .build()
                .unwrap();
            tauri::async_runtime::block_on(async {
                let update = updater
                    .check()
                    .await
                    .unwrap()
                    .expect("an update is offered");
                let bytes = update
                    .download(|_, _| {}, || {})
                    .await
                    .expect("signature verified");
                (update, bytes)
            })
        };

        // A package that fails to unpack: the plugin stops before the swap.
        let (update, bytes) = fetch("bad.json");
        let result = guarded_install(&bundle, &update.version, || update.install(&bytes));
        assert!(result.is_err(), "a truncated package does not install");
        assert_eq!(tree(&bundle), old_tree, "the earlier release is untouched");
        assert!(codesign_ok(&bundle));
        assert!(
            !rollback_path(&bundle).unwrap().exists(),
            "no clone left behind"
        );
        assert_eq!(
            plugin_staging(&tmp),
            Vec::<String>::new(),
            "nothing staged left behind"
        );

        // The real package.
        let (update, bytes) = fetch("good.json");
        guarded_install(&bundle, &update.version, || update.install(&bytes)).expect("installed");
        assert_eq!(
            tree(&bundle),
            new_tree,
            "the bundle is the new build, byte for byte"
        );
        assert_eq!(bundle_identity(&bundle), Some(new_identity));
        assert!(codesign_ok(&bundle), "and its signature holds");
        let rollback = rollback_path(&bundle).unwrap();
        assert_eq!(
            tree(&rollback),
            old_tree,
            "the way back is the whole earlier release"
        );
        assert_eq!(bundle_identity(&rollback), Some(old_identity));
        assert_eq!(
            plugin_staging(&tmp),
            Vec::<String>::new(),
            "the plugin's backup went with its scope"
        );
        // The new version's first launch.
        sweep_rollback_at(&bundle);
        assert!(!rollback.exists());
        assert_eq!(tree(&bundle), new_tree);
        let left: Vec<_> = fs::read_dir(&install)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            left,
            vec![std::ffi::OsString::from("Raff.app")],
            "one رفّ, nothing beside it"
        );
        assert_eq!(
            tree(&data),
            data_before,
            "settings, history and images as they were"
        );
    }
}
