//! Cold-start stage timing. Debug builds only.
//!
//! Raff is an `LSUIElement` menu-bar app, so the usual ways of watching a
//! launch do not apply: there is no Dock bounce, no window to appear, and
//! stderr is swallowed when the bundle is started through LaunchServices
//! (`open`), which is the only launch path that gives the process real
//! window-server access. That combination makes "the tray icon is up but the
//! app is not answering yet" invisible from the outside, which is exactly the
//! window a startup regression hides in.
//!
//! So the trace writes to a file, and is armed by the PRESENCE OF A MARKER
//! FILE rather than an environment variable: `open` does not pass the calling
//! shell's environment to the launched bundle, so an env-only switch cannot be
//! turned on for the launch path that matters. `RAFF_STARTUP_TRACE` is still
//! honoured for a direct `exec` of the binary.
//!
//! A shipped build never arms it, whatever exists in `/tmp`: a world-writable
//! directory is no switch for a privacy tool to leave lying around. When it
//! is armed, the log lives in the app's own data directory, is the user's
//! alone (0600), is never written through a link, and names stages — never an
//! item, an app or a process.
//!
//! Disarmed every call is one relaxed atomic load; in release, not even that.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Touch this file to arm the trace for the next launch of a debug build.
const MARKER: &str = "/tmp/raff-trace-on";
/// The log, inside the app data directory.
const LOG_FILE: &str = "startup-trace.log";
/// `O_NOFOLLOW` from macOS `<sys/fcntl.h>`. std does not export it, and رفّ
/// builds for macOS alone; the test below proves the value by refusing a link.
const O_NOFOLLOW: i32 = 0x0100;

static START: OnceLock<Instant> = OnceLock::new();
static ENABLED: OnceLock<bool> = OnceLock::new();
static SINK: Mutex<Sink> = Mutex::new(Sink::Pending(Vec::new()));

/// Where marked lines go. The first stages run before the data directory is
/// known, so they wait in memory until `set_dir` says where the log lives.
enum Sink {
    Pending(Vec<String>),
    File(File),
    Closed,
}

fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        cfg!(debug_assertions)
            && (std::env::var("RAFF_STARTUP_TRACE").is_ok() || Path::new(MARKER).exists())
    })
}

fn lock_sink() -> std::sync::MutexGuard<'static, Sink> {
    SINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Opens (or creates) the log for appending: owner-only, and refused outright
/// when the path is a symbolic link.
fn open_log(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(O_NOFOLLOW)
        .open(path)
}

/// Anchors the clock. Call as the very first statement in `main` so every
/// later stage is measured from as close to process start as we can observe.
pub fn init() {
    let _ = START.get_or_init(Instant::now);
    if enabled() {
        mark("process_start");
    }
}

/// Points the log at the app data directory and writes out the stages marked
/// before it was known.
pub fn set_dir(dir: &Path) {
    if enabled() {
        attach(&mut lock_sink(), dir);
    }
}

/// Opens the log in `dir` for a sink still waiting for one. A sink that is
/// already writing (or gave up) is left as it is, so a second call cannot cut
/// a live log short.
fn attach(sink: &mut Sink, dir: &Path) {
    let Sink::Pending(lines) = sink else {
        return;
    };
    let lines = std::mem::take(lines);
    let opened = std::fs::create_dir_all(dir).and_then(|_| open_log(&dir.join(LOG_FILE)));
    match opened {
        Ok(mut file) => {
            for line in &lines {
                let _ = writeln!(file, "{line}");
            }
            *sink = Sink::File(file);
        }
        Err(err) => {
            // The lines already went to stderr as they were marked.
            eprintln!("raff-trace: log not opened in {}: {err}", dir.display());
            *sink = Sink::Closed;
        }
    }
}

