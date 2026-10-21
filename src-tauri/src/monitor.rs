//! Clipboard capture: a background thread polls the pasteboard change count
//! every ~350ms (the standard macOS approach — there is no push notification).

use std::ops::ControlFlow;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{
    capture_and_persist, content_hash, detect_kind, CaptureResult, ItemKind, Store,
};
use crate::{macos, tray, AppState, Pause};

const POLL_MS: u64 = 350;
/// The least a capture looks back when asking who owned the clipboard. The
/// span it actually looks back over is the time since the last look (`Watch`),
/// which is never shorter than the sleep between two looks.
const SOURCE_WINDOW: Duration = Duration::from_millis(POLL_MS);
/// Images declaring more pixels than this are refused before anything is
/// allocated for them. A full-screen Retina capture on a 6K display is ~20
/// megapixels, so this leaves a wide margin above any real screenshot while
/// stopping a crafted header from asking for gigabytes.
const MAX_IMAGE_PIXELS: u64 = 80_000_000;
/// The panel displays image previews at 64×40 logical pixels. Store at 2x
/// for Retina screens while preserving the source aspect ratio; `thumbnail`
/// fits inside this box and never crops.
const THUMB_MAX_W: u32 = 128;
const THUMB_MAX_H: u32 = 80;

pub fn start(app: AppHandle) {
    macos::start_activation_watch();
    start_signal_flusher(app.clone());
    start_retention_sweeper(app.clone());
    std::thread::spawn(move || {
        let mut watch = Watch::from(macos::change_count(), Instant::now());
        let outcome = supervise(|| {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            in_pool(|| poll_once(&app, &mut watch));
            ControlFlow::Continue(())
        });
        if outcome == Supervision::GaveUp {
            let state = app.state::<AppState>();
            state.capture_alive.store(false, Ordering::SeqCst);
            // Say it where the user is looking, not only where they might go
            // looking: the settings row needs the window opened first.
            tray::note_capture_stopped();
            let _ = app.emit("raff://changed", ());
        }
    });
}

/// Runs one tick of the capture loop inside its own autorelease pool. The
/// loop's thread lives as long as رفّ, and what AppKit hands back autoreleased
/// from a pasteboard read would otherwise wait for the thread's implicit pool,
/// which drains only when the thread ends — never (018).
fn in_pool<R>(tick: impl FnOnce() -> R) -> R {
    objc2::rc::autoreleasepool(|_| tick())
}

/// How often the retention policy is re-applied while Raff is running.
///
/// Hourly is enough for a promise measured in days, and it is the only cost a
/// machine sitting idle pays: an age limit cannot ride on captures, because
/// the case it exists for is a sensitive copy followed by nobody touching the
/// clipboard for a fortnight.
const RETENTION_SWEEP_MS: u64 = 60 * 60 * 1000;

/// Re-applies the retention policy on a timer, and tells the windows only
/// when a row went: an announcement makes a shown panel fetch and redraw
/// everything, which an hour with nothing past its limit does not need.
fn start_retention_sweeper(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(RETENTION_SWEEP_MS));
        let trimmed = crate::lock_store(&app.state::<AppState>().store).trim_history();
        if trimmed {
            let _ = app.emit("raff://changed", ());
        }
    });
}

/// How long coalesced learning counters wait for the user to pause. Long
/// enough that a run of pastes costs one write instead of one per paste, short
/// enough that quitting rarely drops any.
const SIGNAL_FLUSH_MS: u64 = 2_000;

/// Writes the learning counters that `paste` only marked, once they settle.
fn start_signal_flusher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(SIGNAL_FLUSH_MS));
        let writes = crate::lock_store(&app.state::<AppState>().store).stage_signal_flush();
        // Written with the store lock released, like every other layer write.
        for write in writes {
            if let Err(err) = write.commit() {
                eprintln!("raff: {err}");
            }
        }
    });
}

/// How many ticks may fail back to back before the loop gives up. One panic is
/// an incident worth riding out; a run of them means every tick will fail, and
/// spinning would only burn the battery and flood the log.
const MAX_CONSECUTIVE_PANICS: u32 = 3;

#[derive(PartialEq, Eq, Debug)]
enum Supervision {
    /// `tick` asked to stop.
    Finished,
    /// `tick` failed `MAX_CONSECUTIVE_PANICS` times in a row.
    GaveUp,
}

/// Runs `tick` until it stops or fails repeatedly, absorbing isolated panics.
///
/// Without this, a single panic — a poisoned lock, a decoder that trips over a
/// malformed image — ended the capture thread for the rest of the session with
/// nothing to show for it.
fn supervise(mut tick: impl FnMut() -> ControlFlow<()>) -> Supervision {
    let mut consecutive = 0u32;
    loop {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(&mut tick)) {
            Ok(ControlFlow::Break(())) => return Supervision::Finished,
            Ok(ControlFlow::Continue(())) => consecutive = 0,
            Err(_) => {
                consecutive += 1;
                // The payload is deliberately not logged: nothing about a
                // capture, not even its shape, belongs in a log.
                eprintln!("raff: capture tick failed ({consecutive} in a row)");
                if consecutive >= MAX_CONSECUTIVE_PANICS {
                    eprintln!("raff: capture stopped");
                    return Supervision::GaveUp;
                }
            }
        }
    }
}

/// رفّ's own writes to the pasteboard, and the gate that keeps the capture
/// loop from seeing one half-done (F-OWNWRITE, audit 2026-10-21).
///
/// A write is `clearContents`, the representations, then recording the change
/// count the clear produced; a poll is reading the count, deciding whose
/// change it is, then reading the content. Unless one lock covers both, a poll
/// can land between the clear and the record and take رفّ's write for a new
/// copy — dropping a row's rich parts on «لصق كنص عادي», moving it to the top,
/// spending a pending «تجاهل النسخة التالية» — or a write can land between a
/// poll's check and its read, and رفّ's content is stored as the user's copy.
/// Narrowing either window only makes it rarer; holding the gate closes both.
///
/// Neither side waits on anything else while it holds the gate: the poll
/// reads the settings before it and stores after it, and every writer runs
/// off the main thread. The most a write waits is one pasteboard read, and
/// only when the two coincide.
pub struct OwnWrites(Mutex<Option<isize>>);

