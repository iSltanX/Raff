//! Clipboard capture: a background thread polls the pasteboard change count
//! every ~350ms (the standard macOS approach — there is no push notification).

use std::hash::{Hash, Hasher};
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{detect_kind, CaptureOutcome, ItemKind};
use crate::{macos, tray, AppState};

const POLL_MS: u64 = 350;
/// Thumbnails are capped to this box (logical 200×40 at 2x).
const THUMB_MAX_W: u32 = 400;
const THUMB_MAX_H: u32 = 80;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = macos::change_count();
        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            let count = macos::change_count();
            if count == last {
                continue;
            }
            last = count;

            let state = app.state::<AppState>();
            // Skip our own paste/copy writes.
            if state.skip_change_count.swap(-1, Ordering::SeqCst) == count as i64 {
                continue;
            }

            let (enabled, respect_concealed, excluded) = {
                let store = state.store.lock().unwrap();
                (
                    store.settings.capture_enabled,
                    store.settings.respect_concealed,
                    store.settings.excluded_apps.clone(),
                )
            };
            if !enabled {
                continue;
            }
            // Never store password-manager / auto-generated content.
            if respect_concealed && macos::has_concealed_type() {
                continue;
            }
            let front = macos::frontmost_app();
            if excluded.contains(&front.bundle_id) {
                continue;
            }

            if capture_current(&app, front) {
                let _ = app.emit("raff://changed", ());
                tray::refresh(&app);
            }
        }
    });
}

/// Reads the pasteboard and stores it. Returns true when the store changed.
fn capture_current(app: &AppHandle, front: macos::FrontApp) -> bool {
    let raw = macos::read_clip();
    let state = app.state::<AppState>();

    // Prefer text; fall back to image data.
    if let Some(text) = raw.text.filter(|t| !t.trim().is_empty()) {
        let rtf_b64 = raw
            .rtf
            .map(|r| base64::engine::general_purpose::STANDARD.encode(r));
        let mut store = state.store.lock().unwrap();
        let outcome = store.capture(
            detect_kind(&text),
            text,
            raw.html,
            rtf_b64,
            None,
            None,
            None,
            (front.name, front.bundle_id),
        );
        store.save_history();
        if outcome == CaptureOutcome::Deduped {
            store.save_pinned(); // the bump may have touched a pinned item
        }
        return true;
    }

    let png = raw.png.or_else(|| {
        raw.tiff.and_then(|tiff| {
            image::load_from_memory_with_format(&tiff, image::ImageFormat::Tiff)
                .ok()
                .and_then(|img| encode_png(&img))
        })
    });
    let Some(png) = png else {
        return false;
    };

    let hash = content_hash(&png);
    let Ok(decoded) = image::load_from_memory_with_format(&png, image::ImageFormat::Png) else {
        return false;
    };
    let (w, h) = (decoded.width(), decoded.height());
    let label = format!("صورة {w}×{h}");

    let mut store = state.store.lock().unwrap();
    // Identical image already stored? Bump it without touching the disk.
    let dup = store
        .pinned
        .iter()
        .chain(store.history.iter())
        .any(|i| i.kind == ItemKind::Image && i.hash.as_deref() == Some(hash.as_str()));

    let (image_file, thumb_file) = if dup {
        (None, None)
    } else {
        let dir = store.images_dir();
        let id_base = uuid::Uuid::new_v4().to_string();
        let image_file = format!("{id_base}.png");
        let thumb_file = format!("{id_base}.thumb.png");
        if std::fs::write(dir.join(&image_file), &png).is_err() {
            return false;
        }
        let thumb = decoded.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
        if let Some(bytes) = encode_png(&thumb) {
            let _ = std::fs::write(dir.join(&thumb_file), bytes);
        }
        (Some(image_file), Some(thumb_file))
    };

    let outcome = store.capture(
        ItemKind::Image,
        label,
        None,
        None,
        image_file,
        thumb_file,
        Some(hash),
        (front.name, front.bundle_id),
    );
    store.save_history();
    if outcome == CaptureOutcome::Deduped {
        store.save_pinned();
    }
    true
}

fn encode_png(img: &image::DynamicImage) -> Option<Vec<u8>> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = std::hash::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
