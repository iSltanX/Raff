//! Cold-start stage timing.
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
//! Disarmed (the shipping default) every call is one relaxed atomic load.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

/// Touch this file to arm the trace for the next launch.
const MARKER: &str = "/tmp/raff-trace-on";
const DEFAULT_LOG: &str = "/tmp/raff-startup-trace.log";

static START: OnceLock<Instant> = OnceLock::new();
static ENABLED: OnceLock<bool> = OnceLock::new();
static LOG_PATH: OnceLock<String> = OnceLock::new();

fn enabled() -> bool {
    *ENABLED
        .get_or_init(|| std::env::var("RAFF_STARTUP_TRACE").is_ok() || Path::new(MARKER).exists())
}

fn log_path() -> &'static str {
    LOG_PATH.get_or_init(|| {
        std::env::var("RAFF_STARTUP_TRACE_FILE").unwrap_or_else(|_| DEFAULT_LOG.to_string())
    })
}

/// Anchors the clock. Call as the very first statement in `main` so every
/// later stage is measured from as close to process start as we can observe.
pub fn init() {
    let _ = START.get_or_init(Instant::now);
    if enabled() {
        mark("process_start");
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
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(file, "{elapsed:>10.2} ms  {stage}");
    }
    eprintln!("raff-trace {elapsed:>10.2} ms  {stage}");
}