impl OwnWrites {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Runs `write` — which returns the change count its clear produced, or
    /// `None` when nothing was written — with the gate held, and records that
    /// count before any poll can look at the pasteboard again.
    pub fn write(&self, write: impl FnOnce() -> Option<isize>) -> Option<isize> {
        let mut record = self.hold();
        let count = write()?;
        *record = Some(count);
        Some(count)
    }

    /// A panic under the gate must not turn every later copy and poll into
    /// one: the record is a single count, valid or harmlessly stale.
    fn hold(&self) -> MutexGuard<'_, Option<isize>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// What a poll reads from a pasteboard: the system's, or a test's.
trait Pasteboard {
    fn change_count(&self) -> isize;
    fn has_concealed_type(&self) -> bool;
    fn read_clip(&self) -> macos::RawClip;
}

struct SystemPasteboard;

impl Pasteboard for SystemPasteboard {
    fn change_count(&self) -> isize {
        macos::change_count()
    }
    fn has_concealed_type(&self) -> bool {
        macos::has_concealed_type()
    }
    fn read_clip(&self) -> macos::RawClip {
        macos::read_clip()
    }
}

/// Everything besides the pasteboard that decides a capture, gathered before
/// the gate is taken so that nothing under it waits on the store lock.
struct Rules {
    enabled: bool,
    respect_concealed: bool,
    /// An excluded app was in front somewhere the copy could have happened.
    excluded: bool,
    source: macos::FrontApp,
}

impl Rules {
    fn now(store: &Mutex<Store>, detected_at: Instant, window: Duration) -> Self {
        let (enabled, respect_concealed, excluded_apps) = {
            let store = crate::lock_store(store);
            (
                store.settings.capture_enabled,
                store.settings.respect_concealed,
                store.settings.excluded_apps.clone(),
            )
        };
        // Exclusion is decided before the pasteboard is read, and over the
        // whole window the copy could have happened in — not just over
        // whoever is frontmost by the time the poll runs.
        let activations = macos::activation_snapshot();
        let front_now = macos::frontmost_app();
        let excluded = excluded_apps.contains(&front_now.bundle_id)
            || macos::window_has_excluded(&activations, &excluded_apps, detected_at, window);
        let source = macos::front_at(&activations, detected_at, window).unwrap_or(front_now);
        Rules {
            enabled,
            respect_concealed,
            excluded,
            source,
        }
    }
}

/// What one look at the pasteboard found.
enum Look {
    /// رفّ's own write.
    Own,
    /// Not read: paused or skipped, capture off, an excluded app, or content
    /// an app marked secret.
    Skipped,
    /// The pasteboard moved on between the count this look decided on and the
    /// read. What it holds now was never checked, so it is left to the next
    /// poll, which starts from the new count.
    Moved,
    Read(ClipReading),
}

/// Where the poll loop left off: the change count it last settled on, and
/// when it last read the count.
struct Watch {
    last: isize,
    looked_at: Instant,
}

impl Watch {
    fn from(count: isize, at: Instant) -> Self {
        Self {
            last: count,
            looked_at: at,
        }
    }