/// Watches for periods where the main thread stops servicing work.
///
/// Diagnostic only, and only while the trace is armed. A background thread
/// round-trips a no-op through the main queue a few times a second and
/// reports whenever the reply comes back late, which distinguishes "our
/// dispatch mechanism is wrong" from "the main thread was busy/parked".
pub fn start_stall_detector() {
    if !enabled() {
        return;
    }
    std::thread::spawn(|| loop {
        let started = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::channel();
        crate::macos::dispatch_to_main(move || {
            let _ = tx.send(());
        });
        let answered = rx.recv_timeout(std::time::Duration::from_secs(10)).is_ok();
        let waited = started.elapsed().as_secs_f64() * 1000.0;
        if !answered {
            mark("MAIN_THREAD_STALL >10000ms (no reply)");
        } else if waited > 250.0 {
            mark(&format!("MAIN_THREAD_STALL {waited:.0}ms"));
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    });
}

/// Records one named stage with its offset from process start.
pub fn mark(stage: &str) {
    if !enabled() {
        return;
    }
    let elapsed = START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0;
    let line = format!("{elapsed:>10.2} ms  {stage}");
    match &mut *lock_sink() {
        Sink::Pending(lines) => lines.push(line.clone()),
        Sink::File(file) => {
            let _ = writeln!(file, "{line}");
        }
        Sink::Closed => {}
    }
    eprintln!("raff-trace {line}");
}

/// `mark`, for a stage whose text costs something to build: nothing is
/// computed unless the trace is armed.
pub fn mark_with(stage: impl FnOnce() -> String) {
    if enabled() {
        mark(&stage());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("raff-trace-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_log_is_the_user_s_alone() {
        let dir = temp_dir();
        let log = dir.join(LOG_FILE);
        open_log(&log).unwrap();
        assert_eq!(
            std::fs::metadata(&log).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_buffered_stages_land_in_the_log_and_a_second_attach_keeps_it() {
        let dir = temp_dir();
        let mut sink = Sink::Pending(vec!["    1.00 ms  process_start".into()]);
        attach(&mut sink, &dir);
        assert!(matches!(sink, Sink::File(_)));
        assert!(std::fs::read_to_string(dir.join(LOG_FILE))
            .unwrap()
            .contains("process_start"));

        attach(&mut sink, &temp_dir());
        assert!(
            matches!(sink, Sink::File(_)),
            "a live log is not closed by a second call"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_link_planted_at_the_log_path_is_refused() {
        let dir = temp_dir();
        let target = dir.join("somewhere-else");
        std::fs::write(&target, b"").unwrap();
        let link = dir.join(LOG_FILE);
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(open_log(&link).is_err(), "O_NOFOLLOW refuses the link");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"",
            "and nothing reached its target"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The text of every traced stage in production code: the string literals
    /// of each `mark(…)` / `mark_with(…)` statement.
    fn traced_literals() -> Vec<String> {
        let sources = [
            include_str!("commands.rs"),
            include_str!("main.rs"),
            include_str!("panel.rs"),
            include_str!("paste.rs"),
            include_str!("tray.rs"),
        ];
        let mut literals = Vec::new();
        for source in sources {
            let production = source.split("#[cfg(test)]").next().unwrap();
            let calls = production
                .match_indices("startup_trace::mark(")
                .chain(production.match_indices("startup_trace::mark_with("));
            for (at, _) in calls {
                let statement = &production[at..];
                let statement = &statement[..statement.find(");").unwrap_or(statement.len())];
                literals.extend(statement.split('"').skip(1).step_by(2).map(str::to_owned));
            }
        }
        literals
    }

    #[test]
    fn no_stage_names_an_item_an_app_or_a_process() {
        let literals = traced_literals();
        assert!(literals.len() > 20, "the scan found the trace calls");
        for literal in literals {
            for leak in ["id=", "{id", "pid", "bundle", "argv"] {
                assert!(!literal.contains(leak), "{literal:?} carries `{leak}`");
            }
        }
    }
}

// وحدة اختبارات التدقيق (RAFF-COPILOT-AUDIT). اختبارات فقط.
#[cfg(test)]
mod audit_tests {
    fn enabled_fn_source() -> String {
        let src = include_str!("startup_trace.rs");
        let product = src.split("#[cfg(test)]").next().unwrap();
        let start = product.find("fn enabled()").unwrap();
        let end = start + product[start..].find("\n}\n").unwrap();
        product[start..end].to_string()
    }

    #[test]
    fn aud006_trace_is_debug_only() {
        assert!(enabled_fn_source().contains("debug_assertions"));
    }
}
