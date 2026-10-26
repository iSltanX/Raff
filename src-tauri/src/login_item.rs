//! «افتح رفّ عند تسجيل الدخول»: one registration, the one macOS shows as رفّ.
//!
//! On macOS 13 and later it is `SMAppService.mainApp` — the app itself as a
//! login item, under رفّ's name and icon in System Settings, and whatever the
//! user changes there is what `status` reads back. macOS 12 has no
//! SMAppService; there the LaunchAgent the autostart plugin writes stays, and
//! macOS 12 lists no background items to show it twice.
//!
//! Up to 7.0.0 every macOS got that LaunchAgent: `~/Library/LaunchAgents/
//! Raff.plist`, running the executable inside the bundle. Signed ad hoc, with
//! no team to tie it to an app, System Settings lists it by the executable's
//! name — «raff» with a generic icon — and beside it any login item رفّ has,
//! «Raff» with its icon. A Mac with both started رفّ twice at every login; the
//! second process handed over to the first and quit. `migrate` moves a Mac
//! off the LaunchAgent once, keeping the user's answer: what was off — the
//! switch in رفّ, which deleted the file, or the LaunchAgent in System
//! Settings — stays off, and nothing that was on stops opening رفّ.
//!
//! Only a LaunchAgent this very copy would have written is touched
//! (`owned_legacy_plist`). Nothing here unloads a launchd job, resets the
//! background-items database, or reaches any other app's entry. What System
//! Settings goes on listing after a file is gone is macOS's own record, and
//! macOS decides when it goes.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

use crate::commands::err::{
    LOGIN_ITEM_FAILED as FAILED, LOGIN_ITEM_NEEDS_APPROVAL as NEEDS_APPROVAL,
};

/// `SMAppServiceStatus`, in its order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    NotRegistered,
    Enabled,
    /// Registered, and turned off by the user in System Settings.
    RequiresApproval,
    NotFound,
}

impl Status {
    fn from_raw(raw: isize) -> Self {
        match raw {
            1 => Self::Enabled,
            2 => Self::RequiresApproval,
            3 => Self::NotFound,
            _ => Self::NotRegistered,
        }
    }
}

/// What رفّ asks of Service Management. `MainApp` is the real one; the tests
/// stand in for macOS with their own.
pub trait Registry {
    /// The main app as a login item.
    fn status(&self) -> Status;
    /// Error text is for the log only.
    fn register(&self) -> Result<(), String>;
    fn unregister(&self) -> Result<(), String>;
    /// How System Settings treats a LaunchAgent plist.
    fn legacy_status(&self, plist: &Path) -> Status;
}

/// What `migrate` did, for the log and the tests.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Migrated {
    /// No LaunchAgent of this copy's.
    Nothing,
    /// The LaunchAgent is gone, and رفّ opens at login as a login item.
    Moved,
    /// The LaunchAgent is gone, and nothing was registered in its place: it
    /// was off in رفّ or in System Settings.
    Removed,
    /// The LaunchAgent stays — macOS would not register رفّ, the login item
    /// waits for the user in System Settings, or the file would not go — so
    /// the next login still opens رفّ, and the next launch looks again.
    Kept,
}

/// Moves this copy from an earlier version's LaunchAgent to the login item,
/// once.
///
/// The file is the user's answer, not the stored switch: up to 7.0.0 turning
/// the switch off deleted it, so it is there only while it was on — and
/// settings that could not be read come back with the switch off. System
/// Settings may have overruled it since: a LaunchAgent turned off there is
/// removed with nothing in its place. A login item waiting there for the
/// user's approval — refused, or not yet approved — is not registered over;
/// the LaunchAgent keeps opening رفّ until it is decided.
///
/// Safe at every launch and after an interruption at any step: it registers
/// only what is not registered, removes the LaunchAgent only once the login
/// item stands or the user turned the LaunchAgent off, and never unregisters.
pub fn migrate(registry: &dyn Registry, legacy: Option<&Path>) -> Migrated {
    let Some(plist) = legacy else {
        return Migrated::Nothing;
    };
    let moved = registry.legacy_status(plist) != Status::RequiresApproval;
    if moved {
        match registry.status() {
            Status::Enabled => {}
            Status::RequiresApproval => return Migrated::Kept,
            Status::NotRegistered | Status::NotFound => {
                if let Err(err) = registry.register() {
                    eprintln!("raff: login item registration failed: {err}");
                }
                if registry.status() != Status::Enabled {
                    return Migrated::Kept;
                }
            }
        }
    }
    if let Err(err) = std::fs::remove_file(plist) {
        eprintln!("raff: could not remove the earlier LaunchAgent: {err}");
        return Migrated::Kept;
    }
    if moved {
        Migrated::Moved
    } else {
        Migrated::Removed
    }
}