    /// Takes one look at the count, read between `before` and `after`. When it
    /// moved, answers the span the change could have happened in: from the
    /// previous look to this one.
    ///
    /// The previous look is the right start, not a fixed interval back: the
    /// loop sleeps between looks, but the poll before that sleep can take far
    /// longer than one interval (a large image, a wait at the gate), and an
    /// excluded app in front during that time must still be found (007 ج1).
    /// The next span starts before this read, so nothing falls between two.
    fn notice(&mut self, count: isize, before: Instant, after: Instant) -> Option<Duration> {
        let since = after.saturating_duration_since(self.looked_at);
        self.looked_at = before;
        (count != self.last).then(|| since.max(SOURCE_WINDOW))
    }
}

/// One poll of the pasteboard. `watch` carries the change count across ticks.
fn poll_once(app: &AppHandle, watch: &mut Watch) {
    let before = Instant::now();
    let glance = macos::change_count();
    let detected_at = Instant::now();
    let Some(window) = watch.notice(glance, before, detected_at) else {
        return;
    };
    let state = app.state::<AppState>();
    let rules = Rules::now(&state.store, detected_at, window);
    let (found, pause_ended) = look(
        &SystemPasteboard,
        &state.own_writes,
        &state.pause,
        rules,
        glance,
        &mut watch.last,
    );
    if pause_ended {
        tray::sync_paused();
        // The panel and Settings show the pause; tell them it ended.
        let _ = app.emit("raff://changed", ());
    }
    if let Look::Read(reading) = found {
        if capture_reading(&state.store, reading) {
            let _ = app.emit("raff://changed", ());
        }
    }
}

/// Looks at the pasteboard once, with the gate held from the change count to
/// the last byte read. `glance` is the count `rules` were gathered for.
/// Returns what it found, and whether a pause ended here.
fn look(
    pb: &impl Pasteboard,
    own: &OwnWrites,
    pause: &Mutex<Pause>,
    rules: Rules,
    glance: isize,
    last: &mut isize,
) -> (Look, bool) {
    let mut record = own.hold();
    let count = pb.change_count();
    *last = count;
    // Spent either way. One slot is enough: a poll only ever sees the
    // pasteboard as it is now, so of two writes رفّ makes before one poll the
    // first is already gone; and a record older than the count is a write the
    // user's own copy replaced.
    if record.take() == Some(count) {
        return (Look::Own, false);
    }
    // Another app's copy landed after the rules were gathered: the front app
    // and the exclusions they hold may be about the change before it. The
    // next poll looks at it afresh, so it is not marked as seen.
    if count != glance {
        *last = glance;
        return (Look::Moved, false);
    }

    // Before the pasteboard is touched at all: a change skipped on purpose
    // must leave no trace of itself anywhere, not even its length.
    let (skip, pause_ended) = {
        let mut pause = crate::lock_pause(pause);
        let was_active = pause.is_active();
        let skip = pause.consume();
        (skip, was_active && !pause.is_active())
    };
    if skip || !rules.enabled || rules.excluded {
        return (Look::Skipped, pause_ended);
    }

    // Bracket the probe and the read: if the pasteboard changes in between,
    // what we hold mixes two clipboards and the concealed-type answer belongs
    // to the older one. And the bracket starts at the count the checks above
    // were made for.
    let before = pb.change_count();
    if before != count {
        return (Look::Moved, pause_ended);
    }
    // Never store password-manager / auto-generated content.
    if rules.respect_concealed && pb.has_concealed_type() {
        return (Look::Skipped, pause_ended);
    }
    let clip = pb.read_clip();
    let after = pb.change_count();
    let reading = ClipReading {
        before,
        after,
        clip,
        source: rules.source,
    };
    (Look::Read(reading), pause_ended)
}

/// A pasteboard read bracketed by change counts, plus the app credited with it.
struct ClipReading {
    before: isize,
    after: isize,
    clip: macos::RawClip,
    source: macos::FrontApp,
}

impl ClipReading {
    /// False when the pasteboard changed while we were probing and reading it.
    /// Such a reading describes no single clipboard, and the checks that
    /// guarded it answered for content we no longer hold, so it is dropped —
    /// the next poll sees the new content from its own beginning.
    fn is_stable(&self) -> bool {
        self.before == self.after
    }
}

/// Stores a pasteboard reading. Returns true when the store changed.
fn capture_reading(store_lock: &Mutex<Store>, reading: ClipReading) -> bool {
    if !reading.is_stable() {
        return false;
    }
    let ClipReading {
        clip: raw,
        source: front,
        ..
    } = reading;

    // Prefer text; fall back to image data.
    if let Some(text) = raw.text.filter(|t| !t.trim().is_empty()) {
        let rtf_b64 = raw
            .rtf
            .map(|r| base64::engine::general_purpose::STANDARD.encode(r));
        let kind = detect_kind(&text);
        // Applied and staged under one hold of the lock; the layer is then
        // written with the lock free, so opening the panel does not wait on it.
        return capture_and_persist(store_lock, |store| {
            store.capture(
                kind,
                text,
                raw.html,
                rtf_b64,
                None,
                None,
                None,
                (front.name, front.bundle_id),
            )
        })
        .is_ok();
    }

    let Some((png, decoded)) = decode_capture(raw.png, raw.tiff) else {
        return false;
    };

    let hash = content_hash(&png);
    let (w, h) = (decoded.width(), decoded.height());
    let label = format!("صورة {w}×{h}");

    // Files written for this capture, to take back if it does not persist.
    let mut created: Vec<std::path::PathBuf> = Vec::new();
    let persisted = capture_and_persist(store_lock, |store| {
        let dir = store.images_dir();
        // Identical image already stored, *and* its file is still there? Then
        // bump it without touching the disk. Asking the metadata alone let a
        // row whose file had vanished swallow the re-copy as a duplicate, so
        // no replacement was ever written and the row stayed broken for good —
        // while copying it back out failed with «العنصر غير موجود».
        let dup = store.pinned.iter().chain(store.history.iter()).any(|i| {
            i.kind == ItemKind::Image
                && i.hash.as_deref() == Some(hash.as_str())
                && i.image_file
                    .as_deref()
                    .and_then(|file| crate::storage::image_path(&dir, file))
                    .is_some_and(|path| path.exists())
        });

        let (image_file, thumb_file) = if dup {
            (None, None)
        } else {
            let id_base = uuid::Uuid::new_v4().to_string();
            let image_file = format!("{id_base}.png");
            let thumb_name = format!("{id_base}.thumb.png");
            if std::fs::write(dir.join(&image_file), &png).is_err() {
                return CaptureResult::failed();
            }
            created.push(dir.join(&image_file));
            let thumb_file = write_thumbnail(&dir, thumb_name, &decoded);
            created.extend(thumb_file.iter().map(|name| dir.join(name)));
            (Some(image_file), thumb_file)
        };

        store.capture(
            ItemKind::Image,
            label,
            None,
            None,
            image_file,
            thumb_file,
            Some(hash),
            (front.name, front.bundle_id),
        )
    });

    if persisted.is_err() {
        // The capture was taken back or never made it, so nothing in the model
        // refers to these files. (One that moved to the other layer while its
        // write was in flight is settled as `Ok`, and keeps them.)
        for file in created {
            let _ = std::fs::remove_file(file);
        }
        return false;
    }
    true
}

/// The PNG bytes to store and the decoded image they came from.
///
/// PNG is preferred; a TIFF-only clipboard is decoded once and re-encoded, and
/// that same decode is handed back rather than decoding the PNG we just wrote —
/// the old path decoded the pixels twice for every TIFF capture.
fn decode_capture(
    png: Option<Vec<u8>>,
    tiff: Option<Vec<u8>>,
) -> Option<(Vec<u8>, image::DynamicImage)> {
    if let Some(png) = png {
        if !fits_pixel_budget(&png, image::ImageFormat::Png) {
            return None;
        }
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png).ok()?;
        return Some((png, decoded));
    }

    let tiff = tiff?;
    if !fits_pixel_budget(&tiff, image::ImageFormat::Tiff) {
        return None;
    }
    let decoded = image::load_from_memory_with_format(&tiff, image::ImageFormat::Tiff).ok()?;
    let png = encode_png(&decoded)?;
    Some((png, decoded))
}

/// Whether the dimensions an image *declares* stay inside the budget.
///
/// This reads the header only. A buffer is sized from those declared
/// dimensions during decoding, so the answer has to come before the decoder is
/// handed the bytes — afterwards the allocation has already been attempted.
/// Bytes whose header cannot be read at all do not pass either.
fn fits_pixel_budget(bytes: &[u8], format: image::ImageFormat) -> bool {
    image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_dimensions()
        .is_ok_and(|(w, h)| u64::from(w) * u64::from(h) <= MAX_IMAGE_PIXELS)
}

