//! Clipboard capture: a background thread polls the pasteboard change count
//! every ~350ms (the standard macOS approach — there is no push notification).

use std::sync::atomic::Ordering;
use std::ops::ControlFlow;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{content_hash, detect_kind, persist_capture, ItemKind, Store};
use crate::{macos, tray, AppState};

const POLL_MS: u64 = 350;
/// How far back a capture looks when asking who owned the clipboard. A change
/// noticed at `T` happened somewhere in `(T - POLL_MS, T]`, so that is exactly
/// the span whose frontmost apps have to clear the exclusion list.
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
    std::thread::spawn(move || {
        let mut last = macos::change_count();
        let outcome = supervise(|| {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            poll_once(&app, &mut last);
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

/// One poll of the pasteboard. `last` carries the change count across ticks.
fn poll_once(app: &AppHandle, last: &mut isize) {
    let count = macos::change_count();
    if count == *last {
        return;
    }
    *last = count;
    let detected_at = Instant::now();

    let state = app.state::<AppState>();
    // Skip our own paste/copy writes.
    if state.skip_change_count.swap(-1, Ordering::SeqCst) == count as i64 {
        return;
    }

    // Before the pasteboard is touched at all: a change skipped on purpose
    // must leave no trace of itself anywhere, not even its length.
    {
        let mut pause = crate::lock_pause(&state.pause);
        let was_active = pause.is_active();
        let skip = pause.consume();
        let still_active = pause.is_active();
        drop(pause);
        if was_active && !still_active {
            tray::note_paused(false);
        }
        if skip {
            return;
        }
    }

    let (enabled, respect_concealed, excluded) = {
        let store = crate::lock_store(&state.store);
        (
            store.settings.capture_enabled,
            store.settings.respect_concealed,
            store.settings.excluded_apps.clone(),
        )
    };
    if !enabled {
        return;
    }

    // Exclusion is decided before the pasteboard is touched at all, and
    // over the whole window the copy could have happened in — not just
    // over whoever is frontmost by the time the poll runs.
    let activations = macos::activation_snapshot();
    let front_now = macos::frontmost_app();
    if excluded.contains(&front_now.bundle_id)
        || macos::window_has_excluded(&activations, &excluded, detected_at, SOURCE_WINDOW)
    {
        return;
    }

    // Bracket the probe and the read: if the pasteboard changes in
    // between, what we hold mixes two clipboards and the concealed-type
    // answer belongs to the older one.
    let before = macos::change_count();
    // Never store password-manager / auto-generated content.
    if respect_concealed && macos::has_concealed_type() {
        return;
    }
    let clip = macos::read_clip();
    let after = macos::change_count();

    let reading = ClipReading {
        before,
        after,
        clip,
        source: macos::front_at(&activations, detected_at, SOURCE_WINDOW)
            .unwrap_or(front_now),
    };
    if capture_reading(&state.store, reading) {
        let _ = app.emit("raff://changed", ());
    }
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
        let capture = crate::lock_store(store_lock).capture(
            detect_kind(&text),
            text,
            raw.html,
            rtf_b64,
            None,
            None,
            None,
            (front.name, front.bundle_id),
        );
        // The guard is gone by now: `persist_capture` writes the layer with the
        // store lock free, so opening the panel does not wait on this write.
        return persist_capture(store_lock, capture).is_ok();
    }

    let Some((png, decoded)) = decode_capture(raw.png, raw.tiff) else {
        return false;
    };

    let hash = content_hash(&png);
    let (w, h) = (decoded.width(), decoded.height());
    let label = format!("صورة {w}×{h}");

    let (images_dir, image_file, thumb_file, capture) = {
        let mut store = crate::lock_store(store_lock);
        let dir = store.images_dir();
        // Identical image already stored, *and* its file is still there? Then
        // bump it without touching the disk. Asking the metadata alone let a
        // row whose file had vanished swallow the re-copy as a duplicate, so
        // no replacement was ever written and the row stayed broken for good —
        // while copying it back out failed with «العنصر غير موجود».
        let dup = store
            .pinned
            .iter()
            .chain(store.history.iter())
            .any(|i| {
                i.kind == ItemKind::Image
                    && i.hash.as_deref() == Some(hash.as_str())
                    && i.image_file
                        .as_ref()
                        .is_some_and(|file| dir.join(file).exists())
            });

        let (image_file, thumb_file) = if dup {
            (None, None)
        } else {
            let id_base = uuid::Uuid::new_v4().to_string();
            let image_file = format!("{id_base}.png");
            let thumb_name = format!("{id_base}.thumb.png");
            if std::fs::write(dir.join(&image_file), &png).is_err() {
                return false;
            }
            let thumb_file = write_thumbnail(&dir, thumb_name, &decoded);
            (Some(image_file), thumb_file)
        };

        let capture = store.capture(
            ItemKind::Image,
            label,
            None,
            None,
            image_file.clone(),
            thumb_file.clone(),
            Some(hash),
            (front.name, front.bundle_id),
        );
        (dir, image_file, thumb_file, capture)
    };

    if persist_capture(store_lock, capture).is_err() {
        // These files were created for this failed capture and nothing in the
        // restored model refers to them.
        for file in [image_file, thumb_file].into_iter().flatten() {
            let _ = std::fs::remove_file(images_dir.join(file));
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

        assert_eq!(outcome, Supervision::Finished, "the loop was not given up on");
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
        assert_eq!(guard.history.len(), 1, "it is still one row, not a duplicate");
        let healed = guard.history[0].image_file.clone().unwrap();
        assert!(
            images.join(&healed).exists(),
            "the row points at a file that is actually there again"
        );
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
