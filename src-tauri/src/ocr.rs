//! «اقرأ النص في الصور» (IMP-09, experimental, off by default).
//!
//! A picture's text is read on this Mac by Vision, one picture at a time on a
//! thread of its own, and kept with the row (`ClipItem::ocr_text`) for the
//! deep search to find. Nothing leaves the Mac. Turning the option off stops
//! the reading and forgets every text it read (`Store::forget_ocr_text`).
//!
//! Vision has no binding in the crates Raff uses, so it is reached through
//! `msg_send!`. Arabic arrived in a later revision of the text recogniser
//! than Raff's oldest macOS: it is asked for only where the running system
//! lists it, and the recogniser keeps its own defaults elsewhere.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::storage::Store;
use crate::AppState;

/// How long the reader rests between looks when there is nothing to read.
const IDLE: Duration = Duration::from_secs(3);
/// And between two pictures: a first run over a long history is spread out,
/// not a burst that keeps the store's lock busy.
const PACE: Duration = Duration::from_millis(500);
/// A picture's text past this is not kept: enough for any screenshot.
pub const MAX_OCR_CHARS: usize = 20_000;

/// The reader: looks for a picture not yet read, reads it, and keeps what it
/// found, for as long as Raff runs. It does nothing while the option is off.
pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("raff-ocr".into())
        .spawn(move || loop {
            // A panic in one picture costs that look, not the reader; the
            // store's lock survives it (`lock_store` takes a poisoned lock).
            let read = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let state = app.state::<AppState>();
                objc2::rc::autoreleasepool(|_| step(&state.store, recognize))
            }))
            .unwrap_or(false);
            std::thread::sleep(if read { PACE } else { IDLE });
        });
    if let Err(err) = spawned {
        eprintln!("raff: the picture reader did not start: {err}");
    }
}

/// One picture, if one is waiting and the option is on. Reading happens with
/// the store free; what was read is kept only if the option is still on and
/// the row is still there — in the model at once, on disk with the coalesced
/// flush (`stage_signal_flush`). Answers whether a picture was read.
pub(crate) fn step(store: &Mutex<Store>, read: impl FnOnce(&Path) -> Option<String>) -> bool {
    let next = {
        let store = crate::lock_store(store);
        if !store.settings.ocr_enabled {
            return false;
        }
        store.next_for_ocr()
    };
    let Some((id, path)) = next else {
        return false;
    };
    // A picture Vision cannot read — or that makes the reader panic — is
    // kept as read, with nothing found: it is not tried again on every look.
    let text = path
        .and_then(|path| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read(&path)))
                .ok()
                .flatten()
        })
        .unwrap_or_default();
    let mut text: String = text.trim().chars().take(MAX_OCR_CHARS).collect();
    let mut store = crate::lock_store(store);
    if !store.settings.ocr_enabled {
        return false;
    }
    // «لا تحفظ ما يشبه مفتاحًا سريًا» holds for a picture's text too.
    if store.settings.skip_secrets && crate::secrets::looks_like_secret(&text) {
        text.clear();
    }
    store.set_ocr_text(&id, text);
    true
}

#[link(name = "Vision", kind = "framework")]
extern "C" {}

/// The text Vision reads in the picture at `path`, lines joined by newlines;
/// `None` when it could not read it. An Objective-C exception from Vision or
/// Foundation is caught here: it would otherwise end Raff, not this read.
pub fn recognize(path: &Path) -> Option<String> {
    // `catch` is safe in this objc2: it is what stops an Objective-C exception
    // here. `recognize_unguarded` changes no state of Raff's that one could
    // leave half-done; at worst the objects of this one read are not released.
    objc2::exception::catch(std::panic::AssertUnwindSafe(|| recognize_unguarded(path)))
        .ok()
        .flatten()
}