fn encode_png(img: &image::DynamicImage) -> Option<Vec<u8>> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Writes an aspect-preserving Retina thumbnail and returns its persisted
/// filename. A failed encode or write must not leave a dangling `thumbFile`
/// entry in history; `get_image` can then fall back to the original PNG.
fn write_thumbnail(
    dir: &std::path::Path,
    filename: String,
    decoded: &image::DynamicImage,
) -> Option<String> {
    let thumb = decoded.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
    let bytes = encode_png(&thumb)?;
    std::fs::write(dir.join(&filename), bytes).ok()?;
    Some(filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    #[test]
    fn one_panic_does_not_end_the_capture_loop() {
        let mut turns = 0;
        let outcome = supervise(|| {
            turns += 1;
            if turns == 2 {
                panic!("a lock this tick touched was poisoned");
            }
            if turns == 5 {
                return std::ops::ControlFlow::Break(());
            }
            std::ops::ControlFlow::Continue(())
        });

        assert_eq!(
            outcome,
            Supervision::Finished,
            "the loop was not given up on"
        );
        assert_eq!(turns, 5, "polling carried on across the panic");
    }

    #[test]
    fn a_run_of_panics_gives_the_loop_up() {
        let mut turns = 0;
        let outcome = supervise(|| -> std::ops::ControlFlow<()> {
            turns += 1;
            panic!("every tick fails now");
        });

        assert_eq!(outcome, Supervision::GaveUp);
        assert_eq!(
            turns, MAX_CONSECUTIVE_PANICS,
            "it stops rather than spinning on a tick that cannot succeed"
        );
    }

    // ── F-OWNWRITE: رفّ's own writes and the gate (audit 2026-10-21) ──────
    //
    // A pasteboard shared by two threads, with a hook that runs at the start
    // of a chosen change-count read: a write on another thread can be placed
    // exactly where the audit found the windows, instead of hoping a timer
    // lands there. With the gate, a write placed inside a poll — or a poll
    // inside a write — cannot proceed, so each test waits `BLOCKED_FOR` to
    // give it every chance to, then checks it did not.

    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::{mpsc, Arc};

    const BLOCKED_FOR: Duration = Duration::from_millis(300);

    #[derive(Default)]
    struct Board {
        count: isize,
        text: String,
        html: Option<String>,
    }

    type Hook = Box<dyn FnOnce() + Send>;

    #[derive(Default)]
    struct FakeBoard {
        board: Mutex<Board>,
        count_reads: AtomicUsize,
        clip_reads: AtomicUsize,
        hook: Mutex<Option<(usize, Hook)>>,
    }

    impl FakeBoard {
        fn new(count: isize, text: &str) -> Arc<Self> {
            let board = Self::default();
            *board.board.lock().unwrap() = Board {
                count,
                text: text.into(),
                html: None,
            };
            Arc::new(board)
        }

        /// What `macos::write_clip` does, by any app: clear (the count moves),
        /// set, and answer the count the clear produced.
        fn write(&self, text: &str, html: Option<&str>) -> isize {
            let mut board = self.board.lock().unwrap();
            board.count += 1;
            board.text = text.into();
            board.html = html.map(Into::into);
            board.count
        }

        /// Runs `f` at the start of the `n`th change-count read from now.
        fn at_count_read(&self, n: usize, f: impl FnOnce() + Send + 'static) {
            let due = self.count_reads.load(Ordering::SeqCst) + n;
            *self.hook.lock().unwrap() = Some((due, Box::new(f)));
        }
    }

    impl Pasteboard for FakeBoard {
        fn change_count(&self) -> isize {
            let n = self.count_reads.fetch_add(1, Ordering::SeqCst) + 1;
            let due = {
                let mut hook = self.hook.lock().unwrap();
                match &*hook {
                    Some((at, _)) if *at == n => hook.take().map(|(_, f)| f),
                    _ => None,
                }
            };
            if let Some(f) = due {
                f();
            }
            self.board.lock().unwrap().count
        }
        fn has_concealed_type(&self) -> bool {
            false
        }
        fn read_clip(&self) -> macos::RawClip {
            self.clip_reads.fetch_add(1, Ordering::SeqCst);
            let board = self.board.lock().unwrap();
            macos::RawClip {
                text: Some(board.text.clone()),
                html: board.html.clone(),
                ..Default::default()
            }
        }
    }

    fn rules() -> Rules {
        Rules {
            enabled: true,
            respect_concealed: true,
            excluded: false,
            source: macos::FrontApp {
                name: "Safari".into(),
                bundle_id: "com.apple.Safari".into(),
                ..Default::default()
            },
        }
    }

    /// `poll_once` with the test's pasteboard: one look, then the store.
    fn poll(
        board: &FakeBoard,
        own: &OwnWrites,
        pause: &Mutex<Pause>,
        store: &Mutex<Store>,
        last: &mut isize,
    ) -> &'static str {
        let glance = board.change_count();
        if glance == *last {
            return "unchanged";
        }
        outcome(look(board, own, pause, rules(), glance, last).0, store)
    }

    /// `poll_once` with its loop state, at a chosen instant: what it found,
    /// and the window its rules would have been gathered over.
    fn poll_at(
        board: &FakeBoard,
        own: &OwnWrites,
        pause: &Mutex<Pause>,
        store: &Mutex<Store>,
        watch: &mut Watch,
        at: Instant,
    ) -> (&'static str, Option<Duration>) {
        let glance = board.change_count();
        let Some(window) = watch.notice(glance, at, at) else {
            return ("unchanged", None);
        };
        let found = look(board, own, pause, rules(), glance, &mut watch.last).0;
        (outcome(found, store), Some(window))
    }

    fn outcome(found: Look, store: &Mutex<Store>) -> &'static str {
        match found {
            Look::Own => "own",
            Look::Skipped => "skipped",
            Look::Moved => "moved",
            Look::Read(reading) => {
                if capture_reading(store, reading) {
                    "captured"
                } else {
                    "not stored"
                }
            }
        }
    }

    /// 018: on a thread of its own, as the capture loop runs, an object a
    /// tick autoreleases is gone once the tick is over.
    #[test]
    fn what_a_tick_autoreleases_is_freed_when_the_tick_ends() {
        std::thread::spawn(|| {
            let weak = in_pool(|| {
                let object = objc2_foundation::NSObject::new();
                let weak = objc2::rc::Weak::from_retained(&object);
                let _ = objc2::rc::Retained::autorelease_ptr(object);
                assert!(weak.load().is_some(), "held by the pool until it drains");
                weak
            });
            assert!(weak.load().is_none(), "still alive after the tick");
        })
        .join()
        .unwrap();
    }

    /// And the loop does run every tick that way.
    #[test]
    fn the_capture_loop_runs_each_tick_in_a_pool() {
        let src = include_str!("monitor.rs");
        let start = &src[src.find("pub fn start(").unwrap()..src.find("fn in_pool").unwrap()];
        assert!(start.contains("in_pool(|| poll_once("));
    }

    fn front(at: Instant, bundle: &str) -> macos::Activation {
        macos::Activation {
            at,
            app: macos::FrontApp {
                bundle_id: bundle.into(),
                ..Default::default()
            },
        }
    }

    const MS: fn(u64) -> Duration = Duration::from_millis;

    /// 007 ج1: the previous poll was slow — an image capture, or a wait at the
    /// gate — so 750ms passed between two looks, not 350. The copy was made in
    /// the password manager early in that span, and the user had switched away
    /// before the later part of it. A fixed 350ms window looked only at the
    /// later part, saw Terminal, and stored the copy.
    #[test]
    fn the_exclusion_window_reaches_back_to_the_previous_look() {
        let t0 = Instant::now();
        let mut watch = Watch::from(5, t0);
        let (before, after) = (t0 + MS(750), t0 + MS(751));
        let window = watch.notice(6, before, after).expect("the count moved");
        assert!(window >= after - t0, "{window:?}");

        let log = vec![
            front(t0, "com.apple.Safari"),
            front(t0 + MS(100), "com.agilebits.onepassword7"),
            front(t0 + MS(200), "com.apple.Terminal"),
        ];
        let excluded = vec!["com.agilebits.onepassword7".to_string()];
        assert!(macos::window_has_excluded(&log, &excluded, after, window));
    }

    /// A look that finds nothing moves the start of the next window, and the
    /// window never shrinks below the sleep between two looks.
    #[test]
    fn the_window_starts_at_the_last_look_and_never_falls_below_the_sleep() {
        let t0 = Instant::now();
        let mut watch = Watch::from(5, t0);
        assert_eq!(watch.notice(5, t0 + MS(400), t0 + MS(401)), None);
        let window = watch.notice(6, t0 + MS(1_200), t0 + MS(1_201)).unwrap();
        assert!(window >= MS(801) && window < MS(1_201), "{window:?}");

        let mut quick = Watch::from(5, t0);
        assert_eq!(
            quick.notice(6, t0 + MS(10), t0 + MS(11)),
            Some(SOURCE_WINDOW)
        );
    }

    fn empty_store() -> (std::path::PathBuf, Mutex<Store>) {
        let dir = std::env::temp_dir().join(format!("raff-ownwrite-{}", uuid::Uuid::new_v4()));
        let store = Mutex::new(Store::load(dir.clone()));
        (dir, store)
    }

    fn texts(store: &Mutex<Store>) -> Vec<String> {
        let guard = store.lock().unwrap();
        guard.history.iter().map(|i| i.text.clone()).collect()
    }

    /// Window 1, as the audit reproduced it: «لصق كنص عادي» of a rich row,
    /// and a poll landing after the clear, before the count is recorded. It
    /// used to capture رفّ's write: the row lost its HTML and RTF, jumped to
    /// the top, was credited to the poll's front app, and counted a copy —
    /// and a pending «تجاهل النسخة التالية» was spent on رفّ's write.
    #[test]
    fn a_poll_during_raffs_write_waits_for_the_record_and_skips_it() {
        let (dir, store) = empty_store();
        let rich = ClipReading {
            before: 1,
            after: 1,
            clip: macos::RawClip {
                text: Some("نص منسق".into()),
                html: Some("<b>نص منسق</b>".into()),
                rtf: Some(b"{\\rtf1 synthetic}".to_vec()),
                ..Default::default()
            },
            source: rules().source,
        };
        assert!(capture_reading(&store, rich));
        assert!(capture_reading(&store, reading(2, 2, "later")));
        let board = FakeBoard::new(2, "later");
        let own = Arc::new(OwnWrites::new());
        let pause = Mutex::new(Pause::SkipNext);
        let mut last = 2;

        let (cleared_tx, cleared_rx) = mpsc::channel();
        let (polled_tx, polled_rx) = mpsc::channel::<()>();
        let polled_mid_write = Arc::new(AtomicBool::new(false));
        let writer = {
            let (board, own, polled_mid_write) =
                (board.clone(), own.clone(), polled_mid_write.clone());
            std::thread::spawn(move || {
                own.write(|| {
                    let count = board.write("نص منسق", None);
                    cleared_tx.send(()).unwrap();
                    // The poll's turn, between the clear and the record.
                    let polled = polled_rx.recv_timeout(BLOCKED_FOR).is_ok();
                    polled_mid_write.store(polled, Ordering::SeqCst);
                    Some(count)
                })
            })
        };
        cleared_rx.recv().unwrap();
        let outcome = poll(&board, &own, &pause, &store, &mut last);
        let _ = polled_tx.send(());
        assert_eq!(writer.join().unwrap(), Some(3));

        assert!(
            !polled_mid_write.load(Ordering::SeqCst),
            "the poll looked at a half-done write"
        );
        assert_eq!(outcome, "own");
        assert_eq!(
            board.clip_reads.load(Ordering::SeqCst),
            0,
            "رفّ's write was not even read"
        );
        {
            let guard = store.lock().unwrap();
            assert_eq!(texts_of(&guard), ["later", "نص منسق"], "nothing moved");
            let row = guard.history.iter().find(|i| i.text == "نص منسق").unwrap();
            assert!(
                row.html.is_some() && row.rtf.is_some(),
                "the rich parts are kept"
            );
            assert_eq!(row.source_app_bundle_id, "com.apple.Safari");
            assert_eq!(row.copy_count, 1);
        }
        assert_eq!(
            *pause.lock().unwrap(),
            Pause::SkipNext,
            "the skip is still the user's"
        );

        // The user's next copy is the one skipped, unread.
        board.write("سرّ", None);
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "skipped");
        assert_eq!(board.clip_reads.load(Ordering::SeqCst), 0);
        assert_eq!(*pause.lock().unwrap(), Pause::Off);
        assert_eq!(texts(&store), ["later", "نص منسق"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn texts_of(store: &Store) -> Vec<&str> {
        store.history.iter().map(|i| i.text.as_str()).collect()
    }

    /// Window 2: the poll has decided the change is the user's and is about
    /// to read it when رفّ writes. That write used to land between the check
    /// and the read, so رفّ's content was stored as the user's copy.
    #[test]
    fn raffs_write_during_a_poll_waits_until_the_poll_has_read() {
        let (dir, store) = empty_store();
        let board = FakeBoard::new(3, "نسخة المستخدم");
        let own = Arc::new(OwnWrites::new());
        let pause = Mutex::new(Pause::Off);
        let mut last = 2;

        let wrote_mid_poll = Arc::new(AtomicBool::new(false));
        let (writer_tx, writer_rx) = mpsc::channel();
        {
            let (b, own, wrote_mid_poll) = (board.clone(), own.clone(), wrote_mid_poll.clone());
            // Read 1 is the poll's glance, outside the gate; read 2 the count
            // it decides on; read 3 opens the bracket around the read, after
            // the ownership check.
            board.at_count_read(3, move || {
                let (done_tx, done_rx) = mpsc::channel();
                let writer = std::thread::spawn(move || {
                    let count = own.write(|| Some(b.write("ما كتبه رفّ", None)));
                    let _ = done_tx.send(());
                    count
                });
                wrote_mid_poll.store(done_rx.recv_timeout(BLOCKED_FOR).is_ok(), Ordering::SeqCst);
                writer_tx.send(writer).unwrap();
            });
        }
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "captured");
        assert!(
            !wrote_mid_poll.load(Ordering::SeqCst),
            "رفّ wrote inside the poll"
        );
        assert_eq!(
            texts(&store),
            ["نسخة المستخدم"],
            "the user's copy, not رفّ's"
        );

        assert_eq!(writer_rx.recv().unwrap().join().unwrap(), Some(4));
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "own");
        assert_eq!(texts(&store), ["نسخة المستخدم"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Window 2 with «تجاهل النسخة التالية» pending: the skip belongs to the
    /// user's copy the poll is deciding on, never to رفّ's write behind it.
    #[test]
    fn a_skip_is_spent_on_the_users_copy_not_on_raffs_write_behind_it() {
        let (dir, store) = empty_store();
        let board = FakeBoard::new(3, "سرّ");
        let own = Arc::new(OwnWrites::new());
        let pause = Mutex::new(Pause::SkipNext);
        let mut last = 2;

        let (writer_tx, writer_rx) = mpsc::channel();
        {
            let (b, own) = (board.clone(), own.clone());
            // Read 2: the gate is already held, the count not yet read.
            board.at_count_read(2, move || {
                let writer =
                    std::thread::spawn(move || own.write(|| Some(b.write("ما كتبه رفّ", None))));
                std::thread::sleep(BLOCKED_FOR);
                writer_tx.send(writer).unwrap();
            });
        }
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "skipped");
        assert_eq!(last, 3, "the poll decided on the user's copy");
        assert_eq!(
            board.clip_reads.load(Ordering::SeqCst),
            0,
            "the secret was never read"
        );
        assert_eq!(*pause.lock().unwrap(), Pause::Off);

        assert_eq!(writer_rx.recv().unwrap().join().unwrap(), Some(4));
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "own");
        board.write("نسخة لاحقة", None);
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "captured");
        assert_eq!(texts(&store), ["نسخة لاحقة"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Another app's copy landing after رفّ's write, before the poll: the
    /// pasteboard holds the other app's, which is captured, and the record of
    /// رفّ's write is spent rather than left to name a later change.
    #[test]
    fn a_copy_after_raffs_write_is_captured_and_spends_the_record() {
        let (dir, store) = empty_store();
        let board = FakeBoard::new(2, "قديم");
        let own = OwnWrites::new();
        let pause = Mutex::new(Pause::Off);
        let mut last = 2;

        assert_eq!(own.write(|| Some(board.write("ما كتبه رفّ", None))), Some(3));
        board.write("من تطبيق آخر", None);
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "captured");
        assert_eq!(texts(&store), ["من تطبيق آخر"]);
        assert_eq!(*own.hold(), None, "the record is spent");

        // And رفّ's next write is still recognised.
        own.write(|| Some(board.write("ما كتبه رفّ", None)));
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "own");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 007 ج1 alongside the gate: the loop state changes when a window starts,
    /// not what the gate decides. رفّ's write is still recognised and spent,
    /// a copy landing mid-look is still left to the next poll — and that poll
    /// judges it over a window reaching back to the look that left it.
    #[test]
    fn the_watch_keeps_the_gates_outcomes_and_covers_what_a_look_left() {
        let (dir, store) = empty_store();
        let board = FakeBoard::new(2, "قديم");
        let own = OwnWrites::new();
        let pause = Mutex::new(Pause::Off);
        let t0 = Instant::now();
        let mut watch = Watch::from(2, t0);
        let at = |ms| t0 + MS(ms);

        own.write(|| Some(board.write("ما كتبه رفّ", None)));
        let (found, window) = poll_at(&board, &own, &pause, &store, &mut watch, at(400));
        assert_eq!((found, window), ("own", Some(MS(400))));
        assert_eq!(*own.hold(), None, "the record is spent");
        let unchanged = poll_at(&board, &own, &pause, &store, &mut watch, at(750));
        assert_eq!(unchanged, ("unchanged", None));

        board.write("أولى", None);
        {
            let b = board.clone();
            board.at_count_read(3, move || {
                b.write("ثانية", None);
            });
        }
        let (found, window) = poll_at(&board, &own, &pause, &store, &mut watch, at(1_100));
        assert_eq!((found, window), ("moved", Some(MS(350))));
        let (found, window) = poll_at(&board, &own, &pause, &store, &mut watch, at(1_600));
        assert_eq!(found, "captured");
        assert_eq!(window, Some(MS(500)), "from the look that left it");
        assert_eq!(texts(&store), ["ثانية"]);
        assert_eq!(board.clip_reads.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Another app's copy landing between the count a poll decided on and its
    /// read: what is there now was never checked (a pause, the exclusions),
    /// so it is left to the next poll, which checks it and stores it.
    #[test]
    fn a_copy_landing_mid_poll_is_left_to_the_next_poll() {
        let (dir, store) = empty_store();
        let board = FakeBoard::new(3, "أولى");
        let own = OwnWrites::new();
        let pause = Mutex::new(Pause::Off);
        let mut last = 2;
        {
            let b = board.clone();
            board.at_count_read(3, move || {
                b.write("ثانية", None);
            });
        }
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "moved");
        assert_eq!(board.clip_reads.load(Ordering::SeqCst), 0);
        assert_eq!(last, 3);
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "captured");
        assert_eq!(texts(&store), ["ثانية"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A copy landing between the poll's glance and its look: the rules were
    /// gathered for the glance (who was in front, the exclusions), so the new
    /// change is left to the next poll, which gathers them for it. Nothing is
    /// read, and a pending skip is not spent on it.
    #[test]
    fn a_copy_landing_before_the_look_is_judged_by_its_own_rules() {
        let (dir, store) = empty_store();
        let board = FakeBoard::new(3, "أولى");
        let own = OwnWrites::new();
        let pause = Mutex::new(Pause::SkipNext);
        let mut last = 2;
        {
            let b = board.clone();
            // Read 2: the count the look decides on.
            board.at_count_read(2, move || {
                b.write("ثانية", None);
            });
        }
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "moved");
        assert_eq!(board.clip_reads.load(Ordering::SeqCst), 0);
        assert_eq!(*pause.lock().unwrap(), Pause::SkipNext);
        assert_eq!(last, 3, "the new change is not marked as seen");
        // The next poll takes it up with its own rules: it is the user's next
        // copy, so the skip goes to it, unread.
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "skipped");
        assert_eq!(board.clip_reads.load(Ordering::SeqCst), 0);
        board.write("ثالثة", None);
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "captured");
        assert_eq!(texts(&store), ["ثالثة"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// H7: two of رفّ's writes before one poll. The pasteboard holds only the
    /// second, the record names only the second, and the poll skips it; the
    /// first was never there to be captured. A copy made after is captured.
    #[test]
    fn two_own_writes_before_one_poll_are_skipped_and_the_next_copy_is_not() {
        let (dir, store) = empty_store();
        let board = FakeBoard::new(40, "قديم");
        let own = OwnWrites::new();
        let pause = Mutex::new(Pause::Off);
        let mut last = 40;
        own.write(|| Some(board.write("أولى", None)));
        own.write(|| Some(board.write("ثانية", None)));
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "own");
        board.write("نسخة المستخدم", None);
        assert_eq!(poll(&board, &own, &pause, &store, &mut last), "captured");
        assert_eq!(texts(&store), ["نسخة المستخدم"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A write that fails records nothing, and a stale record never makes a
    /// later change look like رفّ's.
    #[test]
    fn a_rejected_write_records_nothing() {
        let own = OwnWrites::new();
        assert_eq!(own.write(|| None), None);
        assert_eq!(*own.hold(), None);
    }

    /// The gate survives a panic inside a write: the capture loop and the next
    /// copy keep working instead of panicking on a poisoned lock.
    #[test]
    fn a_panic_inside_a_write_does_not_wedge_the_gate() {
        let own = Arc::new(OwnWrites::new());
        let panicked = {
            let own = own.clone();
            std::thread::spawn(move || own.write(|| panic!("a write that fails badly")))
        }
        .join();
        assert!(panicked.is_err());
        assert_eq!(own.write(|| Some(7)), Some(7));
        assert_eq!(*own.hold(), Some(7));
    }

    fn reading(before: isize, after: isize, text: &str) -> ClipReading {
        ClipReading {
            before,
            after,
            clip: macos::RawClip {
                text: Some(text.into()),
                ..Default::default()
            },
            source: macos::FrontApp::default(),
        }
    }

    /// A PNG whose IHDR declares `w`×`h`. Only the header is well-formed —
    /// that is the whole point: nothing must ever decode it.
    fn png_header_declaring(w: u32, h: u32) -> Vec<u8> {
        fn crc32(bytes: &[u8]) -> u32 {
            let mut crc = 0xffff_ffffu32;
            for byte in bytes {
                crc ^= *byte as u32;
                for _ in 0..8 {
                    crc = if crc & 1 != 0 {
                        (crc >> 1) ^ 0xedb8_8320
                    } else {
                        crc >> 1
                    };
                }
            }
            !crc
        }

        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit truecolour, no interlace

        let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(&ihdr);
        out.extend_from_slice(&crc32(&ihdr).to_be_bytes());
        // An empty IDAT: the header reader stops at the first one, so this is
        // the shortest well-formed file that still declares w×h — and it is
        // exactly the shape of the payload that lies about its size.
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(b"IDAT");
        out.extend_from_slice(&crc32(b"IDAT").to_be_bytes());
        out
    }

    fn image_reading(png: Vec<u8>) -> ClipReading {
        ClipReading {
            before: 7,
            after: 7,
            clip: macos::RawClip {
                png: Some(png),
                ..Default::default()
            },
            source: macos::FrontApp::default(),
        }
    }

    #[test]
    fn recopying_an_image_whose_file_vanished_writes_it_again() {
        let dir = std::env::temp_dir().join(format!("raff-heal-test-{}", uuid::Uuid::new_v4()));
        let store = Mutex::new(Store::load(dir.clone()));
        let png = encode_png(&image::DynamicImage::new_rgba8(12, 9)).unwrap();

        assert!(capture_reading(&store, image_reading(png.clone())));
        let images = dir.join(crate::storage::IMAGES_DIR);
        let stored = {
            let guard = store.lock().unwrap();
            guard.history[0].image_file.clone().unwrap()
        };

        // The file goes away underneath the row — a botched sync, a manual
        // clean-up. The metadata still names it.
        std::fs::remove_file(images.join(&stored)).unwrap();

        // Copying the very same image again is the user's only lever.
        assert!(capture_reading(&store, image_reading(png)));

        let guard = store.lock().unwrap();
        assert_eq!(
            guard.history.len(),
            1,
            "it is still one row, not a duplicate"
        );
        let healed = guard.history[0].image_file.clone().unwrap();
        assert!(
            images.join(&healed).exists(),
            "the row points at a file that is actually there again"
        );
    }

    fn solid_png(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        let pixels = image::RgbaImage::from_pixel(w, h, image::Rgba(rgba));
        encode_png(&image::DynamicImage::ImageRgba8(pixels)).unwrap()
    }

    #[test]
    fn a_pinned_image_without_a_fingerprint_keeps_its_own_picture() {
        let dir = std::env::temp_dir().join(format!("raff-hashless-test-{}", uuid::Uuid::new_v4()));
        let images = dir.join(crate::storage::IMAGES_DIR);
        std::fs::create_dir_all(&images).unwrap();

        // An older pinned row with no fingerprint, under the label every
        // 100×100 image gets.
        let original = solid_png(100, 100, [200, 30, 30, 255]);
        std::fs::write(images.join("legacy.png"), &original).unwrap();
        std::fs::write(
            dir.join(crate::storage::PINNED_FILE),
            r#"[{"id":"legacy","type":"image","text":"صورة 100×100","imageFile":"legacy.png","sourceAppBundleId":"com.apple.Preview","sourceApp":"Preview","createdAt":100,"isPinned":true,"pinnedOrder":0,"copyCount":1,"pasteCount":0,"lastUsedAt":100}]"#,
        )
        .unwrap();
        let store = Mutex::new(Store::load(dir.clone()));

        // A different picture of the same size, copied twice.
        let other = solid_png(100, 100, [30, 30, 200, 255]);
        assert!(capture_reading(&store, image_reading(other.clone())));
        assert!(capture_reading(&store, image_reading(other.clone())));

        let check = |store: &Store, when: &str| {
            assert_eq!(store.pinned.len(), 1, "{when}");
            assert_eq!(
                store.pinned[0].image_file.as_deref(),
                Some("legacy.png"),
                "{when}: the pinned row still points at its own picture"
            );
            assert_eq!(
                std::fs::read(images.join("legacy.png")).unwrap(),
                original,
                "{when}: and that picture is still on disk, unchanged"
            );
            assert_eq!(
                store.history.len(),
                1,
                "{when}: the new picture is one row of its own"
            );
            let file = store.history[0].image_file.clone().unwrap();
            assert_eq!(std::fs::read(images.join(file)).unwrap(), other, "{when}");
        };
        check(&store.lock().unwrap(), "after the copies");
        drop(store);

        // A clean load runs orphan collection: both files must still count.
        check(&Store::load(dir.clone()), "after reload");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_pixel_budget_is_decided_from_the_header_alone() {
        let side = (MAX_IMAGE_PIXELS as f64).sqrt() as u32 + 1_000;
        let oversized = png_header_declaring(side, side);
        let ordinary = png_header_declaring(1_600, 1_000);

        // Neither of these carries one byte of pixel data — they differ only
        // in what the header claims. Accepting the second and refusing the
        // first is what proves the decision is taken from the header, before
        // any buffer is sized to the declared dimensions.
        assert!(!fits_pixel_budget(&oversized, image::ImageFormat::Png));
        assert!(fits_pixel_budget(&ordinary, image::ImageFormat::Png));
    }

    #[test]
    fn an_image_within_the_pixel_budget_is_still_captured() {
        let dir = std::env::temp_dir().join(format!("raff-pixels-test-{}", uuid::Uuid::new_v4()));
        let store = Mutex::new(Store::load(dir.clone()));
        let png = encode_png(&image::DynamicImage::new_rgba8(8, 8)).unwrap();

        assert!(capture_reading(&store, image_reading(png)));
        assert_eq!(store.lock().unwrap().history.len(), 1);
    }

    #[test]
    fn a_pasteboard_that_changed_mid_read_is_not_stored() {
        let dir = std::env::temp_dir().join(format!("raff-race-test-{}", uuid::Uuid::new_v4()));
        let store = Mutex::new(Store::load(dir.clone()));

        assert!(!capture_reading(&store, reading(41, 42, "كلمة مرور")));

        assert!(store.lock().unwrap().history.is_empty());
        assert!(!dir.join(crate::storage::HISTORY_FILE).exists());
        assert_eq!(
            std::fs::read_dir(dir.join(crate::storage::IMAGES_DIR))
                .map(|d| d.count())
                .unwrap_or(0),
            0
        );
    }

    #[test]
    fn a_settled_pasteboard_is_still_stored() {
        let dir = std::env::temp_dir().join(format!("raff-race-test-{}", uuid::Uuid::new_v4()));
        let store = Mutex::new(Store::load(dir));

        assert!(capture_reading(&store, reading(42, 42, "نصّ عادي")));
        assert_eq!(store.lock().unwrap().history.len(), 1);
    }

    #[test]
    fn retina_thumbnail_fits_without_cropping() {
        let wide = image::DynamicImage::new_rgba8(1000, 100);
        let wide_thumb = wide.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
        assert_eq!(wide_thumb.dimensions(), (128, 13));

        let tall = image::DynamicImage::new_rgba8(100, 1000);
        let tall_thumb = tall.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
        assert_eq!(tall_thumb.dimensions(), (8, 80));

        let square = image::DynamicImage::new_rgba8(800, 800);
        let square_thumb = square.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
        assert_eq!(square_thumb.dimensions(), (80, 80));
    }

    #[test]
    fn thumbnail_filename_is_returned_only_after_a_successful_write() {
        let root = std::env::temp_dir().join(format!("raff-thumb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = image::DynamicImage::new_rgba8(640, 480);

        let name = "preview.thumb.png".to_string();
        assert_eq!(write_thumbnail(&root, name.clone(), &source), Some(name));
        let decoded = image::open(root.join("preview.thumb.png")).unwrap();
        assert_eq!(decoded.dimensions(), (107, 80));

        let missing_parent = root.join("missing");
        assert_eq!(
            write_thumbnail(&missing_parent, "never-written.png".into(), &source),
            None
        );
    }
}
