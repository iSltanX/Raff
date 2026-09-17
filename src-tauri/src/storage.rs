//! Local JSON storage: history.json (capped), pinned.json (never auto-pruned),
//! settings.json, and an images/ directory for captured PNGs.
//! All files live in the app data dir. No network, ever.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const HISTORY_FILE: &str = "history.json";
pub const PINNED_FILE: &str = "pinned.json";
pub const SETTINGS_FILE: &str = "settings.json";
pub const PANEL_PLACEMENT_FILE: &str = "panel-placement.json";
/// Short-lived transaction journal for the panel's five-second delete undo.
/// It is intentionally separate from history/pinned so no storage migration is
/// required and an interrupted delete can be resolved safely on next launch.
pub const PENDING_DELETE_FILE: &str = "pending-delete.json";
/// Durable intent for a cross-file history↔pinned move. It lets launch-time
/// recovery converge two JSON layers after a crash between their writes.
pub const PENDING_PIN_FILE: &str = "pending-pin.json";
pub const IMAGES_DIR: &str = "images";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Text,
    Link,
    Code,
    Image,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemKind,
    /// Plain text content; for images, a short label like "صورة 420×315".
    pub text: String,
    /// Rich representations (restored on normal paste, skipped for plain paste).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    /// RTF bytes, base64.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_file: Option<String>,
    /// Content hash used for image de-duplication.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    pub source_app_bundle_id: String,
    pub source_app: String,
    /// Milliseconds since epoch.
    pub created_at: u64,
    pub is_pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_order: Option<u32>,
    // Silent learning signals (plan §9, v1: logging only — no adaptive behavior).
    pub copy_count: u32,
    pub paste_count: u32,
    pub last_used_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// tauri global-shortcut accelerator string.
    pub hotkey: String,
    pub launch_at_login: bool,
    pub history_limit: usize,
    pub capture_enabled: bool,
    pub respect_concealed: bool,
    /// Bundle ids that Raff never captures from.
    pub excluded_apps: Vec<String>,
    pub learning_enabled: bool,
    pub first_run_shown: bool,
    /// Explicit appearance, used when `follow_system` is off.
    pub appearance: Appearance,
    /// Follow the macOS appearance (default on first launch).
    pub follow_system: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "shift+super+v".into(),
            launch_at_login: false,
            history_limit: 500,
            capture_enabled: true,
            respect_concealed: true,
            excluded_apps: Vec::new(),
            learning_enabled: true,
            first_run_shown: false,
            appearance: Appearance::Light,
            follow_system: true,
        }
    }
}

/// The most the recent layer may weigh. The count limit is a resource cap; the
/// budget is what turns the worst case into a number — 1000 rows each carrying
/// the largest payload `read_clip` still admits is about a gigabyte otherwise.
pub const MAX_HISTORY_BYTES: usize = 64 * 1024 * 1024;

/// Rough stored weight of a row. Only the payloads matter at this scale; the
/// fixed fields are noise beside a 256 KB rich representation.
fn weight(item: &ClipItem) -> usize {
    item.text.len()
        + item.html.as_deref().map_or(0, str::len)
        + item.rtf.as_deref().map_or(0, str::len)
}

#[derive(PartialEq, Eq, Debug)]
pub(crate) enum CaptureOutcome {
    /// Existing item bumped/moved — no new row.
    Deduped,
    Added,
    Failed,
}

#[derive(Debug)]
pub(crate) struct CaptureResult {
    outcome: CaptureOutcome,
    dropped: Vec<ClipItem>,
    layer: Option<DeletedLayer>,
    undo: CaptureUndo,
}

/// Exactly what it takes to put `capture` back, and nothing more.
///
/// This replaces the copy of both layers that used to be taken before every
/// capture "just in case the write fails" — two full clones on every copy the
/// user made, paid at the allowed limit of 1000 rows, to guard a path that
/// almost never runs.
#[derive(Debug)]
pub(crate) enum CaptureUndo {
    /// Nothing was touched.
    Nothing,
    /// A new row went to the head of history; `CaptureResult::dropped` holds
    /// whatever fell off the end.
    Added,
    /// The pinned row at `index` was overwritten; here it is as it was.
    PinnedBumped { index: usize, previous: Box<ClipItem> },
    /// The history row at `index` was moved to the head and overwritten.
    HistoryBumped { index: usize, previous: Box<ClipItem> },
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum DeletedLayer {
    History,
    Pinned,
}

/// Full receipt retained until the undo window closes. The original item is
/// the source of truth for chronological/pinned order, pin state, learning
/// counters and image references even when other items move in the meantime.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PendingDelete {
    token: String,
    item: ClipItem,
    layer: DeletedLayer,
    index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    before_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    before_created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    after_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    after_created_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PendingPin {
    item: ClipItem,
    desired: bool,
    #[serde(default)]
    dropped: Vec<ClipItem>,
}

pub struct Store {
    dir: PathBuf,
    pub history: Vec<ClipItem>,
    pub pinned: Vec<ClipItem>,
    pub settings: Settings,
    /// A layer could not be parsed on this launch and was copied aside. The
    /// panel needs this to tell "nothing is saved" apart from "your content is
    /// there, it just was not read" — two states an empty list looks identical in.
    pub unreadable_layer: bool,
    pending_delete: Option<PendingDelete>,
    pending_pin: Option<PendingPin>,
    /// Layers whose learning counters moved and have not been written yet.
    dirty_signals: DirtySignals,
}

/// Which layers are carrying unwritten learning-counter bumps.
#[derive(Default, Clone, Copy)]
pub struct DirtySignals {
    history: bool,
    pinned: bool,
}

/// Last user-chosen panel origin in physical desktop coordinates. Kept outside
/// Settings so dragging the utility panel never rewrites user preferences or
/// triggers any settings-side effect.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PanelPlacement {
    pub x: f64,
    pub y: f64,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Folds text for searching, exactly as `normalizeArabic` in `logic.js` does.
///
/// The two must agree: the panel filters what it can see with the JavaScript
/// one and asks this one about everything it cannot, and a query that means
/// two different things on the two sides would show and hide the same row.
pub fn normalize_for_search(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            // Arabic-Indic digits fold to Western, so either spelling finds both.
            '\u{0660}'..='\u{0669}' => {
                out.push(char::from(b'0' + (ch as u32 - 0x0660) as u8));
            }
            // Tashkeel and the superscript alef carry no search meaning...
            '\u{064B}'..='\u{065F}' | '\u{0670}' => {}
            '\u{0640}' => {}                       // ...nor does tatweel
            '\u{0623}' | '\u{0625}' | '\u{0622}' => out.push('\u{0627}'),
            '\u{0649}' => out.push('\u{064A}'),
            _ => out.extend(ch.to_lowercase()),
        }
    }
    out
}

/// Heuristic content typing (plan §4: simple, not smart).
pub fn detect_kind(text: &str) -> ItemKind {
    let t = text.trim();
    if t.is_empty() {
        return ItemKind::Text;
    }
    let single_token = !t.contains(char::is_whitespace);
    if single_token
        && (t.starts_with("http://") || t.starts_with("https://") || t.starts_with("www."))
    {
        return ItemKind::Link;
    }

    let mut score = 0u32;
    const STARTERS: [&str; 22] = [
        "const ",
        "let ",
        "var ",
        "function ",
        "fn ",
        "def ",
        "class ",
        "import ",
        "export ",
        "#include",
        "<?php",
        "select ",
        "insert ",
        "update ",
        "delete from",
        "package ",
        "use ",
        "pub ",
        "async ",
        "public ",
        "private ",
        "#!/",
    ];
    let lower = t.to_lowercase();
    if STARTERS.iter().any(|s| lower.starts_with(s)) {
        score += 2;
    }
    for needle in ["=>", "();", "</", "/>", "&&", "||", "!=", "=="] {
        if t.contains(needle) {
            score += 1;
        }
    }
    let code_line_endings = t
        .lines()
        .filter(|l| {
            let l = l.trim_end();
            l.ends_with(';') || l.ends_with('{') || l.ends_with('}')
        })
        .count();
    if code_line_endings >= 2 {
        score += 2;
    } else if code_line_endings == 1 && t.lines().count() <= 2 {
        score += 1;
    }
    if t.contains('\t') || t.lines().any(|l| l.starts_with("    ")) {
        score += 1;
    }

    if score >= 2 {
        ItemKind::Code
    } else {
        ItemKind::Text
    }
}