fn recognize_unguarded(path: &Path) -> Option<String> {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let request_class: &AnyClass = class!(VNRecognizeTextRequest);
    let path = NSString::from_str(path.to_str()?);
    // SAFETY: every message below is one Vision and Foundation document for
    // these classes, with the argument and return types they declare; every
    // object is held by a `Retained` for as long as it is used.
    unsafe {
        let url: Option<Retained<AnyObject>> = msg_send![class!(NSURL), fileURLWithPath: &*path];
        let url = url?;
        let options: Option<Retained<AnyObject>> = msg_send![class!(NSDictionary), dictionary];
        let options = options?;
        let allocated: Allocated<AnyObject> = msg_send![class!(VNImageRequestHandler), alloc];
        let handler: Option<Retained<AnyObject>> =
            msg_send![allocated, initWithURL: &*url, options: &*options];
        let handler = handler?;
        let request: Option<Retained<AnyObject>> = msg_send![request_class, new];
        let request = request?;

        // Accurate (0), with language correction.
        let _: () = msg_send![&*request, setRecognitionLevel: 0isize];
        let _: () = msg_send![&*request, setUsesLanguageCorrection: true];
        // The newest revision this system has, and Arabic where it lists it.
        let revisions: Option<Retained<AnyObject>> = msg_send![request_class, supportedRevisions];
        if let Some(revisions) = revisions {
            let latest: usize = msg_send![&*revisions, lastIndex];
            // NSNotFound: an empty set.
            if latest != isize::MAX as usize {
                let _: () = msg_send![&*request, setRevision: latest];
            }
        }
        if lists_arabic(&request) {
            let arabic = NSString::from_str("ar-SA");
            let english = NSString::from_str("en-US");
            let languages: Option<Retained<AnyObject>> = msg_send![class!(NSMutableArray), array];
            if let Some(languages) = languages {
                let _: () = msg_send![&*languages, addObject: &*arabic];
                let _: () = msg_send![&*languages, addObject: &*english];
                let _: () = msg_send![&*request, setRecognitionLanguages: &*languages];
            }
        }

        let requests: Option<Retained<AnyObject>> =
            msg_send![class!(NSArray), arrayWithObject: &*request];
        let requests = requests?;
        let done: bool = msg_send![
            &*handler,
            performRequests: &*requests,
            error: std::ptr::null_mut::<*mut AnyObject>()
        ];
        if !done {
            return None;
        }
        let results: Option<Retained<AnyObject>> = msg_send![&*request, results];
        let results = results?;
        let count: usize = msg_send![&*results, count];
        let mut lines = Vec::with_capacity(count);
        for index in 0..count {
            let observation: *mut AnyObject = msg_send![&*results, objectAtIndex: index];
            let Some(observation) = observation.as_ref() else {
                continue;
            };
            let candidates: Option<Retained<AnyObject>> =
                msg_send![observation, topCandidates: 1usize];
            let Some(candidates) = candidates else {
                continue;
            };
            let first: *mut AnyObject = msg_send![&*candidates, firstObject];
            let Some(first) = first.as_ref() else {
                continue;
            };
            let string: Option<Retained<NSString>> = msg_send![first, string];
            if let Some(string) = string {
                lines.push(string.to_string());
            }
        }
        Some(lines.join("\n"))
    }
}

/// Whether this system's recogniser, at the revision set on `request`, reads
/// Arabic.
///
/// SAFETY: `request` is a `VNRecognizeTextRequest`.
unsafe fn lists_arabic(request: &objc2::runtime::AnyObject) -> bool {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;

    let languages: Option<Retained<AnyObject>> = msg_send![
        request,
        supportedRecognitionLanguagesAndReturnError: std::ptr::null_mut::<*mut AnyObject>()
    ];
    let Some(languages) = languages else {
        return false;
    };
    let arabic = NSString::from_str("ar-SA");
    msg_send![&*languages, containsObject: &*arabic]
}