/// Whether the next login opens رفّ: the login item, or an earlier version's
/// LaunchAgent still waiting to be moved and not turned off.
pub fn is_on(registry: &dyn Registry, legacy: Option<&Path>) -> bool {
    registry.status() == Status::Enabled
        || legacy.is_some_and(|plist| registry.legacy_status(plist) != Status::RequiresApproval)
}

/// The Settings switch. Either way an earlier version's LaunchAgent goes: on
/// is the login item, off is off.
pub fn set(registry: &dyn Registry, legacy: Option<&Path>, on: bool) -> Result<(), &'static str> {
    if on {
        if registry.status() != Status::Enabled {
            // Already registered comes back as an error too; the status
            // read after it is the answer.
            if let Err(err) = registry.register() {
                eprintln!("raff: login item registration failed: {err}");
            }
        }
        match registry.status() {
            Status::Enabled => {}
            Status::RequiresApproval => return Err(NEEDS_APPROVAL),
            Status::NotRegistered | Status::NotFound => return Err(FAILED),
        }
    } else {
        if matches!(
            registry.status(),
            Status::Enabled | Status::RequiresApproval
        ) {
            if let Err(err) = registry.unregister() {
                eprintln!("raff: login item unregistration failed: {err}");
            }
        }
        if registry.status() == Status::Enabled {
            return Err(FAILED);
        }
    }
    if let Some(plist) = legacy {
        if let Err(err) = std::fs::remove_file(plist) {
            eprintln!("raff: could not remove the earlier LaunchAgent: {err}");
            // Turned off, it would still open رفّ at the next login.
            if !on {
                return Err(FAILED);
            }
        }
    }
    Ok(())
}

/// The LaunchAgent an earlier رفّ wrote for this very copy, if it is there:
/// `<dir>/<name>.plist`, a regular file holding exactly what the autostart
/// plugin (auto-launch 0.5) writes — the label `name`, this executable as the
/// one program argument, run at load. Another copy's, a build's, or anyone
/// else's file at that path is not رفّ's to remove.
pub fn owned_legacy_plist(dir: &Path, name: &str, exe: &Path) -> Option<PathBuf> {
    let path = dir.join(format!("{name}.plist"));
    if !std::fs::symlink_metadata(&path).ok()?.file_type().is_file() {
        return None;
    }
    let value = plist::Value::from_file(&path).ok()?;
    let dict = value.as_dictionary()?;
    let args = dict.get("ProgramArguments")?.as_array()?;
    let owned = dict.len() == 3
        && dict.get("Label")?.as_string()? == name
        && dict.get("RunAtLoad")?.as_boolean()?
        && args.len() == 1;
    if !owned {
        return None;
    }
    // The plugin wrote the canonical path of the executable that enabled it.
    let program = Path::new(args[0].as_string()?).canonicalize().ok()?;
    (program == exe.canonicalize().ok()?).then_some(path)
}

// ─── macOS ─────────────────────────────────────────────────────────────────────

#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

/// An Objective-C exception from Service Management or Foundation stops here;
/// it would otherwise end رفّ, not one question to macOS.
fn caught<R>(call: impl FnOnce() -> R) -> Option<R> {
    objc2::exception::catch(std::panic::AssertUnwindSafe(call)).ok()
}

/// `SMAppService.mainApp`, where this macOS has the class (13 and later).
pub struct MainApp(objc2::rc::Retained<objc2::runtime::AnyObject>);

impl MainApp {
    pub fn get() -> Option<Self> {
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject};
        let class = AnyClass::get(c"SMAppService")?;
        // SAFETY: `mainAppService` is a class property returning the shared
        // SMAppService for the main bundle (ServiceManagement, macOS 13).
        let service: Option<Retained<AnyObject>> =
            caught(|| unsafe { objc2::msg_send![class, mainAppService] })?;
        service.map(Self)
    }

    fn call(&self, register: bool) -> Result<(), String> {
        use objc2::rc::Retained;
        use objc2_foundation::NSError;
        let service = &*self.0;
        // SAFETY: `registerAndReturnError:` and `unregisterAndReturnError:`
        // take an `NSError **` and return BOOL, which `_` stands for.
        caught(|| {
            let sent: Result<(), Retained<NSError>> = if register {
                unsafe { objc2::msg_send![service, registerAndReturnError: _] }
            } else {
                unsafe { objc2::msg_send![service, unregisterAndReturnError: _] }
            };
            sent.map_err(|err| format!("{} ({})", err.localizedDescription(), err.code()))
        })
        .unwrap_or_else(|| Err("Objective-C exception".into()))
    }
}