/// Image filenames named by a set-aside `*.json.corrupt` copy.
///
/// Such a copy exists precisely because it did not parse, so it is read
/// leniently: every `"imageFile"` / `"thumbFile"` value that can still be
/// recovered from the text counts. Keeping one file too many costs disk;
/// keeping one too few destroys the images the copy exists to point at.
fn referenced_by_recovery_copies(dir: &Path) -> std::collections::HashSet<String> {
    const KEYS: [&str; 2] = ["\"imageFile\"", "\"thumbFile\""];
    let mut found = std::collections::HashSet::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("corrupt") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for key in KEYS {
            let mut rest = text.as_str();
            while let Some(at) = rest.find(key) {
                rest = &rest[at + key.len()..];
                if let Some(name) = json_string_value(rest) {
                    found.insert(name);
                }
            }
        }
    }
    found
}

/// The string literal a `"key"` is assigned, when the text right after the key
/// is `: "…"`. Stored filenames are generated ids, so no escape handling.
fn json_string_value(after_key: &str) -> Option<String> {
    let rest = after_key.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn load_json_with_status<T: serde::de::DeserializeOwned + Default>(path: &Path) -> (T, bool) {
    if !path.exists() {
        return (T::default(), true);
    }
    match fs::read_to_string(path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<T>(&s).map_err(|e| e.to_string()))
    {
        Ok(v) => (v, true),
        Err(err) => {
            // Never destroy user data silently: keep the unreadable file aside.
            let corrupt = path.with_extension("json.corrupt");
            let _ = fs::copy(path, &corrupt);
            eprintln!(
                "raff: unreadable {} ({err}); copied to {}",
                path.display(),
                corrupt.display()
            );
            (T::default(), false)
        }
    }
}

fn load_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    load_json_with_status(path).0
}

fn try_save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    stage_json(path, value)?.commit()
}

/// Serializes `value` for `path` and takes the ticket that orders its write.
///
/// Compact, not pretty: nothing but the machine reads these files, and at the
/// allowed limit the indentation was a second copy of the layer to build,
/// write and read back on every capture.
///
/// Every caller holds the store lock at this point, so tickets come out in the
/// same order as the states they describe — which is what lets a write that
/// happens after the lock was released still be placed correctly.
fn stage_json<T: Serialize>(path: &Path, value: &T) -> Result<LayerWrite, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|err| format!("تعذّر تجهيز {} للحفظ: {err}", path.display()))?;
    Ok(LayerWrite {
        path: path.to_path_buf(),
        bytes,
        ticket: next_write_ticket(),
    })
}

fn next_write_ticket() -> u64 {
    static TICKETS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    TICKETS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

fn write_layer_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)
        .and_then(|_| fs::rename(&tmp, path))
        .map_err(|err| format!("تعذّر حفظ {}: {err}", path.display()))
}

/// The newest serialization of each layer that has reached the disk.
///
/// Bytes are prepared under the store lock and written after it is released,
/// so two captures can be in flight at once. The ticket each carries lets the
/// writer refuse to lay an older layer over a newer one.
fn write_gate() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, u64>> {
    static GATE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, u64>>,
    > = std::sync::OnceLock::new();
    GATE.get_or_init(Default::default)
}

/// One layer, serialized and waiting to be written with the store lock released.
pub(crate) struct LayerWrite {
    path: PathBuf,
    bytes: Vec<u8>,
    ticket: u64,
}

impl LayerWrite {
    pub(crate) fn commit(self) -> Result<(), String> {
        let mut gate = write_gate()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if gate
            .get(&self.path)
            .is_some_and(|latest| *latest > self.ticket)
        {
            // A later state of this same layer is already on disk, and it
            // contains everything ours did. Writing now would undo it.
            return Ok(());
        }
        let result = write_layer_bytes(&self.path, &self.bytes);
        if result.is_ok() {
            gate.insert(self.path, self.ticket);
        }
        result
    }
}

fn save_json<T: Serialize>(path: &Path, value: &T) {
    if let Err(err) = try_save_json(path, value) {
        eprintln!("raff: {err}");
    }
}