/// The picture behind a row, if its file name is one of Raff's own.
pub(crate) fn picture_path(images_dir: &Path, file: Option<&str>) -> Option<PathBuf> {
    let path = crate::storage::image_path(images_dir, file?)?;
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{ItemKind, SettingsPatch};
    use std::cell::Cell;

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("raff-ocr-test-{}", uuid::Uuid::new_v4()))
    }

    /// A store with one picture whose file exists, and one whose file is gone.
    fn store_with_pictures(dir: &Path, ocr_enabled: bool) -> Mutex<Store> {
        let mut store = Store::load(dir.to_path_buf());
        std::fs::create_dir_all(store.images_dir()).unwrap();
        std::fs::write(store.images_dir().join("here.png"), b"png").unwrap();
        for (file, hash) in [("gone.png", "h-gone"), ("here.png", "h-here")] {
            store.capture(
                ItemKind::Image,
                "صورة 10×10".into(),
                None,
                None,
                Some(file.into()),
                None,
                Some(hash.into()),
                ("Preview".into(), "com.apple.Preview".into()),
            );
        }
        store.save_history();
        if ocr_enabled {
            let settings = SettingsPatch {
                ocr_enabled: Some(true),
                ..Default::default()
            }
            .applied_to(&store.settings);
            store.update_settings_persisted(settings).unwrap();
        }
        Mutex::new(store)
    }

    fn flush(store: &Mutex<Store>) {
        let writes = crate::lock_store(store).stage_signal_flush();
        for write in writes {
            write.commit().unwrap();
        }
    }

    fn set_ocr(store: &Mutex<Store>, on: bool) {
        let mut store = crate::lock_store(store);
        let settings = SettingsPatch {
            ocr_enabled: Some(on),
            ..Default::default()
        }
        .applied_to(&store.settings);
        store.update_settings_persisted(settings).unwrap();
    }

    fn ocr_of(store: &Mutex<Store>, file: &str) -> Option<String> {
        crate::lock_store(store)
            .history
            .iter()
            .find(|i| i.image_file.as_deref() == Some(file))
            .and_then(|i| i.ocr_text.clone())
    }

    #[test]
    fn nothing_is_read_while_the_option_is_off() {
        let store = store_with_pictures(&temp(), false);
        let asked = Cell::new(0);
        assert!(!step(&store, |_| {
            asked.set(asked.get() + 1);
            Some("نص".into())
        }));
        assert_eq!(asked.get(), 0);
        assert_eq!(ocr_of(&store, "here.png"), None);
    }

    /// Newest first, one picture a step; a file that is gone is kept as read
    /// with nothing found and never handed to Vision; the text is on disk.
    #[test]
    fn each_picture_is_read_once_and_kept() {
        let dir = temp();
        let store = store_with_pictures(&dir, true);
        let asked = Cell::new(0);
        let read = |path: &Path| {
            asked.set(asked.get() + 1);
            assert!(path.ends_with("here.png"));
            Some("  فاتورة رقم ٤٢\nTotal 42  ".into())
        };
        assert!(step(&store, read));
        assert_eq!(
            ocr_of(&store, "here.png").as_deref(),
            Some("فاتورة رقم ٤٢\nTotal 42")
        );
        assert!(step(&store, read));
        assert_eq!(ocr_of(&store, "gone.png").as_deref(), Some(""));
        assert!(!step(&store, read), "nothing left to read");
        assert_eq!(asked.get(), 1, "the missing file never reached Vision");

        // Kept in the model at once, written by the coalesced flush: a first
        // run over a long history is not one full history write per picture.
        assert!(Store::load(dir.clone())
            .history
            .iter()
            .all(|i| i.ocr_text.is_none()));
        flush(&store);
        let reloaded = Store::load(dir);
        let kept = reloaded
            .history
            .iter()
            .find(|i| i.image_file.as_deref() == Some("here.png"))
            .and_then(|i| i.ocr_text.clone());
        assert_eq!(kept.as_deref(), Some("فاتورة رقم ٤٢\nTotal 42"));
    }

    /// Turned off while a picture was being read: what was read is not kept.
    /// Turned off afterwards: every text read is forgotten, on disk too.
    #[test]
    fn turning_it_off_keeps_nothing_and_forgets_what_was_read() {
        let dir = temp();
        let store = store_with_pictures(&dir, true);
        let off = |store: &Mutex<Store>| {
            let mut store = crate::lock_store(store);
            let settings = SettingsPatch {
                ocr_enabled: Some(false),
                ..Default::default()
            }
            .applied_to(&store.settings);
            store.update_settings_persisted(settings).unwrap();
        };
        assert!(!step(&store, |_| {
            off(&store);
            Some("سرّ".into())
        }));
        assert_eq!(ocr_of(&store, "here.png"), None);

        {
            let mut s = crate::lock_store(&store);
            let settings = SettingsPatch {
                ocr_enabled: Some(true),
                ..Default::default()
            }
            .applied_to(&s.settings);
            s.update_settings_persisted(settings).unwrap();
        }
        assert!(step(&store, |_| Some("نص".into())));
        assert_eq!(ocr_of(&store, "here.png").as_deref(), Some("نص"));
        off(&store);
        assert_eq!(ocr_of(&store, "here.png"), None);
        let reloaded = Store::load(dir);
        assert!(
            reloaded.history.iter().all(|i| i.ocr_text.is_none()),
            "forgotten on disk"
        );
    }

    /// A picture's text is as long as a screenshot's, not as long as a book.
    #[test]
    fn a_long_text_is_cut_to_its_cap() {
        let store = store_with_pictures(&temp(), true);
        assert!(step(&store, |_| Some("ب".repeat(MAX_OCR_CHARS + 50))));
        assert_eq!(
            ocr_of(&store, "here.png").map(|t| t.chars().count()),
            Some(MAX_OCR_CHARS)
        );
    }

    /// Review 2026-10-22: a picture that makes the reader panic is kept as
    /// read with nothing found — not tried again every few seconds forever.
    #[test]
    fn a_picture_that_breaks_the_reader_is_not_tried_again() {
        let store = store_with_pictures(&temp(), true);
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let read = step(&store, |_| panic!("Vision fell over"));
        std::panic::set_hook(hook);
        assert!(read);
        assert_eq!(ocr_of(&store, "here.png").as_deref(), Some(""));
    }

    /// Review 2026-10-22: «لا تحفظ ما يشبه مفتاحًا سريًا» holds for the text
    /// read in a picture too: a screenshot of a token keeps no token.
    #[test]
    fn a_secret_read_in_a_picture_is_not_kept_when_asked() {
        let token = "token ghp_0123456789abcdefABCDEF0123456789abcd";
        let store = store_with_pictures(&temp(), true);
        assert!(step(&store, |_| Some(token.into())));
        assert_eq!(
            ocr_of(&store, "here.png").as_deref(),
            Some(token),
            "off: kept"
        );

        let store = store_with_pictures(&temp(), true);
        {
            let mut s = crate::lock_store(&store);
            let settings = SettingsPatch {
                skip_secrets: Some(true),
                ..Default::default()
            }
            .applied_to(&s.settings);
            s.update_settings_persisted(settings).unwrap();
        }
        assert!(step(&store, |_| Some(token.into())));
        assert_eq!(
            ocr_of(&store, "here.png").as_deref(),
            Some(""),
            "on: not kept"
        );
    }

    /// Review 2026-10-22: «إيقافه يمحو كل نص قرأه» everywhere a text can be —
    /// a deleted picture waiting for its Undo too — and the search does not
    /// look at picture text while the option is off.
    #[test]
    fn turning_it_off_forgets_a_deleted_pictures_text_too() {
        let dir = temp();
        let store = store_with_pictures(&dir, true);
        assert!(step(&store, |_| Some("فاتورة".into())));
        let id = crate::lock_store(&store).history[0].id.clone();
        let token = crate::lock_store(&store).delete_reversible(&id).unwrap();
        set_ocr(&store, false);
        let journal =
            std::fs::read_to_string(dir.join(crate::storage::PENDING_DELETE_FILE)).unwrap();
        assert!(
            !journal.contains("فاتورة"),
            "not on disk in the Undo journal"
        );
        crate::lock_store(&store).undo_delete(&token).unwrap();
        assert_eq!(
            ocr_of(&store, "here.png"),
            None,
            "Undo brings the picture, not its text"
        );
    }

    /// Review 2026-10-22: off on disk but text still in a layer — a stop
    /// between the settings write and the layer's, or settings that had to be
    /// recovered — is forgotten when Raff starts.
    #[test]
    fn text_left_behind_while_off_is_forgotten_at_launch() {
        let dir = temp();
        let store = store_with_pictures(&dir, true);
        assert!(step(&store, |_| Some("نص".into())));
        flush(&store);
        drop(store);
        let settings_path = dir.join("settings.json");
        let mut settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
        settings["ocrEnabled"] = false.into();
        std::fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
        let history = std::fs::read_to_string(dir.join("history.json")).unwrap();
        assert!(
            history.contains("\"ocrText\":\"نص\""),
            "the stop left it there"
        );

        let reloaded = Store::load(dir.clone());
        assert!(reloaded.history.iter().all(|i| i.ocr_text.is_none()));
        let history = std::fs::read_to_string(dir.join("history.json")).unwrap();
        assert!(!history.contains("ocrText"), "and on disk");
    }

    /// The real recogniser on a picture with known text. A measurement of
    /// this Mac's Vision, run by hand: `cargo test vision_reads -- --ignored`.
    #[test]
    #[ignore = "native Vision, run by hand"]
    fn vision_reads_a_picture() {
        let path = std::env::var("RAFF_OCR_SAMPLE").expect("RAFF_OCR_SAMPLE=<png>");
        let text = recognize(Path::new(&path)).expect("Vision read the picture");
        println!("OCR: {text:?}");
        assert!(!text.trim().is_empty());
    }
}