impl Registry for MainApp {
    fn status(&self) -> Status {
        // SAFETY: `status` is a readonly NSInteger property.
        caught(|| unsafe { objc2::msg_send![&*self.0, status] })
            .map_or(Status::NotFound, Status::from_raw)
    }

    fn register(&self) -> Result<(), String> {
        self.call(true)
    }

    fn unregister(&self) -> Result<(), String> {
        self.call(false)
    }

    fn legacy_status(&self, plist: &Path) -> Status {
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2_foundation::NSString;
        let (Some(class), Some(path)) = (AnyClass::get(c"SMAppService"), plist.to_str()) else {
            return Status::NotFound;
        };
        let path = NSString::from_str(path);
        // SAFETY: `fileURLWithPath:` returns an NSURL; `statusForLegacyURL:`
        // takes one and returns an SMAppServiceStatus (macOS 13).
        caught(|| unsafe {
            let url: Option<Retained<AnyObject>> =
                objc2::msg_send![objc2::class!(NSURL), fileURLWithPath: &*path];
            let url = url?;
            let raw: isize = objc2::msg_send![class, statusForLegacyURL: &*url];
            Some(Status::from_raw(raw))
        })
        .flatten()
        .unwrap_or(Status::NotFound)
    }
}

// ─── The app ───────────────────────────────────────────────────────────────────

/// This copy's earlier LaunchAgent, where the autostart plugin put it.
fn legacy_plist(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().home_dir().ok()?.join("Library/LaunchAgents");
    let exe = std::env::current_exe().ok()?;
    owned_legacy_plist(&dir, &app.package_info().name, &exe)
}

/// A build run outside an app bundle has no login item to register, and its
/// LaunchAgent would take the installed رفّ's file name.
fn bundled() -> bool {
    crate::macos::app_bundle_path().is_some()
}

/// At every launch: an earlier version's LaunchAgent moved over, once, and
/// the stored switch made to say what the next login will do.
pub fn at_launch(app: &AppHandle) {
    if !bundled() {
        return;
    }
    if let Some(service) = MainApp::get() {
        let migrated = migrate(&service, legacy_plist(app).as_deref());
        if migrated != Migrated::Nothing {
            eprintln!("raff: earlier LaunchAgent: {migrated:?}");
        }
    }
    sync_setting(app);
}

/// Whether the next login opens رفّ, as macOS has it. `None` where this build
/// cannot tell.
pub fn actual(app: &AppHandle) -> Option<bool> {
    if !bundled() {
        return None;
    }
    match MainApp::get() {
        Some(service) => Some(is_on(&service, legacy_plist(app).as_deref())),
        None => app.autolaunch().is_enabled().ok(),
    }
}

/// The stored switch brought to what macOS will do — the user may have
/// changed it in System Settings since. Settings reads the switch from here.
pub fn sync_setting(app: &AppHandle) {
    let Some(on) = actual(app) else {
        return;
    };
    let state = app.state::<crate::AppState>();
    let mut store = crate::lock_store(&state.store);
    if store.settings.launch_at_login == on {
        return;
    }
    // Settings that could not be read are not written over for this: the
    // switch shows the answer, and the user's next change saves it.
    if store.unreadable_settings {
        store.settings.launch_at_login = on;
    } else if let Err(err) = store.set_launch_at_login_persisted(on) {
        eprintln!("raff: could not record the login item's state: {err}");
    }
}

