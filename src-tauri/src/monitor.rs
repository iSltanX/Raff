//! Clipboard capture: a background thread polls the pasteboard change count
//! every ~350ms (the standard macOS approach — there is no push notification).

use std::hash::{Hash, Hasher};
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{detect_kind, ItemKind};
use crate::{macos, AppState};

const POLL_MS: u64 = 350;
/// The panel displays image previews at 136×72 logical pixels. Store at 2x
/// for Retina screens while preserving the source aspect ratio; `thumbnail`
/// fits inside this box and never crops.
const THUMB_MAX_W: u32 = 272;
const THUMB_MAX_H: u32 = 144;

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
        let old_history = store.history.clone();
        let old_pinned = store.pinned.clone();
        let capture = store.capture(
            detect_kind(&text),
            text,
            raw.html,
            rtf_b64,
            None,
            None,
            None,
            (front.name, front.bundle_id),
        );
        let Ok(_outcome) = store.persist_capture(capture, old_history, old_pinned) else {
            return false;
        };
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
        let thumb_name = format!("{id_base}.thumb.png");
        if std::fs::write(dir.join(&image_file), &png).is_err() {
            return false;
        }
        let thumb_file = write_thumbnail(&dir, thumb_name, &decoded);
        (Some(image_file), thumb_file)
    };

    let old_history = store.history.clone();
    let old_pinned = store.pinned.clone();
    let created_files = [image_file.clone(), thumb_file.clone()];
    let capture = store.capture(
        ItemKind::Image,
        label,
        None,
        None,
        image_file,
        thumb_file,
        Some(hash),
        (front.name, front.bundle_id),
    );
    if store
        .persist_capture(capture, old_history, old_pinned)
        .is_err()
    {
        // These files were created for this failed capture and are not
        // referenced by the restored metadata snapshot.
        for file in created_files.into_iter().flatten() {
            let _ = std::fs::remove_file(store.images_dir().join(file));
        }
        return false;
    }
    true
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

fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = std::hash::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    #[test]
    fn retina_thumbnail_fits_without_cropping() {
        let wide = image::DynamicImage::new_rgba8(1000, 100);
        let wide_thumb = wide.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
        assert_eq!(wide_thumb.dimensions(), (272, 27));

        let tall = image::DynamicImage::new_rgba8(100, 1000);
        let tall_thumb = tall.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
        assert_eq!(tall_thumb.dimensions(), (14, 144));

        let square = image::DynamicImage::new_rgba8(800, 800);
        let square_thumb = square.thumbnail(THUMB_MAX_W, THUMB_MAX_H);
        assert_eq!(square_thumb.dimensions(), (144, 144));
    }

    #[test]
    fn thumbnail_filename_is_returned_only_after_a_successful_write() {
        let root = std::env::temp_dir().join(format!("raff-thumb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = image::DynamicImage::new_rgba8(640, 480);

        let name = "preview.thumb.png".to_string();
        assert_eq!(write_thumbnail(&root, name.clone(), &source), Some(name));
        let decoded = image::open(root.join("preview.thumb.png")).unwrap();
        assert_eq!(decoded.dimensions(), (192, 144));

        let missing_parent = root.join("missing");
        assert_eq!(
            write_thumbnail(&missing_parent, "never-written.png".into(), &source),
            None
        );
    }
}
