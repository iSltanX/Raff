//! A local backup of the shelf and the settings (IMP-05): one readable JSON
//! file the user saves where they choose, and reads back on another Mac.
//!
//! What goes in is what the user would rebuild by hand: the pinned items —
//! their text, formatting and names — and the settings. Not the history, which
//! is meant to pass, and not pictures, which would make the file a folder.
//! Reading one back is strict: a file that is not exactly this shape is
//! refused whole, never half-applied; items already on the shelf are not
//! added twice, and every added item gets a new id.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::storage::{ItemKind, Settings, Store};
use crate::AppState;

/// What the file says it is, so a stray JSON file is not read as one.
pub const FORMAT: &str = "raff-backup";
pub const VERSION: u32 = 1;
/// Far above any real shelf; a file larger than this is not one of ours.
pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_ITEMS: usize = 2_000;

pub const INVALID: &str = "raff/backup-invalid";
/// A file from a later Raff, whose shape this one cannot know.
pub const NEWER: &str = "raff/backup-newer";
/// `rtf` is stored base64: the capture cap on its bytes, in base64 characters.
pub const MAX_RTF_BASE64: usize = crate::macos::MAX_RICH_BYTES.div_ceil(3) * 4;
pub const TOO_LARGE: &str = "raff/backup-too-large";
pub const WRITE_FAILED: &str = "raff/backup-write-failed";

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupFile {
    pub format: String,
    pub version: u32,
    pub exported_at: u64,
    pub settings: Settings,
    pub pinned: Vec<BackupItem>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupItem {
    #[serde(rename = "type")]
    pub kind: ItemKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtf: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: u64,
}

/// The file for this store, and how many pinned pictures it leaves out.
pub fn build(store: &Store, now: u64) -> (BackupFile, usize) {
    let mut pinned: Vec<&crate::storage::ClipItem> = store.pinned.iter().collect();
    pinned.sort_by_key(|item| item.pinned_order.unwrap_or(u32::MAX));
    let pictures = pinned.iter().filter(|i| i.kind == ItemKind::Image).count();
    let items = pinned
        .into_iter()
        .filter(|item| item.kind != ItemKind::Image)
        .map(|item| BackupItem {
            kind: item.kind,
            text: item.text.clone(),
            html: item.html.clone(),
            rtf: item.rtf.clone(),
            label: item.label.clone(),
            created_at: item.created_at,
        })
        .collect();
    let file = BackupFile {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: now,
        settings: store.settings.clone(),
        pinned: items,
    };
    (file, pictures)
}

/// What any version of the file says about itself, read before the rest so
/// a file from a later Raff is told apart from one that is not a backup.
#[derive(Deserialize)]
struct Header {
    format: Option<String>,
    version: Option<u32>,
}

/// Reads a backup, refusing anything that is not exactly one: another format
/// or version, an unknown field, a picture, an empty item or one over the
/// limits a copy is held to, a name over its cap, or settings `validate`
/// refuses. The settings object itself is lenient as `settings.json` is
/// (missing fields take their defaults, unknown ones are ignored); `validate`
/// is what holds it to account.
pub fn parse(
    bytes: &[u8],
    validate: impl Fn(&Settings) -> Result<(), String>,
) -> Result<BackupFile, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(TOO_LARGE.into());
    }
    let header: Header = serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if header.format.as_deref() != Some(FORMAT) {
        return Err(INVALID.into());
    }
    if header.version.is_some_and(|version| version > VERSION) {
        return Err(NEWER.into());
    }
    let file: BackupFile = serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    let label_ok = |l: &Option<String>| {
        l.as_deref()
            .is_none_or(|l| l.chars().count() <= crate::storage::LABEL_MAX_CHARS)
    };
    let within_capture_limits = |item: &BackupItem| {
        item.text.chars().count() <= crate::macos::MAX_TEXT_CHARS
            && item
                .html
                .as_ref()
                .is_none_or(|html| html.len() <= crate::macos::MAX_RICH_BYTES)
            && item
                .rtf
                .as_ref()
                .is_none_or(|rtf| rtf.len() <= MAX_RTF_BASE64)
    };
    let sound = file.version == VERSION
        && file.pinned.len() <= MAX_ITEMS
        && file.pinned.iter().all(|item| {
            item.kind != ItemKind::Image
                && !item.text.trim().is_empty()
                && label_ok(&item.label)
                && within_capture_limits(item)
        });
    if !sound {
        return Err(INVALID.into());
    }
    validate(&file.settings).map_err(|_| INVALID.to_string())?;
    Ok(file)
}