/// Applies a capture and persists its layer with the store lock released.
///
/// The model is mutated and the bytes prepared under the lock; the write, the
/// expensive part, happens with the lock free, and a failure is undone from
/// the capture's own undo record rather than from a copy of the whole layer.
pub(crate) fn persist_capture(
    store: &std::sync::Mutex<Store>,
    result: CaptureResult,
) -> Result<CaptureOutcome, String> {
    let write = match crate::lock_store(store).stage_capture(&result) {
        Ok(write) => write,
        Err(err) => return Err(err),
    };
    let CaptureResult {
        outcome,
        dropped,
        undo,
        ..
    } = result;

    if let Err(err) = write.commit() {
        crate::lock_store(store).rollback_capture(undo, dropped);
        return Err(err);
    }
    // Only now are these rows certainly gone from the layer on disk.
    let guard = crate::lock_store(store);
    for item in &dropped {
        guard.delete_files(item);
    }
    Ok(outcome)
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join(IMAGES_DIR));
        let (history, history_metadata_loaded): (Vec<ClipItem>, bool) =
            load_json_with_status(&dir.join(HISTORY_FILE));
        let (pinned, pinned_metadata_loaded): (Vec<ClipItem>, bool) =
            load_json_with_status(&dir.join(PINNED_FILE));
        let settings: Settings = load_json(&dir.join(SETTINGS_FILE));
        let pending_delete: Option<PendingDelete> = load_json(&dir.join(PENDING_DELETE_FILE));
        let pending_pin: Option<PendingPin> = load_json(&dir.join(PENDING_PIN_FILE));
        let mut store = Self {
            dir,
            history,
            pinned,
            settings,
            unreadable_layer: !(history_metadata_loaded && pinned_metadata_loaded),
            pending_delete,
            pending_pin,
            dirty_signals: DirtySignals::default(),
        };

        store.resolve_interrupted_pin();
        // A toast cannot survive a process restart, so a journal from the
        // previous process is resolved immediately. Transaction ordering makes
        // this safe in both crash windows:
        // - item still on disk => delete never committed; preserve its files
        // - item absent on disk => deletion committed; clean up its files
        store.resolve_interrupted_delete();
        // An unreadable layer may still be the only metadata referencing image
        // files. Its recovery copy is useful only if those images survive too,
        // so orphan collection is safe exclusively when both live layers were
        // decoded (a missing file is a valid empty layer).
        if history_metadata_loaded && pinned_metadata_loaded {
            store.cleanup_orphan_images();
        }
        store
    }

    pub fn images_dir(&self) -> PathBuf {
        self.dir.join(IMAGES_DIR)
    }

    fn cleanup_orphan_images(&self) {
        // A recovery copy outlives the boot that created it: the next good
        // capture rewrites the live layer, so from then on both layers parse
        // and the guard in `load` no longer fires. The copy is then the only
        // metadata naming its images, and must count as a reference.
        let mut referenced = referenced_by_recovery_copies(&self.dir);
        for item in self.pinned.iter().chain(self.history.iter()) {
            referenced.extend(item.image_file.iter().cloned());
            referenced.extend(item.thumb_file.iter().cloned());
        }
        if let Some(pending) = &self.pending_delete {
            referenced.extend(pending.item.image_file.iter().cloned());
            referenced.extend(pending.item.thumb_file.iter().cloned());
        }
        if let Some(pending) = &self.pending_pin {
            referenced.extend(pending.item.image_file.iter().cloned());
            referenced.extend(pending.item.thumb_file.iter().cloned());
            for item in &pending.dropped {
                referenced.extend(item.image_file.iter().cloned());
                referenced.extend(item.thumb_file.iter().cloned());
            }
        }
        let Ok(entries) = fs::read_dir(self.images_dir()) else {
            return;
        };
        for entry in entries.flatten() {
            if !entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !referenced.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    pub fn mark_first_run_shown_persisted(&mut self) -> Result<(), String> {
        let previous = self.settings.first_run_shown;
        self.settings.first_run_shown = true;
        if let Err(err) = try_save_json(&self.dir.join(SETTINGS_FILE), &self.settings) {
            self.settings.first_run_shown = previous;
            return Err(err);
        }
        Ok(())
    }

    pub fn save_history(&self) {
        save_json(&self.dir.join(HISTORY_FILE), &self.history);
    }
    pub fn save_pinned(&self) {
        save_json(&self.dir.join(PINNED_FILE), &self.pinned);
    }
    pub fn save_settings(&self) {
        save_json(&self.dir.join(SETTINGS_FILE), &self.settings);
    }

    /// Atomically advances the settings model and its history-cap side effect
    /// from the command's point of view. A failed write restores both in-memory
    /// and durable snapshots; pruned image files are deleted only after both
    /// JSON files have landed successfully.
    pub fn update_settings_persisted(&mut self, settings: Settings) -> Result<(), String> {
        self.try_finish_pending_pin()?;
        let old_settings = self.settings.clone();
        let old_history = self.history.clone();
        self.settings = settings;
        let limit = self.settings.history_limit.max(1);
        let dropped = if self.history.len() > limit {
            self.history.split_off(limit)
        } else {
            Vec::new()
        };

        let writes = try_save_json(&self.dir.join(SETTINGS_FILE), &self.settings)
            .and_then(|_| try_save_json(&self.dir.join(HISTORY_FILE), &self.history));
        if let Err(err) = writes {
            self.settings = old_settings;
            self.history = old_history;
            save_json(&self.dir.join(SETTINGS_FILE), &self.settings);
            save_json(&self.dir.join(HISTORY_FILE), &self.history);
            return Err(err);
        }
        for item in &dropped {
            self.delete_files(item);
        }
        Ok(())
    }
    pub fn load_panel_placement(&self) -> Option<PanelPlacement> {
        load_json(&self.dir.join(PANEL_PLACEMENT_FILE))
    }
    pub fn save_panel_placement(&self, placement: PanelPlacement) {
        save_json(&self.dir.join(PANEL_PLACEMENT_FILE), &Some(placement));
    }

    pub fn find(&self, id: &str) -> Option<&ClipItem> {
        self.pinned
            .iter()
            .chain(self.history.iter())
            .find(|i| i.id == id)
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut ClipItem> {
        self.pinned
            .iter_mut()
            .chain(self.history.iter_mut())
            .find(|i| i.id == id)
    }

    fn same_content(a: &ClipItem, kind: ItemKind, text: &str, hash: Option<&str>) -> bool {
        if a.kind != kind {
            return false;
        }
        match (a.hash.as_deref(), hash) {
            (Some(h1), Some(h2)) => h1 == h2,
            _ => a.text == text,
        }
    }

    /// Adds a captured clip, de-duplicating against pinned items and the whole
    /// recent history (an identical re-copy bumps the existing row to the top).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture(
        &mut self,
        kind: ItemKind,
        text: String,
        html: Option<String>,
        rtf: Option<String>,
        image_file: Option<String>,
        thumb_file: Option<String>,
        hash: Option<String>,
        source: (String, String), // (name, bundle_id)
    ) -> CaptureResult {
        if let Err(err) = self.try_finish_pending_pin() {
            eprintln!("raff: capture deferred until pin transaction completes: {err}");
            return CaptureResult {
                outcome: CaptureOutcome::Failed,
                dropped: Vec::new(),
                layer: None,
                undo: CaptureUndo::Nothing,
            };
        }
        // Keep recency a strict total order even when several pasteboard
        // changes land inside the same millisecond. This also makes Undo's
        // chronological restoration deterministic.
        let now = self
            .pinned
            .iter()
            .chain(self.history.iter())
            .map(|item| item.created_at)
            .max()
            .map_or_else(now_ms, |latest| now_ms().max(latest.saturating_add(1)));
        let learning = self.settings.learning_enabled;

        if let Some((index, p)) = self
            .pinned
            .iter_mut()
            .enumerate()
            .find(|(_, i)| Self::same_content(i, kind, &text, hash.as_deref()))
        {
            let previous = Box::new(p.clone());
            p.text = text;
            p.html = html;
            p.rtf = rtf;
            if image_file.is_some() {
                p.image_file = image_file;
            }
            if thumb_file.is_some() {
                p.thumb_file = thumb_file;
            }
            p.hash = hash;
            p.source_app = source.0;
            p.source_app_bundle_id = source.1;
            p.created_at = now;
            if learning {
                p.copy_count += 1;
                p.last_used_at = now;
            }
            return CaptureResult {
                outcome: CaptureOutcome::Deduped,
                dropped: Vec::new(),
                layer: Some(DeletedLayer::Pinned),
                undo: CaptureUndo::PinnedBumped { index, previous },
            };
        }

        if let Some(pos) = self
            .history
            .iter()
            .position(|i| Self::same_content(i, kind, &text, hash.as_deref()))
        {
            let mut item = self.history.remove(pos);
            let previous = Box::new(item.clone());
            if learning {
                item.copy_count += 1;
            }
            item.text = text;
            item.html = html;
            item.rtf = rtf;
            if image_file.is_some() {
                item.image_file = image_file;
            }
            if thumb_file.is_some() {
                item.thumb_file = thumb_file;
            }
            item.hash = hash;
            item.source_app = source.0;
            item.source_app_bundle_id = source.1;
            item.created_at = now;
            item.last_used_at = now;
            self.history.insert(0, item);
            return CaptureResult {
                outcome: CaptureOutcome::Deduped,
                dropped: Vec::new(),
                layer: Some(DeletedLayer::History),
                undo: CaptureUndo::HistoryBumped {
                    index: pos,
                    previous,
                },
            };
        }

        let item = ClipItem {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            text,
            html,
            rtf,
            image_file,
            thumb_file,
            hash,
            source_app: source.0,
            source_app_bundle_id: source.1,
            created_at: now,
            is_pinned: false,
            pinned_order: None,
            copy_count: 1,
            paste_count: 0,
            last_used_at: now,
        };
        self.history.insert(0, item);
        CaptureResult {
            outcome: CaptureOutcome::Added,
            dropped: self.trim_history_to_limits(),
            layer: Some(DeletedLayer::History),
            undo: CaptureUndo::Added,
        }
    }

    /// Drops the oldest rows until the layer is inside both limits, and hands
    /// them back so their image files are removed only once the write commits.
    ///
    /// A single row heavier than the whole budget is kept: it already cleared
    /// the per-item cap in `read_clip`, and dropping it the instant it arrived
    /// would look exactly like capture quietly not working.
    fn trim_history_to_limits(&mut self) -> Vec<ClipItem> {
        let limit = self.settings.history_limit.max(1);
        let mut keep = self.history.len().min(limit);
        let mut total = 0usize;
        for (index, item) in self.history.iter().take(keep).enumerate() {
            total = total.saturating_add(weight(item));
            if total > MAX_HISTORY_BYTES && index > 0 {
                keep = index;
                break;
            }
        }
        self.history.split_off(keep)
    }

    /// Serializes the layer a capture touched, without writing it.
    ///
    /// The bytes leave with a ticket so the caller can write them after the
    /// store lock is released — the write is tens of megabytes at the allowed
    /// limit, and the main thread takes this same lock every time the panel is
    /// opened or dragged.
    fn stage_capture(&mut self, result: &CaptureResult) -> Result<LayerWrite, String> {
        if result.outcome == CaptureOutcome::Failed {
            return Err("تعذّر إكمال معاملة التثبيت السابقة".into());
        }
        let path = match result.layer {
            Some(DeletedLayer::History) => self.dir.join(HISTORY_FILE),
            Some(DeletedLayer::Pinned) => self.dir.join(PINNED_FILE),
            None => return Err("تعذّر تحديد طبقة الالتقاط".into()),
        };
        match result.layer {
            Some(DeletedLayer::Pinned) => stage_json(&path, &self.pinned),
            _ => stage_json(&path, &self.history),
        }
    }

    /// Records that a learning counter moved, without writing the layer.
    ///
    /// These counters are bumped on every paste and every copy made through
    /// رفّ, and each bump used to rewrite its layer whole — tens of megabytes
    /// at the allowed limit, to move one number by one. They are coalesced and
    /// written once the user pauses instead. Losing a second or two of them to
    /// a quit is acceptable: they are silent ranking signals, not content.
    pub fn mark_signals_dirty(&mut self, pinned: bool) {
        if pinned {
            self.dirty_signals.pinned = true;
        } else {
            self.dirty_signals.history = true;
        }
    }

    /// Serializes any layer carrying coalesced counter bumps, without writing.
    pub(crate) fn stage_signal_flush(&mut self) -> Vec<LayerWrite> {
        let dirty = std::mem::take(&mut self.dirty_signals);
        let mut writes = Vec::new();
        if dirty.history {
            match stage_json(&self.dir.join(HISTORY_FILE), &self.history) {
                Ok(write) => writes.push(write),
                Err(err) => eprintln!("raff: {err}"),
            }
        }
        if dirty.pinned {
            match stage_json(&self.dir.join(PINNED_FILE), &self.pinned) {
                Ok(write) => writes.push(write),
                Err(err) => eprintln!("raff: {err}"),
            }
        }
        writes
    }

    /// Puts back exactly what `capture` changed, from its undo record.
    fn rollback_capture(&mut self, undo: CaptureUndo, dropped: Vec<ClipItem>) {
        match undo {
            CaptureUndo::Nothing => {}
            CaptureUndo::Added => {
                if !self.history.is_empty() {
                    self.history.remove(0);
                }
                self.history.extend(dropped);
            }
            CaptureUndo::PinnedBumped { index, previous } => {
                if let Some(slot) = self.pinned.get_mut(index) {
                    *slot = *previous;
                }
            }
            CaptureUndo::HistoryBumped { index, previous } => {
                if !self.history.is_empty() {
                    self.history.remove(0);
                }
                let index = index.min(self.history.len());
                self.history.insert(index, *previous);
            }
        }
    }

    fn delete_files(&self, item: &ClipItem) {
        for f in [&item.image_file, &item.thumb_file].into_iter().flatten() {
            let _ = fs::remove_file(self.images_dir().join(f));
        }
    }

    fn try_save_pending_delete(&self) -> Result<(), String> {
        if self.pending_delete.is_some() {
            try_save_json(&self.dir.join(PENDING_DELETE_FILE), &self.pending_delete)
        } else {
            match fs::remove_file(self.dir.join(PENDING_DELETE_FILE)) {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(err) => Err(format!("تعذّر إغلاق سجل الحذف المؤقت: {err}")),
            }
        }
    }

    fn save_pending_delete(&self) {
        if let Err(err) = self.try_save_pending_delete() {
            eprintln!("raff: {err}");
        }
    }

    fn try_save_pending_pin(&self) -> Result<(), String> {
        if self.pending_pin.is_some() {
            try_save_json(&self.dir.join(PENDING_PIN_FILE), &self.pending_pin)
        } else {
            match fs::remove_file(self.dir.join(PENDING_PIN_FILE)) {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(err) => Err(format!("تعذّر إغلاق سجل التثبيت المؤقت: {err}")),
            }
        }
    }

    fn apply_pending_pin_in_memory(&mut self, pending: &PendingPin) {
        self.history.retain(|item| item.id != pending.item.id);
        self.pinned.retain(|item| item.id != pending.item.id);
        let mut item = pending.item.clone();
        item.is_pinned = pending.desired;
        if pending.desired {
            let order = item.pinned_order.unwrap_or(u32::MAX);
            let at = self
                .pinned
                .iter()
                .position(|candidate| candidate.pinned_order.unwrap_or(u32::MAX) > order)
                .unwrap_or(self.pinned.len());
            self.pinned.insert(at, item);
        } else {
            item.pinned_order = None;
            let at = self
                .history
                .iter()
                .position(|candidate| candidate.created_at < item.created_at)
                .unwrap_or(self.history.len());
            self.history.insert(at, item);
        }
    }

    fn try_finish_pending_pin(&mut self) -> Result<(), String> {
        let Some(pending) = self.pending_pin.clone() else {
            return Ok(());
        };
        self.apply_pending_pin_in_memory(&pending);
        // An interrupted unpin must reapply the same history cap. The full
        // dropped receipts keep cleanup deterministic without deleting their
        // image files until both layer JSON writes have committed.
        for dropped in &pending.dropped {
            self.history.retain(|item| item.id != dropped.id);
        }
        try_save_json(&self.dir.join(HISTORY_FILE), &self.history)?;
        try_save_json(&self.dir.join(PINNED_FILE), &self.pinned)?;
        self.pending_pin = None;
        if let Err(err) = self.try_save_pending_pin() {
            self.pending_pin = Some(pending);
            return Err(err);
        }
        for dropped in &pending.dropped {
            self.delete_files(dropped);
        }
        Ok(())
    }

    pub fn finish_pending_pin(&mut self) -> Result<(), String> {
        self.try_finish_pending_pin()
    }

    fn resolve_interrupted_pin(&mut self) {
        if let Err(err) = self.try_finish_pending_pin() {
            // The in-memory state is already converged. Keeping the durable
            // journal makes the next launch retry rather than accepting a
            // duplicate or dropping the user's item.
            eprintln!("raff: {err}");
        }
    }

    fn resolve_interrupted_delete(&mut self) {
        let Some(pending) = self.pending_delete.take() else {
            return;
        };
        let item_is_live = self
            .pinned
            .iter()
            .chain(self.history.iter())
            .any(|item| item.id == pending.item.id);
        if !item_is_live {
            self.delete_files(&pending.item);
        }
        self.save_pending_delete();
    }

    fn commit_any_pending_delete(&mut self) -> Result<(), String> {
        if let Some(pending) = self.pending_delete.take() {
            self.delete_files(&pending.item);
            self.try_save_pending_delete()?;
        }
        Ok(())
    }

    /// Enforces the history cap (oldest items dropped, their image files
    /// deleted). Public so a shrunk `history_limit` applies immediately.
    pub fn trim_history(&mut self) {
        while self.history.len() > self.settings.history_limit.max(1) {
            if let Some(dropped) = self.history.pop() {
                self.delete_files(&dropped);
            }
        }
    }

    /// Pin moves the item from the recent layer to the pinned shelf (plan §2:
    /// two layers). Unpin returns it to the history at its recency position.
    pub fn toggle_pin(&mut self, id: &str) -> bool {
        if let Some(pos) = self.history.iter().position(|i| i.id == id) {
            let mut item = self.history.remove(pos);
            item.is_pinned = true;
            item.pinned_order = Some(
                self.pinned
                    .iter()
                    .filter_map(|i| i.pinned_order)
                    .max()
                    .map_or(0, |m| m + 1),
            );
            self.pinned.push(item);
            return true;
        }
        if let Some(pos) = self.pinned.iter().position(|i| i.id == id) {
            let mut item = self.pinned.remove(pos);
            item.is_pinned = false;
            item.pinned_order = None;
            let at = self
                .history
                .iter()
                .position(|i| i.created_at < item.created_at)
                .unwrap_or(self.history.len());
            self.history.insert(at, item);
            return true;
        }
        false
    }

    /// Moves an item between the two persisted layers without ever reporting
    /// success for an in-memory-only change. The destination is written first
    /// (a crash can at worst leave a recoverable duplicate, never lose the
    /// item); any write failure restores both vectors and best-effort rewrites
    /// their previous durable snapshots before returning an error to the UI.
    pub fn set_pin_persisted(&mut self, id: &str, desired: bool) -> Result<bool, String> {
        self.try_finish_pending_pin()?;
        let was_pinned = self
            .find(id)
            .map(|item| item.is_pinned)
            .ok_or_else(|| "العنصر غير موجود".to_string())?;
        if was_pinned == desired {
            return Ok(desired);
        }
        let old_history = self.history.clone();
        let old_pinned = self.pinned.clone();
        if !self.toggle_pin(id) {
            return Err("تعذّر تغيير حالة التثبيت".into());
        }

        let limit = self.settings.history_limit.max(1);
        let dropped = if self.history.len() > limit {
            self.history.split_off(limit)
        } else {
            Vec::new()
        };

        let moved = self
            .find(id)
            .cloned()
            .ok_or_else(|| "العنصر غير موجود".to_string())?;
        self.pending_pin = Some(PendingPin {
            item: moved,
            desired,
            dropped,
        });
        if let Err(err) = self.try_save_pending_pin() {
            self.pending_pin = None;
            self.history = old_history;
            self.pinned = old_pinned;
            return Err(err);
        }

        let writes = if was_pinned {
            try_save_json(&self.dir.join(HISTORY_FILE), &self.history)
                .and_then(|_| try_save_json(&self.dir.join(PINNED_FILE), &self.pinned))
        } else {
            try_save_json(&self.dir.join(PINNED_FILE), &self.pinned)
                .and_then(|_| try_save_json(&self.dir.join(HISTORY_FILE), &self.history))
        };
        if let Err(err) = writes {
            // The desired state is still durable in pending-pin.json. Keep it
            // active and report success; launch recovery will finish the two
            // layer writes without data loss or duplication.
            eprintln!("raff: deferred pin layer write: {err}");
            return Ok(desired);
        }
        let pending = self.pending_pin.take().expect("pending pin intent");
        if let Err(err) = self.try_save_pending_pin() {
            // Both layers already contain the desired state. Preserve the
            // in-memory intent so any following delete/clear first retries
            // journal retirement; restart recovery is idempotent as well.
            self.pending_pin = Some(pending);
            eprintln!("raff: deferred pin journal cleanup: {err}");
        } else {
            for dropped in &pending.dropped {
                self.delete_files(dropped);
            }
        }
        Ok(desired)
    }

    /// Removes exactly one item and journals a lossless undo receipt. Starting
    /// another deletion finalizes the preceding one, matching the UI's single
    /// visible toast / single available Undo contract.
    pub fn delete_reversible(&mut self, id: &str) -> Result<String, String> {
        self.try_finish_pending_pin()?;
        let location = self
            .history
            .iter()
            .position(|item| item.id == id)
            .map(|index| (DeletedLayer::History, index))
            .or_else(|| {
                self.pinned
                    .iter()
                    .position(|item| item.id == id)
                    .map(|index| (DeletedLayer::Pinned, index))
            })
            .ok_or_else(|| "العنصر غير موجود".to_string())?;

        self.commit_any_pending_delete()?;
        let source = match location.0 {
            DeletedLayer::History => &self.history,
            DeletedLayer::Pinned => &self.pinned,
        };
        let before = location
            .1
            .checked_sub(1)
            .and_then(|index| source.get(index))
            .map(|item| (item.id.clone(), item.created_at));
        let after = source
            .get(location.1 + 1)
            .map(|item| (item.id.clone(), item.created_at));
        let item = match location.0 {
            DeletedLayer::History => self.history.remove(location.1),
            DeletedLayer::Pinned => self.pinned.remove(location.1),
        };
        let token = uuid::Uuid::new_v4().to_string();
        self.pending_delete = Some(PendingDelete {
            token: token.clone(),
            item,
            layer: location.0,
            index: location.1,
            before_id: before.as_ref().map(|item| item.0.clone()),
            before_created_at: before.as_ref().map(|item| item.1),
            after_id: after.as_ref().map(|item| item.0.clone()),
            after_created_at: after.as_ref().map(|item| item.1),
        });

        // Journal first. If the process stops before the layer files land,
        // load() sees the item still live and discards the journal. If the
        // layer files did land, load() finalizes the deletion and image cleanup.
        if let Err(err) = self.try_save_pending_delete() {
            let pending = self.pending_delete.take().expect("pending receipt");
            match pending.layer {
                DeletedLayer::History => self
                    .history
                    .insert(pending.index.min(self.history.len()), pending.item),
                DeletedLayer::Pinned => self
                    .pinned
                    .insert(pending.index.min(self.pinned.len()), pending.item),
            }
            return Err(err);
        }

        let layer_result = match location.0 {
            DeletedLayer::History => try_save_json(&self.dir.join(HISTORY_FILE), &self.history),
            DeletedLayer::Pinned => try_save_json(&self.dir.join(PINNED_FILE), &self.pinned),
        };
        if let Err(err) = layer_result {
            // The layer did not commit, so restore the in-memory model and
            // retire the journal. If journal removal itself fails, restart
            // recovery sees the still-live item and safely discards it.
            let pending = self.pending_delete.take().expect("pending receipt");
            match pending.layer {
                DeletedLayer::History => self
                    .history
                    .insert(pending.index.min(self.history.len()), pending.item),
                DeletedLayer::Pinned => self
                    .pinned
                    .insert(pending.index.min(self.pinned.len()), pending.item),
            }
            self.save_pending_delete();
            return Err(err);
        }
        Ok(token)
    }

    fn restore_index(items: &[ClipItem], pending: &PendingDelete) -> usize {
        match pending.layer {
            DeletedLayer::History => {
                // Stable equal-timestamp anchors preserve the exact original
                // order on very fast captures. A re-captured neighbor gets a
                // new timestamp and is deliberately ignored; strict recency
                // then places the receipt correctly.
                if let (Some(id), Some(created_at)) = (&pending.after_id, pending.after_created_at)
                {
                    if created_at == pending.item.created_at {
                        if let Some(index) = items
                            .iter()
                            .position(|item| item.id == *id && item.created_at == created_at)
                        {
                            return index;
                        }
                    }
                }
                if let (Some(id), Some(created_at)) =
                    (&pending.before_id, pending.before_created_at)
                {
                    if created_at == pending.item.created_at {
                        if let Some(index) = items
                            .iter()
                            .position(|item| item.id == *id && item.created_at == created_at)
                        {
                            return index + 1;
                        }
                    }
                }
                items
                    .iter()
                    .position(|item| item.created_at < pending.item.created_at)
                    .unwrap_or(items.len())
            }
            DeletedLayer::Pinned => {
                let order = pending.item.pinned_order.unwrap_or(u32::MAX);
                items
                    .iter()
                    .position(|item| item.pinned_order.unwrap_or(u32::MAX) > order)
                    .unwrap_or(items.len())
            }
        }
    }

    /// Restores the one pending receipt according to its saved chronological
    /// or pinned order, so capture de-duplication and concurrent pin mutations
    /// cannot make a numeric index or neighbor position stale.
    pub fn undo_delete(&mut self, token: &str) -> Result<(), String> {
        let Some(pending) = self.pending_delete.as_ref() else {
            return Err("انتهت مهلة التراجع عن الحذف".into());
        };
        if pending.token != token || self.find(&pending.item.id).is_some() {
            return Err("انتهت مهلة التراجع عن الحذف".into());
        }

        let pending = pending.clone();
        match pending.layer {
            DeletedLayer::History => {
                let index = Self::restore_index(&self.history, &pending);
                self.history.insert(index, pending.item.clone());
                // Persist the restored layer before removing its journal. If
                // the process stops between these writes, load() sees the live
                // item and safely retires the journal instead of finalizing
                // the deletion.
                if let Err(err) = try_save_json(&self.dir.join(HISTORY_FILE), &self.history) {
                    self.history.remove(index);
                    return Err(err);
                }
            }
            DeletedLayer::Pinned => {
                let index = Self::restore_index(&self.pinned, &pending);
                self.pinned.insert(index, pending.item.clone());
                if let Err(err) = try_save_json(&self.dir.join(PINNED_FILE), &self.pinned) {
                    self.pinned.remove(index);
                    return Err(err);
                }
            }
        }

        // The unchanged layer needs no write. Removing the journal is the
        // transaction's final commit point. A failed journal removal does not
        // invalidate the successful restore: restart recovery sees the live
        // item and retires the stale receipt without deleting it.
        self.pending_delete = None;
        self.save_pending_delete();
        Ok(())
    }

    /// Permanently closes an undo window and removes image files only after the
    /// caller proves it owns the current receipt.
    pub fn commit_delete(&mut self, token: &str) -> Result<(), String> {
        if self.pending_delete.as_ref().map(|p| p.token.as_str()) != Some(token) {
            return Err("انتهت مهلة التراجع عن الحذف".into());
        }
        self.commit_any_pending_delete()
    }

    pub fn clear_history(&mut self) {
        // Clearing history supersedes any row-level undo. This keeps a pending
        // deleted history item from reappearing after the explicit bulk wipe.
        if let Err(err) = self.commit_any_pending_delete() {
            eprintln!("raff: {err}");
        }
        for item in &self.history {
            self.delete_files(item);
        }
        self.history.clear();
    }

    pub fn clear_history_persisted(&mut self) -> Result<(), String> {
        self.try_finish_pending_pin()?;
        self.commit_any_pending_delete()?;
        let old_history = std::mem::take(&mut self.history);
        if let Err(err) = try_save_json(&self.dir.join(HISTORY_FILE), &self.history) {
            self.history = old_history;
            return Err(err);
        }
        for item in &old_history {
            self.delete_files(item);
        }
        Ok(())
    }

    /// "مسح بيانات التعلّم" — resets the silent signals on every item.
    pub fn clear_learning(&mut self) {
        for item in self.pinned.iter_mut().chain(self.history.iter_mut()) {
            item.copy_count = 0;
            item.paste_count = 0;
            item.last_used_at = item.created_at;
        }
    }

    pub fn clear_learning_persisted(&mut self) -> Result<(), String> {
        self.try_finish_pending_pin()?;
        let old_history = self.history.clone();
        let old_pinned = self.pinned.clone();
        self.clear_learning();
        let writes = try_save_json(&self.dir.join(HISTORY_FILE), &self.history)
            .and_then(|_| try_save_json(&self.dir.join(PINNED_FILE), &self.pinned));
        if let Err(err) = writes {
            self.history = old_history;
            self.pinned = old_pinned;
            save_json(&self.dir.join(HISTORY_FILE), &self.history);
            save_json(&self.dir.join(PINNED_FILE), &self.pinned);
            return Err(err);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        Store::load(dir)
    }

    fn capture_text(s: &mut Store, text: &str) -> CaptureOutcome {
        s.capture(
            detect_kind(text),
            text.into(),
            None,
            None,
            None,
            None,
            None,
            ("Test".into(), "com.test".into()),
        )
        .outcome
    }

    #[test]
    fn panel_placement_round_trips_independently_of_settings() {
        let s = store();
        let expected = PanelPlacement { x: -812.0, y: 96.0 };
        assert_eq!(s.load_panel_placement(), None);
        s.save_panel_placement(expected);
        assert_eq!(s.load_panel_placement(), Some(expected));
    }

    #[test]
    fn detects_links() {
        assert_eq!(detect_kind("https://example.com/x?y=1"), ItemKind::Link);
        assert_eq!(detect_kind("  http://a.b  "), ItemKind::Link);
        assert_eq!(detect_kind("www.example.com"), ItemKind::Link);
        assert_eq!(detect_kind("see https://a.b please"), ItemKind::Text);
    }

    #[test]
    fn detects_code() {
        assert_eq!(
            detect_kind("const fetchUser = async (id) => await api.get(`/users/${id}`)"),
            ItemKind::Code
        );
        assert_eq!(
            detect_kind("SELECT * FROM users WHERE created_at > NOW()"),
            ItemKind::Code
        );
        assert_eq!(
            detect_kind("fn main() {\n    println!(\"hi\");\n}"),
            ItemKind::Code
        );
        assert_eq!(detect_kind("مرحباً بكم في رفّ"), ItemKind::Text);
        assert_eq!(
            detect_kind("Meeting notes: Q3 roadmap — focus on onboarding."),
            ItemKind::Text
        );
    }

    #[test]
    fn dedupes_and_moves_to_top() {
        let mut s = store();
        capture_text(&mut s, "alpha");
        capture_text(&mut s, "beta");
        assert_eq!(capture_text(&mut s, "alpha"), CaptureOutcome::Deduped);
        assert_eq!(s.history.len(), 2);
        assert_eq!(s.history[0].text, "alpha");
        assert_eq!(s.history[0].copy_count, 2);
    }

    #[test]
    fn dedupe_refreshes_latest_source_and_rich_representations() {
        let mut s = store();
        s.capture(
            ItemKind::Text,
            "same text".into(),
            Some("<b>old</b>".into()),
            Some("old-rtf".into()),
            None,
            None,
            None,
            ("Old App".into(), "com.example.old".into()),
        );
        let first_created_at = s.history[0].created_at;

        assert_eq!(
            s.capture(
                ItemKind::Text,
                "same text".into(),
                Some("<i>latest</i>".into()),
                Some("latest-rtf".into()),
                None,
                None,
                None,
                ("New App".into(), "com.example.new".into()),
            )
            .outcome,
            CaptureOutcome::Deduped
        );

        let item = &s.history[0];
        assert_eq!(item.source_app, "New App");
        assert_eq!(item.source_app_bundle_id, "com.example.new");
        assert_eq!(item.html.as_deref(), Some("<i>latest</i>"));
        assert_eq!(item.rtf.as_deref(), Some("latest-rtf"));
        assert!(item.created_at > first_created_at);
    }

    #[test]
    fn caps_history() {
        let mut s = store();
        s.settings.history_limit = 3;
        for i in 0..5 {
            capture_text(&mut s, &format!("item {i}"));
        }
        assert_eq!(s.history.len(), 3);
        assert_eq!(s.history[0].text, "item 4");
    }

    #[test]
    fn shrinking_limit_trims_immediately() {
        let mut s = store();
        for i in 0..5 {
            capture_text(&mut s, &format!("item {i}"));
        }
        s.settings.history_limit = 2;
        s.trim_history();
        assert_eq!(s.history.len(), 2);
        assert_eq!(s.history[0].text, "item 4");
        assert_eq!(s.history[1].text, "item 3");
    }

    #[test]
    fn pin_roundtrip() {
        let mut s = store();
        capture_text(&mut s, "keep me");
        capture_text(&mut s, "newer");
        let id = s.history[1].id.clone();
        assert!(s.toggle_pin(&id));
        assert_eq!(s.history.len(), 1);
        assert_eq!(s.pinned.len(), 1);
        assert!(s.pinned[0].is_pinned);
        // copying the same content again bumps the pinned item, no new row
        assert_eq!(capture_text(&mut s, "keep me"), CaptureOutcome::Deduped);
        assert_eq!(s.history.len(), 1);
        assert!(s.toggle_pin(&id));
        assert_eq!(s.pinned.len(), 0);
        assert_eq!(s.history.len(), 2);
        assert_eq!(s.history[0].text, "keep me");
    }

    #[test]
    fn failed_persisted_pin_rolls_back_and_returns_an_error() {
        let mut s = store();
        capture_text(&mut s, "pin must be durable");
        let id = s.history[0].id.clone();
        s.save_history();
        fs::create_dir(s.dir.join(PENDING_PIN_FILE)).unwrap();

        let result = s.set_pin_persisted(&id, true);

        assert!(result.is_err());
        let item = s.find(&id).expect("item remains available");
        assert!(!item.is_pinned, "failed persistence rolls back pin state");
        assert!(s.pinned.is_empty());
    }

    #[test]
    fn interrupted_pin_move_converges_without_duplicate_or_loss() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        capture_text(&mut s, "pin across a crash window");
        s.save_history();
        let id = s.history[0].id.clone();
        assert!(s.toggle_pin(&id));
        s.pending_pin = Some(PendingPin {
            item: s.find(&id).unwrap().clone(),
            desired: true,
            dropped: Vec::new(),
        });
        s.try_save_pending_pin().unwrap();
        // Destination landed, source did not: both files contain the same id.
        s.save_pinned();
        drop(s);

        let recovered = Store::load(dir.clone());
        assert_eq!(
            recovered
                .history
                .iter()
                .chain(recovered.pinned.iter())
                .filter(|item| item.id == id)
                .count(),
            1
        );
        assert!(recovered.pinned.iter().any(|item| item.id == id));
        assert!(!dir.join(PENDING_PIN_FILE).exists());
    }

    #[test]
    fn interrupted_unpin_reapplies_history_cap_before_file_cleanup() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        s.settings.history_limit = 1;
        capture_text(&mut s, "pinned item");
        let pinned_id = s.history[0].id.clone();
        assert!(s.toggle_pin(&pinned_id));
        capture_text(&mut s, "old history");
        let old_id = s.history[0].id.clone();
        // Make the soon-to-be-unpinned item the newest, so the full history
        // evicts the genuinely old row when it returns.
        let newest = s.history[0].created_at.saturating_add(1);
        s.find_mut(&pinned_id).unwrap().created_at = newest;
        // Cap is now satisfied by one historical item + one pinned item.
        s.save_history();
        s.save_pinned();

        assert!(s.toggle_pin(&pinned_id));
        let dropped = s.history.split_off(1);
        assert_eq!(dropped[0].id, old_id);
        s.pending_pin = Some(PendingPin {
            item: s.find(&pinned_id).unwrap().clone(),
            desired: false,
            dropped,
        });
        s.try_save_pending_pin().unwrap();
        // Only the destination landed before the simulated crash.
        s.save_history();
        drop(s);

        let recovered = Store::load(dir.clone());
        assert_eq!(recovered.history.len(), 1);
        assert_eq!(recovered.history[0].id, pinned_id);
        assert!(recovered.pinned.is_empty());
        assert!(recovered.find(&old_id).is_none());
        assert!(!dir.join(PENDING_PIN_FILE).exists());
    }

    #[test]
    fn reversible_delete_restores_exact_history_index_and_full_state() {
        let mut s = store();
        capture_text(&mut s, "oldest");
        capture_text(&mut s, "middle");
        capture_text(&mut s, "newest");
        let before: Vec<String> = s.history.iter().map(|item| item.id.clone()).collect();
        let id = before[1].clone();
        let item = s.find_mut(&id).unwrap();
        item.copy_count = 17;
        item.paste_count = 9;
        item.source_app = "اسم تطبيق طويل".into();

        let token = s.delete_reversible(&id).expect("receipt");
        assert!(s.find(&id).is_none());
        s.undo_delete(&token).expect("undo succeeds");

        assert_eq!(
            s.history
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<_>>(),
            before
        );
        let restored = s.find(&id).unwrap();
        assert!(!restored.is_pinned);
        assert_eq!(restored.copy_count, 17);
        assert_eq!(restored.paste_count, 9);
        assert_eq!(restored.source_app, "اسم تطبيق طويل");
        assert!(!s.dir.join(PENDING_DELETE_FILE).exists());
    }

    #[test]
    fn reversible_delete_restores_exact_pinned_index_and_pin_state() {
        let mut s = store();
        for text in ["one", "two", "three"] {
            capture_text(&mut s, text);
            let id = s.history[0].id.clone();
            assert!(s.toggle_pin(&id));
        }
        let before: Vec<(String, Option<u32>)> = s
            .pinned
            .iter()
            .map(|item| (item.id.clone(), item.pinned_order))
            .collect();
        let id = before[1].0.clone();

        let token = s.delete_reversible(&id).expect("receipt");
        s.undo_delete(&token).expect("undo succeeds");

        assert_eq!(
            s.pinned
                .iter()
                .map(|item| (item.id.clone(), item.pinned_order))
                .collect::<Vec<_>>(),
            before
        );
        assert!(s.find(&id).unwrap().is_pinned);
    }

    #[test]
    fn undo_uses_neighbors_after_a_new_capture_instead_of_a_stale_index() {
        let mut s = store();
        capture_text(&mut s, "oldest");
        capture_text(&mut s, "middle");
        capture_text(&mut s, "newest");
        let deleted_id = s.history[1].id.clone();
        let oldest_id = s.history[2].id.clone();

        let token = s.delete_reversible(&deleted_id).expect("receipt");
        capture_text(&mut s, "captured during undo window");
        s.undo_delete(&token).expect("undo succeeds");

        let ids: Vec<&str> = s.history.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(
            ids[2], deleted_id,
            "restored beside its original older neighbor"
        );
        assert_eq!(ids[3], oldest_id);

        s.settings.history_limit = 3;
        s.trim_history();
        assert!(s.find(&oldest_id).is_none(), "true oldest item is trimmed");
        assert!(
            s.find(&deleted_id).is_some(),
            "restored middle item is retained"
        );
    }

    #[test]
    fn undo_history_order_survives_a_recaptured_former_neighbor() {
        let mut s = store();
        capture_text(&mut s, "oldest");
        capture_text(&mut s, "middle");
        capture_text(&mut s, "newest");
        let deleted_id = s.history[1].id.clone();
        let oldest_id = s.history[2].id.clone();

        let token = s.delete_reversible(&deleted_id).expect("receipt");
        assert_eq!(capture_text(&mut s, "oldest"), CaptureOutcome::Deduped);
        assert_eq!(
            s.history[0].id, oldest_id,
            "former neighbor moved to the top"
        );
        s.undo_delete(&token).expect("undo succeeds");

        let restored_index = s
            .history
            .iter()
            .position(|item| item.id == deleted_id)
            .unwrap();
        assert_eq!(restored_index, 2, "saved createdAt controls the order");
    }

    #[test]
    fn failed_delete_journal_write_rolls_back_without_a_success_receipt() {
        let mut s = store();
        capture_text(&mut s, "must survive a failed transaction");
        let id = s.history[0].id.clone();
        // A directory at the destination makes the atomic rename fail without
        // relying on platform-specific permission behavior.
        fs::create_dir(s.dir.join(PENDING_DELETE_FILE)).unwrap();

        let result = s.delete_reversible(&id);

        assert!(result.is_err());
        assert!(s.find(&id).is_some(), "in-memory item is restored");
        assert!(s.pending_delete.is_none(), "no undo receipt is advertised");
    }

    #[test]
    fn a_second_delete_commits_the_first_receipt_and_image_cleanup() {
        let mut s = store();
        let image_file = "pending-original.png";
        let thumb_file = "pending-thumb.png";
        fs::write(s.images_dir().join(image_file), b"image").unwrap();
        fs::write(s.images_dir().join(thumb_file), b"thumb").unwrap();
        s.capture(
            ItemKind::Image,
            "image".into(),
            None,
            None,
            Some(image_file.into()),
            Some(thumb_file.into()),
            Some("image-hash".into()),
            ("Test".into(), "com.test".into()),
        );
        let image_id = s.history[0].id.clone();
        capture_text(&mut s, "second");
        let second_id = s.history[0].id.clone();

        let first_token = s.delete_reversible(&image_id).expect("first receipt");
        assert!(s.images_dir().join(image_file).exists());
        assert!(s.images_dir().join(thumb_file).exists());

        let second_token = s.delete_reversible(&second_id).expect("second receipt");
        assert!(
            s.undo_delete(&first_token).is_err(),
            "only the newest toast remains undoable"
        );
        assert!(!s.images_dir().join(image_file).exists());
        assert!(!s.images_dir().join(thumb_file).exists());
        s.undo_delete(&second_token).expect("newest receipt undoes");
        assert_eq!(s.history[0].id, second_id);
    }

    #[test]
    fn committed_delete_survives_restart_and_cleans_its_journal() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        capture_text(&mut s, "delete across restart");
        s.save_history();
        let id = s.history[0].id.clone();
        let _token = s.delete_reversible(&id).expect("receipt");
        assert!(dir.join(PENDING_DELETE_FILE).exists());
        drop(s);

        let reloaded = Store::load(dir.clone());
        assert!(reloaded.find(&id).is_none());
        assert!(!dir.join(PENDING_DELETE_FILE).exists());
    }

    #[test]
    fn interrupted_pinned_undo_preserves_the_restored_item() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        capture_text(&mut s, "pinned across interrupted undo");
        let id = s.history[0].id.clone();
        assert!(s.toggle_pin(&id));
        s.save_history();
        s.save_pinned();
        let _token = s.delete_reversible(&id).expect("receipt");

        // Reproduce the only crash boundary that matters: the restored layer
        // has landed, while pending-delete.json has not yet been retired.
        let pending = s.pending_delete.as_ref().expect("journal").clone();
        assert_eq!(pending.layer, DeletedLayer::Pinned);
        s.pinned
            .insert(pending.index.min(s.pinned.len()), pending.item);
        s.save_pinned();
        drop(s);

        let reloaded = Store::load(dir.clone());
        let restored = reloaded.find(&id).expect("restored item survives restart");
        assert!(restored.is_pinned);
        assert!(!dir.join(PENDING_DELETE_FILE).exists());
    }

    #[test]
    fn corrupt_file_is_preserved() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(HISTORY_FILE), "{not json").unwrap();
        let s = Store::load(dir.clone());
        assert!(s.history.is_empty());
        assert!(dir.join("history.json.corrupt").exists());
    }

    #[test]
    fn corrupt_history_preserves_all_images_for_recovery() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let images = dir.join(IMAGES_DIR);
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("referenced.png"), b"referenced").unwrap();
        fs::write(images.join("apparently-orphan.png"), b"apparently orphan").unwrap();
        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"type":"image","imageFile":"referenced.png""#,
        )
        .unwrap();

        let store = Store::load(dir.clone());

        assert!(
            store.history.is_empty(),
            "unreadable metadata is not trusted"
        );
        assert!(dir.join("history.json.corrupt").exists());
        assert!(
            images.join("referenced.png").exists(),
            "an image named by recoverable corrupt metadata must survive"
        );
        assert!(
            images.join("apparently-orphan.png").exists(),
            "GC must skip the whole image directory when references are incomplete"
        );
    }

    #[test]
    fn a_recovery_copy_keeps_its_images_on_the_boot_after_the_one_that_healed_history() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let images = dir.join(IMAGES_DIR);
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("a.png"), b"a").unwrap();
        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"type":"image","imageFile":"a.png","thumbFile":"a.thumb.png""#,
        )
        .unwrap();

        // First boot sets the recovery copy aside and skips collection.
        let mut store = Store::load(dir.clone());
        assert!(dir.join("history.json.corrupt").exists());

        // One good capture rewrites history.json — the guard now has nothing
        // left to notice, because both layers parse from here on.
        let capture = store.capture(
            ItemKind::Text,
            "نصّ".into(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        let store = std::sync::Mutex::new(store);
        persist_capture(&store, capture).unwrap();
        drop(store);

        let store = Store::load(dir.clone());
        assert_eq!(store.history.len(), 1, "the healed layer reads fine now");
        assert!(
            images.join("a.png").exists(),
            "the only metadata naming this image is the recovery copy"
        );
    }

    #[test]
    fn a_failed_capture_write_restores_the_model_from_its_undo_record() {
        // 1000 is the highest limit `validate_settings` allows, and the size
        // the old path cloned twice on every single copy the user made.
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        s.settings.history_limit = 1000;
        for n in 0..1000 {
            capture_text(&mut s, &format!("item {n}"));
        }
        let before_len = s.history.len();
        let before_head = s.history[0].id.clone();
        let before_tail = s.history[before_len - 1].id.clone();

        // The temporary file every layer write goes through cannot be created,
        // so the write fails while `history.json` itself stays readable.
        fs::create_dir(dir.join("history.json.tmp")).unwrap();

        let store = std::sync::Mutex::new(s);
        let capture = crate::lock_store(&store).capture(
            ItemKind::Text,
            "one more".into(),
            None,
            None,
            None,
            None,
            None,
            ("Test".into(), "com.test".into()),
        );

        assert!(persist_capture(&store, capture).is_err());

        let s = crate::lock_store(&store);
        assert_eq!(s.history.len(), before_len, "the row it pushed off came back");
        assert_eq!(s.history[0].id, before_head, "the new row is gone");
        assert_eq!(
            s.history[before_len - 1].id,
            before_tail,
            "and the tail is the one that was there"
        );
    }

    #[test]
    fn the_size_budget_trims_a_history_that_is_still_under_the_count_limit() {
        let mut s = store();
        s.settings.history_limit = 1000;
        // Rows of 2 MB: well inside the per-item cap, and a count limit of
        // 1000 of them is what makes "1000 items" an unbounded promise.
        let bulk = "a".repeat(2 * 1024 * 1024);
        let rows = 2 + MAX_HISTORY_BYTES / bulk.len();
        for n in 0..rows {
            capture_text(&mut s, &format!("{n} {bulk}"));
        }

        assert!(
            s.history.len() < rows,
            "the count limit alone would have kept every row"
        );
        assert!(
            s.history.iter().map(weight).sum::<usize>() <= MAX_HISTORY_BYTES,
            "the layer stays inside its byte budget"
        );
        assert_eq!(
            s.history[0].text.split(' ').next(),
            Some((rows - 1).to_string().as_str()),
            "trimming drops the oldest, never the newest"
        );
    }

    #[test]
    fn a_learning_bump_waits_for_the_flush_instead_of_rewriting_the_layer() {
        let mut s = store();
        capture_text(&mut s, "counted");
        let id = s.history[0].id.clone();
        s.save_history();
        let on_disk = fs::read(s.dir.join(HISTORY_FILE)).unwrap();

        // Exactly what `bump_signals` does for a paste.
        s.find_mut(&id).unwrap().paste_count += 1;
        s.mark_signals_dirty(false);

        assert_eq!(
            fs::read(s.dir.join(HISTORY_FILE)).unwrap(),
            on_disk,
            "moving a counter by one must not rewrite the whole layer"
        );

        for write in s.stage_signal_flush() {
            write.commit().unwrap();
        }
        assert_ne!(
            fs::read(s.dir.join(HISTORY_FILE)).unwrap(),
            on_disk,
            "the pause is when it is written"
        );
        assert!(s.stage_signal_flush().is_empty(), "and only once");
    }

    #[test]
    fn a_stale_layer_write_never_lands_on_top_of_a_newer_one() {
        let mut s = store();
        capture_text(&mut s, "first");
        let stale = stage_json(&s.dir.join(HISTORY_FILE), &s.history).unwrap();

        capture_text(&mut s, "second");
        let fresh = stage_json(&s.dir.join(HISTORY_FILE), &s.history).unwrap();

        // The newer serialization wins the race to the disk; the older one
        // then arrives holding a layer that no longer exists.
        fresh.commit().unwrap();
        stale.commit().unwrap();

        let written: Vec<ClipItem> =
            serde_json::from_slice(&fs::read(s.dir.join(HISTORY_FILE)).unwrap()).unwrap();
        assert_eq!(written.len(), 2, "the older write was refused, not applied");
    }

    #[test]
    fn a_single_row_larger_than_the_budget_is_still_kept() {
        let mut s = store();
        capture_text(&mut s, &"a".repeat(MAX_HISTORY_BYTES + 1));

        assert_eq!(
            s.history.len(),
            1,
            "a row that already passed the per-item cap must not vanish on arrival"
        );
    }

    #[test]
    fn startup_removes_only_unreferenced_image_files() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        fs::write(s.images_dir().join("kept.png"), b"kept").unwrap();
        fs::write(s.images_dir().join("orphan.png"), b"orphan").unwrap();
        let capture = s.capture(
            ItemKind::Image,
            "image".into(),
            None,
            None,
            Some("kept.png".into()),
            None,
            Some("hash".into()),
            ("Test".into(), "com.test".into()),
        );
        let s = std::sync::Mutex::new(s);
        persist_capture(&s, capture).unwrap();
        let s = s.into_inner().unwrap();
        drop(s);

        let reloaded = Store::load(dir.clone());
        assert!(reloaded.images_dir().join("kept.png").exists());
        assert!(!reloaded.images_dir().join("orphan.png").exists());
    }

    #[test]
    fn settings_from_older_versions_get_appearance_defaults() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"hotkey":"shift+super+v"}"#).unwrap();
        let s = Store::load(dir);
        assert!(s.settings.follow_system);
        assert_eq!(s.settings.appearance, Appearance::Light);
    }

    #[test]
    fn unknown_legacy_settings_fields_are_tolerated_then_retired() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"removedLegacyPreference":"dark","historyLimit":200}"#,
        )
        .unwrap();

        let s = Store::load(dir.clone());
        assert_eq!(s.settings.history_limit, 200);
        s.save_settings();

        let persisted = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        assert!(!persisted.contains("removedLegacyPreference"));
        let reloaded = Store::load(dir);
        assert_eq!(reloaded.settings.history_limit, 200);
    }

    /// «مسح سجل الحافظة» must empty the recent layer only — the pinned shelf
    /// is the user's deliberate keep-list and survives the wipe untouched.
    #[test]
    fn clear_history_keeps_pinned() {
        let mut s = store();
        capture_text(&mut s, "throwaway");
        capture_text(&mut s, "keep me");
        capture_text(&mut s, "another");
        let pinned_id = s
            .history
            .iter()
            .find(|i| i.text == "keep me")
            .unwrap()
            .id
            .clone();
        assert!(s.toggle_pin(&pinned_id));
        assert_eq!(s.pinned.len(), 1);
        assert_eq!(s.history.len(), 2);

        s.clear_history();

        assert!(s.history.is_empty(), "recent items are gone");
        assert_eq!(s.pinned.len(), 1, "pinned shelf survives");
        assert_eq!(s.pinned[0].text, "keep me");
        assert!(s.pinned[0].is_pinned);
        // The kept item is still addressable (no dangling/ghost entries).
        assert!(s.find(&pinned_id).is_some());
    }

    /// Settings and learning signals are separate concerns from the history
    /// wipe: clearing the shelf must not silently reset either.
    #[test]
    fn clear_history_leaves_settings_and_pinned_signals_alone() {
        let mut s = store();
        s.settings.hotkey = "shift+super+r".into();
        s.settings.history_limit = 42;
        capture_text(&mut s, "pin me");
        let id = s.history[0].id.clone();
        s.toggle_pin(&id);
        s.find_mut(&id).unwrap().paste_count = 7;

        s.clear_history();

        assert_eq!(s.settings.hotkey, "shift+super+r");
        assert_eq!(s.settings.history_limit, 42);
        assert_eq!(s.find(&id).unwrap().paste_count, 7);
    }

    #[test]
    fn clear_learning_resets_signals() {
        let mut s = store();
        capture_text(&mut s, "alpha");
        capture_text(&mut s, "alpha");
        assert_eq!(s.history[0].copy_count, 2);
        s.clear_learning();
        assert_eq!(s.history[0].copy_count, 0);
        assert_eq!(s.history[0].paste_count, 0);
    }
}