/// Turns opening at login on or off for the Settings switch.
pub fn apply(app: &AppHandle, on: bool) -> Result<(), &'static str> {
    if !bundled() {
        return Err(FAILED);
    }
    match MainApp::get() {
        Some(service) => set(&service, legacy_plist(app).as_deref(), on),
        None => {
            let autolaunch = app.autolaunch();
            let result = if on {
                autolaunch.enable()
            } else {
                autolaunch.disable()
            };
            result.map_err(|err| {
                eprintln!("raff: LaunchAgent change failed: {err}");
                FAILED
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::fs;

    /// macOS as far as these functions can see it. `refuse` makes `register`
    /// fail without a change, as macOS does for a bundle it will not take;
    /// `ask_approval` makes it land as `RequiresApproval`. A login item the
    /// user turned off is not registered over: `kSMErrorLaunchDeniedByUser`,
    /// status unchanged (SMAppService.h).
    struct FakeMac {
        main: Cell<Status>,
        legacy: Cell<Status>,
        refuse: bool,
        ask_approval: bool,
        registers: Cell<u32>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl FakeMac {
        fn new(main: Status, legacy: Status) -> Self {
            Self {
                main: Cell::new(main),
                legacy: Cell::new(legacy),
                refuse: false,
                ask_approval: false,
                registers: Cell::new(0),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl Registry for FakeMac {
        fn status(&self) -> Status {
            self.main.get()
        }
        fn register(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("register");
            if self.refuse {
                return Err("refused".into());
            }
            if self.main.get() == Status::Enabled {
                return Err("already registered".into());
            }
            if self.main.get() == Status::RequiresApproval {
                return Err("launch denied by user".into());
            }
            self.registers.set(self.registers.get() + 1);
            self.main.set(if self.ask_approval {
                Status::RequiresApproval
            } else {
                Status::Enabled
            });
            Ok(())
        }
        fn unregister(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("unregister");
            if self.main.get() == Status::NotRegistered {
                return Err("job not found".into());
            }
            self.main.set(Status::NotRegistered);
            Ok(())
        }
        fn legacy_status(&self, _plist: &Path) -> Status {
            self.legacy.get()
        }
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("raff-login-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// The plist byte for byte as auto-launch 0.5.0 writes it (7.0.0's file).
    fn auto_launch_plist(label: &str, program: &Path) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>{label}</string>\n  <key>ProgramArguments</key>\n  <array><string>{}</string></array>\n  <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>",
            program.display()
        )
    }

    /// A fake installed copy and its 7.0.0 LaunchAgent.
    struct Fixture {
        root: PathBuf,
        agents: PathBuf,
        exe: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let root = scratch(label);
            let exe = root.join("Applications/Raff.app/Contents/MacOS/raff");
            fs::create_dir_all(exe.parent().unwrap()).unwrap();
            fs::write(&exe, b"#!/bin/sh\n").unwrap();
            let agents = root.join("Library/LaunchAgents");
            fs::create_dir_all(&agents).unwrap();
            Self { root, agents, exe }
        }
        fn plist(&self) -> PathBuf {
            self.agents.join("Raff.plist")
        }
        fn write_legacy(&self) {
            fs::write(self.plist(), auto_launch_plist("Raff", &self.exe)).unwrap();
        }
        fn legacy(&self) -> Option<PathBuf> {
            owned_legacy_plist(&self.agents, "Raff", &self.exe)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn the_7_0_0_launch_agent_of_this_copy_is_recognised() {
        let fx = Fixture::new("owned");
        fx.write_legacy();
        assert_eq!(fx.legacy(), Some(fx.plist()));
    }

    #[test]
    fn a_launch_agent_for_another_copy_or_shape_is_not_ours() {
        let fx = Fixture::new("foreign");
        let other = fx.root.join("Elsewhere/Raff.app/Contents/MacOS/raff");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, b"").unwrap();

        // Another copy of رفّ (a build, a second install).
        fs::write(fx.plist(), auto_launch_plist("Raff", &other)).unwrap();
        assert_eq!(fx.legacy(), None, "another copy's LaunchAgent");
        // A program that no longer exists.
        let gone = fx.root.join("Gone.app/Contents/MacOS/raff");
        fs::write(fx.plist(), auto_launch_plist("Raff", &gone)).unwrap();
        assert_eq!(fx.legacy(), None, "a program that is not there");
        // Our program under another label.
        fs::write(fx.plist(), auto_launch_plist("com.example.Raff", &fx.exe)).unwrap();
        assert_eq!(fx.legacy(), None, "another label");
        // Our program with a key auto-launch never writes.
        let extra = auto_launch_plist("Raff", &fx.exe).replace(
            "<key>RunAtLoad</key>",
            "<key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>",
        );
        fs::write(fx.plist(), extra).unwrap();
        assert_eq!(fx.legacy(), None, "a key auto-launch does not write");
        // Not a plist at all.
        fs::write(fx.plist(), b"Raff").unwrap();
        assert_eq!(fx.legacy(), None, "not a property list");
        // A symlink to our own, well-formed file.
        let real = fx.root.join("real.plist");
        fs::write(&real, auto_launch_plist("Raff", &fx.exe)).unwrap();
        fs::remove_file(fx.plist()).unwrap();
        std::os::unix::fs::symlink(&real, fx.plist()).unwrap();
        assert_eq!(fx.legacy(), None, "a symlink is not followed");
        assert!(real.exists());
    }

    #[test]
    fn the_switch_on_moves_the_launch_agent_to_one_login_item() {
        let fx = Fixture::new("move");
        fx.write_legacy();
        let mac = FakeMac::new(Status::NotRegistered, Status::Enabled);
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Moved);
        assert_eq!(mac.main.get(), Status::Enabled);
        assert!(!fx.plist().exists(), "the LaunchAgent is gone");
        assert!(is_on(&mac, fx.legacy().as_deref()));
    }

    #[test]
    fn a_login_item_already_there_is_kept_and_not_registered_again() {
        // The Mac this was found on: «Raff» in Open at Login, enabled, and
        // «raff» turned off in System Settings.
        let fx = Fixture::new("both");
        fx.write_legacy();
        let mac = FakeMac::new(Status::Enabled, Status::RequiresApproval);
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Removed);
        assert_eq!(mac.registers.get(), 0);
        assert!(
            mac.calls.borrow().is_empty(),
            "nothing registered or unregistered"
        );
        assert_eq!(mac.main.get(), Status::Enabled);
        assert!(!fx.plist().exists());
        assert!(
            is_on(&mac, fx.legacy().as_deref()),
            "the switch says what the next login does"
        );
    }

    #[test]
    fn turned_off_in_system_settings_stays_off() {
        let fx = Fixture::new("denied");
        fx.write_legacy();
        let mac = FakeMac::new(Status::NotRegistered, Status::RequiresApproval);
        assert!(!is_on(&mac, fx.legacy().as_deref()), "off before the move");
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Removed);
        assert_eq!(mac.registers.get(), 0, "not turned back on");
        assert!(!fx.plist().exists());
        assert!(!is_on(&mac, fx.legacy().as_deref()));
    }

    #[test]
    fn a_login_item_waiting_for_approval_is_not_registered_over() {
        // Refused in System Settings, or registered and not yet approved: the
        // LaunchAgent keeps opening رفّ until the user decides.
        let fx = Fixture::new("main-waiting");
        fx.write_legacy();
        let mac = FakeMac::new(Status::RequiresApproval, Status::Enabled);
        for _ in 0..3 {
            assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Kept);
        }
        assert!(mac.calls.borrow().is_empty(), "never registered over");
        assert!(fx.plist().exists());
        assert!(is_on(&mac, fx.legacy().as_deref()));
        // Approved in System Settings: the next launch moves.
        mac.main.set(Status::Enabled);
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Moved);
        assert!(!fx.plist().exists());
    }

    #[test]
    fn the_launch_agent_not_the_stored_switch_is_the_answer() {
        // Settings that could not be read come back with the switch off; the
        // file says it was on (7.0.0 deleted it when turned off), and it
        // keeps opening رفّ — now as the login item.
        let fx = Fixture::new("unreadable");
        fx.write_legacy();
        let mac = FakeMac::new(Status::NotRegistered, Status::Enabled);
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Moved);
        assert_eq!(mac.main.get(), Status::Enabled);
        assert!(is_on(&mac, fx.legacy().as_deref()));
    }

    #[test]
    fn a_refused_registration_keeps_the_launch_agent_working() {
        let fx = Fixture::new("refused");
        fx.write_legacy();
        let mut mac = FakeMac::new(Status::NotRegistered, Status::Enabled);
        mac.refuse = true;
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Kept);
        assert!(fx.plist().exists(), "the next login still opens رفّ");
        assert!(
            is_on(&mac, fx.legacy().as_deref()),
            "and the switch says so"
        );
        // The next launch tries again, and once macOS takes it, moves.
        mac.refuse = false;
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Moved);
        assert!(!fx.plist().exists());
    }

    #[test]
    fn approval_pending_after_registering_keeps_the_launch_agent() {
        let fx = Fixture::new("pending");
        fx.write_legacy();
        let mut mac = FakeMac::new(Status::NotRegistered, Status::Enabled);
        mac.ask_approval = true;
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Kept);
        // The next launch does not take the pending item for a refusal.
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Kept);
        assert_eq!(mac.registers.get(), 1);
        assert!(fx.plist().exists(), "رفّ still opens at login");
        assert!(is_on(&mac, fx.legacy().as_deref()));
    }

    #[test]
    fn repeated_launches_register_once_and_leave_one_registration() {
        let fx = Fixture::new("repeat");
        fx.write_legacy();
        let mac = FakeMac::new(Status::NotRegistered, Status::Enabled);
        let mut outcomes = Vec::new();
        for _ in 0..5 {
            outcomes.push(migrate(&mac, fx.legacy().as_deref()));
        }
        assert_eq!(outcomes[0], Migrated::Moved);
        assert!(outcomes[1..].iter().all(|o| *o == Migrated::Nothing));
        assert_eq!(mac.registers.get(), 1);
        assert_eq!(*mac.calls.borrow(), vec!["register"]);
        assert!(!fx.plist().exists());
    }

    #[test]
    fn an_interruption_after_registering_finishes_at_the_next_launch() {
        // Registered, then the process ended before the file went.
        let fx = Fixture::new("interrupted");
        fx.write_legacy();
        let mac = FakeMac::new(Status::Enabled, Status::Enabled);
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Moved);
        assert_eq!(mac.registers.get(), 0, "not registered a second time");
        assert!(!fx.plist().exists());
    }

    #[test]
    fn a_launch_agent_that_is_not_ours_is_left_alone() {
        let fx = Fixture::new("leave");
        let other = fx.root.join("Other/Raff.app/Contents/MacOS/raff");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, b"").unwrap();
        fs::write(fx.plist(), auto_launch_plist("Raff", &other)).unwrap();
        let mac = FakeMac::new(Status::NotRegistered, Status::Enabled);
        assert_eq!(migrate(&mac, fx.legacy().as_deref()), Migrated::Nothing);
        assert!(fx.plist().exists());
        assert!(mac.calls.borrow().is_empty());
    }

    #[test]
    fn the_switch_registers_and_unregisters_the_one_login_item() {
        let mac = FakeMac::new(Status::NotRegistered, Status::NotRegistered);
        assert_eq!(set(&mac, None, true), Ok(()));
        assert_eq!(mac.main.get(), Status::Enabled);
        assert_eq!(set(&mac, None, true), Ok(()), "on again is no change");
        assert_eq!(mac.registers.get(), 1);
        assert_eq!(set(&mac, None, false), Ok(()));
        assert_eq!(mac.main.get(), Status::NotRegistered);
        assert_eq!(set(&mac, None, false), Ok(()), "off again is no change");
    }

    #[test]
    fn the_switch_says_why_macos_did_not_turn_it_on() {
        let mut mac = FakeMac::new(Status::NotRegistered, Status::NotRegistered);
        mac.ask_approval = true;
        assert_eq!(set(&mac, None, true), Err(NEEDS_APPROVAL));
        let mut mac = FakeMac::new(Status::NotRegistered, Status::NotRegistered);
        mac.refuse = true;
        assert_eq!(set(&mac, None, true), Err(FAILED));
        // Turned off in System Settings: on from رفّ says so, and leaves an
        // earlier LaunchAgent where it is.
        let fx = Fixture::new("denied-switch");
        fx.write_legacy();
        let mac = FakeMac::new(Status::RequiresApproval, Status::Enabled);
        assert_eq!(set(&mac, fx.legacy().as_deref(), true), Err(NEEDS_APPROVAL));
        assert_eq!(mac.main.get(), Status::RequiresApproval);
        assert!(fx.plist().exists());
        // And off from رفّ clears the entry.
        let mac = FakeMac::new(Status::RequiresApproval, Status::NotRegistered);
        assert_eq!(set(&mac, None, false), Ok(()));
        assert_eq!(mac.main.get(), Status::NotRegistered);
    }

    #[test]
    fn either_position_of_the_switch_removes_a_kept_launch_agent() {
        for on in [true, false] {
            let fx = Fixture::new("switch-legacy");
            fx.write_legacy();
            let mac = FakeMac::new(Status::NotRegistered, Status::Enabled);
            assert_eq!(set(&mac, fx.legacy().as_deref(), on), Ok(()));
            assert!(!fx.plist().exists(), "on={on}");
            assert_eq!(is_on(&mac, fx.legacy().as_deref()), on);
        }
    }

    #[test]
    fn status_values_follow_sm_app_service_status() {
        assert_eq!(Status::from_raw(0), Status::NotRegistered);
        assert_eq!(Status::from_raw(1), Status::Enabled);
        assert_eq!(Status::from_raw(2), Status::RequiresApproval);
        assert_eq!(Status::from_raw(3), Status::NotFound);
    }
}