/// What an export did.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportDto {
    /// False when the save panel was cancelled.
    pub saved: bool,
    pub items: usize,
    /// Pinned pictures the file leaves out.
    pub pictures: usize,
}

/// What an import did. The settings come back for Settings to save through
/// its own path, which words a refused shortcut as it always does.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportDto {
    /// False when the open panel was cancelled.
    pub imported: bool,
    pub added: usize,
    pub skipped: usize,
    pub settings: Option<Settings>,
}

/// Runs `panel` on the main thread and waits for its answer, off it: a modal
/// panel inside Tauri's own event task can re-enter it (see `report.rs`).
async fn on_main_panel(panel: impl FnOnce() -> Option<String> + Send + 'static) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    crate::macos::dispatch_to_main(move || {
        let _ = tx.send(panel());
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
}

/// «تصدير…»: the shelf and the settings into a file the user names.
#[tauri::command]
pub async fn export_backup(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<ExportDto, String> {
    crate::access::require(&window, "export_backup")?;
    let (file, pictures) = {
        let state = app.state::<AppState>();
        let store = crate::lock_store(&state.store);
        build(&store, crate::storage::now_ms())
    };
    let Some(path) =
        on_main_panel(|| crate::macos::choose_backup_destination("رف — نسخة احتياطية.json")).await
    else {
        return Ok(ExportDto {
            saved: false,
            items: 0,
            pictures,
        });
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|_| WRITE_FAILED.to_string())?;
    tauri::async_runtime::spawn_blocking(move || write_backup(&path, &bytes))
        .await
        .map_err(|_| WRITE_FAILED.to_string())?
        .map_err(|_| WRITE_FAILED.to_string())?;
    Ok(ExportDto {
        saved: true,
        items: file.pinned.len(),
        pictures,
    })
}

/// «استيراد…»: a backup's items onto the shelf, its settings back to Settings.
#[tauri::command]
pub async fn import_backup(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<ImportDto, String> {
    crate::access::require(&window, "import_backup")?;
    let Some(path) = on_main_panel(crate::macos::choose_backup_file).await else {
        return Ok(ImportDto {
            imported: false,
            added: 0,
            skipped: 0,
            settings: None,
        });
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || read_capped(&path))
        .await
        .map_err(|_| INVALID.to_string())??;
    let file = parse(&bytes, crate::commands::check_settings)?;
    let (added, skipped) = {
        let state = app.state::<AppState>();
        let mut store = crate::lock_store(&state.store);
        store
            .import_pinned(&file.pinned)
            .map_err(|e| crate::commands::save_failed_code(&e))?
    };
    if added > 0 {
        use tauri::Emitter;
        let _ = app.emit("raff://changed", ());
    }
    Ok(ImportDto {
        imported: true,
        added,
        skipped,
        settings: Some(file.settings),
    })
}

/// The backup into `path`, whole or not at all: written beside it, flushed,
/// then renamed over it — a file the user chose to replace is never left
/// half-written. Readable by its owner alone, as Raff's own files are.
fn write_backup(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = std::path::Path::new(path);
    let name = path
        .file_name()
        .ok_or(std::io::ErrorKind::InvalidInput)?
        .to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.raff-tmp"));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        // Ours, made a moment ago in this call: nothing of the user's.
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// A regular file, read up to one byte past the cap.
fn read_capped(path: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let meta = std::fs::metadata(path).map_err(|_| INVALID.to_string())?;
    if !meta.is_file() {
        return Err(INVALID.into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| INVALID.to_string())?
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| INVALID.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_pins(texts: &[&str]) -> Store {
        store_in(&temp(), texts)
    }

    fn temp() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("raff-backup-test-{}", uuid::Uuid::new_v4()))
    }

    fn store_in(dir: &std::path::Path, texts: &[&str]) -> Store {
        let mut store = Store::load(dir.to_path_buf());
        for text in texts {
            store.capture(
                ItemKind::Text,
                (*text).into(),
                None,
                None,
                None,
                None,
                None,
                ("Notes".into(), "com.apple.Notes".into()),
            );
            let id = store.history[0].id.clone();
            assert!(store.toggle_pin(&id));
        }
        store.save_history();
        store.save_pinned();
        store
    }

    #[test]
    fn a_backup_round_trips_through_its_file() {
        let mut store = store_with_pins(&["أول", "ثانٍ"]);
        let id = store.pinned[0].id.clone();
        store.set_label_persisted(&id, Some("اسم")).unwrap();
        let (file, pictures) = build(&store, 7);
        assert_eq!(pictures, 0);
        assert_eq!(file.pinned.len(), 2);
        let bytes = serde_json::to_vec_pretty(&file).unwrap();
        let back = parse(&bytes, |_| Ok(())).unwrap();
        assert_eq!(back, file);
        assert!(back
            .pinned
            .iter()
            .any(|i| i.label.as_deref() == Some("اسم")));
    }

    /// Read back into another shelf: added at its end with new ids, what is
    /// there already skipped, nothing added twice on a second import.
    #[test]
    fn an_import_adds_what_is_missing_once() {
        let source = store_with_pins(&["أول", "ثانٍ"]);
        let (file, _) = build(&source, 7);
        let dir = temp();
        let mut target = store_in(&dir, &["ثانٍ"]);
        assert_eq!(target.import_pinned(&file.pinned).unwrap(), (1, 1));
        assert_eq!(
            target.import_pinned(&file.pinned).unwrap(),
            (0, 2),
            "again: nothing new"
        );
        let texts: Vec<&str> = target.pinned.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(texts, ["ثانٍ", "أول"]);
        assert!(
            source
                .pinned
                .iter()
                .all(|s| target.pinned.iter().all(|t| t.id != s.id)),
            "new ids"
        );
        let reloaded = Store::load(dir);
        assert_eq!(reloaded.pinned.len(), 2, "persisted");
    }

    #[test]
    fn anything_but_a_backup_is_refused_whole() {
        let store = store_with_pins(&["أول"]);
        let (file, _) = build(&store, 7);
        let good = serde_json::to_value(&file).unwrap();
        let refused = |value: serde_json::Value| {
            parse(&serde_json::to_vec(&value).unwrap(), |_| Ok(())).unwrap_err()
        };
        let mut v = good.clone();
        v["format"] = "something-else".into();
        assert_eq!(refused(v), INVALID);
        let mut v = good.clone();
        v["version"] = 2.into();
        assert_eq!(refused(v), NEWER, "a later Raff's file, said as such");
        let mut v = good.clone();
        v["extra"] = true.into();
        assert_eq!(refused(v), INVALID, "an unknown field");
        let mut v = good.clone();
        v["pinned"][0]["type"] = "image".into();
        assert_eq!(refused(v), INVALID, "no pictures");
        let mut v = good.clone();
        v["pinned"][0]["text"] = "  ".into();
        assert_eq!(refused(v), INVALID, "no empty item");
        let mut v = good.clone();
        v["pinned"][0]["label"] = "ب".repeat(41).into();
        assert_eq!(refused(v), INVALID, "a name over its cap");
        assert_eq!(parse(b"not json", |_| Ok(())).unwrap_err(), INVALID);
        let bytes = serde_json::to_vec(&good).unwrap();
        assert_eq!(
            parse(&bytes, |_| Err("no".into())).unwrap_err(),
            INVALID,
            "settings refused"
        );
        assert_eq!(
            parse(&vec![b' '; MAX_FILE_BYTES + 1], |_| Ok(())).unwrap_err(),
            TOO_LARGE
        );
    }

    /// Review 2026-10-22: a file from a later Raff says so, even when it
    /// carries fields this one does not know; and an item is held to the
    /// limits a copy is held to.
    #[test]
    fn a_newer_file_says_so_and_items_keep_capture_limits() {
        let store = store_with_pins(&["أول"]);
        let (file, _) = build(&store, 7);
        let good = serde_json::to_value(&file).unwrap();
        let refused = |value: serde_json::Value| {
            parse(&serde_json::to_vec(&value).unwrap(), |_| Ok(())).unwrap_err()
        };
        let mut v = good.clone();
        v["version"] = 2.into();
        v["somethingNew"] = true.into();
        assert_eq!(refused(v), NEWER);
        let mut v = good.clone();
        v["version"] = 0.into();
        assert_eq!(refused(v), INVALID);
        let mut v = good.clone();
        v["pinned"][0]["text"] = "ا".repeat(crate::macos::MAX_TEXT_CHARS + 1).into();
        assert_eq!(refused(v), INVALID, "text over the capture cap");
        let mut v = good.clone();
        v["pinned"][0]["html"] = "x".repeat(crate::macos::MAX_RICH_BYTES + 1).into();
        assert_eq!(refused(v), INVALID, "html over the capture cap");
        let mut v = good.clone();
        v["pinned"][0]["rtf"] = "x".repeat(MAX_RTF_BASE64 + 1).into();
        assert_eq!(refused(v), INVALID, "rtf over the capture cap");
    }

    /// Review 2026-10-22: a stamp from the future — a wrong clock, an edited
    /// file — would lift every later capture's stamp past it (`next_stamp`),
    /// and retention would never reach them.
    #[test]
    fn an_imported_stamp_is_never_in_the_future() {
        let mut target = store_in(&temp(), &[]);
        let item = BackupItem {
            kind: ItemKind::Text,
            text: "من المستقبل".into(),
            html: None,
            rtf: None,
            label: None,
            created_at: u64::MAX,
        };
        let before = crate::storage::now_ms();
        assert_eq!(target.import_pinned(&[item]).unwrap(), (1, 0));
        let stamp = target.pinned[0].created_at;
        assert!(
            stamp <= crate::storage::now_ms() && stamp >= before,
            "{stamp}"
        );
        assert!(target.pinned[0].last_used_at <= crate::storage::now_ms());
    }

    /// Review 2026-10-22: content already in the history is pinned from there,
    /// not added beside it — the shelf and the history never hold the same
    /// text twice. And a name in the file reaches a pinned item that has none.
    #[test]
    fn an_import_pins_from_the_history_and_brings_missing_names() {
        let dir = temp();
        let mut target = store_in(&dir, &["مثبّت بلا اسم"]);
        target.capture(
            ItemKind::Text,
            "في السجل".into(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        target.save_history();
        let history_id = target.history[0].id.clone();
        let item = |text: &str, label: Option<&str>| BackupItem {
            kind: ItemKind::Text,
            text: text.into(),
            html: None,
            rtf: None,
            label: label.map(Into::into),
            created_at: 5,
        };
        let (added, skipped) = target
            .import_pinned(&[
                item("في السجل", Some("من السجل")),
                item("مثبّت بلا اسم", Some("اسمه")),
            ])
            .unwrap();
        assert_eq!((added, skipped), (1, 1));
        assert!(
            target.history.iter().all(|i| i.text != "في السجل"),
            "no copy left in the history"
        );
        let pinned = target.pinned.iter().find(|i| i.text == "في السجل").unwrap();
        assert_eq!(pinned.id, history_id, "the history row itself, pinned");
        assert_eq!(pinned.label.as_deref(), Some("من السجل"));
        let named = target
            .pinned
            .iter()
            .find(|i| i.text == "مثبّت بلا اسم")
            .unwrap();
        assert_eq!(named.label.as_deref(), Some("اسمه"));

        let reloaded = Store::load(dir);
        assert_eq!(reloaded.pinned.len(), 2);
        assert!(reloaded.history.iter().all(|i| i.text != "في السجل"));
        assert!(reloaded
            .pinned
            .iter()
            .any(|i| i.label.as_deref() == Some("من السجل")));
        assert!(reloaded
            .pinned
            .iter()
            .any(|i| i.label.as_deref() == Some("اسمه")));
    }

    /// Review 2026-10-22: the file lands whole or not at all (a file chosen to
    /// be replaced is not left half-written), and only its owner reads it.
    #[test]
    fn the_file_is_written_whole_and_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("نسخة.json");
        std::fs::write(&path, b"old").unwrap();
        write_backup(path.to_str().unwrap(), b"{\"new\":1}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"new\":1}");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(left.len(), 1, "no temporary file left behind");
    }
}
