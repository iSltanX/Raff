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
    /// Milliseconds since epoch: when the content was last copied. History is
    /// ordered by it and the age limit counts from it; pinning and unpinning
    /// never change it.
    pub created_at: u64,
    pub is_pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_order: Option<u32>,
    // Silent learning signals (v1: logging only — no adaptive behavior).
    pub copy_count: u32,
    pub paste_count: u32,
    pub last_used_at: u64,
    /// A pinned item's own name (IMP-07), shown above its text and searched
    /// with it. Pinned items only: unpinning drops it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// Days an unpinned row is kept, or `0` to keep it until a count or size
    /// limit pushes it out.
    ///
    /// The count answers «كم أحتفظ»; this answers «كم يعيش ما نسختُه على
    /// قرصي», and for a privacy tool only the second is a promise the user can
    /// hold Raff to — «٥٠٠ عنصر» is two days for one person and three months
    /// for another. `0` is what every existing install migrates to, which is
    /// exactly today's behaviour.
    pub retention_days: u32,
    /// These are the defaults standing in for a `settings.json` that could not
    /// be read. Written down, so the notice outlives a restart and any other
    /// save; only turning capture back on — the user's confirmation — clears it.
    /// Absent from the file whenever it is false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub settings_recovered: bool,
}

/// The settings a caller wants changed, and only those.
///
/// A window used to send a whole `Settings` built from its last view of them,
/// so a change made anywhere else in between — «إيقاف الالتقاط» from the menu
/// bar while Settings was open, say — was silently put back by the next
/// unrelated save (H6). Now an absent field keeps whatever the store holds
/// when the patch lands. A complete object is still a valid patch.
///
/// `settings_recovered` has no field here: the store owns it.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub hotkey: Option<String>,
    pub launch_at_login: Option<bool>,
    pub history_limit: Option<usize>,
    pub capture_enabled: Option<bool>,
    pub respect_concealed: Option<bool>,
    pub excluded_apps: Option<Vec<String>>,
    pub learning_enabled: Option<bool>,
    pub first_run_shown: Option<bool>,
    pub appearance: Option<Appearance>,
    pub follow_system: Option<bool>,
    pub retention_days: Option<u32>,
}

impl SettingsPatch {
    /// `current`, with this patch's fields laid over it.
    pub fn applied_to(self, current: &Settings) -> Settings {
        let mut next = current.clone();
        if let Some(value) = self.hotkey {
            next.hotkey = value;
        }
        if let Some(value) = self.launch_at_login {
            next.launch_at_login = value;
        }
        if let Some(value) = self.history_limit {
            next.history_limit = value;
        }
        if let Some(value) = self.capture_enabled {
            next.capture_enabled = value;
        }
        if let Some(value) = self.respect_concealed {
            next.respect_concealed = value;
        }
        if let Some(value) = self.excluded_apps {
            next.excluded_apps = value;
        }
        if let Some(value) = self.learning_enabled {
            next.learning_enabled = value;
        }
        if let Some(value) = self.first_run_shown {
            next.first_run_shown = value;
        }
        if let Some(value) = self.appearance {
            next.appearance = value;
        }
        if let Some(value) = self.follow_system {
            next.follow_system = value;
        }
        if let Some(value) = self.retention_days {
            next.retention_days = value;
        }
        next
    }
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
            retention_days: 0,
            settings_recovered: false,
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

/// A use of a row through رفّ: a paste, or a copy made from the panel or menu.
/// Why an unpinned row left instead of coming back (ت١٧، ت٢٩).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnpinRemoval {
    /// Past the retention period: the age limit counts from the copy.
    Retention,
    /// Older than every row history held before it came back.
    OlderThanHistory,
    /// Taken back, then let go by the count or the byte budget.
    Limit,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Usage {
    Paste,
    Copy,
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

impl CaptureResult {
    /// Nothing was captured: nothing to write, nothing to take back.
    pub(crate) fn failed() -> Self {
        Self {
            outcome: CaptureOutcome::Failed,
            dropped: Vec::new(),
            layer: None,
            undo: CaptureUndo::Nothing,
        }
    }
}

/// Exactly what it takes to put `capture` back, and nothing more.
///
/// This replaces the copy of both layers that used to be taken before every
/// capture "just in case the write fails" — two full clones on every copy the
/// user made, paid at the allowed limit of 1000 rows, to guard a path that
/// almost never runs.
///
/// Rows are named by id, never by position: the layers can change between the
/// capture and its undo (an unpin lands on top, a row is deleted or moved),
/// and a position would then name somebody else's row.
#[derive(Debug)]
pub(crate) enum CaptureUndo {
    /// Nothing was touched.
    Nothing,
    /// The row `id` went to the head of history; `CaptureResult::dropped`
    /// holds whatever fell off the end.
    Added { id: String },
    /// A pinned row was overwritten.
    PinnedBumped(Bump),
    /// A history row was moved to the head and overwritten.
    HistoryBumped(Bump),
}

/// What a re-copy did to an existing row, so that exactly that — and nothing
/// that happened to the row since — can be taken back.
#[derive(Debug)]
pub(crate) struct Bump {
    /// The row as it was before the re-copy.
    previous: Box<ClipItem>,
    /// Whether the re-copy counted itself as one more copy.
    counted: bool,
    /// The «last used» stamp the re-copy set, if it set one.
    used_at: Option<u64>,
}

impl Bump {
    /// Puts back the content the re-copy replaced, while keeping what the row
    /// went through since that the re-copy did not do: its pin state and
    /// order, and every use counted meanwhile (a paste, a copy through رفّ) —
    /// only the re-copy's own count comes off.
    fn take_back(self, row: &mut ClipItem) {
        let copy_count = row.copy_count.saturating_sub(u32::from(self.counted));
        let last_used_at = match self.used_at {
            Some(stamp) if row.last_used_at == stamp => self.previous.last_used_at,
            _ => row.last_used_at,
        };
        let (paste_count, is_pinned, pinned_order) =
            (row.paste_count, row.is_pinned, row.pinned_order);
        *row = *self.previous;
        row.copy_count = copy_count;
        row.paste_count = paste_count;
        row.last_used_at = last_used_at;
        row.is_pinned = is_pinned;
        row.pinned_order = pinned_order;
    }
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
    /// When the delete happened: a row of the same content dated from then on
    /// is the copy made inside the undo window (017). Absent in a journal
    /// written before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<u64>,
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
    /// A layer — history, pinned or settings — could not be parsed on this
    /// launch and was copied aside.
    pub unreadable_layer: bool,
    /// The layer that did not parse is the shelf itself (history or pinned).
    /// The panel needs this to tell "nothing is saved" apart from "your content
    /// is there, it just was not read" — two states an empty list looks
    /// identical in.
    pub unreadable_shelf: bool,
    /// `settings.json` did not parse — on this launch or an earlier one. The
    /// defaults would turn capture back on with no app excluded — the very
    /// choices the file existed to keep — so capture is held off and this stays
    /// set until the user turns it back on themselves
    /// (`Settings::settings_recovered` carries it across launches).
    pub unreadable_settings: bool,
    pending_delete: Option<PendingDelete>,
    pending_pin: Option<PendingPin>,
    /// Layers whose learning counters moved and have not been written yet.
    dirty_signals: DirtySignals,
    /// Why the last unpin did not take its row back (`return_to_history`),
    /// so the panel can say it. Cleared by every move.
    unpin_removal: Option<UnpinRemoval>,
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

/// A stored image file name that names a file inside `images/` and nothing
/// else (005). Names are generated (`<uuid>.png`, `<uuid>.thumb.png`), so the
/// rule can be narrow: ASCII letters, digits, `-`, `_` and single dots, not
/// starting with a dot, at most 128 bytes. A history file edited by hand, or
/// damaged, cannot make رفّ read, send or delete anything outside the folder.
pub(crate) fn is_safe_image_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// The path of a stored image, or `None` for a name that would leave the
/// folder. Every read and delete of an image goes through here.
pub(crate) fn image_path(images_dir: &Path, name: &str) -> Option<PathBuf> {
    is_safe_image_name(name).then(|| images_dir.join(name))
}

/// Drops the image names that fail `is_safe_image_name`: the row stays, as a
/// picture whose file is unavailable. Reports whether anything changed.
fn disarm_image_names(items: &mut [ClipItem]) -> bool {
    let mut changed = false;
    for item in items.iter_mut() {
        for name in [&mut item.image_file, &mut item.thumb_file] {
            if name.as_deref().is_some_and(|n| !is_safe_image_name(n)) {
                *name = None;
                changed = true;
            }
        }
    }
    changed
}

/// An undo the history no longer has room for: the item would be the one to
/// leave as it came back (017). A kind, not words — the panel words it (ت٢٣).
pub(crate) const UNDO_NO_ROOM: &str = "raff/undo-no-room";
/// The same, because its age is past the retention period, not the count —
/// not the undo window running out, which is another thing.
pub(crate) const UNDO_RETENTION: &str = "raff/undo-retention";
/// A pinned item's name is a few words, not a note (IMP-07).
pub(crate) const LABEL_MAX_CHARS: usize = 40;
pub(crate) const LABEL_TOO_LONG: &str = "raff/label-too-long";
/// Only the shelf has names: the item is not pinned, or is gone.
pub(crate) const LABEL_NOT_PINNED: &str = "raff/label-not-pinned";

/// That other thing: the delete was made final — its five seconds ran out, or
/// «مسح السجل» settled it — before the undo arrived (ت٤٥ ب٣).
pub(crate) const UNDO_EXPIRED: &str = "raff/undo-expired";

/// Adds `from`'s use to `into`: both were the same copy.
fn fold_counts(into: &mut ClipItem, from: &ClipItem) {
    into.copy_count = into.copy_count.saturating_add(from.copy_count);
    into.paste_count = into.paste_count.saturating_add(from.paste_count);
    into.last_used_at = into.last_used_at.max(from.last_used_at);
}

/// `item` takes in a newer copy of itself, as a re-copy bumps a row: the
/// copy's time, source and representations, and both counts. Its own image
/// files stay; the copy's are the ones to delete.
fn take_in_copy(item: &mut ClipItem, copy: &ClipItem) {
    fold_counts(item, copy);
    if copy.created_at > item.created_at {
        item.created_at = copy.created_at;
        item.text.clone_from(&copy.text);
        item.html.clone_from(&copy.html);
        item.rtf.clone_from(&copy.rtf);
        item.source_app.clone_from(&copy.source_app);
        item.source_app_bundle_id
            .clone_from(&copy.source_app_bundle_id);
    }
}

/// Version prefix on a stored image fingerprint.
///
/// The value is written into `history.json` and used as an identity key, so
/// the algorithm behind it has to be one this project owns. `DefaultHasher`
/// documents its algorithm as unspecified and free to change between Rust
/// releases: after a toolchain upgrade every stored fingerprint would quietly
/// stop matching, and re-copying a saved image would silently make a second
/// row and a second file. The prefix is what lets a value written by the old
/// one be recognised and replaced.
const HASH_PREFIX: &str = "f1:";

/// FNV-1a, 64-bit — short enough to write down here and fixed forever.
///
/// The job is dropping duplicates of images the user copied twice, not
/// resisting an adversary who gets to choose the bytes.
pub fn content_hash(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{HASH_PREFIX}{hash:016x}")
}

/// Replaces fingerprints written by the old, undefined algorithm.
///
/// Every image whose file survives is re-fingerprinted from that file, so no
/// duplicate is ever accepted as the price of the change. One whose file is
/// gone loses its fingerprint instead of keeping an unverifiable value. With
/// none it matches no capture (`Store::same_content`): its label is shared by
/// every image of its size, so it says nothing about the picture.
fn migrate_image_hashes(items: &mut [ClipItem], images_dir: &Path) -> bool {
    let mut changed = false;
    for item in items.iter_mut() {
        if item.kind != ItemKind::Image {
            continue;
        }
        let from_file = |item: &ClipItem| {
            item.image_file
                .as_deref()
                .and_then(|file| image_path(images_dir, file))
                .and_then(|path| fs::read(path).ok())
                .map(|bytes| content_hash(&bytes))
        };
        match item.hash.as_deref() {
            Some(hash) if !hash.starts_with(HASH_PREFIX) => {
                item.hash = from_file(item);
                changed = true;
            }
            // ت٨: a row from before fingerprints, whose file is still here,
            // gets one — or re-copying that picture would make a second row.
            None => {
                if let Some(hash) = from_file(item) {
                    item.hash = Some(hash);
                    changed = true;
                }
            }
            _ => {}
        }
    }
    changed
}

/// Folds text for searching, exactly as `normalizeArabic` in `logic.js` does.
///
/// The two must agree: the panel filters what it can see with the JavaScript
/// one and asks this one about everything it cannot, and a query that means
/// two different things on the two sides would show and hide the same row.
pub fn normalize_for_search(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            // Arabic-Indic digits fold to Western, so either spelling finds both.
            '\u{0660}'..='\u{0669}' => {
                folded.push(char::from(b'0' + (ch as u32 - 0x0660) as u8));
            }
            // Tashkeel and the superscript alef carry no search meaning...
            '\u{064B}'..='\u{065F}' | '\u{0670}' => {}
            '\u{0640}' => {} // ...nor does tatweel
            '\u{0623}' | '\u{0625}' | '\u{0622}' => folded.push('\u{0627}'),
            '\u{0649}' => folded.push('\u{064A}'),
            _ => folded.push(ch),
        }
    }
    // Lowercased as a whole, after the folds, as `toLowerCase()` is: case is
    // contextual — a capital sigma that ends a word becomes ς, not σ — and a
    // character at a time cannot see the word it ends.
    folded.to_lowercase()
}

/// Trims a search query exactly as `String.prototype.trim` does in `logic.js`.
///
/// `str::trim` goes by Unicode's White_Space; JavaScript has its own list. It
/// also strips U+FEFF — a byte-order mark is how text pasted from some files
/// begins — and leaves U+0085 alone. Trimmed two ways, one query is two.
pub fn trim_query(query: &str) -> &str {
    query.trim_matches(|ch| {
        matches!(
            ch,
            // WhiteSpace: TAB, VT, FF, ZWNBSP and every Zs space...
            '\t' | '\u{000B}' | '\u{000C}' | '\u{FEFF}' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200A}'
                | '\u{202F}' | '\u{205F}' | '\u{3000}'
                // ...and LineTerminator.
                | '\n' | '\r' | '\u{2028}' | '\u{2029}'
        )
    })
}

/// Schemes the «روابط» filter recognises.
///
/// An explicit list, not "anything with a colon": `C:\\Users`, `12:30` and
/// `note: see below` are not links, and a filter that claimed they were would
/// be worse than one that missed a few.
const LINK_SCHEMES: [&str; 4] = ["http://", "https://", "mailto:", "tel:"];

/// Whether a single whitespace-free token is a link.
///
/// Deliberately conservative about the bare-domain case: a host has to have a
/// plausible last label, or every `file.txt` and `3.5` in the shelf would file
/// itself under «روابط».
fn is_link(token: &str) -> bool {
    if let Some(scheme) = LINK_SCHEMES
        .iter()
        .find(|scheme| token.starts_with(**scheme))
    {
        // A scheme on its own addresses nothing.
        return token.len() > scheme.len();
    }
    let rest = token.strip_prefix("www.").unwrap_or(token);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return false;
    }
    // A path, query or fragment after the host is its own evidence, and it is
    // what `example.co.uk/guide` has and `report.pdf` does not — so the ending
    // does not have to be recognised for those.
    if host.len() < rest.len() {
        return true;
    }
    let tld = labels[labels.len() - 1].to_ascii_lowercase();
    // "Two or more letters" is not a test: `file.txt`, `notes.md` and
    // `report.pdf` all pass it, and filing those under «روابط» would be worse
    // than missing a domain. A short list of the endings this shelf actually
    // sees is the conservative call — an unknown one stays text, which is the
    // harmless direction, and `www.` or a scheme still recognises it.
    KNOWN_TLDS.contains(&tld.as_str())
        && labels[..labels.len() - 1]
            .iter()
            .all(|label| label.chars().all(|c| c.is_alphanumeric() || c == '-'))
}

/// Endings recognised in a bare domain, with no `www.` and no scheme to go on.
const KNOWN_TLDS: [&str; 30] = [
    // generic
    "com", "net", "org", "edu", "gov", "int", "mil", "info", "io", "dev", "app", "ai", "co", "me",
    "xyz", "online", "site", // Arabic-speaking region
    "sa", "ae", "eg", "qa", "kw", "bh", "om", "jo", "ma", "tn", "dz", "iq", "ps",
];

/// Heuristic content typing (simple, not smart).
pub fn detect_kind(text: &str) -> ItemKind {
    let t = text.trim();
    if t.is_empty() {
        return ItemKind::Text;
    }
    let single_token = !t.contains(char::is_whitespace);
    if single_token && is_link(t) {
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

/// Image filenames named by any set-aside copy — the newest `*.json.corrupt`
/// and every stamped `*.json.<ms>.corrupt` before it.
///
/// Such a copy exists precisely because it did not parse, so it is read
/// leniently: every `"imageFile"` / `"thumbFile"` value that can still be
/// recovered from the text counts. Keeping one file too many costs disk;
/// keeping one too few destroys the images the copy exists to point at.
///
/// Leniently includes the encoding: a write cut short inside a two-byte
/// Arabic letter leaves bytes that are not UTF-8, and the names around them
/// (plain ASCII) are still worth every image they keep.
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
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for key in KEYS {
            let mut rest = text.as_ref();
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
            match set_aside(path) {
                Ok(copy) => eprintln!(
                    "raff: unreadable {} ({err}); copied to {}",
                    path.display(),
                    copy.display()
                ),
                Err(copy_err) => eprintln!(
                    "raff: unreadable {} ({err}); could not copy it aside: {copy_err}",
                    path.display()
                ),
            }
            (T::default(), false)
        }
    }
}

/// Set-aside copies kept per layer, the newest included.
///
/// Every copy keeps the images it names alive (`referenced_by_recovery_copies`),
/// and a history copy can weigh as much as the layer's whole byte budget, so
/// "all of them, forever" is not an option. Five distinct unreadable versions
/// of one file is already far past anything but a disk that is failing.
const MAX_RECOVERY_COPIES: usize = 5;

/// Copies an unreadable layer aside without ever replacing an earlier copy.
///
/// The newest copy is `<file>.corrupt`, where it always was. An earlier one is
/// first moved to `<file>.<ms>.corrupt`, stamped with the time it was set
/// aside. Bytes already kept are not copied again: a layer that stays
/// unreadable is met at every launch, and each launch would otherwise push a
/// genuinely different copy out of the cap. Past the cap, the oldest go.
///
/// The new copy is written beside the others before anything moves, so a
/// write that fails (a full disk) leaves every existing copy where it was.
fn set_aside(path: &Path) -> std::io::Result<PathBuf> {
    let bytes = fs::read(path)?;
    let newest = path.with_extension("json.corrupt");
    let copies = recovery_copies(path);
    if let Some((_, same)) = copies
        .iter()
        .find(|(_, copy)| fs::read(copy).is_ok_and(|kept| kept == bytes))
    {
        return Ok(same.clone());
    }
    let staged = path.with_extension("json.corrupt.tmp");
    fs::write(&staged, &bytes)?;
    if newest.exists() {
        let mut stamp = fs::metadata(&newest)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or_else(now_ms, |since| since.as_millis() as u64);
        let mut archived = path.with_extension(format!("json.{stamp}.corrupt"));
        while archived.exists() {
            stamp += 1;
            archived = path.with_extension(format!("json.{stamp}.corrupt"));
        }
        if let Err(err) = fs::rename(&newest, &archived) {
            let _ = fs::remove_file(&staged);
            return Err(err);
        }
    }
    fs::rename(&staged, &newest)?;

    let mut stamped: Vec<(u64, PathBuf)> = recovery_copies(path)
        .into_iter()
        .filter_map(|(stamp, copy)| stamp.map(|stamp| (stamp, copy)))
        .collect();
    stamped.sort();
    let excess = (stamped.len() + 1).saturating_sub(MAX_RECOVERY_COPIES);
    for (_, oldest) in stamped.into_iter().take(excess) {
        let _ = fs::remove_file(oldest);
    }
    Ok(newest)
}

/// Every set-aside copy of the layer at `path`, with its stamp; the newest,
/// unstamped `<file>.corrupt` comes back with `None`.
fn recovery_copies(path: &Path) -> Vec<(Option<u64>, PathBuf)> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let prefix = format!("{name}.");
    entries
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().to_str()?.to_owned();
            let middle = file.strip_prefix(&prefix)?.strip_suffix("corrupt")?;
            let stamp = match middle {
                "" => None,
                stamped => Some(stamped.strip_suffix('.')?.parse::<u64>().ok()?),
            };
            Some((stamp, entry.path()))
        })
        .collect()
}

fn load_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    load_json_with_status(path).0
}

/// A journal (pending pin or delete) that does not parse is set aside like a
/// layer — and then removed (016 ج2). A layer is rewritten by the next save;
/// a journal is not, so it lingered and was met again at every launch. It is
/// removed only once a set-aside copy holds exactly its bytes, which also
/// keeps the images it names alive (`referenced_by_recovery_copies`).
fn load_journal<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    let (value, readable) = load_json_with_status(path);
    if !readable {
        if let Ok(bytes) = fs::read(path) {
            let kept = recovery_copies(path)
                .iter()
                .any(|(_, copy)| fs::read(copy).is_ok_and(|copy| copy == bytes));
            if kept {
                let _ = fs::remove_file(path);
            }
        }
    }
    value
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
    let ticket = next_write_ticket();
    staged_tickets()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(path.to_path_buf())
        .and_modify(|latest| *latest = (*latest).max(ticket))
        .or_insert(ticket);
    Ok(LayerWrite {
        path: path.to_path_buf(),
        bytes,
        ticket,
    })
}

/// The newest ticket handed out for each layer, whether or not its write has
/// landed (`write_gate` knows the ones that have).
fn staged_tickets() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, u64>> {
    static STAGED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, u64>>> =
        std::sync::OnceLock::new();
    STAGED.get_or_init(Default::default)
}

/// Whether a write of `path` newer than `ticket` has been staged since.
fn staged_since(path: &Path, ticket: u64) -> bool {
    staged_tickets()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .is_some_and(|latest| *latest > ticket)
}

fn next_write_ticket() -> u64 {
    static TICKETS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    TICKETS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

fn write_layer_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let durable = is_durable_layer(path);
    let written = if durable {
        write_synced(&tmp, bytes)
    } else {
        fs::write(&tmp, bytes)
    };
    written
        .and_then(|_| fs::rename(&tmp, path))
        .map_err(|err| format!("تعذّر حفظ {}: {err}", path.display()))?;
    if durable {
        sync_parent_dir(path);
    }
    stop::point();
    Ok(())
}

/// Tests only: stops the "process" right after its n-th step that reached
/// the disk — a layer or journal written, a journal removed — as a power cut
/// would. The test then loads a new store from what is on disk. Compiled out
/// of the app.
#[cfg(test)]
pub(crate) mod stop {
    use std::cell::Cell;

    thread_local! {
        static AFTER: Cell<Option<usize>> = const { Cell::new(None) };
        static STEPS: Cell<usize> = const { Cell::new(0) };
    }

    /// Counts steps from now on, stopping after the `after`-th.
    pub(crate) fn arm(after: usize) {
        AFTER.set(Some(after));
        STEPS.set(0);
    }

    /// Stops counting; how many steps were taken.
    pub(crate) fn disarm() -> usize {
        AFTER.set(None);
        STEPS.get()
    }

    pub(crate) fn point() {
        let Some(after) = AFTER.get() else {
            return;
        };
        STEPS.set(STEPS.get() + 1);
        if STEPS.get() >= after {
            AFTER.set(None);
            panic!("simulated stop after step {after}");
        }
    }
}

#[cfg(not(test))]
mod stop {
    #[inline(always)]
    pub(crate) fn point() {}
}

/// The files whose writes reach the platter before they count as done (H3):
/// the settings, and the two journals the delete and pin transactions start
/// with. Each is small and written only on a deliberate act, so the flush —
/// about 7 ms on an SSD — is paid rarely. History is not among them: it is
/// rewritten whole on every copy (tens of megabytes at the limit, ~50 ms to
/// flush), and a power cut costs it at most the last few copies.
fn is_durable_layer(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(SETTINGS_FILE | PENDING_DELETE_FILE | PENDING_PIN_FILE)
    )
}

/// Writes `bytes` to `path` and flushes them to the device. `sync_all` is
/// `fcntl(F_FULLFSYNC)` on macOS, the only call that gets past the drive's
/// own cache; a plain `fsync` there does not.
fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(test)]
    tests::note_sync();
    Ok(())
}

/// Makes the rename that just landed `path` durable too. Best effort: the
/// write has already happened by now, and reporting it as failed would have
/// the caller undo in memory a change that is on disk — a pin journal, say,
/// replayed at the next launch after the user was told the pin failed.
fn sync_parent_dir(path: &Path) {
    let Some(dir) = path.parent() else { return };
    if let Err(err) = fs::File::open(dir).and_then(|dir| dir.sync_all()) {
        eprintln!("raff: could not flush {}: {err}", dir.display());
    }
}

/// The newest serialization of each layer that has reached the disk.
///
/// Bytes are prepared under the store lock and written after it is released,
/// so two captures can be in flight at once. The ticket each carries lets the
/// writer refuse to lay an older layer over a newer one.
fn write_gate() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, u64>> {
    static GATE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, u64>>> =
        std::sync::OnceLock::new();
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

/// Whether a write of `path` newer than `ticket` has reached the disk.
fn written_since(path: &Path, ticket: u64) -> bool {
    write_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .is_some_and(|latest| *latest > ticket)
}

fn save_json<T: Serialize>(path: &Path, value: &T) {
    if let Err(err) = try_save_json(path, value) {
        eprintln!("raff: {err}");
    }
}

/// Applies a capture and persists its layer with the store lock released.
///
/// `apply` changes the model and its layer is serialized under one hold of
/// the lock, so no other change can slip in between and the write's ticket
/// orders exactly the state it carries. The write, the expensive part,
/// happens with the lock free, and the outcome is settled under the lock
/// again (`Store::settle_capture`).
pub(crate) fn capture_and_persist(
    store: &std::sync::Mutex<Store>,
    apply: impl FnOnce(&mut Store) -> CaptureResult,
) -> Result<CaptureOutcome, String> {
    let staged = {
        let mut store = crate::lock_store(store);
        let result = apply(&mut store);
        store.stage_capture(result)?
    };
    let written = staged.write();
    crate::lock_store(store).settle_capture(written)
}

/// `capture_and_persist` for a capture already applied to the model.
#[cfg(test)]
pub(crate) fn persist_capture(
    store: &std::sync::Mutex<Store>,
    result: CaptureResult,
) -> Result<CaptureOutcome, String> {
    capture_and_persist(store, |_| result)
}

/// A capture applied to the model, its layer serialized and waiting to be
/// written with the store lock released.
pub(crate) struct StagedCapture {
    layer: DeletedLayer,
    write: LayerWrite,
    outcome: CaptureOutcome,
    dropped: Vec<ClipItem>,
    undo: CaptureUndo,
}

/// A staged capture after its write was tried, waiting to be settled under
/// the lock: which layer, under which ticket, and how it went.
pub(crate) struct WrittenCapture {
    layer: DeletedLayer,
    path: PathBuf,
    ticket: u64,
    result: Result<(), String>,
    outcome: CaptureOutcome,
    dropped: Vec<ClipItem>,
    undo: CaptureUndo,
}

impl StagedCapture {
    /// The write itself — the expensive part, with the store lock released.
    pub(crate) fn write(self) -> WrittenCapture {
        let StagedCapture {
            layer,
            write,
            outcome,
            dropped,
            undo,
        } = self;
        let (path, ticket) = (write.path.clone(), write.ticket);
        WrittenCapture {
            result: write.commit(),
            layer,
            path,
            ticket,
            outcome,
            dropped,
            undo,
        }
    }
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join(IMAGES_DIR));
        let (history, history_metadata_loaded): (Vec<ClipItem>, bool) =
            load_json_with_status(&dir.join(HISTORY_FILE));
        let (pinned, pinned_metadata_loaded): (Vec<ClipItem>, bool) =
            load_json_with_status(&dir.join(PINNED_FILE));
        let (mut settings, settings_loaded): (Settings, bool) =
            load_json_with_status(&dir.join(SETTINGS_FILE));
        if !settings_loaded {
            settings.capture_enabled = false;
            settings.settings_recovered = true;
            // A file that existed means the welcome already ran; reopening it
            // would put its «أبقِه يعمل» ahead of the review this calls for.
            settings.first_run_shown = true;
        }
        let pending_delete: Option<PendingDelete> = load_journal(&dir.join(PENDING_DELETE_FILE));
        let pending_pin: Option<PendingPin> = load_journal(&dir.join(PENDING_PIN_FILE));
        let unreadable_shelf = !(history_metadata_loaded && pinned_metadata_loaded);
        let unreadable_settings = settings.settings_recovered;
        let mut store = Self {
            dir,
            history,
            pinned,
            settings,
            unreadable_layer: unreadable_shelf || !settings_loaded,
            unreadable_shelf,
            unreadable_settings,
            pending_delete,
            pending_pin,
            dirty_signals: DirtySignals::default(),
            unpin_removal: None,
        };

        // 005: before anything reads, sends or deletes a file a row names.
        if disarm_image_names(&mut store.history) {
            store.save_history();
        }
        if disarm_image_names(&mut store.pinned) {
            store.save_pinned();
        }
        if let Some(pending) = store.pending_delete.as_mut() {
            disarm_image_names(std::slice::from_mut(&mut pending.item));
        }
        if let Some(pending) = store.pending_pin.as_mut() {
            disarm_image_names(std::slice::from_mut(&mut pending.item));
            disarm_image_names(&mut pending.dropped);
        }

        store.resolve_interrupted_pin();
        // A toast cannot survive a process restart, so a journal from the
        // previous process is resolved immediately. Transaction ordering makes
        // this safe in both crash windows, judged on the layers as decoded:
        // - item in a layer => delete never committed; preserve its files
        // - item in neither => deletion committed; clean up its files
        // A layer that could not be decoded reads as empty, so its rows count
        // as absent and the deletion is completed, files and all — although
        // the recovery copy kept of that layer still names them. That is
        // deliberate (ت٤٦(د)): the user asked for this item to go, and a
        // recovery copy is not a reason to keep its files.
        store.resolve_interrupted_delete();
        // Before anything is shown: the age limit has no capture to ride on.
        store.trim_history();
        // Before anything compares fingerprints, and written down so the next
        // launch finds nothing left to migrate.
        let images_dir = store.images_dir();
        if migrate_image_hashes(&mut store.history, &images_dir) {
            store.save_history();
        }
        if migrate_image_hashes(&mut store.pinned, &images_dir) {
            store.save_pinned();
        }
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
    pub fn update_settings_persisted(&mut self, mut settings: Settings) -> Result<(), String> {
        self.try_finish_pending_pin()?;
        // The store owns the recovery marker, whatever the caller sent: turning
        // capture on is the confirmation it was waiting for; any other change
        // is saved with the marker still on.
        settings.settings_recovered = self.settings.settings_recovered && !settings.capture_enabled;
        let old_settings = self.settings.clone();
        let old_history = self.history.clone();
        self.settings = settings;
        let dropped = self.prune_history();

        let writes = try_save_json(&self.dir.join(SETTINGS_FILE), &self.settings)
            .and_then(|_| try_save_json(&self.dir.join(HISTORY_FILE), &self.history));
        if let Err(err) = writes {
            self.settings = old_settings;
            self.history = old_history;
            save_json(&self.dir.join(SETTINGS_FILE), &self.settings);
            save_json(&self.dir.join(HISTORY_FILE), &self.history);
            return Err(err);
        }
        self.unreadable_settings = self.settings.settings_recovered;
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

    /// Two images are the same only when their fingerprints are. An image's
    /// text is a label every picture of that size shares («صورة 100×100»), so
    /// letting it decide merged a row with no fingerprint into whatever image
    /// of the same size came next — replacing a pinned picture with another.
    fn same_content(a: &ClipItem, kind: ItemKind, text: &str, hash: Option<&str>) -> bool {
        if a.kind != kind {
            return false;
        }
        match (a.hash.as_deref(), hash) {
            (Some(h1), Some(h2)) => h1 == h2,
            _ if kind == ItemKind::Image => false,
            _ => a.text == text,
        }
    }

    /// The next place on the timeline: now, or one past the newest row, so
    /// recency stays a strict total order even when several changes land
    /// inside the same millisecond. This also makes Undo's chronological
    /// restoration deterministic.
    fn next_stamp(&self) -> u64 {
        self.pinned
            .iter()
            .chain(self.history.iter())
            .map(|item| item.created_at)
            .max()
            .map_or_else(now_ms, |latest| now_ms().max(latest.saturating_add(1)))
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
            return CaptureResult::failed();
        }
        let now = self.next_stamp();
        let learning = self.settings.learning_enabled;

        if let Some(p) = self
            .pinned
            .iter_mut()
            .find(|i| Self::same_content(i, kind, &text, hash.as_deref()))
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
                undo: CaptureUndo::PinnedBumped(Bump {
                    previous,
                    counted: learning,
                    used_at: learning.then_some(now),
                }),
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
                undo: CaptureUndo::HistoryBumped(Bump {
                    previous,
                    counted: learning,
                    used_at: Some(now),
                }),
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
            label: None,
        };
        let id = item.id.clone();
        self.history.insert(0, item);
        CaptureResult {
            outcome: CaptureOutcome::Added,
            dropped: self.prune_history(),
            layer: Some(DeletedLayer::History),
            undo: CaptureUndo::Added { id },
        }
    }

    /// The one place the retention policy lives.
    ///
    /// Three limits answering three different questions: the count is a
    /// resource cap, the byte budget is what makes the worst case a number,
    /// and the age is the privacy promise. Pinned rows are outside all three,
    /// on purpose. Dropped rows come back to the caller so their image files
    /// are deleted only once the layer write has committed.
    ///
    /// A single row heavier than the whole budget is kept: it already cleared
    /// the per-item cap in `read_clip`, and dropping it the instant it arrived
    /// would look exactly like capture quietly not working.
    fn prune_history(&mut self) -> Vec<ClipItem> {
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
        let mut dropped = self.history.split_off(keep);

        if let Some(oldest_allowed) = self.oldest_allowed_ms() {
            // Partitioned rather than truncated: recency order is maintained,
            // but the promise must not depend on it holding.
            let mut kept = Vec::with_capacity(self.history.len());
            for item in self.history.drain(..) {
                if item.created_at >= oldest_allowed {
                    kept.push(item);
                } else {
                    dropped.push(item);
                }
            }
            self.history = kept;
        }
        dropped
    }

    /// The oldest `created_at` still covered, or `None` when the user keeps
    /// things until a count or size limit says otherwise.
    fn oldest_allowed_ms(&self) -> Option<u64> {
        let days = u64::from(self.settings.retention_days);
        if days == 0 {
            return None;
        }
        Some(now_ms().saturating_sub(days * 24 * 60 * 60 * 1000))
    }

    /// Serializes the layer a capture touched, without writing it.
    ///
    /// The bytes leave with a ticket so the caller can write them after the
    /// store lock is released — the write is tens of megabytes at the allowed
    /// limit, and the main thread takes this same lock every time the panel is
    /// opened or dragged.
    pub(crate) fn stage_capture(&mut self, result: CaptureResult) -> Result<StagedCapture, String> {
        if result.outcome == CaptureOutcome::Failed {
            return Err("لم يُلتقط شيء".into());
        }
        let layer = result
            .layer
            .ok_or_else(|| "تعذّر تحديد طبقة الالتقاط".to_string())?;
        let write = match layer {
            DeletedLayer::Pinned => stage_json(&self.dir.join(PINNED_FILE), &self.pinned),
            DeletedLayer::History => stage_json(&self.dir.join(HISTORY_FILE), &self.history),
        }?;
        Ok(StagedCapture {
            layer,
            write,
            outcome: result.outcome,
            dropped: result.dropped,
            undo: result.undo,
        })
    }

    /// Settles a capture once its write has been tried, under the lock again.
    ///
    /// A write that failed is not the end of it. The lock was free while it
    /// ran, so something else may have changed the layers meanwhile — an
    /// unpin, a delete — and written them:
    /// - If a later write of the same layer has landed, it was serialized from
    ///   a model that already held this capture (`capture_and_persist` applies
    ///   and stages under one hold of the lock), so the capture is on disk and
    ///   stands, exactly as if its own write had worked.
    /// - Otherwise it is taken back by identity (`rollback_capture`), without
    ///   touching any row but its own. A pin journaled meanwhile was decided
    ///   with the capture still holding a place; it is decided again without
    ///   it (`reweigh_pending_pin`), so the rows that go are the ones the
    ///   policy picks. A later write that was staged but has not
    ///   landed may still carry the capture, so the layer is then written
    ///   again from the model to outrank that write — best effort: on a disk
    ///   still failing, this write fails as well, and the next good write
    ///   settles it.
    /// - A capture whose row moved to the other layer meanwhile (pinned while
    ///   its write was in flight, the pin's own layer writes deferred to its
    ///   journal) stays where the user put it, and so do its files: `Ok`.
    pub(crate) fn settle_capture(
        &mut self,
        written: WrittenCapture,
    ) -> Result<CaptureOutcome, String> {
        let WrittenCapture {
            layer,
            path,
            ticket,
            result,
            outcome,
            dropped,
            undo,
        } = written;
        if let Err(err) = result {
            if !written_since(&path, ticket) {
                let stands_elsewhere = self.rollback_capture(undo, dropped);
                // Only a capture into history held a place a pin could count.
                if layer == DeletedLayer::History {
                    self.reweigh_pending_pin();
                }
                if staged_since(&path, ticket) {
                    self.rewrite_layer(layer);
                }
                return if stands_elsewhere {
                    Ok(outcome)
                } else {
                    Err(err)
                };
            }
            eprintln!("raff: a capture write failed ({err}); a later write already holds it");
        }
        // Only now are these rows certainly gone from the layer on disk.
        for item in &dropped {
            self.delete_files(item);
        }
        Ok(outcome)
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

    /// Counts one use of `id` — a silent learning signal — and marks its layer
    /// for the coalesced flush. False when nothing was counted: learning is
    /// off, or the row is gone.
    pub(crate) fn count_use(&mut self, id: &str, usage: Usage) -> bool {
        if !self.settings.learning_enabled {
            return false;
        }
        let Some(item) = self.find_mut(id) else {
            return false;
        };
        match usage {
            Usage::Paste => item.paste_count += 1,
            Usage::Copy => item.copy_count += 1,
        }
        // Never back in time, even within one millisecond: a use after a
        // re-copy must read as after it (`Bump::take_back` relies on it).
        item.last_used_at = now_ms().max(item.last_used_at.saturating_add(1));
        let pinned = item.is_pinned;
        self.mark_signals_dirty(pinned);
        true
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

    /// Puts back what `capture` changed, from its undo record, finding its own
    /// row by id and touching no other. The rows it pushed off come back if
    /// they are still missing (its write never landed, so they are on disk).
    ///
    /// Returns whether the capture's row stands in the other layer instead:
    /// moved there meanwhile (pinned or unpinned while the write was in
    /// flight), it is left where the user put it.
    fn rollback_capture(&mut self, undo: CaptureUndo, dropped: Vec<ClipItem>) -> bool {
        let stands_elsewhere = match undo {
            CaptureUndo::Nothing => false,
            CaptureUndo::Added { id } => {
                self.history.retain(|item| item.id != id);
                self.pinned.iter().any(|item| item.id == id)
            }
            CaptureUndo::PinnedBumped(bump) => {
                let id = bump.previous.id.clone();
                match self.pinned.iter_mut().find(|item| item.id == id) {
                    Some(row) => {
                        bump.take_back(row);
                        false
                    }
                    None => self.history.iter().any(|item| item.id == id),
                }
            }
            CaptureUndo::HistoryBumped(bump) => {
                let id = bump.previous.id.clone();
                match self.history.iter().position(|item| item.id == id) {
                    Some(at) => {
                        let mut row = self.history.remove(at);
                        bump.take_back(&mut row);
                        self.insert_by_recency(row);
                        false
                    }
                    None => self.pinned.iter().any(|item| item.id == id),
                }
            }
        };
        for item in dropped {
            if self.find(&item.id).is_none() {
                self.insert_by_recency(item);
            }
        }
        stands_elsewhere
    }

    /// A pin journaled while a capture's write was in flight was decided on a
    /// model that held the capture: it held a place, and it may have pushed
    /// off the oldest row an unpinned one is weighed against. Once the capture
    /// is taken back, the rows the journal let go come back if still missing —
    /// all but an unpinned row history did not take back — and the journal is
    /// carried out again on history as it now stands (`carry_out_pin`): that
    /// row is weighed again, one taken back stays, and the policy picks what
    /// goes. Its rows' files only go when it completes.
    ///
    /// If that changes nothing, nothing is written. The corrected journal is
    /// written best effort: if it cannot be, memory stays corrected all the
    /// same, because a restart decides again on the layers it reads
    /// (`try_finish_pending_pin`) and reaches this result, not the stale one.
    fn reweigh_pending_pin(&mut self) {
        let Some(mut pending) = self.pending_pin.clone() else {
            return;
        };
        let history = self.history.clone();
        for item in &pending.dropped {
            if item.id != pending.item.id && self.find(&item.id).is_none() {
                self.insert_by_recency(item.clone());
            }
        }
        let dropped = self.carry_out_pin(&pending);
        let ids = |rows: &[ClipItem]| {
            rows.iter()
                .map(|item| item.id.clone())
                .collect::<std::collections::BTreeSet<_>>()
        };
        if ids(&dropped) == ids(&pending.dropped) {
            self.history = history;
            return;
        }
        pending.dropped = dropped;
        self.pending_pin = Some(pending);
        if let Err(err) = self.try_save_pending_pin() {
            eprintln!(
                "raff: could not correct the pin journal ({err}); a restart decides it again"
            );
        }
    }

    /// Puts a history row where its timestamp says it belongs.
    fn insert_by_recency(&mut self, item: ClipItem) {
        let at = self
            .history
            .iter()
            .position(|other| other.created_at < item.created_at)
            .unwrap_or(self.history.len());
        self.history.insert(at, item);
    }

    /// Writes a layer again from the model, best effort.
    fn rewrite_layer(&self, layer: DeletedLayer) {
        let result = match layer {
            DeletedLayer::Pinned => try_save_json(&self.dir.join(PINNED_FILE), &self.pinned),
            DeletedLayer::History => try_save_json(&self.dir.join(HISTORY_FILE), &self.history),
        };
        if let Err(err) = result {
            eprintln!("raff: {err}");
        }
    }

    fn delete_files(&self, item: &ClipItem) {
        self.delete_files_except(item, None);
    }

    /// Deletes `item`'s image files, sparing any that `keep` names — and any
    /// that another saved row still names, in either layer or in a journal.
    /// Two rows can come to name one file: a pinned picture whose own file
    /// was gone takes its copy's, and a stop before the copy's row is written
    /// away leaves both (ت٤٦). Every deletion of an image comes here, so a
    /// file goes only with the last row that names it.
    fn delete_files_except(&self, item: &ClipItem, keep: Option<&ClipItem>) {
        let images = self.images_dir();
        let names = |row: &ClipItem, f: &String| {
            row.image_file.as_ref() == Some(f) || row.thumb_file.as_ref() == Some(f)
        };
        for f in [&item.image_file, &item.thumb_file].into_iter().flatten() {
            let shared = keep.is_some_and(|keep| names(keep, f))
                || self
                    .saved_rows()
                    .any(|row| row.id != item.id && names(row, f));
            if let (false, Some(path)) = (shared, image_path(&images, f)) {
                if fs::remove_file(path).is_ok() {
                    stop::point();
                }
            }
        }
    }

    /// Every row the store still holds on to: both layers, and the rows its
    /// journals carry.
    fn saved_rows(&self) -> impl Iterator<Item = &ClipItem> {
        self.history
            .iter()
            .chain(&self.pinned)
            .chain(self.pending_delete.iter().map(|pending| &pending.item))
            .chain(
                self.pending_pin
                    .iter()
                    .flat_map(|pending| std::iter::once(&pending.item).chain(&pending.dropped)),
            )
    }

    fn try_save_pending_delete(&self) -> Result<(), String> {
        if self.pending_delete.is_some() {
            try_save_json(&self.dir.join(PENDING_DELETE_FILE), &self.pending_delete)
        } else {
            match fs::remove_file(self.dir.join(PENDING_DELETE_FILE)) {
                Ok(()) => {
                    stop::point();
                    Ok(())
                }
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
                Ok(()) => {
                    stop::point();
                    Ok(())
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(err) => Err(format!("تعذّر إغلاق سجل التثبيت المؤقت: {err}")),
            }
        }
    }

    /// Puts the journal's row where its move takes it on the layers as they
    /// now stand, and returns what history lets go because of it.
    ///
    /// A row already where the move takes it stays as it is, with whatever it
    /// went through since. An unpinned row already back in history is not
    /// weighed again: its return was decided, and the history it would now be
    /// weighed against is the one its return already trimmed.
    fn carry_out_pin(&mut self, pending: &PendingPin) -> Vec<ClipItem> {
        let id = pending.item.id.as_str();
        if pending.desired {
            self.history.retain(|item| item.id != id);
            if !self.pinned.iter().any(|item| item.id == id) {
                let mut item = pending.item.clone();
                item.is_pinned = true;
                let order = item.pinned_order.unwrap_or(u32::MAX);
                let at = self
                    .pinned
                    .iter()
                    .position(|candidate| candidate.pinned_order.unwrap_or(u32::MAX) > order)
                    .unwrap_or(self.pinned.len());
                self.pinned.insert(at, item);
            }
            return self.prune_history();
        }
        self.pinned.retain(|item| item.id != id);
        if self.history.iter().any(|item| item.id == id) {
            return self.prune_history();
        }
        let mut item = pending.item.clone();
        item.is_pinned = false;
        item.pinned_order = None;
        // A name belongs to the shelf (IMP-07): history rows have none.
        item.label = None;
        self.return_to_history(item)
    }

    /// Completes the pin journal on the layers as they now stand: the ones
    /// read at launch, or the ones in memory after a deferred write.
    ///
    /// The journal says which row moved and which way. Where it lands and
    /// what history lets go are decided again here (`carry_out_pin`), not read
    /// from the journal, whose choice was made on the model of its moment —
    /// one that may have held a copy that never reached the disk: its write
    /// failed, or the process stopped first. Carried out as written, such a
    /// choice deleted a newer row and its picture in place of the oldest
    /// (006). The journal's rows are kept for their files: those of the rows
    /// that are gone are deleted once both layers are written, and only those.
    fn try_finish_pending_pin(&mut self) -> Result<(), String> {
        let Some(mut pending) = self.pending_pin.clone() else {
            return Ok(());
        };
        for item in self.carry_out_pin(&pending) {
            if !pending.dropped.iter().any(|known| known.id == item.id) {
                pending.dropped.push(item);
            }
        }
        let written = try_save_json(&self.dir.join(HISTORY_FILE), &self.history)
            .and_then(|_| try_save_json(&self.dir.join(PINNED_FILE), &self.pinned));
        if let Err(err) = written {
            self.pending_pin = Some(pending);
            return Err(err);
        }
        self.pending_pin = None;
        if let Err(err) = self.try_save_pending_pin() {
            self.pending_pin = Some(pending);
            return Err(err);
        }
        self.delete_files_of_rows_gone(&pending.dropped);
        Ok(())
    }

    /// Deletes the files of those `rows` neither layer holds any more.
    fn delete_files_of_rows_gone(&self, rows: &[ClipItem]) {
        for item in rows {
            if self.find(&item.id).is_none() {
                self.delete_files(item);
            }
        }
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
        let settled = if item_is_live {
            self.finish_interrupted_fold(&pending)
        } else {
            self.delete_files(&pending.item);
            true
        };
        // Kept on disk when the fold could not be finished: the next launch
        // tries again. Never kept in memory — it names the live row.
        if settled {
            self.save_pending_delete();
        }
    }

    /// An undo that puts a pinned item back on its shelf, taking in a copy
    /// made meanwhile, writes the shelf first and then history without the
    /// copy (017). Stopped between the two, the copy is still in history,
    /// beside a pinned row that already carries its counts: it leaves now, as
    /// it would have (ت٤٦). Its files go only if nothing else names them, and
    /// whatever the restored row no longer names is collected as an orphan.
    ///
    /// Only that undo leaves this shape: a copy of a pinned row's content
    /// lands on the row itself, never beside it in history. Returns whether
    /// the receipt can go.
    fn finish_interrupted_fold(&mut self, pending: &PendingDelete) -> bool {
        let deleted = &pending.item;
        let (DeletedLayer::Pinned, Some(since)) = (pending.layer, pending.deleted_at) else {
            return true;
        };
        if !self.pinned.iter().any(|item| item.id == deleted.id) {
            return true;
        }
        let Some(index) = self.history.iter().position(|item| {
            item.created_at >= since
                && Self::same_content(item, deleted.kind, &deleted.text, deleted.hash.as_deref())
        }) else {
            return true;
        };
        let copy = self.history.remove(index);
        if let Err(err) = try_save_json(&self.dir.join(HISTORY_FILE), &self.history) {
            eprintln!("raff: {err}");
            self.history.insert(index, copy);
            return false;
        }
        self.delete_files(&copy);
        true
    }

    fn commit_any_pending_delete(&mut self) -> Result<(), String> {
        if let Some(pending) = self.pending_delete.take() {
            self.delete_files(&pending.item);
            self.try_save_pending_delete()?;
        }
        Ok(())
    }

    /// Applies the retention policy now and writes the result.
    ///
    /// The entry point for every prune that is not a capture: a shrunk limit,
    /// a shortened retention window, launch, and the hourly sweep. Time-based
    /// retention cannot ride on captures the way the count could — a sensitive
    /// copy followed by a fortnight away from the machine is precisely the
    /// case the promise was made for, and precisely the case with no capture
    /// to hang a prune on.
    ///
    /// Returns whether anything went, so the hourly sweep only tells the
    /// windows when there is something new to show.
    pub fn trim_history(&mut self) -> bool {
        let dropped = self.prune_history();
        if dropped.is_empty() {
            return false;
        }
        self.save_history();
        for item in &dropped {
            self.delete_files(item);
        }
        true
    }

    /// Adds a backup's items to the shelf (IMP-05), and answers how many were
    /// added and how many were there already.
    ///
    /// - Content in the history is pinned from there, through the pin's own
    ///   transaction: the shelf and the history never hold the same text
    ///   twice. Each such pin is durable as it lands; a later failure leaves
    ///   those pinned, and reports the failure.
    /// - Content already pinned is skipped; it takes the file's name only when
    ///   it has none.
    /// - Anything else goes at the end of the shelf with a new id, and a stamp
    ///   no later than now: a stamp from the future would lift every later
    ///   capture's past it (`next_stamp`) and keep them from retention.
    ///
    /// The rest is one write of the shelf; when it fails the shelf stays as
    /// it was after the pins from the history.
    pub fn import_pinned(
        &mut self,
        items: &[crate::backup::BackupItem],
    ) -> Result<(usize, usize), String> {
        self.try_finish_pending_pin()?;
        let now = now_ms();
        let name_of = |item: &crate::backup::BackupItem| {
            item.label
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(String::from)
        };
        let (mut added, mut skipped) = (0, 0);

        // From the history first, each through its own pin transaction.
        let mut named_from_history = Vec::new();
        let mut handled = vec![false; items.len()];
        for (index, item) in items.iter().enumerate() {
            let pinned_already = self
                .pinned
                .iter()
                .any(|pinned| Self::same_content(pinned, item.kind, &item.text, None));
            if pinned_already {
                continue;
            }
            let Some(id) = self
                .history
                .iter()
                .find(|row| Self::same_content(row, item.kind, &item.text, None))
                .map(|row| row.id.clone())
            else {
                continue;
            };
            self.set_pin_persisted(&id, true)?;
            named_from_history.push((id, name_of(item)));
            handled[index] = true;
            added += 1;
        }

        // The rest, and the names, in one write of the shelf.
        let previous = self.pinned.clone();
        let mut changed = false;
        let mut next_order = self
            .pinned
            .iter()
            .filter_map(|item| item.pinned_order)
            .max()
            .map_or(0, |order| order + 1);
        for (id, name) in named_from_history {
            if let (Some(name), Some(row)) = (name, self.pinned.iter_mut().find(|p| p.id == id)) {
                row.label = Some(name);
                changed = true;
            }
        }
        for (item, _) in items.iter().zip(&handled).filter(|(_, handled)| !**handled) {
            if let Some(pinned) = self
                .pinned
                .iter_mut()
                .find(|pinned| Self::same_content(pinned, item.kind, &item.text, None))
            {
                if pinned.label.is_none() {
                    if let Some(name) = name_of(item) {
                        pinned.label = Some(name);
                        changed = true;
                    }
                }
                skipped += 1;
                continue;
            }
            let stamp = item.created_at.min(now);
            self.pinned.push(ClipItem {
                id: uuid::Uuid::new_v4().to_string(),
                kind: item.kind,
                text: item.text.clone(),
                html: item.html.clone(),
                rtf: item.rtf.clone(),
                image_file: None,
                thumb_file: None,
                hash: None,
                source_app_bundle_id: String::new(),
                source_app: "نسخة احتياطية".into(),
                created_at: stamp,
                is_pinned: true,
                pinned_order: Some(next_order),
                copy_count: 0,
                paste_count: 0,
                last_used_at: stamp,
                label: name_of(item),
            });
            next_order += 1;
            added += 1;
            changed = true;
        }
        if changed {
            if let Err(err) = try_save_json(&self.dir.join(PINNED_FILE), &self.pinned) {
                self.pinned = previous;
                return Err(err);
            }
        }
        Ok((added, skipped))
    }

    /// Names a pinned item, or clears its name with `None` or blank text
    /// (IMP-07). Persisted before it answers; on a failed write the shelf
    /// stays as it was.
    pub fn set_label_persisted(&mut self, id: &str, label: Option<&str>) -> Result<(), String> {
        self.try_finish_pending_pin()?;
        let label = label.map(str::trim).filter(|l| !l.is_empty());
        if label.is_some_and(|l| l.chars().count() > LABEL_MAX_CHARS) {
            return Err(LABEL_TOO_LONG.into());
        }
        let Some(index) = self.pinned.iter().position(|item| item.id == id) else {
            return Err(LABEL_NOT_PINNED.into());
        };
        let previous = self.pinned[index].label.clone();
        self.pinned[index].label = label.map(str::to_string);
        if let Err(err) = try_save_json(&self.dir.join(PINNED_FILE), &self.pinned) {
            self.pinned[index].label = previous;
            return Err(err);
        }
        Ok(())
    }

    /// Rewrites the pinned shelf into exactly this order.
    ///
    /// `ids` has to be the pinned set exactly: same ids, none missing, none
    /// extra, none repeated. A caller working from a stale view would
    /// otherwise drop a row — or list one twice — while calling it a reorder,
    /// and the shelf is the one layer nothing ever prunes for the user.
    ///
    /// The whole layer is copied for the rollback. That is fine here and not
    /// in `capture`: pinning is a deliberate, rare act on a short list, not a
    /// cost paid on every copy the user makes.
    pub fn reorder_pinned_persisted(&mut self, ids: &[String]) -> Result<(), String> {
        self.try_finish_pending_pin()?;

        let mut seen = std::collections::HashSet::new();
        let matches_shelf = ids.len() == self.pinned.len()
            && ids.iter().all(|id| {
                seen.insert(id.as_str()) && self.pinned.iter().any(|item| item.id == *id)
            });
        if !matches_shelf {
            return Err("ترتيب المثبتات لا يطابق المحفوظ".into());
        }

        let previous = self.pinned.clone();
        let mut reordered = Vec::with_capacity(ids.len());
        for (order, id) in ids.iter().enumerate() {
            let position = self
                .pinned
                .iter()
                .position(|item| item.id == *id)
                .expect("checked above");
            let mut item = self.pinned.remove(position);
            item.pinned_order = Some(order as u32);
            reordered.push(item);
        }
        self.pinned = reordered;

        if let Err(err) = try_save_json(&self.dir.join(PINNED_FILE), &self.pinned) {
            self.pinned = previous;
            return Err(err);
        }
        Ok(())
    }

    /// Moves `id` to the other layer in memory, and returns the move as the
    /// pin journal records it: the row, which way, and what history let go.
    ///
    /// Pin puts the row at the end of the pinned shelf. Unpin returns it to
    /// history by its date (`return_to_history`) — or not at all, and then it
    /// is among the rows let go.
    fn move_pin(&mut self, id: &str) -> Option<PendingPin> {
        self.unpin_removal = None;
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
            self.pinned.push(item.clone());
            return Some(PendingPin {
                item,
                desired: true,
                dropped: self.prune_history(),
            });
        }
        let pos = self.pinned.iter().position(|i| i.id == id)?;
        let mut item = self.pinned.remove(pos);
        item.is_pinned = false;
        item.pinned_order = None;
        // A name belongs to the shelf (IMP-07): history rows have none.
        item.label = None;
        let dropped = self.return_to_history(item.clone());
        Some(PendingPin {
            item,
            desired: false,
            dropped,
        })
    }

    /// Why the last unpin did not take its row back, if it did not.
    pub fn unpin_removal(&self) -> Option<UnpinRemoval> {
        self.unpin_removal
    }

    /// `move_pin` without the record, for tests that set up a layer by hand.
    #[cfg(test)]
    pub fn toggle_pin(&mut self, id: &str) -> bool {
        self.move_pin(id).is_some()
    }

    /// Where an unpinned row goes (Sultan, 2026-10-21): back to the place
    /// its date gives it in history, with that date unchanged. A row older
    /// than the oldest one history holds is not taken back, even with room to
    /// spare; into an empty history it is. Then the whole retention policy
    /// applies, as to any row: a full history lets its oldest row go, and the
    /// age limit counts from the copy.
    ///
    /// A history row waiting in its delete's undo window still counts: the
    /// delete may yet be taken back, and a row removed for being older than
    /// what remained would then be lost for nothing. It only lowers the bar,
    /// though — it does not stand in for an empty history, which takes the
    /// row back.
    ///
    /// Returns what history lets go: the row itself when it is not taken
    /// back, and whatever `prune_history` drops.
    fn return_to_history(&mut self, item: ClipItem) -> Vec<ClipItem> {
        let waiting = self
            .pending_delete
            .as_ref()
            .filter(|pending| pending.layer == DeletedLayer::History)
            .map(|pending| pending.item.created_at);
        let oldest = self
            .history
            .iter()
            .map(|other| other.created_at)
            .min()
            .map(|oldest| waiting.map_or(oldest, |waiting| oldest.min(waiting)));
        // Past the retention period, the age limit is what lets it go — in
        // an empty history as well, and ahead of it being older than all of
        // it: that is the reason the panel gives (ت٢٩).
        let past_retention = self
            .oldest_allowed_ms()
            .is_some_and(|oldest_allowed| item.created_at < oldest_allowed);
        if oldest.is_some_and(|oldest| item.created_at < oldest) {
            self.unpin_removal = Some(if past_retention {
                UnpinRemoval::Retention
            } else {
                UnpinRemoval::OlderThanHistory
            });
            let mut dropped = self.prune_history();
            dropped.push(item);
            return dropped;
        }
        // Ahead of a row with the same date: that row is not newer, and a
        // full history lets the last one go.
        let at = self
            .history
            .iter()
            .position(|other| other.created_at <= item.created_at)
            .unwrap_or(self.history.len());
        let id = item.id.clone();
        self.history.insert(at, item);
        let dropped = self.prune_history();
        if dropped.iter().any(|gone| gone.id == id) {
            self.unpin_removal = Some(if past_retention {
                UnpinRemoval::Retention
            } else {
                UnpinRemoval::Limit
            });
        }
        dropped
    }

    /// Moves an item between the two persisted layers without ever reporting
    /// success for an in-memory-only change. The destination is written first
    /// (a crash can at worst leave a recoverable duplicate, never lose the
    /// item); any write failure restores both vectors and best-effort rewrites
    /// their previous durable snapshots before returning an error to the UI.
    /// An unpinned row goes where `return_to_history` says; when that is
    /// nowhere, the unpin still succeeds, and the row and its files are gone
    /// once both layers are written.
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
        let Some(pending) = self.move_pin(id) else {
            return Err("تعذّر تغيير حالة التثبيت".into());
        };

        // From here on every early return puts both layers back first.
        self.pending_pin = Some(pending);
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
            self.delete_files_of_rows_gone(&pending.dropped);
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
            deleted_at: Some(now_ms()),
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

    /// The token of the delete still waiting on its undo window, if any.
    pub fn pending_delete_token(&self) -> Option<String> {
        self.pending_delete.as_ref().map(|p| p.token.clone())
    }

    /// Restores the one pending receipt according to its saved chronological
    /// or pinned order, so capture de-duplication and concurrent pin mutations
    /// cannot make a numeric index or neighbor position stale. Answers the id
    /// of the row that stands for the item now: its own, or the newer copy's
    /// a history item was folded into (ت٤٥ ب٦).
    pub fn undo_delete(&mut self, token: &str) -> Result<String, String> {
        // A pin still being written is finished first: the undo may take a
        // row out of the shelf, and an unfinished pin journal would put it
        // back afterwards — two of one item.
        self.try_finish_pending_pin()?;
        let Some(pending) = self.pending_delete.as_ref() else {
            return Err(UNDO_EXPIRED.into());
        };
        if pending.token != token || self.find(&pending.item.id).is_some() {
            return Err(UNDO_EXPIRED.into());
        }
        let pending = pending.clone();
        let deleted = &pending.item;

        // 017: the same content copied again inside the undo window is a row
        // of its own now, dated from the delete on (a re-copy bumps the row
        // it lands on). A duplicate already there before — two rows can
        // predate fingerprints — is not that copy. Bringing the deleted row
        // back beside the copy would make two of one; the undo folds them
        // instead, as a re-copy would. A journal from before the delete time
        // was recorded falls back to "newer than the deleted row".
        let since = pending
            .deleted_at
            .unwrap_or_else(|| deleted.created_at.saturating_add(1));
        let is_copy = |i: &ClipItem| {
            i.created_at >= since
                && Self::same_content(i, deleted.kind, &deleted.text, deleted.hash.as_deref())
        };
        let twin = self
            .history
            .iter()
            .position(is_copy)
            .map(|index| (DeletedLayer::History, index))
            .or_else(|| {
                self.pinned
                    .iter()
                    .position(is_copy)
                    .map(|index| (DeletedLayer::Pinned, index))
            });

        // Only the layers a branch changes are kept for the rollback: history
        // can weigh tens of megabytes, under the lock the main thread takes.
        // With a copy, its layer changes (the row folded into, or the copy
        // taken out), and a pinned item's shelf; without one, the item's own.
        let changes = |layer: DeletedLayer| match twin {
            Some((twin_layer, _)) => {
                twin_layer == layer
                    || (pending.layer == DeletedLayer::Pinned && layer == DeletedLayer::Pinned)
            }
            None => pending.layer == layer,
        };
        // A history item folded into its newer copy is that copy from now on;
        // anything else comes back as itself.
        let standing = match (pending.layer, twin) {
            (DeletedLayer::History, Some((DeletedLayer::History, index))) => {
                self.history[index].id.clone()
            }
            (DeletedLayer::History, Some((DeletedLayer::Pinned, index))) => {
                self.pinned[index].id.clone()
            }
            _ => deleted.id.clone(),
        };
        let history_before = changes(DeletedLayer::History).then(|| self.history.clone());
        let pinned_before = changes(DeletedLayer::Pinned).then(|| self.pinned.clone());
        let rollback = |store: &mut Self| {
            if let Some(history) = &history_before {
                store.history.clone_from(history);
            }
            if let Some(pinned) = &pinned_before {
                store.pinned.clone_from(pinned);
            }
        };

        let written = match (pending.layer, twin) {
            // A pinned item keeps its pin: it comes back to its place on the
            // shelf, taking in the copy made meanwhile, which leaves its layer.
            (DeletedLayer::Pinned, Some((twin_layer, index))) => {
                let copy = match twin_layer {
                    DeletedLayer::History => self.history.remove(index),
                    DeletedLayer::Pinned => self.pinned.remove(index),
                };
                let mut item = deleted.clone();
                take_in_copy(&mut item, &copy);
                // Its own picture is the one kept — unless its file is gone,
                // when the copy's healthy one is all there is.
                let images = self.images_dir();
                let has_file = item
                    .image_file
                    .as_deref()
                    .and_then(|file| image_path(&images, file))
                    .is_some_and(|path| path.exists());
                if item.kind == ItemKind::Image && !has_file && copy.image_file.is_some() {
                    item.image_file.clone_from(&copy.image_file);
                    item.thumb_file.clone_from(&copy.thumb_file);
                }
                let at = Self::restore_index(&self.pinned, &pending);
                self.pinned.insert(at, item.clone());
                // Whatever the restored row no longer names goes: the copy's
                // files, and the deleted row's own when it took the copy's.
                let retire = |store: &Self| {
                    store.delete_files_except(&copy, Some(&item));
                    store.delete_files_except(deleted, Some(&item));
                };
                // The shelf first: a stop between the writes leaves a duplicate
                // in history, never the item gone with its files.
                match try_save_json(&self.dir.join(PINNED_FILE), &self.pinned) {
                    Err(err) => Err(err),
                    Ok(()) if twin_layer == DeletedLayer::Pinned => {
                        retire(self);
                        Ok(())
                    }
                    Ok(()) => match try_save_json(&self.dir.join(HISTORY_FILE), &self.history) {
                        Ok(()) => {
                            retire(self);
                            Ok(())
                        }
                        Err(err) => {
                            // The shelf already landed: put it back as the
                            // rolled-back memory has it, or the disk would
                            // name this item while memory does not.
                            rollback(self);
                            self.rewrite_layer(DeletedLayer::Pinned);
                            return Err(err);
                        }
                    },
                }
            }
            // A history item is already back, as the newer copy: that row
            // stays where the copy put it and carries both counts.
            (DeletedLayer::History, Some((twin_layer, index))) => {
                let survivor = match twin_layer {
                    DeletedLayer::History => &mut self.history[index],
                    DeletedLayer::Pinned => &mut self.pinned[index],
                };
                fold_counts(survivor, deleted);
                let survivor = survivor.clone();
                let file = match twin_layer {
                    DeletedLayer::History => {
                        try_save_json(&self.dir.join(HISTORY_FILE), &self.history)
                    }
                    DeletedLayer::Pinned => {
                        try_save_json(&self.dir.join(PINNED_FILE), &self.pinned)
                    }
                };
                file.map(|()| self.delete_files_except(deleted, Some(&survivor)))
            }
            (DeletedLayer::Pinned, None) => {
                let at = Self::restore_index(&self.pinned, &pending);
                self.pinned.insert(at, deleted.clone());
                try_save_json(&self.dir.join(PINNED_FILE), &self.pinned)
            }
            // Back to its place in history, which may have filled meanwhile:
            // the same limits as any copy, so the oldest leaves. If that is
            // the item itself, it cannot come back, and the panel says why —
            // its age, or a history with no room left.
            (DeletedLayer::History, None) => {
                let at = Self::restore_index(&self.history, &pending);
                self.history.insert(at, deleted.clone());
                let dropped = self.prune_history();
                if dropped.iter().any(|item| item.id == deleted.id) {
                    let expired = self
                        .oldest_allowed_ms()
                        .is_some_and(|oldest| deleted.created_at < oldest);
                    rollback(self);
                    self.pending_delete = None;
                    self.save_pending_delete();
                    self.delete_files(deleted);
                    return Err(if expired {
                        UNDO_RETENTION
                    } else {
                        UNDO_NO_ROOM
                    }
                    .into());
                }
                let saved = try_save_json(&self.dir.join(HISTORY_FILE), &self.history);
                if saved.is_ok() {
                    for item in &dropped {
                        self.delete_files(item);
                    }
                }
                saved
            }
        };
        // Persisted before the journal goes: if the process stops between
        // these writes, load() sees the live item and retires the receipt.
        if let Err(err) = written {
            rollback(self);
            return Err(err);
        }

        // Removing the journal is the transaction's final commit point. A
        // failed removal does not invalidate the restore: restart recovery
        // sees the live item and retires the stale receipt without deleting.
        self.pending_delete = None;
        self.save_pending_delete();
        Ok(standing)
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

    thread_local! {
        static SYNCED_WRITES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// Counts flushed writes on the calling thread, so parallel tests do not
    /// see each other's.
    pub(super) fn note_sync() {
        SYNCED_WRITES.with(|count| count.set(count.get() + 1));
    }

    fn synced_writes() -> usize {
        SYNCED_WRITES.with(std::cell::Cell::get)
    }

    #[test]
    fn the_settings_and_the_two_journals_are_the_durable_layers() {
        for file in [SETTINGS_FILE, PENDING_DELETE_FILE, PENDING_PIN_FILE] {
            assert!(is_durable_layer(&Path::new("/data").join(file)), "{file}");
        }
        for file in [
            HISTORY_FILE,
            PINNED_FILE,
            PANEL_PLACEMENT_FILE,
            "history.json.corrupt",
        ] {
            assert!(!is_durable_layer(&Path::new("/data").join(file)), "{file}");
        }
    }

    /// H3: what is flushed is exactly the settings and the journals — never
    /// the history every copy rewrites.
    #[test]
    fn settings_and_journals_are_flushed_and_a_capture_is_not() {
        let mut s = store();
        let before = synced_writes();

        capture_text(&mut s, "copied text");
        s.save_history();
        assert_eq!(
            synced_writes(),
            before,
            "a capture rewrites history without a flush"
        );

        let mut next = s.settings.clone();
        next.retention_days = 7;
        s.update_settings_persisted(next).unwrap();
        assert_eq!(
            synced_writes(),
            before + 1,
            "settings.json is flushed; the history beside it is not"
        );

        let id = s.history[0].id.clone();
        s.set_pin_persisted(&id, true).unwrap();
        assert_eq!(
            synced_writes(),
            before + 2,
            "the pin journal is flushed, the layers it moves between are not"
        );

        s.delete_reversible(&id).unwrap();
        assert_eq!(synced_writes(), before + 3, "so is the delete journal");

        let reloaded = Store::load(s.dir.clone());
        assert_eq!(reloaded.settings.retention_days, 7);
        assert!(reloaded.find(&id).is_none());
    }

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
    fn a_week_long_retention_sweeps_at_boot_with_no_capture_at_all() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let images = dir.join(IMAGES_DIR);
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("old.png"), b"old").unwrap();
        fs::write(images.join("old.thumb.png"), b"old thumb").unwrap();

        let day = 24 * 60 * 60 * 1000u64;
        let now = now_ms();
        let row = |id: &str, age_days: u64, image: &str| {
            format!(
                r#"{{"id":"{id}","type":"image","text":"صورة","imageFile":"{image}","thumbFile":"{image}.thumb.png","sourceAppBundleId":"com.test","sourceApp":"Test","createdAt":{},"isPinned":false,"copyCount":1,"pasteCount":0,"lastUsedAt":1}}"#,
                now - age_days * day
            )
        };
        fs::write(
            dir.join(HISTORY_FILE),
            format!(
                "[{},{}]",
                row("nine-days", 9, "old"),
                row("two-days", 2, "kept")
            ),
        )
        .unwrap();
        fs::write(
            dir.join(PINNED_FILE),
            format!(
                r#"[{{"id":"pinned","type":"text","text":"مثبّت","sourceAppBundleId":"com.test","sourceApp":"Test","createdAt":{},"isPinned":true,"pinnedOrder":0,"copyCount":1,"pasteCount":0,"lastUsedAt":1}}]"#,
                now - 30 * day
            ),
        )
        .unwrap();
        fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"hotkey":"shift+super+v","retentionDays":7}"#,
        )
        .unwrap();

        // Nothing is captured: `load` alone has to enforce the promise, or a
        // fortnight away from the machine keeps the very item it was made for.
        let store = Store::load(dir.clone());

        assert_eq!(
            store
                .history
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            vec!["two-days"],
            "past the window goes, inside it stays"
        );
        assert!(
            !images.join("old.png").exists(),
            "and its image goes with it"
        );
        assert!(!images.join("old.thumb.png").exists());
        assert_eq!(store.pinned.len(), 1, "a pinned item is outside the policy");

        // Written down, not just applied in memory.
        let reloaded = Store::load(dir);
        assert_eq!(reloaded.history.len(), 1);
    }

    #[test]
    fn no_retention_set_keeps_everything_the_count_allows() {
        let mut s = store();
        s.settings.retention_days = 0;
        capture_text(&mut s, "قديم");
        s.history[0].created_at = now_ms() - 400 * 24 * 60 * 60 * 1000;

        assert!(
            !s.trim_history(),
            "nothing went, so the sweep announces nothing"
        );

        assert_eq!(s.history.len(), 1, "0 means the age limit is not in play");
    }

    #[test]
    fn shrinking_limit_trims_immediately() {
        let mut s = store();
        for i in 0..5 {
            capture_text(&mut s, &format!("item {i}"));
        }
        s.settings.history_limit = 2;
        assert!(s.trim_history(), "rows went: the windows are told");
        assert_eq!(s.history.len(), 2);
        assert_eq!(s.history[0].text, "item 4");
        assert_eq!(s.history[1].text, "item 3");
    }

    fn pin_two(s: &mut Store) -> (String, String) {
        capture_text(s, "\u{0623}\u{0648}\u{0644}");
        let first = s.history[0].id.clone();
        capture_text(s, "\u{062b}\u{0627}\u{0646}");
        let second = s.history[0].id.clone();
        assert!(s.toggle_pin(&first));
        assert!(s.toggle_pin(&second));
        s.save_pinned();
        (first, second)
    }

    fn pinned_ids_in_order(s: &Store) -> Vec<String> {
        let mut pinned: Vec<&ClipItem> = s.pinned.iter().collect();
        pinned.sort_by_key(|item| item.pinned_order.unwrap_or(u32::MAX));
        pinned.iter().map(|item| item.id.clone()).collect()
    }

    #[test]
    fn a_reordered_pinned_shelf_is_still_in_that_order_after_a_restart() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        let (first, second) = pin_two(&mut s);
        assert_eq!(pinned_ids_in_order(&s), vec![first.clone(), second.clone()]);

        s.reorder_pinned_persisted(&[second.clone(), first.clone()])
            .unwrap();
        assert_eq!(pinned_ids_in_order(&s), vec![second.clone(), first.clone()]);
        drop(s);

        let reloaded = Store::load(dir);
        assert_eq!(
            pinned_ids_in_order(&reloaded),
            vec![second, first],
            "the arrangement is the user's, so it outlives the process"
        );
    }

    #[test]
    fn a_set_that_is_not_the_pinned_shelf_is_refused_and_changes_nothing() {
        let mut s = store();
        let (first, second) = pin_two(&mut s);
        let before = pinned_ids_in_order(&s);

        for wrong in [
            vec![first.clone()],                                // one short
            vec![first.clone(), second.clone(), first.clone()], // one too many
            vec![first.clone(), first.clone()],                 // right length, repeated
            vec![
                first.clone(),
                "\u{063a}\u{0631}\u{064a}\u{0628}".to_string(),
            ], // a stranger
        ] {
            assert!(
                s.reorder_pinned_persisted(&wrong).is_err(),
                "{wrong:?} is not the pinned shelf"
            );
            assert_eq!(pinned_ids_in_order(&s), before, "and nothing moved");
        }
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
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(&dir, 1, 0, &[("old", t)], &[("p", t + MINUTE)]);

        // What set_pin_persisted does up to the crash: the move in memory,
        // the journal, and only the destination layer on disk.
        let pending = s.move_pin("p").unwrap();
        assert_eq!(ids_of(&pending.dropped), ["old"]);
        s.pending_pin = Some(pending);
        s.try_save_pending_pin().unwrap();
        s.save_history();
        drop(s);

        let recovered = Store::load(dir.clone());
        assert_eq!(history_ids(&recovered), ["p"]);
        assert!(recovered.pinned.is_empty());
        assert_eq!(picture_files_exist(&dir, "old"), (false, false));
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert!(!dir.join(PENDING_PIN_FILE).exists());
    }

    fn layer_on_disk(s: &Store, file: &str) -> Vec<ClipItem> {
        serde_json::from_slice(&fs::read(s.dir.join(file)).unwrap()).unwrap()
    }

    fn history_ids(s: &Store) -> Vec<String> {
        s.history.iter().map(|item| item.id.clone()).collect()
    }

    fn ids_of(rows: &[ClipItem]) -> Vec<String> {
        rows.iter().map(|item| item.id.clone()).collect()
    }

    /// A row back in history is weighed by its date like any other from then
    /// on: no later settings change or sweep singles it out, and it goes
    /// when it is the oldest of a full history.
    #[test]
    fn an_unpinned_row_is_weighed_like_any_other_afterwards() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            3,
            0,
            &[("r3", t + 3 * MINUTE), ("r1", t)],
            &[("p", t + 2 * MINUTE)],
        );

        s.set_pin_persisted("p", false).unwrap();
        assert_eq!(history_ids(&s), ["r3", "p", "r1"], "room for all three");

        let mut settings = s.settings.clone();
        settings.learning_enabled = !settings.learning_enabled;
        s.update_settings_persisted(settings).unwrap();
        s.trim_history(); // what the hourly sweep runs
        assert_eq!(history_ids(&s), ["r3", "p", "r1"]);

        let store = std::sync::Mutex::new(s);
        for text in ["d", "e"] {
            let result = crate::lock_store(&store).capture(
                ItemKind::Text,
                text.into(),
                None,
                None,
                None,
                None,
                None,
                ("Notes".into(), "com.apple.Notes".into()),
            );
            persist_capture(&store, result).unwrap();
            let s = crate::lock_store(&store);
            let reloaded = Store::load(dir.clone());
            assert_eq!(history_ids(&reloaded), history_ids(&s), "after {text}");
        }
        let s = store.into_inner().unwrap();
        let texts: Vec<&str> = s.history.iter().map(|item| item.text.as_str()).collect();
        assert_eq!(
            texts,
            ["e", "d", "صورة r3"],
            "r1 went first, then p: each in its turn as the oldest"
        );
        assert_eq!(picture_files_exist(&dir, "p"), (false, false));
        assert_eq!(picture_files_exist(&dir, "r3"), (true, true));
    }

    #[test]
    fn a_pinned_row_copied_again_comes_back_as_the_newest() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            2,
            0,
            &[("h2", t + 2 * MINUTE), ("h1", t + MINUTE)],
            &[("p", t)],
        );
        let result = s.capture(
            ItemKind::Image,
            "صورة p".into(),
            None,
            None,
            None,
            None,
            Some(content_hash(b"p")),
            ("Preview".into(), "com.apple.Preview".into()),
        );
        assert_eq!(result.outcome, CaptureOutcome::Deduped);
        let copied_at = created_at(&s, "p").unwrap();
        assert!(copied_at > t + 2 * MINUTE, "a copy dates the row");

        s.set_pin_persisted("p", false).unwrap();

        assert_eq!(history_ids(&s), ["p", "h2"], "newest: on top, and h1 goes");
        assert_eq!(created_at(&s, "p"), Some(copied_at));
    }

    #[test]
    fn undoing_the_delete_of_an_unpinned_row_puts_it_back_in_its_place() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            3,
            0,
            &[("h2", t + 2 * MINUTE), ("h1", t)],
            &[("p", t + MINUTE)],
        );
        s.set_pin_persisted("p", false).unwrap();
        assert_eq!(history_ids(&s), ["h2", "p", "h1"]);

        let token = s.delete_reversible("p").unwrap();
        assert!(s.find("p").is_none());
        s.undo_delete(&token).unwrap();

        assert_eq!(history_ids(&s), ["h2", "p", "h1"], "exactly where it was");
        assert_eq!(created_at(&s, "p"), Some(t + MINUTE));
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["h2", "p", "h1"]);
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
    }

    #[test]
    fn a_refused_unpin_leaves_the_row_pinned_with_its_date_and_drops_nothing() {
        // Between the two, it would push h1 off; older than both, it would go
        // itself. Refused, neither happens.
        for p in [30, 10] {
            let dir = test_dir();
            let t = now_ms() - 60 * MINUTE;
            let mut s = shelf_on_disk(
                &dir,
                2,
                0,
                &[("h2", t + 40 * MINUTE), ("h1", t + 20 * MINUTE)],
                &[("p", t + p * MINUTE)],
            );
            let before = s.find("p").unwrap().clone();
            fs::create_dir(dir.join(PENDING_PIN_FILE)).unwrap();

            assert!(s.set_pin_persisted("p", false).is_err(), "p at {p}");

            let item = s.find("p").unwrap();
            assert!(item.is_pinned);
            assert_eq!(item.created_at, before.created_at);
            assert_eq!(history_ids(&s), ["h2", "h1"], "nothing made room for it");
            for name in ["p", "h1", "h2"] {
                assert_eq!(picture_files_exist(&dir, name), (true, true), "{name}");
            }
        }
    }

    /// The destination layer landed and the source did not: history already
    /// holds the row where its return put it, and it stays there — weighed
    /// again against the history it trimmed, it would be older than all of
    /// it and go.
    #[test]
    fn an_interrupted_unpin_keeps_the_place_its_return_was_given() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            2,
            0,
            &[("h2", t + 2 * MINUTE), ("h1", t)],
            &[("p", t + MINUTE)],
        );

        let pending = s.move_pin("p").unwrap();
        assert_eq!(history_ids(&s), ["h2", "p"]);
        s.pending_pin = Some(pending);
        s.try_save_pending_pin().unwrap();
        s.save_history();
        drop(s);

        let recovered = Store::load(dir.clone());
        assert_eq!(history_ids(&recovered), ["h2", "p"]);
        assert_eq!(created_at(&recovered, "p"), Some(t + MINUTE));
        assert!(recovered.pinned.is_empty());
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert_eq!(picture_files_exist(&dir, "h1"), (false, false));
        assert!(!dir.join(PENDING_PIN_FILE).exists());
    }

    /// A build of this branch once wrote a second date (`capturedAt`) on rows
    /// it unpinned. Such a row still loads, and the field is not written back.
    #[test]
    fn a_row_carrying_the_retired_captured_at_field_still_loads() {
        let dir = test_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"id":"old","type":"text","text":"من بناء سابق","sourceAppBundleId":"com.apple.Notes","sourceApp":"Notes","createdAt":5,"capturedAt":3,"isPinned":false,"copyCount":1,"pasteCount":0,"lastUsedAt":5}]"#,
        )
        .unwrap();

        let mut s = Store::load(dir.clone());
        assert!(!s.unreadable_shelf);
        assert_eq!(history_ids(&s), ["old"]);

        capture_text(&mut s, "نسخة جديدة");
        s.save_history();
        assert!(!fs::read_to_string(dir.join(HISTORY_FILE))
            .unwrap()
            .contains("capturedAt"));
    }

    #[test]
    fn unpinning_applies_the_whole_retention_policy_not_just_the_count() {
        let mut s = store();
        s.settings.retention_days = 7;
        capture_text(&mut s, "to pin and back");
        let id = s.history[0].id.clone();
        s.set_pin_persisted(&id, true).unwrap();
        capture_text(&mut s, "past the window");
        let expired = s.history[0].id.clone();
        s.find_mut(&expired).unwrap().created_at = now_ms() - 9 * 24 * 60 * 60 * 1000;

        s.set_pin_persisted(&id, false).unwrap();

        assert!(
            s.find(&expired).is_none(),
            "the age limit applies here as well"
        );
        assert!(!layer_on_disk(&s, HISTORY_FILE)
            .iter()
            .any(|item| item.id == expired));
        assert!(s.find(&id).is_some());
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
    fn a_recovery_copy_cut_inside_an_arabic_letter_still_keeps_its_images() {
        // A write cut short by a power loss can stop inside a two-byte
        // Arabic letter, so the copy set aside is not valid UTF-8 at all. The
        // image names in it are plain ASCII and must still count.
        for layer in [HISTORY_FILE, PINNED_FILE] {
            let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
            let images = dir.join(IMAGES_DIR);
            fs::create_dir_all(&images).unwrap();
            fs::write(images.join("kept.png"), b"kept").unwrap();
            fs::write(images.join("kept.thumb.png"), b"kept thumb").unwrap();
            let mut cut = r#"[{"type":"image","imageFile":"kept.png","thumbFile":"kept.thumb.png","text":"صورة مرحب"#
                .as_bytes()
                .to_vec();
            cut.push("ا".as_bytes()[0]);
            fs::write(dir.join(layer), &cut).unwrap();

            // First boot: the layer is set aside and collection is skipped.
            let mut store = Store::load(dir.clone());
            assert!(
                dir.join(layer).with_extension("json.corrupt").exists(),
                "{layer}: set aside"
            );

            // The ordinary save that heals the layer: a capture rewrites
            // history, and pinning it rewrites pinned as well.
            let result = store.capture(
                ItemKind::Text,
                "نصّ بعد الانقطاع".into(),
                None,
                None,
                None,
                None,
                None,
                ("Notes".into(), "com.apple.Notes".into()),
            );
            let store = std::sync::Mutex::new(store);
            persist_capture(&store, result).unwrap();
            let mut store = store.into_inner().unwrap();
            if layer == PINNED_FILE {
                let id = store.history[0].id.clone();
                store.set_pin_persisted(&id, true).unwrap();
            }
            drop(store);

            // Second boot: both layers parse, so orphan collection runs.
            let store = Store::load(dir.clone());
            assert!(!store.unreadable_shelf, "{layer}: healed by the save");
            for name in ["kept.png", "kept.thumb.png"] {
                assert!(
                    images.join(name).exists(),
                    "{layer}: {name} is named only by the recovery copy"
                );
            }

            // And it holds across a further save and reload.
            let mut store = store;
            let result = store.capture(
                ItemKind::Text,
                "نسخة أخرى".into(),
                None,
                None,
                None,
                None,
                None,
                ("Notes".into(), "com.apple.Notes".into()),
            );
            let store = std::sync::Mutex::new(store);
            persist_capture(&store, result).unwrap();
            drop(store);
            let _ = Store::load(dir.clone());
            assert_eq!(fs::read(images.join("kept.png")).unwrap(), b"kept");
            assert_eq!(
                fs::read(images.join("kept.thumb.png")).unwrap(),
                b"kept thumb"
            );
            let _ = fs::remove_dir_all(dir);
        }
    }

    fn set_aside_contents(dir: &Path) -> Vec<Vec<u8>> {
        let mut kept: Vec<Vec<u8>> = recovery_copies(&dir.join(HISTORY_FILE))
            .into_iter()
            .map(|(_, copy)| fs::read(copy).unwrap())
            .collect();
        kept.sort();
        kept
    }

    #[test]
    fn a_second_unreadable_history_does_not_replace_the_first_copy() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let images = dir.join(IMAGES_DIR);
        fs::create_dir_all(&images).unwrap();
        for name in ["first.png", "second.png", "orphan.png"] {
            fs::write(images.join(name), name).unwrap();
        }

        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"type":"image","imageFile":"first.png""#,
        )
        .unwrap();
        Store::load(dir.clone());
        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"type":"image","imageFile":"second.png""#,
        )
        .unwrap();
        Store::load(dir.clone());

        assert_eq!(
            set_aside_contents(&dir),
            [
                br#"[{"type":"image","imageFile":"first.png""#.to_vec(),
                br#"[{"type":"image","imageFile":"second.png""#.to_vec(),
            ],
            "both versions are kept"
        );
        assert_eq!(
            fs::read(dir.join("history.json.corrupt")).unwrap(),
            br#"[{"type":"image","imageFile":"second.png""#,
            "the newest stays where it always was"
        );

        // History heals; from here on collection runs, and has to count every
        // copy, not only the newest.
        fs::write(dir.join(HISTORY_FILE), "[]").unwrap();
        Store::load(dir.clone());
        assert!(
            images.join("first.png").exists(),
            "named only by the earlier copy"
        );
        assert!(
            images.join("second.png").exists(),
            "named only by the newest copy"
        );
        assert!(
            !images.join("orphan.png").exists(),
            "and collection did run"
        );
    }

    #[test]
    fn a_copy_that_cannot_be_written_moves_nothing() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(HISTORY_FILE), "{first").unwrap();
        Store::load(dir.clone());
        // Whatever stops the write — a full disk, here a directory in the way.
        fs::create_dir(dir.join("history.json.corrupt.tmp")).unwrap();
        fs::write(dir.join(HISTORY_FILE), "{second").unwrap();

        Store::load(dir.clone());

        assert_eq!(
            fs::read(dir.join("history.json.corrupt")).unwrap(),
            b"{first",
            "the newest slot still holds the earlier copy, not nothing"
        );
        assert_eq!(set_aside_contents(&dir), [b"{first".to_vec()]);
    }

    #[test]
    fn a_layer_that_stays_unreadable_is_set_aside_once() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(HISTORY_FILE), "{still not json").unwrap();

        for _ in 0..3 {
            Store::load(dir.clone());
        }

        assert_eq!(set_aside_contents(&dir), [b"{still not json".to_vec()]);
    }

    #[test]
    fn set_aside_copies_are_capped_and_the_oldest_go_first() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        for version in 0..MAX_RECOVERY_COPIES + 2 {
            fs::write(dir.join(HISTORY_FILE), format!("{{broken {version}")).unwrap();
            Store::load(dir.clone());
        }

        let kept = set_aside_contents(&dir);
        assert_eq!(kept.len(), MAX_RECOVERY_COPIES);
        assert!(
            !kept.contains(&b"{broken 0".to_vec()),
            "the oldest went first"
        );
        assert!(!kept.contains(&b"{broken 1".to_vec()));
        assert_eq!(
            fs::read(dir.join("history.json.corrupt")).unwrap(),
            format!("{{broken {}", MAX_RECOVERY_COPIES + 1).into_bytes()
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
        assert_eq!(
            s.history.len(),
            before_len,
            "the row it pushed off came back"
        );
        assert_eq!(s.history[0].id, before_head, "the new row is gone");
        assert_eq!(
            s.history[before_len - 1].id,
            before_tail,
            "and the tail is the one that was there"
        );
    }

    #[test]
    fn a_failed_capture_keeps_an_unpin_that_landed_meanwhile_and_its_picture() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        // Room for one more row, and p newer than both.
        let mut s = shelf_on_disk(
            &dir,
            3,
            0,
            &[("h2", t + MINUTE), ("h1", t)],
            &[("p", t + 2 * MINUTE)],
        );
        let blocker = dir.join("history.json.tmp");

        // The capture is applied and staged under the lock...
        let result = s.capture(
            ItemKind::Text,
            "نسخة جديدة".into(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        let captured = s.history[0].id.clone();
        let staged = s.stage_capture(result).unwrap();
        // ...its write fails: the disk refuses the temporary file for a moment...
        fs::create_dir(&blocker).unwrap();
        let written = staged.write();
        fs::remove_dir(&blocker).unwrap();
        // ...and before it is settled, p is unpinned. That unpin is written
        // from a model that already holds the capture.
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        assert!(
            s.settle_capture(written).is_ok(),
            "what is on disk already holds the capture"
        );
        assert_eq!(history_ids(&s), [captured.as_str(), "p", "h2"]);

        // Life goes on, then رفّ restarts.
        let next = s.capture(
            ItemKind::Text,
            "بعدها".into(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        let store = std::sync::Mutex::new(s);
        persist_capture(&store, next).unwrap();
        drop(store);
        let reloaded = Store::load(dir.clone());
        let back = reloaded
            .find("p")
            .expect("the unpinned picture survives the restart");
        assert!(!back.is_pinned);
        assert_eq!(back.created_at, t + 2 * MINUTE);
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
    }

    /// The copy and the unpin's layers both fail; the unpin's journal lands.
    /// Counting the copy, history's oldest row was h2 (the copy pushed h1
    /// off), and p, older than h2, was not taken back. The copy is taken back
    /// by its own row, touching no other; h1 is then the oldest again, so p
    /// comes back and pushes h1 off — not h2, the newer one.
    #[test]
    fn a_double_failure_evicts_the_row_the_policy_would_not_a_newer_one() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            2,
            0,
            &[("h2", t + 2 * MINUTE), ("h1", t)],
            &[("p", t + MINUTE)],
        );
        let blocker = dir.join("history.json.tmp");
        let written = a_copy_that_will_not_land(&mut s, &blocker);
        let captured = s.history[0].id.clone();
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));
        assert_eq!(
            history_ids(&s),
            [captured.as_str(), "h2"],
            "with the copy counted, p is older than all of history"
        );
        assert_eq!(ids_of(&s.pending_pin.as_ref().unwrap().dropped), ["p"]);

        assert!(s.settle_capture(written).is_err());

        assert!(s.find(&captured).is_none(), "the capture is taken back");
        assert_eq!(history_ids(&s), ["h2", "p"], "p is back, and h1 makes room");
        assert_eq!(
            ids_of(&s.pending_pin.as_ref().unwrap().dropped),
            ["h1"],
            "the journal says so before any file goes"
        );
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert_eq!(picture_files_exist(&dir, "h1"), (true, true), "not yet");

        // The disk recovers; رفّ restarts and completes the unpin.
        fs::remove_dir(&blocker).unwrap();
        drop(s);
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["h2", "p"]);
        assert!(reloaded.find(&captured).is_none());
        assert!(reloaded.pinned.is_empty());
        assert!(reloaded.pending_pin.is_none());
        assert_eq!(
            picture_files_exist(&dir, "h2"),
            (true, true),
            "h2 keeps both files"
        );
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert_eq!(
            picture_files_exist(&dir, "h1"),
            (false, false),
            "h1, the oldest, goes as the policy says"
        );
    }

    /// A failed re-copy of h1: it went to the top, h2 became the oldest row,
    /// and p, older than h2, was not taken back. Put back by identity, h1 is
    /// the oldest again — and p, newer than it, comes back.
    #[test]
    fn a_failed_recopy_puts_its_row_back_by_identity_around_an_unpin() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            3,
            0,
            &[("h2", t + 2 * MINUTE), ("h1", t)],
            &[("p", t + MINUTE)],
        );
        let blocker = dir.join("history.json.tmp");
        let before = s.find("h1").unwrap().clone();

        let result = s.capture(
            ItemKind::Image,
            "صورة h1".into(),
            None,
            None,
            None,
            None,
            Some(content_hash(b"h1")),
            ("Preview".into(), "com.apple.Preview".into()),
        );
        assert_eq!(result.outcome, CaptureOutcome::Deduped);
        let staged = s.stage_capture(result).unwrap();
        fs::create_dir(&blocker).unwrap();
        let written = staged.write();
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));
        assert!(s.find("p").is_none(), "older than h2, then the oldest");

        assert!(s.settle_capture(written).is_err());
        let row = s.find("h1").expect("the re-copied row is still there");
        assert_eq!(row.created_at, before.created_at, "at the place it had");
        assert_eq!(row.copy_count, before.copy_count, "with the counts it had");
        assert_eq!(
            history_ids(&s),
            ["h2", "p", "h1"],
            "and p is back between them"
        );

        fs::remove_dir(&blocker).unwrap();
        drop(s);
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["h2", "p", "h1"]);
        assert_eq!(
            reloaded.find("h1").map(|row| row.created_at),
            Some(before.created_at)
        );
        for name in ["h2", "p", "h1"] {
            assert_eq!(picture_files_exist(&dir, name), (true, true), "{name}");
        }
    }

    #[test]
    fn a_taken_back_capture_is_not_laid_back_on_disk_by_a_write_staged_meanwhile() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        capture_text(&mut s, "قبلها");
        s.save_history();
        let blocker = dir.join("history.json.tmp");

        let result = s.capture(
            ItemKind::Text,
            "نسخة لن تُحفظ".into(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        let captured = s.history[0].id.clone();
        let staged = s.stage_capture(result).unwrap();
        fs::create_dir(&blocker).unwrap();
        let written = staged.write();
        // Meanwhile a paste moves a counter, and its coalesced write is staged
        // — from a model still holding the capture — but not written yet.
        s.mark_signals_dirty(false);
        let late = s.stage_signal_flush();
        assert_eq!(late.len(), 1);
        fs::remove_dir(&blocker).unwrap();

        assert!(s.settle_capture(written).is_err());
        assert!(s.find(&captured).is_none());
        for write in late {
            write.commit().unwrap();
        }

        let reloaded = Store::load(dir.clone());
        assert!(
            reloaded.find(&captured).is_none(),
            "the late write did not bring it back"
        );
        assert_eq!(reloaded.history.len(), 1);
    }

    #[test]
    fn a_capture_pinned_while_its_write_failed_stays_pinned_with_its_picture() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        let images = dir.join(IMAGES_DIR);
        fs::write(images.join("c.png"), b"captured picture").unwrap();
        let result = s.capture(
            ItemKind::Image,
            "صورة 3×3".into(),
            None,
            None,
            Some("c.png".into()),
            None,
            Some(content_hash(b"captured picture")),
            ("Preview".into(), "com.apple.Preview".into()),
        );
        let captured = s.history[0].id.clone();
        let staged = s.stage_capture(result).unwrap();
        let blocker = dir.join("history.json.tmp");
        fs::create_dir(&blocker).unwrap();
        let written = staged.write();
        // Pinned from the panel while the disk still refuses history writes:
        // the journal and the pinned layer land, the history write waits.
        assert_eq!(s.set_pin_persisted(&captured, true), Ok(true));

        let synced = synced_writes();
        assert!(
            s.settle_capture(written).is_ok(),
            "it stands on the pinned shelf, and its picture with it"
        );
        assert_eq!(
            synced_writes(),
            synced,
            "reweighing that changes nothing writes no journal"
        );
        assert!(s.find(&captured).unwrap().is_pinned);

        fs::remove_dir(&blocker).unwrap();
        drop(s);
        let reloaded = Store::load(dir.clone());
        assert!(
            reloaded
                .find(&captured)
                .expect("still there after a restart")
                .is_pinned
        );
        assert_eq!(fs::read(images.join("c.png")).unwrap(), b"captured picture");
    }

    #[test]
    fn a_failed_recopy_of_a_pinned_row_restores_its_content_and_keeps_a_new_order() {
        let mut s = store();
        capture_text(&mut s, "first");
        let first = s.history[0].id.clone();
        s.set_pin_persisted(&first, true).unwrap();
        capture_text(&mut s, "second");
        let second = s.history[0].id.clone();
        s.set_pin_persisted(&second, true).unwrap();
        let before = s.find(&second).unwrap().clone();

        let result = s.capture(
            detect_kind("second"),
            "second".into(),
            None,
            None,
            None,
            None,
            None,
            ("Other".into(), "com.other".into()),
        );
        assert_eq!(result.outcome, CaptureOutcome::Deduped);
        // The shelf is reordered meanwhile.
        s.find_mut(&first).unwrap().pinned_order = Some(1);
        s.find_mut(&second).unwrap().pinned_order = Some(0);

        assert!(!s.rollback_capture(result.undo, result.dropped));
        let row = s.find(&second).unwrap();
        assert_eq!(row.source_app, before.source_app, "its content is put back");
        assert_eq!(row.created_at, before.created_at);
        assert_eq!(row.pinned_order, Some(0), "and the reorder stands");
    }

    fn picture_files_exist(dir: &Path, name: &str) -> (bool, bool) {
        let images = dir.join(IMAGES_DIR);
        (
            images.join(format!("{name}.png")).exists(),
            images.join(format!("{name}.thumb.png")).exists(),
        )
    }

    /// The failed copy pushed nothing off, but the unpin made meanwhile
    /// counted it and pushed off `h1` — in a history that, without the copy,
    /// has room for both.
    #[test]
    fn a_double_failure_below_the_limit_pushes_nothing_off() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(&dir, 2, 0, &[("h1", t)], &[("p", t + MINUTE)]);
        let blocker = dir.join("history.json.tmp");

        let written = a_copy_that_will_not_land(&mut s, &blocker);
        assert_eq!(s.history.len(), 2, "there was room for the copy");
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));
        assert_eq!(
            ids_of(&s.pending_pin.as_ref().unwrap().dropped),
            ["h1"],
            "the unpin counted the copy"
        );

        assert!(s.settle_capture(written).is_err());
        assert_eq!(history_ids(&s), ["p", "h1"]);
        assert!(s.pending_pin.as_ref().unwrap().dropped.is_empty());

        fs::remove_dir(&blocker).unwrap();
        drop(s);
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["p", "h1"]);
        assert_eq!(picture_files_exist(&dir, "h1"), (true, true));
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
    }

    /// The failed copy is a re-copy of the oldest picture, which then sat on
    /// top; with h2 the oldest, p was not taken back. Without the re-copy,
    /// p comes back and pushes off the oldest: the re-copied one.
    #[test]
    fn a_double_failure_around_a_recopy_evicts_the_row_the_policy_would() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            2,
            0,
            &[("h2", t + 2 * MINUTE), ("h1", t)],
            &[("p", t + MINUTE)],
        );
        let blocker = dir.join("history.json.tmp");

        let result = s.capture(
            ItemKind::Image,
            "صورة h1".into(),
            None,
            None,
            None,
            None,
            Some(content_hash(b"h1")),
            ("Preview".into(), "com.apple.Preview".into()),
        );
        assert_eq!(result.outcome, CaptureOutcome::Deduped);
        let staged = s.stage_capture(result).unwrap();
        fs::create_dir(&blocker).unwrap();
        let written = staged.write();
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        assert!(s.settle_capture(written).is_err());
        assert_eq!(history_ids(&s), ["h2", "p"]);

        fs::remove_dir(&blocker).unwrap();
        drop(s);
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["h2", "p"]);
        assert!(reloaded.find("h1").is_none());
        assert_eq!(picture_files_exist(&dir, "h2"), (true, true));
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert_eq!(picture_files_exist(&dir, "h1"), (false, false));
    }

    #[test]
    fn taking_back_a_failed_recopy_with_no_use_since_puts_its_last_use_back() {
        for (pinned, learning) in [(false, true), (true, true), (false, false), (true, false)] {
            let mut s = store();
            s.settings.learning_enabled = learning;
            capture_text(&mut s, "used");
            capture_text(&mut s, "other");
            let id = s.history[1].id.clone();
            if pinned {
                s.set_pin_persisted(&id, true).unwrap();
            }
            let before = s.find(&id).unwrap().clone();
            let result = s.capture(
                detect_kind("used"),
                "used".into(),
                None,
                None,
                None,
                None,
                None,
                ("Other".into(), "com.other".into()),
            );
            assert_eq!(result.outcome, CaptureOutcome::Deduped);

            assert!(!s.rollback_capture(result.undo, result.dropped));
            let row = s.find(&id).unwrap();
            let case = format!("pinned={pinned} learning={learning}");
            assert_eq!(row.last_used_at, before.last_used_at, "{case}");
            assert_eq!(row.copy_count, before.copy_count, "{case}");
            assert_eq!(row.paste_count, before.paste_count, "{case}");
            assert_eq!(row.created_at, before.created_at, "{case}");
        }
    }

    #[test]
    fn taking_back_a_failed_recopy_keeps_the_uses_counted_meanwhile() {
        for pinned in [false, true] {
            let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
            let mut s = Store::load(dir.clone());
            capture_text(&mut s, "used");
            capture_text(&mut s, "other");
            let id = s.history[1].id.clone();
            s.save_history();
            if pinned {
                s.set_pin_persisted(&id, true).unwrap();
            }
            let before = s.find(&id).unwrap().clone();
            let blocker = dir.join(if pinned {
                "pinned.json.tmp"
            } else {
                "history.json.tmp"
            });

            // The re-copy counts one copy and stamps the row; its write fails.
            let result = s.capture(
                detect_kind("used"),
                "used".into(),
                None,
                None,
                None,
                None,
                None,
                ("Other".into(), "com.other".into()),
            );
            assert_eq!(result.outcome, CaptureOutcome::Deduped);
            let staged = s.stage_capture(result).unwrap();
            fs::create_dir(&blocker).unwrap();
            let written = staged.write();
            // Meanwhile it is pasted, and copied through رفّ.
            assert!(s.count_use(&id, Usage::Paste));
            assert!(s.count_use(&id, Usage::Copy));
            let used_at = s.find(&id).unwrap().last_used_at;

            assert!(s.settle_capture(written).is_err());
            let row = s.find(&id).unwrap();
            assert_eq!(
                row.source_app, before.source_app,
                "pinned={pinned}: re-copy taken back"
            );
            assert_eq!(row.created_at, before.created_at, "pinned={pinned}");
            assert_eq!(
                row.paste_count,
                before.paste_count + 1,
                "pinned={pinned}: the paste stays counted"
            );
            assert_eq!(
                row.copy_count,
                before.copy_count + 1,
                "pinned={pinned}: the copy through رفّ stays, the failed re-copy goes"
            );
            assert_eq!(
                row.last_used_at, used_at,
                "pinned={pinned}: and when it was used"
            );

            // The counters reach the disk with the next flush, and survive a restart.
            fs::remove_dir(&blocker).unwrap();
            for write in s.stage_signal_flush() {
                write.commit().unwrap();
            }
            drop(s);
            let reloaded = Store::load(dir.clone());
            let row = reloaded.find(&id).unwrap();
            assert_eq!(row.paste_count, before.paste_count + 1, "pinned={pinned}");
            assert_eq!(row.copy_count, before.copy_count + 1, "pinned={pinned}");
            assert_eq!(row.last_used_at, used_at, "pinned={pinned}");
        }
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
    fn the_fingerprint_is_this_project_s_own_and_is_written_down() {
        // Literals, not values read back from whatever the standard library
        // happens to hash with today. If this test has to be edited, every
        // fingerprint already on disk has just stopped matching.
        assert_eq!(content_hash(b""), "f1:cbf29ce484222325");
        assert_eq!(content_hash(b"raff"), "f1:6dcf031fd20381b8");
        assert_eq!(
            content_hash(&[0x89, b'P', b'N', b'G']),
            "f1:09935de427cea543"
        );
    }

    #[test]
    fn an_old_fingerprint_is_recomputed_from_its_file_at_boot() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let images = dir.join(IMAGES_DIR);
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("shot.png"), b"raff").unwrap();
        // A row written before the fingerprint had a defined algorithm.
        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"id":"1","type":"image","text":"صورة 2×2","imageFile":"shot.png","hash":"9f8e7d6c5b4a3210","sourceAppBundleId":"com.test","sourceApp":"Test","createdAt":1,"isPinned":false,"copyCount":1,"pasteCount":0,"lastUsedAt":1}]"#,
        )
        .unwrap();

        let store = Store::load(dir.clone());

        assert_eq!(
            store.history[0].hash.as_deref(),
            Some("f1:6dcf031fd20381b8"),
            "recomputed from the file itself, not carried over or dropped"
        );

        // And it was written down, so the next boot has nothing left to do.
        let reloaded = Store::load(dir);
        assert_eq!(
            reloaded.history[0].hash.as_deref(),
            Some("f1:6dcf031fd20381b8")
        );

        // Which is the whole point: re-copying the same image still dedupes.
        let mut store = reloaded;
        let result = store.capture(
            ItemKind::Image,
            "صورة 2×2".into(),
            None,
            None,
            Some("again.png".into()),
            None,
            Some(content_hash(b"raff")),
            ("Test".into(), "com.test".into()),
        );
        assert_eq!(result.outcome, CaptureOutcome::Deduped);
        assert_eq!(store.history.len(), 1);
    }

    #[test]
    fn an_old_fingerprint_with_no_file_left_is_dropped_not_guessed() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(IMAGES_DIR)).unwrap();
        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"id":"1","type":"image","text":"صورة 2×2","imageFile":"gone.png","hash":"9f8e7d6c5b4a3210","sourceAppBundleId":"com.test","sourceApp":"Test","createdAt":1,"isPinned":false,"copyCount":1,"pasteCount":0,"lastUsedAt":1}]"#,
        )
        .unwrap();

        let store = Store::load(dir);

        assert_eq!(
            store.history[0].hash, None,
            "an unverifiable fingerprint is dropped, not kept: it describes no file any more"
        );
    }

    #[test]
    fn links_cover_the_schemes_and_bare_domains_people_actually_copy() {
        for link in [
            "https://example.com/a",
            "http://example.com",
            "www.example.com",
            "mailto:a@b.com",
            "tel:+966500000000",
            "example.com",
            "docs.example.co.uk/guide",
        ] {
            assert_eq!(detect_kind(link), ItemKind::Link, "{link}");
        }
    }

    #[test]
    fn prose_that_merely_contains_a_link_stays_text() {
        for text in [
            "\u{0627}\u{0641}\u{062a}\u{062d} https://example.com \u{0627}\u{0644}\u{0622}\u{0646}", // prose around a URL
            "example",                                   // a word, not a domain
            "3.5",                                       // a number
            "file.txt",                                  // a filename, not a host
            "\u{0645}\u{0644}\u{0641}.\u{0646}\u{0635}", // ...in Arabic too
            "a@b",                                       // not an address, and no scheme
            "mailto:",                                   // a scheme with nothing after it
        ] {
            assert_ne!(detect_kind(text), ItemKind::Link, "{text}");
        }
    }

    #[test]
    fn a_learning_bump_waits_for_the_flush_instead_of_rewriting_the_layer() {
        let mut s = store();
        capture_text(&mut s, "counted");
        let id = s.history[0].id.clone();
        s.save_history();
        let on_disk = fs::read(s.dir.join(HISTORY_FILE)).unwrap();

        // What a paste does to the store.
        assert!(s.count_use(&id, Usage::Paste));

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
    fn unreadable_settings_hold_capture_off_until_the_user_turns_it_back_on() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let unreadable: &[u8] = br#"{"captureEnabled": false, "excludedApps": ["com.bank""#;
        fs::write(dir.join(SETTINGS_FILE), unreadable).unwrap();

        let mut s = Store::load(dir.clone());

        assert!(
            !s.settings.capture_enabled,
            "the defaults would capture everything the file was keeping out"
        );
        assert!(s.unreadable_settings && s.unreadable_layer);
        assert!(
            !s.unreadable_shelf,
            "history and pinned were read: the shelf is not in question"
        );
        assert_eq!(
            fs::read(dir.join(SETTINGS_FILE)).unwrap(),
            unreadable,
            "the original is not overwritten at launch"
        );
        assert!(
            !Store::load(dir.clone()).settings.capture_enabled,
            "and every launch holds off the same way"
        );
        assert!(
            s.settings.first_run_shown,
            "the welcome does not stand in for the review"
        );

        // Any other change is saved, but it is not the confirmation — not even
        // one that sent the marker back cleared.
        let mut next = s.settings.clone();
        next.excluded_apps = vec!["com.bank".into()];
        next.settings_recovered = false;
        s.update_settings_persisted(next).unwrap();
        assert!(s.unreadable_settings);
        assert!(!s.settings.capture_enabled);
        s.mark_first_run_shown_persisted().unwrap();
        let after_saves = Store::load(dir.clone());
        assert!(
            after_saves.unreadable_settings && !after_saves.settings.capture_enabled,
            "the file parses again now, and the notice still stands"
        );
        assert!(
            !after_saves.unreadable_layer,
            "though nothing was unreadable on this launch"
        );

        let mut next = s.settings.clone();
        next.capture_enabled = true;
        s.update_settings_persisted(next).unwrap();
        assert!(!s.unreadable_settings, "turning capture on is");

        let reloaded = Store::load(dir);
        assert!(reloaded.settings.capture_enabled);
        assert!(!reloaded.unreadable_settings && !reloaded.unreadable_layer);
        assert_eq!(reloaded.settings.excluded_apps, ["com.bank"]);
        assert!(
            !fs::read_to_string(reloaded.dir.join(SETTINGS_FILE))
                .unwrap()
                .contains("settingsRecovered"),
            "a settings file with nothing to recover from does not mention it"
        );
    }

    /// H6: Settings was opened with capture on; the menu bar has turned it
    /// off since. A save from the window that changes one other field must
    /// leave capture as the menu bar put it.
    #[test]
    fn a_patch_changes_only_its_own_fields() {
        let mut current = Settings::default();
        current.capture_enabled = false; // the menu bar, after the window loaded
        current.excluded_apps = vec!["com.bank".into()];

        let patch: SettingsPatch = serde_json::from_str(r#"{"launchAtLogin": true}"#).unwrap();
        let next = patch.applied_to(&current);

        assert!(next.launch_at_login);
        assert!(!next.capture_enabled, "the menu bar's change survives");
        assert_eq!(next.excluded_apps, ["com.bank"]);
        assert_eq!(next.hotkey, current.hotkey);
    }

    /// Every field a patch can carry, each set away from its default, so a
    /// dropped or crossed assignment in `applied_to` shows. And the list of
    /// settings is pinned: a field added to `Settings` fails here until
    /// `SettingsPatch` learns it too — otherwise saving it would silently do
    /// nothing.
    #[test]
    fn a_patch_carries_every_setting_and_nothing_crosses() {
        let wanted = Settings {
            hotkey: "ctrl+alt+k".into(),
            launch_at_login: true,
            history_limit: 1000,
            capture_enabled: false,
            respect_concealed: false,
            excluded_apps: vec!["com.bank".into()],
            learning_enabled: false,
            first_run_shown: true,
            appearance: Appearance::Dark,
            follow_system: false,
            retention_days: 30,
            settings_recovered: false,
        };
        let json = serde_json::to_value(&wanted).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "appearance",
                "captureEnabled",
                "excludedApps",
                "firstRunShown",
                "followSystem",
                "historyLimit",
                "hotkey",
                "launchAtLogin",
                "learningEnabled",
                "respectConcealed",
                "retentionDays",
            ],
            "a new setting needs a SettingsPatch field before it can be saved"
        );

        let patch: SettingsPatch = serde_json::from_value(json).unwrap();
        let next = patch.applied_to(&Settings::default());

        assert_eq!(
            serde_json::to_value(&next).unwrap(),
            serde_json::to_value(&wanted).unwrap()
        );
    }

    #[test]
    fn a_complete_object_is_still_a_valid_patch_and_the_marker_is_not_the_caller_s() {
        let mut sent = Settings::default();
        sent.capture_enabled = false;
        sent.history_limit = 200;
        sent.settings_recovered = true;
        let patch: SettingsPatch =
            serde_json::from_str(&serde_json::to_string(&sent).unwrap()).unwrap();

        let next = patch.applied_to(&Settings::default());

        assert!(!next.capture_enabled);
        assert_eq!(next.history_limit, 200);
        assert!(
            !next.settings_recovered,
            "only the store sets the recovery marker"
        );
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

    // --- Unpinning by its place in time (Sultan, 2026-10-21) ------------------
    //
    // A row comes back to where its capture date puts it, with that date.
    // One older than the oldest row history held before it came back is
    // removed, even with room to spare; into an empty history it comes back.

    const MINUTE: u64 = 60 * 1000;

    /// A picture row as the layer files hold it: id `name`, its image and
    /// thumbnail named after it, captured at `created_at`.
    fn picture_row(name: &str, created_at: u64, pinned_order: Option<u32>) -> serde_json::Value {
        serde_json::json!({
            "id": name,
            "type": "image",
            "text": format!("صورة {name}"),
            "imageFile": format!("{name}.png"),
            "thumbFile": format!("{name}.thumb.png"),
            "hash": content_hash(name.as_bytes()),
            "sourceAppBundleId": "com.apple.Preview",
            "sourceApp": "Preview",
            "createdAt": created_at,
            "isPinned": pinned_order.is_some(),
            "pinnedOrder": pinned_order,
            "copyCount": 1,
            "pasteCount": 0,
            "lastUsedAt": created_at,
        })
    }

    /// Writes the three layers and every picture's two files, then loads them
    /// as a launch would. `history` is newest first.
    fn shelf_on_disk(
        dir: &Path,
        limit: usize,
        retention_days: u32,
        history: &[(&str, u64)],
        pinned: &[(&str, u64)],
    ) -> Store {
        let images = dir.join(IMAGES_DIR);
        fs::create_dir_all(&images).unwrap();
        for (name, _) in history.iter().chain(pinned) {
            fs::write(images.join(format!("{name}.png")), name).unwrap();
            fs::write(images.join(format!("{name}.thumb.png")), name).unwrap();
        }
        let rows = |layer: &[(&str, u64)], pinned: bool| {
            serde_json::Value::Array(
                layer
                    .iter()
                    .enumerate()
                    .map(|(at, (name, created_at))| {
                        picture_row(name, *created_at, pinned.then_some(at as u32))
                    })
                    .collect(),
            )
        };
        fs::write(dir.join(HISTORY_FILE), rows(history, false).to_string()).unwrap();
        fs::write(dir.join(PINNED_FILE), rows(pinned, true).to_string()).unwrap();
        fs::write(
            dir.join(SETTINGS_FILE),
            serde_json::json!({
                "historyLimit": limit,
                "retentionDays": retention_days,
                "firstRunShown": true,
            })
            .to_string(),
        )
        .unwrap();
        Store::load(dir.to_path_buf())
    }

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()))
    }

    fn created_at(s: &Store, id: &str) -> Option<u64> {
        s.find(id).map(|item| item.created_at)
    }

    #[test]
    fn an_unpinned_row_returns_to_its_place_in_time_and_the_oldest_makes_room() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let (h1, p, h2) = (t, t + MINUTE, t + 2 * MINUTE);
        let mut s = shelf_on_disk(&dir, 2, 0, &[("h2", h2), ("h1", h1)], &[("p", p)]);

        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        assert_eq!(history_ids(&s), ["h2", "p"], "between the two, by its date");
        assert_eq!(created_at(&s, "p"), Some(p), "with the date it had");
        assert!(s.pinned.is_empty());
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert_eq!(picture_files_exist(&dir, "h2"), (true, true));
        assert_eq!(
            picture_files_exist(&dir, "h1"),
            (false, false),
            "the full history lets its oldest row go"
        );
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["h2", "p"]);
        assert_eq!(created_at(&reloaded, "p"), Some(p));
        assert!(reloaded.pinned.is_empty());
        assert!(
            !fs::read_to_string(dir.join(HISTORY_FILE))
                .unwrap()
                .contains("capturedAt"),
            "one date per row, and it is the capture's"
        );
    }

    #[test]
    fn an_unpinned_row_older_than_the_whole_history_is_removed_even_with_room() {
        for limit in [2, 3] {
            let dir = test_dir();
            let t = now_ms() - 30 * MINUTE;
            let (p, h1, h2) = (t, t + MINUTE, t + 2 * MINUTE);
            let mut s = shelf_on_disk(&dir, limit, 0, &[("h2", h2), ("h1", h1)], &[("p", p)]);

            assert_eq!(s.set_pin_persisted("p", false), Ok(false), "limit {limit}");

            assert_eq!(history_ids(&s), ["h2", "h1"], "limit {limit}: untouched");
            assert!(s.find("p").is_none(), "limit {limit}: removed");
            assert_eq!(
                picture_files_exist(&dir, "p"),
                (false, false),
                "limit {limit}: with its files"
            );
            assert_eq!(
                picture_files_exist(&dir, "h1"),
                (true, true),
                "limit {limit}"
            );
            assert_eq!(
                picture_files_exist(&dir, "h2"),
                (true, true),
                "limit {limit}"
            );
            let reloaded = Store::load(dir.clone());
            assert_eq!(history_ids(&reloaded), ["h2", "h1"], "limit {limit}");
            assert!(reloaded.find("p").is_none(), "limit {limit}");
            assert!(!dir.join(PENDING_PIN_FILE).exists(), "limit {limit}");
        }
    }

    #[test]
    fn an_unpinned_row_comes_back_to_an_empty_history_with_its_date() {
        let dir = test_dir();
        let p = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(&dir, 2, 0, &[], &[("p", p)]);

        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        assert_eq!(history_ids(&s), ["p"]);
        assert_eq!(created_at(&s, "p"), Some(p));
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["p"]);
        assert_eq!(created_at(&reloaded, "p"), Some(p));
    }

    #[test]
    fn the_age_limit_counts_from_the_capture_of_an_unpinned_row() {
        let dir = test_dir();
        let month_ago = now_ms() - 30 * 24 * 60 * MINUTE;
        let mut s = shelf_on_disk(&dir, 2, 7, &[], &[("p", month_ago)]);

        assert_eq!(
            s.set_pin_persisted("p", false),
            Ok(false),
            "the unpin itself succeeds"
        );

        assert!(
            s.find("p").is_none(),
            "a month old, past a week's retention: it goes as any row would"
        );
        assert_eq!(picture_files_exist(&dir, "p"), (false, false));
        assert!(Store::load(dir.clone()).find("p").is_none());
    }

    #[test]
    fn a_removed_unpin_says_whether_its_age_or_the_history_let_it_go() {
        // Past retention, the age limit is the reason: into an empty history
        // as well, and also when the row is older than all of it.
        let month_ago = now_ms() - 30 * 24 * 60 * MINUTE;
        let a_minute_ago = now_ms() - MINUTE;
        for history in [&[][..], &[("h1", a_minute_ago)][..]] {
            let dir = test_dir();
            let mut s = shelf_on_disk(&dir, 5, 7, history, &[("p", month_ago)]);
            assert_eq!(s.set_pin_persisted("p", false), Ok(false));
            assert!(s.find("p").is_none());
            assert_eq!(
                s.unpin_removal(),
                Some(UnpinRemoval::Retention),
                "history {history:?}"
            );
        }

        // Within retention, older than every row history holds.
        let t = now_ms() - 30 * MINUTE;
        let dir = test_dir();
        let mut s = shelf_on_disk(&dir, 5, 7, &[("h1", t + MINUTE)], &[("p", t)]);
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));
        assert_eq!(s.unpin_removal(), Some(UnpinRemoval::OlderThanHistory));

        // Taken back: there is no reason to give, and none left over.
        let dir = test_dir();
        let mut s = shelf_on_disk(&dir, 5, 7, &[("h1", t)], &[("p", t + MINUTE)]);
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));
        assert!(s.find("p").is_some());
        assert_eq!(s.unpin_removal(), None);
    }

    #[test]
    fn an_unpinned_row_dated_like_the_oldest_is_not_older_and_comes_back() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(&dir, 2, 0, &[("h2", t + MINUTE), ("h1", t)], &[("p", t)]);

        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        assert_eq!(
            history_ids(&s),
            ["h2", "p"],
            "the row already there is the one the full history lets go"
        );
        assert_eq!(created_at(&s, "p"), Some(t));
    }

    #[test]
    fn pinning_and_unpinning_never_changes_the_date() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(&dir, 3, 0, &[("h2", t + 2 * MINUTE), ("h1", t)], &[]);
        for round in 0..3 {
            s.set_pin_persisted("h2", true).unwrap();
            s.set_pin_persisted("h2", false).unwrap();
            assert_eq!(history_ids(&s), ["h2", "h1"], "round {round}");
            assert_eq!(created_at(&s, "h2"), Some(t + 2 * MINUTE), "round {round}");
        }
        assert_eq!(created_at(&Store::load(dir), "h2"), Some(t + 2 * MINUTE));
    }

    // --- A pin journal finished at a restart (006, the review's two cases) ----

    /// A copy whose history write fails, applied and staged as a capture is;
    /// returns its settlement-to-be. `blocker` stays in place.
    fn a_copy_that_will_not_land(s: &mut Store, blocker: &Path) -> WrittenCapture {
        let result = s.capture(
            ItemKind::Text,
            "نسخة لن تُحفظ".into(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        let staged = s.stage_capture(result).unwrap();
        fs::create_dir(blocker).unwrap();
        staged.write()
    }

    /// The review's case 1: the copy fails, the unpin made meanwhile is
    /// journaled but its layers fail, and the corrected journal cannot be
    /// written either. A restart must leave what the policy leaves on the
    /// layers as they are on disk: the newer `h2` and its picture stay.
    #[test]
    fn a_pin_journal_left_uncorrected_still_spares_the_newer_row_at_a_restart() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let (h1, p, h2) = (t, t + MINUTE, t + 2 * MINUTE);
        let mut s = shelf_on_disk(&dir, 2, 0, &[("h2", h2), ("h1", h1)], &[("p", p)]);
        let blocker = dir.join("history.json.tmp");
        let written = a_copy_that_will_not_land(&mut s, &blocker);
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));
        fs::create_dir(dir.join("pending-pin.json.tmp")).unwrap();
        assert!(s.settle_capture(written).is_err());
        assert_eq!(
            history_ids(&s),
            ["h2", "p"],
            "memory is corrected all the same"
        );

        fs::remove_dir(&blocker).unwrap();
        fs::remove_dir(dir.join("pending-pin.json.tmp")).unwrap();
        drop(s);
        let reloaded = Store::load(dir.clone());

        assert!(reloaded.find("h2").is_some(), "the newer row stays");
        assert_eq!(picture_files_exist(&dir, "h2"), (true, true));
        assert!(reloaded.find("h1").is_none(), "the oldest goes");
        assert_eq!(picture_files_exist(&dir, "h1"), (false, false));
        assert!(reloaded.find("p").is_some(), "the unpinned row stays");
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert!(reloaded.pending_pin.is_none());
    }

    /// The review's case 2: no disk fault at all at the restart. The unpin's
    /// journal reached the disk (it is flushed), its layers and the copy did
    /// not, and the process stopped before the copy was settled.
    #[test]
    fn a_power_cut_before_the_copy_is_settled_spares_the_newer_row() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let (h1, p, h2) = (t, t + MINUTE, t + 2 * MINUTE);
        let mut s = shelf_on_disk(&dir, 2, 0, &[("h2", h2), ("h1", h1)], &[("p", p)]);
        let blocker = dir.join("history.json.tmp");
        let _never_settled = a_copy_that_will_not_land(&mut s, &blocker);
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        drop(s);
        fs::remove_dir(&blocker).unwrap();
        let reloaded = Store::load(dir.clone());

        assert!(reloaded.find("h2").is_some(), "the newer row stays");
        assert_eq!(picture_files_exist(&dir, "h2"), (true, true));
        assert!(reloaded.find("h1").is_none());
        assert_eq!(picture_files_exist(&dir, "h1"), (false, false));
        assert!(reloaded.find("p").is_some());
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
    }

    /// The same power cut with room for every row once the copy is gone: the
    /// journal pushed `h1` off to make room for the copy, and nothing has to go.
    #[test]
    fn a_power_cut_below_the_limit_pushes_nothing_off() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let (h1, p, h2) = (t, t + MINUTE, t + 2 * MINUTE);
        let mut s = shelf_on_disk(&dir, 3, 0, &[("h2", h2), ("h1", h1)], &[("p", p)]);
        let blocker = dir.join("history.json.tmp");
        let _never_settled = a_copy_that_will_not_land(&mut s, &blocker);
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        drop(s);
        fs::remove_dir(&blocker).unwrap();
        let reloaded = Store::load(dir.clone());

        assert_eq!(reloaded.history.len(), 3, "all three fit");
        for name in ["h2", "p", "h1"] {
            assert!(reloaded.find(name).is_some(), "{name} stays");
            assert_eq!(picture_files_exist(&dir, name), (true, true), "{name}");
        }
    }

    /// What a launch finds after either case: the layers as they were before
    /// the unpin, and a journal whose choice names the newer `h2`. Finishing
    /// it lets go what the policy picks now — `h1` — and deletes the files of
    /// that row, and of no row still held.
    #[test]
    fn finishing_a_stale_pin_journal_deletes_the_files_of_what_goes_now_and_only_those() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            2,
            0,
            &[("h2", t + 2 * MINUTE), ("h1", t)],
            &[("p", t + MINUTE)],
        );
        let stale = s.find("h2").unwrap().clone();
        let mut item = s.find("p").unwrap().clone();
        item.is_pinned = false;
        item.pinned_order = None;
        s.pending_pin = Some(PendingPin {
            item,
            desired: false,
            dropped: vec![stale],
        });

        s.finish_pending_pin().unwrap();

        assert_eq!(history_ids(&s), ["h2", "p"]);
        assert!(s.pinned.is_empty());
        assert_eq!(picture_files_exist(&dir, "h2"), (true, true), "still held");
        assert_eq!(
            picture_files_exist(&dir, "h1"),
            (false, false),
            "let go now"
        );
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));
        assert!(!dir.join(PENDING_PIN_FILE).exists());
    }

    /// A row deleted a moment ago is still history's while its undo lasts:
    /// one unpinned meanwhile is weighed against it, and is not removed for
    /// being older than what remains — the delete may yet be taken back.
    #[test]
    fn a_row_waiting_for_its_undo_still_counts_when_an_unpin_is_weighed() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            5,
            0,
            &[("y", t + 5 * MINUTE), ("x", t + MINUTE)],
            &[("r", t + 3 * MINUTE)],
        );
        let token = s.delete_reversible("x").unwrap();

        assert_eq!(s.set_pin_persisted("r", false), Ok(false));
        assert_eq!(history_ids(&s), ["y", "r"], "newer than x: taken back");
        assert_eq!(picture_files_exist(&dir, "r"), (true, true));

        s.undo_delete(&token).unwrap();
        assert_eq!(history_ids(&s), ["y", "r", "x"]);
    }

    /// The waiting row can only lower the bar of a history that has rows; it
    /// does not stand in for an empty one. Its only row deleted a moment ago,
    /// history is empty, and an empty history takes the row back (ت١٧).
    #[test]
    fn a_waiting_delete_does_not_turn_an_empty_history_against_an_unpin() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(&dir, 5, 0, &[("d", t + 2 * MINUTE)], &[("p", t)]);
        let token = s.delete_reversible("d").unwrap();

        assert_eq!(s.set_pin_persisted("p", false), Ok(false));
        assert_eq!(history_ids(&s), ["p"]);
        assert_eq!(picture_files_exist(&dir, "p"), (true, true));

        s.undo_delete(&token).unwrap();
        assert_eq!(history_ids(&s), ["d", "p"]);
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["d", "p"]);
    }

    /// The same, across a crash: the unpin's layers did not land, and the
    /// restart decides again — with the delete still waiting in its journal.
    #[test]
    fn a_restart_weighs_an_unpin_against_a_delete_still_waiting_for_its_undo() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let mut s = shelf_on_disk(
            &dir,
            5,
            0,
            &[("y", t + 5 * MINUTE), ("x", t + MINUTE)],
            &[("r", t + 3 * MINUTE)],
        );
        s.delete_reversible("x").unwrap();
        let blocker = dir.join("history.json.tmp");
        fs::create_dir(&blocker).unwrap();
        assert_eq!(s.set_pin_persisted("r", false), Ok(false));
        assert_eq!(history_ids(&s), ["y", "r"]);

        drop(s);
        fs::remove_dir(&blocker).unwrap();
        let reloaded = Store::load(dir.clone());

        assert!(
            reloaded.find("r").is_some(),
            "what the user saw come back stays"
        );
        assert_eq!(picture_files_exist(&dir, "r"), (true, true));
    }

    /// Weighed again after the copy is taken back, a row older than all of
    /// history is still not taken back — even with room for it now.
    #[test]
    fn a_double_failure_still_removes_a_row_older_than_all_of_history() {
        let dir = test_dir();
        let t = now_ms() - 30 * MINUTE;
        let (p, h1, h2) = (t, t + MINUTE, t + 2 * MINUTE);
        let mut s = shelf_on_disk(&dir, 3, 0, &[("h2", h2), ("h1", h1)], &[("p", p)]);
        let blocker = dir.join("history.json.tmp");
        let written = a_copy_that_will_not_land(&mut s, &blocker);
        assert_eq!(s.set_pin_persisted("p", false), Ok(false));

        assert!(s.settle_capture(written).is_err());
        assert_eq!(history_ids(&s), ["h2", "h1"]);

        fs::remove_dir(&blocker).unwrap();
        drop(s);
        let reloaded = Store::load(dir.clone());
        assert_eq!(history_ids(&reloaded), ["h2", "h1"]);
        assert!(reloaded.find("p").is_none());
        assert_eq!(picture_files_exist(&dir, "p"), (false, false));
        assert_eq!(picture_files_exist(&dir, "h1"), (true, true));
        assert_eq!(picture_files_exist(&dir, "h2"), (true, true));
    }
}

// ---------------------------------------------------------------------------
// وحدة اختبارات التدقيق (RAFF-COPILOT-AUDIT). اختبارات فقط؛ لا تغيّر سلوك المنتج.
// اختبارات RAFF-AUD-00N كلها تعمل مع الحزمة: الخلل الذي أعادت إنتاجه أُصلح.
// والمتجاهَل هنا مسبارا أداء فقط (perf-probe)، يُشغَّلان بـ:
// cargo test --release audit_tests -- --ignored perf_probe --nocapture
// ---------------------------------------------------------------------------
#[cfg(test)]
mod audit_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn tmp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("raff-audit-{tag}-{}", uuid::Uuid::new_v4()))
    }

    fn cap(s: &mut Store, text: &str) -> CaptureResult {
        s.capture(
            detect_kind(text),
            text.into(),
            None,
            None,
            None,
            None,
            None,
            ("Audit".into(), "com.audit".into()),
        )
    }

    fn cap_persist(store: &Mutex<Store>, text: &str) -> Result<CaptureOutcome, String> {
        let result = cap(&mut crate::lock_store(store), text);
        persist_capture(store, result)
    }

    fn ids(items: &[ClipItem]) -> Vec<String> {
        items.iter().map(|i| i.id.clone()).collect()
    }

    /// xorshift64 بذرة ثابتة: تسلسلات حتمية قابلة للإعادة.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// يحضّر حالة RAFF-AUD-001: تاريخ ممتلئ عند الحد، وعنصر مثبّت أقدم من كل ما فيه.
    fn full_history_with_old_pinned(dir: &Path) -> (Store, String) {
        let mut s = Store::load(dir.to_path_buf());
        s.settings.history_limit = 2;
        cap(&mut s, "pinned-old");
        let pinned_id = s.history[0].id.clone();
        assert!(s.set_pin_persisted(&pinned_id, true).unwrap());
        s.find_mut(&pinned_id).unwrap().created_at = 1;
        s.save_pinned();
        cap(&mut s, "recent-a");
        cap(&mut s, "recent-b");
        s.save_history();
        assert_eq!(s.history.len(), 2);
        (s, pinned_id)
    }

    // --- H4 / RAFF-AUD-001 ------------------------------------------------

    /// بقاعدة سلطان (2026-10-21) يُستبعد العنصر الأقدم من كل السجل عند إلغاء
    /// تثبيته، ولا يُزاح لأجله عنصر أحدث. والرفض يعيد الطبقتين كما كانتا.
    #[test]
    fn aud001_unpin_at_cap_removes_the_older_item_or_refuses_without_side_effects() {
        let dir = tmp_dir("aud001");
        let (mut s, pinned_id) = full_history_with_old_pinned(&dir);
        let before = (ids(&s.history), ids(&s.pinned));
        assert_eq!(s.set_pin_persisted(&pinned_id, false), Ok(false));
        assert!(s.find(&pinned_id).is_none(), "أقدم من كل السجل: يُستبعد");
        assert_eq!(ids(&s.history), before.0, "ولا يُزاح عنصر أحدث");
        assert!(s.pinned.is_empty());

        let dir = tmp_dir("aud001-refused");
        let (mut s, pinned_id) = full_history_with_old_pinned(&dir);
        let before = (ids(&s.history), ids(&s.pinned));
        fs::create_dir(dir.join(PENDING_PIN_FILE)).unwrap();
        assert!(s.set_pin_persisted(&pinned_id, false).is_err());
        assert_eq!(
            (ids(&s.history), ids(&s.pinned)),
            before,
            "الرفض يعيد الطبقتين كما كانتا"
        );
        let _ = fs::remove_dir_all(dir);
    }

    // --- H1 / H2 / RAFF-AUD-002 / RAFF-AUD-003: مصفوفة الفساد ------------------

    fn corruption_payloads() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("empty", Vec::new()),
            ("truncated", b"[{\"id\":\"x\",\"type\":\"te".to_vec()),
            ("wrong-type", b"{\"not\":\"an array\"}".to_vec()),
            ("binary", vec![0xff, 0xfe, 0x00, 0x13, 0x37]),
            ("nul-only", vec![0u8; 64]),
            ("bom-empty-array", b"\xef\xbb\xbf[]".to_vec()),
        ]
    }

    #[test]
    fn h1_corrupt_history_or_pinned_is_flagged_copied_aside_and_images_survive() {
        for layer in [HISTORY_FILE, PINNED_FILE] {
            for (name, bytes) in corruption_payloads() {
                let dir = tmp_dir("h1");
                fs::create_dir_all(dir.join(IMAGES_DIR)).unwrap();
                let image = dir.join(IMAGES_DIR).join("orphan-candidate.png");
                fs::write(&image, b"png").unwrap();
                fs::write(dir.join(layer), &bytes).unwrap();

                let s = Store::load(dir.clone());

                assert!(
                    s.unreadable_layer,
                    "{layer}/{name}: يجب رفع علامة الطبقة غير المقروءة"
                );
                let copy = dir.join(layer).with_extension("json.corrupt");
                assert_eq!(
                    fs::read(&copy).unwrap(),
                    bytes,
                    "{layer}/{name}: النسخة الجانبية مطابقة"
                );
                assert_eq!(
                    fs::read(dir.join(layer)).unwrap(),
                    bytes,
                    "{layer}/{name}: الأصل لم يُستبدل عند الإقلاع"
                );
                assert!(
                    image.exists(),
                    "{layer}/{name}: لا تنظيف للصور اليتيمة مع طبقة غير مقروءة"
                );
                let _ = fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn aud002_corrupt_settings_is_surfaced() {
        let dir = tmp_dir("aud002");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SETTINGS_FILE), b"{oops").unwrap();
        let s = Store::load(dir.clone());
        assert!(
            s.unreadable_layer,
            "فساد الإعدادات يجب أن يصل إلى الواجهة كما في الطبقتين الأخريين"
        );
        let _ = fs::remove_dir_all(dir);
    }

    fn two_successive_corruptions(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(HISTORY_FILE), b"FIRST-CORRUPTION").unwrap();
        let s = Store::load(dir.to_path_buf());
        drop(s);
        fs::write(dir.join(HISTORY_FILE), b"SECOND-CORRUPTION").unwrap();
        let _ = Store::load(dir.to_path_buf());
    }

    #[test]
    fn aud003_every_recovery_copy_is_kept() {
        let dir = tmp_dir("aud003");
        two_successive_corruptions(&dir);
        let mut found_first = false;
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            if fs::read(entry.path())
                .map(|b| b == b"FIRST-CORRUPTION")
                .unwrap_or(false)
            {
                found_first = true;
            }
        }
        assert!(found_first, "نسخة الفساد الأول يجب أن تبقى في مكان ما");
        let _ = fs::remove_dir_all(dir);
    }

    // --- حقن الأعطال: مجلد مكان ملف .tmp يجعل الكتابة تفشل ---------------------

    #[test]
    fn fault_capture_write_failure_rolls_back_memory_and_disk() {
        let dir = tmp_dir("fault-cap");
        let store = Mutex::new(Store::load(dir.clone()));
        cap_persist(&store, "kept").unwrap();
        let before = ids(&crate::lock_store(&store).history);
        fs::create_dir(dir.join("history.json.tmp")).unwrap();

        let result = cap_persist(&store, "doomed");

        assert!(result.is_err());
        assert_eq!(
            ids(&crate::lock_store(&store).history),
            before,
            "الذاكرة تعود كما كانت"
        );
        fs::remove_dir(dir.join("history.json.tmp")).unwrap();
        assert_eq!(
            ids(&Store::load(dir.clone()).history),
            before,
            "القرص لم يتغيّر"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fault_settings_write_failure_restores_settings() {
        let dir = tmp_dir("fault-set");
        let mut s = Store::load(dir.clone());
        s.save_settings();
        fs::create_dir(dir.join("settings.json.tmp")).unwrap();
        let mut next = s.settings.clone();
        next.capture_enabled = false;
        next.excluded_apps = vec!["com.bank".into()];

        assert!(s.update_settings_persisted(next).is_err());
        assert!(s.settings.capture_enabled, "الإعداد يعود في الذاكرة");
        assert!(s.settings.excluded_apps.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fault_pin_journal_failure_leaves_item_unpinned_everywhere() {
        let dir = tmp_dir("fault-pin");
        let mut s = Store::load(dir.clone());
        cap(&mut s, "x");
        s.save_history();
        let id = s.history[0].id.clone();
        fs::create_dir(dir.join("pending-pin.json.tmp")).unwrap();
        assert!(s.set_pin_persisted(&id, true).is_err());
        assert!(!s.find(&id).unwrap().is_pinned);
        fs::remove_dir(dir.join("pending-pin.json.tmp")).unwrap();
        let r = Store::load(dir.clone());
        assert!(r.pinned.is_empty() && r.history.len() == 1);
        let _ = fs::remove_dir_all(dir);
    }

    // --- اختبار قائم على نموذج: تسلسلات عشوائية ببذرة ثابتة + تطابق إعادة التحميل --

    fn check_invariants(s: &Store, step: usize, op: &str) {
        let mut seen = std::collections::HashSet::new();
        for item in s.history.iter().chain(s.pinned.iter()) {
            assert!(
                seen.insert(item.id.clone()),
                "خطوة {step} ({op}): معرّف مكرر {}",
                item.id
            );
        }
        assert!(
            s.history.iter().all(|i| !i.is_pinned),
            "خطوة {step} ({op}): عنصر مثبت في التاريخ"
        );
        assert!(
            s.pinned.iter().all(|i| i.is_pinned),
            "خطوة {step} ({op}): عنصر غير مثبت في الرف"
        );
        assert!(
            s.history.len() <= s.settings.history_limit.max(1),
            "خطوة {step} ({op}): تجاوز الحد"
        );
    }

    fn run_model(seed: u64, steps: usize) {
        let dir = tmp_dir("model");
        let store = Mutex::new(Store::load(dir.clone()));
        {
            let mut s = crate::lock_store(&store);
            let mut settings = s.settings.clone();
            settings.history_limit = 1000;
            s.update_settings_persisted(settings).unwrap();
        }
        let mut rng = Rng(seed);
        let mut pending_token: Option<String> = None;
        for step in 0..steps {
            let roll = rng.below(100);
            let op;
            if roll < 45 {
                op = "capture";
                let text = format!("item-{}", rng.below(60));
                cap_persist(&store, &text).unwrap();
            } else {
                let mut s = crate::lock_store(&store);
                let all: Vec<String> = ids(&s.history).into_iter().chain(ids(&s.pinned)).collect();
                if all.is_empty() {
                    continue;
                }
                let target = all[rng.below(all.len() as u64) as usize].clone();
                if roll < 65 {
                    op = "pin-toggle";
                    let desired = !s.find(&target).unwrap().is_pinned;
                    s.set_pin_persisted(&target, desired).unwrap();
                } else if roll < 80 {
                    op = "delete";
                    pending_token = Some(s.delete_reversible(&target).unwrap());
                } else if roll < 88 {
                    op = "undo";
                    if let Some(token) = pending_token.take() {
                        s.undo_delete(&token).unwrap();
                    }
                } else if roll < 94 {
                    op = "commit";
                    if let Some(token) = pending_token.take() {
                        s.commit_delete(&token).unwrap();
                    }
                } else {
                    op = "reorder";
                    let mut order = ids(&s.pinned);
                    order.reverse();
                    s.reorder_pinned_persisted(&order).unwrap();
                }
            }
            let s = crate::lock_store(&store);
            check_invariants(&s, step, op);
            if step % 10 == 9 {
                let r = Store::load(dir.clone());
                assert_eq!(
                    ids(&r.history),
                    ids(&s.history),
                    "بذرة {seed} خطوة {step} ({op}): التاريخ بعد إعادة التحميل"
                );
                assert_eq!(
                    ids(&r.pinned),
                    ids(&s.pinned),
                    "بذرة {seed} خطوة {step} ({op}): الرف بعد إعادة التحميل"
                );
            }
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn model_based_sequences_preserve_invariants_and_reload_equality() {
        for seed in [0x5eed_u64, 0xC0FFEE, 0xBADD_CAFE, 42, 7] {
            run_model(seed, 200);
        }
    }

    // --- التزامن: التقاطات متوازية عبر persist_capture --------------------------

    #[test]
    fn concurrent_persist_capture_loses_nothing() {
        let dir = tmp_dir("conc");
        let store = Arc::new(Mutex::new(Store::load(dir.clone())));
        {
            let mut s = crate::lock_store(&store);
            let mut settings = s.settings.clone();
            settings.history_limit = 1000;
            s.update_settings_persisted(settings).unwrap();
        }
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    for i in 0..40 {
                        cap_persist(&store, &format!("t{t}-i{i}")).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let mem = ids(&crate::lock_store(&store).history);
        assert_eq!(mem.len(), 320);
        let disk = Store::load(dir.clone());
        assert_eq!(
            ids(&disk.history),
            mem,
            "القرص يطابق الذاكرة بعد كتابات متزامنة"
        );
        let _ = fs::remove_dir_all(dir);
    }

    // --- تكافؤ التطبيع JS ↔ Rust عبر متجهات مشتركة -----------------------------

    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("../../audit/fixtures/normalize-vectors.json")).unwrap()
    }

    #[test]
    fn normalize_parity_with_js_for_all_non_divergent_vectors() {
        let v = vectors();
        let mut checked = 0;
        for vec in v["vectors"].as_array().unwrap() {
            let input = vec["input"].as_str().unwrap();
            let got = normalize_for_search(input);
            if vec["divergence"].is_null() {
                assert_eq!(
                    got,
                    vec["expected"].as_str().unwrap(),
                    "تباين غير متوقع للمدخل {input:?}"
                );
            } else {
                // نموذج JS لـRust (طيّ حرفًا حرفًا ثم خفض النص كاملًا) يطابق Rust تمامًا،
                // وهو هنا مساوٍ لـexpected منذ RAFF-AUD-007.
                assert_eq!(
                    got,
                    vec["perCharModel"].as_str().unwrap(),
                    "نموذج Rust في المولِّد لا يطابق Rust: {input:?}"
                );
            }
            checked += 1;
        }
        assert!(checked >= 200);
    }

    #[test]
    fn aud007_normalize_parity_for_divergent_vectors() {
        let v = vectors();
        for vec in v["vectors"].as_array().unwrap() {
            if !vec["divergence"].is_null() {
                let input = vec["input"].as_str().unwrap();
                assert_eq!(
                    normalize_for_search(input),
                    vec["expected"].as_str().unwrap(),
                    "{input:?}"
                );
            }
        }
    }

    #[test]
    fn aud008_trim_parity_with_js() {
        let v = vectors();
        for t in v["trimVectors"].as_array().unwrap() {
            let input = t["input"].as_str().unwrap();
            assert_eq!(
                trim_query(input),
                t["jsTrim"].as_str().unwrap(),
                "{input:?}"
            );
        }
    }

    // --- مجسّات أداء (تقيس ولا تحكم؛ تُشغَّل يدويًا) ----------------------------

    #[test]
    #[ignore = "perf-probe: قياس فقط"]
    fn perf_probe_capture_at_limit_with_heavy_rows() {
        let dir = tmp_dir("perf");
        let store = Mutex::new(Store::load(dir.clone()));
        {
            let mut s = crate::lock_store(&store);
            let mut settings = s.settings.clone();
            settings.history_limit = 1000;
            s.update_settings_persisted(settings).unwrap();
        }
        let filler = "ع".repeat(16 * 1024);
        let t0 = std::time::Instant::now();
        {
            let mut s = crate::lock_store(&store);
            for i in 0..1000 {
                cap(&mut s, &format!("{i}-{filler}"));
            }
            s.save_history();
        }
        let fill = t0.elapsed();
        let mut worst = std::time::Duration::ZERO;
        for i in 0..20 {
            let t = std::time::Instant::now();
            cap_persist(&store, &format!("extra-{i}-{filler}")).unwrap();
            worst = worst.max(t.elapsed());
        }
        let size = fs::metadata(dir.join(HISTORY_FILE)).unwrap().len();
        let t = std::time::Instant::now();
        let r = Store::load(dir.clone());
        let load = t.elapsed();
        println!(
            "perf: fill1000={fill:?} worst_capture_at_limit={worst:?} history_bytes={size} load={load:?} rows={}",
            r.history.len()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "perf-probe: قياس فقط"]
    fn perf_probe_normalize_large_text() {
        let text = "أَهْلًا بِكُمْ ٠١٢٣ Hello ".repeat(40_000);
        let t = std::time::Instant::now();
        let out = normalize_for_search(&text);
        println!(
            "perf: normalize {} bytes -> {} bytes in {:?}",
            text.len(),
            out.len(),
            t.elapsed()
        );
    }
}

// م٢ — سلامة البيانات (roadmap-2026-10): 005 أسماء ملفات الصور، و017 دمج
// التراجع عن الحذف وقصّه، و016 ج2 اليومية التالفة، وت٨ بصم الصور القديمة.
#[cfg(test)]
mod data_safety_tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("raff-m2-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(IMAGES_DIR)).unwrap();
        dir
    }

    fn capture_text(s: &mut Store, text: &str) {
        s.capture(
            detect_kind(text),
            text.into(),
            None,
            None,
            None,
            None,
            None,
            ("Test".into(), "com.test".into()),
        );
    }

    /// A stored image row as JSON, with whatever names the file says.
    fn image_row(id: &str, image: &str, thumb: &str, hash: Option<&str>) -> serde_json::Value {
        let now = now_ms();
        let mut row = serde_json::json!({
            "id": id, "type": "image", "text": "صورة 10×10",
            "imageFile": image, "thumbFile": thumb,
            "sourceAppBundleId": "com.test", "sourceApp": "Test",
            "createdAt": now, "isPinned": false,
            "copyCount": 1, "pasteCount": 0, "lastUsedAt": now
        });
        if let Some(hash) = hash {
            row["hash"] = serde_json::json!(hash);
        }
        row
    }

    // 005 ────────────────────────────────────────────────────────────────

    #[test]
    fn an_image_name_has_to_stay_inside_the_images_folder() {
        for good in [
            "5f1c9a0e-1b2c-4d5e-8f90-1234567890ab.png",
            "5f1c9a0e-1b2c-4d5e-8f90-1234567890ab.thumb.png",
            "original.png",
            "preview.thumb.png",
        ] {
            assert!(is_safe_image_name(good), "{good}");
        }
        for bad in [
            "",
            "..",
            "../outside.png",
            "a/../../outside.png",
            "/etc/passwd",
            "sub/inside.png",
            "back\\slash.png",
            ".hidden.png",
            "two..dots.png",
            &"a".repeat(200),
        ] {
            assert!(!is_safe_image_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_row_naming_a_file_outside_is_disarmed_at_load_and_nothing_outside_is_read_or_deleted() {
        let dir = temp_dir();
        let outside = dir.join("outside.png");
        fs::write(&outside, b"not an image of ours").unwrap();
        let rows = serde_json::json!([image_row(
            "r1",
            "../outside.png",
            "../outside.png",
            Some("legacy")
        )]);
        fs::write(dir.join(HISTORY_FILE), serde_json::to_vec(&rows).unwrap()).unwrap();

        let mut s = Store::load(dir.clone());
        let item = s.find("r1").expect("the row stays");
        assert_eq!(item.image_file, None, "its name is dropped, not followed");
        assert_eq!(item.thumb_file, None);
        assert_eq!(
            item.hash, None,
            "and its fingerprint is not taken from that file"
        );
        assert!(
            !fs::read_to_string(dir.join(HISTORY_FILE))
                .unwrap()
                .contains("outside"),
            "written down, so the next launch does not meet it again"
        );

        let token = s.delete_reversible("r1").unwrap();
        s.commit_delete(&token).unwrap();
        assert!(outside.exists(), "deleting the row deletes nothing outside");
    }

    #[test]
    fn an_interrupted_delete_naming_a_file_outside_deletes_nothing_outside() {
        let dir = temp_dir();
        let outside = dir.join("outside.png");
        fs::write(&outside, b"keep me").unwrap();
        let journal = serde_json::json!({
            "token": "t", "item": image_row("gone", "../outside.png", "../outside.png", None),
            "layer": "history", "index": 0
        });
        fs::write(
            dir.join(PENDING_DELETE_FILE),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        let _ = Store::load(dir.clone());
        assert!(outside.exists());
        assert!(
            !dir.join(PENDING_DELETE_FILE).exists(),
            "the journal is still retired"
        );
    }

    // ت٨ ─────────────────────────────────────────────────────────────────

    #[test]
    fn an_old_image_row_without_a_fingerprint_gets_one_from_its_file() {
        let dir = temp_dir();
        fs::write(dir.join(IMAGES_DIR).join("old.png"), b"old picture").unwrap();
        let rows = serde_json::json!([image_row("old", "old.png", "old.thumb.png", None)]);
        fs::write(dir.join(HISTORY_FILE), serde_json::to_vec(&rows).unwrap()).unwrap();

        let s = Store::load(dir);
        assert_eq!(
            s.find("old").unwrap().hash.as_deref(),
            Some(content_hash(b"old picture").as_str())
        );
    }

    // 017 ────────────────────────────────────────────────────────────────

    /// IMP-07: a pinned item takes a name, which is kept, trimmed, capped,
    /// and gone with the pin.
    #[test]
    fn a_pinned_item_is_named_and_unpinning_drops_the_name() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "x");
        let id = s.history[0].id.clone();
        assert_eq!(
            s.set_label_persisted(&id, Some("اسم")),
            Err(LABEL_NOT_PINNED.to_string())
        );
        assert!(s.toggle_pin(&id));
        s.save_pinned();
        s.save_history();

        s.set_label_persisted(&id, Some("  عنوان المكتب  "))
            .unwrap();
        assert_eq!(s.pinned[0].label.as_deref(), Some("عنوان المكتب"));
        let reloaded = Store::load(s.dir.clone());
        assert_eq!(
            reloaded.pinned[0].label.as_deref(),
            Some("عنوان المكتب"),
            "persisted"
        );

        let long = "ب".repeat(LABEL_MAX_CHARS + 1);
        assert_eq!(
            s.set_label_persisted(&id, Some(&long)),
            Err(LABEL_TOO_LONG.to_string())
        );
        assert_eq!(
            s.pinned[0].label.as_deref(),
            Some("عنوان المكتب"),
            "unchanged by a refusal"
        );

        s.set_label_persisted(&id, Some("   ")).unwrap();
        assert_eq!(s.pinned[0].label, None, "blank clears it");
        s.set_label_persisted(&id, Some("اسم")).unwrap();
        assert!(s.toggle_pin(&id));
        let row = s
            .history
            .iter()
            .find(|i| i.id == id)
            .expect("back in history");
        assert_eq!(row.label, None, "unpinned, it has no name");
    }

    /// ت٤٥ ب٣: «مسح السجل» made the delete final while its «تراجع» was on
    /// screen. The undo then says the window is over, as a kind the panel can
    /// word, not a raw sentence that reached the user as «تعذّر حفظ التغيير».
    #[test]
    fn an_undo_after_the_delete_was_made_final_says_the_window_is_over() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "x");
        let id = s.history[0].id.clone();
        let token = s.delete_reversible(&id).unwrap();
        s.clear_history_persisted().unwrap();
        assert_eq!(s.undo_delete(&token), Err(UNDO_EXPIRED.to_string()));
        assert_eq!(
            s.undo_delete("no-such-token"),
            Err(UNDO_EXPIRED.to_string())
        );
    }

    #[test]
    fn undoing_a_delete_folds_into_the_same_text_copied_meanwhile() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "x");
        capture_text(&mut s, "y");
        let deleted = s.history.iter().find(|i| i.text == "x").unwrap().id.clone();
        s.find_mut(&deleted).unwrap().copy_count = 4;
        let token = s.delete_reversible(&deleted).unwrap();
        capture_text(&mut s, "x"); // copied again inside the undo window

        let standing = s.undo_delete(&token).expect("undo succeeds");
        let xs: Vec<&ClipItem> = s.history.iter().filter(|i| i.text == "x").collect();
        assert_eq!(standing, xs[0].id, "the panel is told which row it is now");
        assert_ne!(standing, deleted);
        assert_eq!(xs.len(), 1, "one row, not two");
        assert_eq!(xs[0].copy_count, 5, "carrying both counts");
        assert_eq!(s.history[0].text, "x", "where the new copy put it");
        assert!(s.pending_delete.is_none());

        let reloaded = Store::load(s.dir.clone());
        assert_eq!(reloaded.history.iter().filter(|i| i.text == "x").count(), 1);
    }

    #[test]
    fn undoing_a_pinned_delete_keeps_the_pin_and_takes_in_the_copy_made_meanwhile() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "pinned text");
        let id = s.history[0].id.clone();
        assert!(s.toggle_pin(&id));
        s.save_history();
        s.save_pinned();
        let token = s.delete_reversible(&id).unwrap();
        capture_text(&mut s, "pinned text"); // lands in history: the pin is gone for now

        let standing = s.undo_delete(&token).expect("undo succeeds");
        assert_eq!(standing, id, "a pin comes back as itself");
        let pinned = s
            .pinned
            .iter()
            .find(|i| i.id == id)
            .expect("back on the shelf");
        assert_eq!(pinned.text, "pinned text");
        assert_eq!(pinned.copy_count, 2, "the copy made meanwhile counts");
        assert!(
            s.history.iter().all(|i| i.text != "pinned text"),
            "and is not left behind in history as a duplicate"
        );
    }

    #[test]
    fn undo_trims_a_history_that_filled_meanwhile() {
        let mut s = Store::load(temp_dir());
        s.settings.history_limit = 3;
        for text in ["a", "b", "c"] {
            capture_text(&mut s, text);
        }
        let b = s.history.iter().find(|i| i.text == "b").unwrap().id.clone();
        let token = s.delete_reversible(&b).unwrap();
        capture_text(&mut s, "d"); // history full again: d, c, a

        s.undo_delete(&token).expect("undo succeeds");
        let texts: Vec<&str> = s.history.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(
            texts,
            ["d", "c", "b"],
            "b is back and the oldest leaves, as for any copy"
        );
    }

    #[test]
    fn an_undo_the_history_no_longer_has_room_for_says_so() {
        let mut s = Store::load(temp_dir());
        s.settings.history_limit = 2;
        capture_text(&mut s, "a");
        capture_text(&mut s, "b");
        let a = s.history.iter().find(|i| i.text == "a").unwrap().id.clone();
        let token = s.delete_reversible(&a).unwrap();
        capture_text(&mut s, "c"); // c, b: «a» would now be the one to leave

        assert_eq!(
            s.undo_delete(&token),
            Err(UNDO_NO_ROOM.to_string()),
            "it cannot come back, and the panel says why"
        );
        assert!(s.find(&a).is_none());
        assert!(s.pending_delete.is_none(), "the receipt is spent");
        assert_eq!(s.history.len(), 2);
    }

    fn capture_image(s: &mut Store, file: &str, hash: &str) {
        s.capture(
            ItemKind::Image,
            "صورة 10×10".into(),
            None,
            None,
            Some(format!("{file}.png")),
            Some(format!("{file}.thumb.png")),
            Some(hash.into()),
            ("Test".into(), "com.test".into()),
        );
    }

    #[test]
    fn a_pin_still_being_written_is_finished_before_an_undo_reshapes_the_shelf() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "t");
        let deleted = s.history[0].id.clone();
        assert!(s.toggle_pin(&deleted));
        let token = s.delete_reversible(&deleted).unwrap();
        capture_text(&mut s, "t"); // the same text again, in history
        let copy = s.history[0].id.clone();
        assert!(s.toggle_pin(&copy)); // pinned too — its journal not yet retired
        let item = s.find(&copy).unwrap().clone();
        s.pending_pin = Some(PendingPin {
            item,
            desired: true,
            dropped: Vec::new(),
        });

        s.undo_delete(&token).expect("undo succeeds");
        capture_text(&mut s, "something else"); // any later change finishes pins
        assert_eq!(
            s.pinned.iter().filter(|i| i.text == "t").count(),
            1,
            "one pinned «t», not two"
        );
    }

    #[test]
    fn a_pinned_undo_that_cannot_finish_leaves_the_disk_as_the_memory() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "p");
        let deleted = s.history[0].id.clone();
        assert!(s.toggle_pin(&deleted));
        s.save_history();
        s.save_pinned();
        let token = s.delete_reversible(&deleted).unwrap();
        capture_text(&mut s, "p");
        s.save_history();
        // history.json can no longer be written: the second of the two writes fails.
        fs::remove_file(s.dir.join(HISTORY_FILE)).unwrap();
        fs::create_dir(s.dir.join(HISTORY_FILE)).unwrap();

        assert!(s.undo_delete(&token).is_err());
        assert!(
            s.pinned.iter().all(|i| i.id != deleted),
            "memory rolled back"
        );
        let on_disk = fs::read_to_string(s.dir.join(PINNED_FILE)).unwrap();
        assert!(!on_disk.contains(&deleted), "and the shelf on disk with it");
        assert!(
            s.pending_delete.is_some(),
            "the receipt stays for another try"
        );
    }

    #[test]
    fn an_older_duplicate_is_not_mistaken_for_the_copy_made_meanwhile() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "same");
        let deleted = s.history[0].id.clone();
        // An older row of the same text (two such rows can predate fingerprints).
        let mut older = s.history[0].clone();
        older.id = "older".into();
        older.created_at -= 60_000;
        s.history.push(older);
        let token = s.delete_reversible(&deleted).unwrap();

        s.undo_delete(&token).expect("undo succeeds");
        assert!(s.find(&deleted).is_some(), "it comes back as itself");
        assert!(s.find("older").is_some(), "and the older row is left alone");
    }

    #[test]
    fn a_pinned_picture_whose_file_is_gone_takes_the_copy_s_file() {
        let mut s = Store::load(temp_dir());
        capture_image(&mut s, "lost", "f1:0000000000000001");
        let images = s.images_dir();
        // Its picture is gone; its thumbnail outlived it.
        fs::write(images.join("lost.thumb.png"), b"thumb").unwrap();
        let deleted = s.history[0].id.clone();
        assert!(s.toggle_pin(&deleted));
        let token = s.delete_reversible(&deleted).unwrap();
        fs::write(images.join("fresh.png"), b"png").unwrap();
        fs::write(images.join("fresh.thumb.png"), b"thumb").unwrap();
        capture_image(&mut s, "fresh", "f1:0000000000000001");

        s.undo_delete(&token).expect("undo succeeds");
        let pinned = s.find(&deleted).unwrap();
        assert_eq!(
            pinned.image_file.as_deref(),
            Some("fresh.png"),
            "the file that exists"
        );
        assert!(images.join("fresh.png").exists(), "and it is kept");
        assert!(
            !images.join("lost.thumb.png").exists(),
            "the thumbnail of the lost picture names nothing now"
        );
    }

    #[test]
    fn an_undo_past_the_retention_period_says_that_rather_than_no_room() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "old");
        let deleted = s.history[0].id.clone();
        s.find_mut(&deleted).unwrap().created_at = now_ms() - 3 * 86_400_000;
        s.settings.retention_days = 1;
        let token = s.delete_reversible(&deleted).unwrap();
        assert_eq!(s.undo_delete(&token), Err(UNDO_RETENTION.to_string()));
    }

    #[test]
    fn a_newer_duplicate_from_before_the_delete_is_not_the_copy_made_meanwhile() {
        let mut s = Store::load(temp_dir());
        capture_text(&mut s, "same");
        let deleted = s.history[0].id.clone();
        s.find_mut(&deleted).unwrap().created_at -= 120_000;
        // A newer row of the same text, already there before the delete
        // (two such rows can predate fingerprints).
        let mut newer = s.history[0].clone();
        newer.id = "newer".into();
        newer.created_at += 60_000;
        s.history.insert(0, newer);
        let token = s.delete_reversible(&deleted).unwrap();

        s.undo_delete(&token).expect("undo succeeds");
        assert!(s.find(&deleted).is_some(), "it comes back as itself");
        assert_eq!(
            s.find("newer").unwrap().copy_count,
            1,
            "and the row that was already there is not folded into"
        );
    }

    /// Writes the files a picture names, so that what an undo deletes or
    /// keeps can be seen on disk.
    fn picture_files(s: &Store, names: &[&str]) {
        for name in names {
            fs::write(s.images_dir().join(format!("{name}.png")), b"png").unwrap();
            fs::write(s.images_dir().join(format!("{name}.thumb.png")), b"thumb").unwrap();
        }
    }

    fn has_files(s: &Store, name: &str) -> (bool, bool) {
        let images = s.images_dir();
        (
            images.join(format!("{name}.png")).exists(),
            images.join(format!("{name}.thumb.png")).exists(),
        )
    }

    #[test]
    fn a_pinned_undo_takes_in_a_copy_pinned_meanwhile_and_keeps_its_own_picture() {
        let mut s = Store::load(temp_dir());
        picture_files(&s, &["own", "copy"]);
        capture_image(&mut s, "own", "f1:0000000000000002");
        let deleted = s.history[0].id.clone();
        assert!(s.toggle_pin(&deleted));
        let token = s.delete_reversible(&deleted).unwrap();
        capture_image(&mut s, "copy", "f1:0000000000000002");
        let copy = s.history[0].id.clone();
        assert!(s.toggle_pin(&copy));

        s.undo_delete(&token).expect("undo succeeds");
        assert_eq!(s.pinned.len(), 1, "one pinned picture, not two");
        assert_eq!(s.pinned[0].id, deleted);
        assert_eq!(s.pinned[0].copy_count, 2);
        assert_eq!(has_files(&s, "own"), (true, true), "its own files stay");
        assert_eq!(has_files(&s, "copy"), (false, false), "the copy's go");
        assert_eq!(Store::load(s.dir.clone()).pinned.len(), 1);
    }

    #[test]
    fn a_pinned_undo_takes_in_a_copy_from_history_and_keeps_its_own_picture() {
        let mut s = Store::load(temp_dir());
        picture_files(&s, &["own", "copy"]);
        capture_image(&mut s, "own", "f1:0000000000000003");
        let deleted = s.history[0].id.clone();
        assert!(s.toggle_pin(&deleted));
        let token = s.delete_reversible(&deleted).unwrap();
        capture_image(&mut s, "copy", "f1:0000000000000003");

        s.undo_delete(&token).expect("undo succeeds");
        assert_eq!(
            s.pinned[0].image_file.as_deref(),
            Some("own.png"),
            "its file exists"
        );
        assert!(s.history.is_empty(), "the copy left history");
        assert_eq!(has_files(&s, "own"), (true, true));
        assert_eq!(has_files(&s, "copy"), (false, false));
    }

    #[test]
    fn a_history_undo_folds_into_a_copy_and_its_own_picture_goes() {
        let mut s = Store::load(temp_dir());
        picture_files(&s, &["own", "copy"]);
        capture_image(&mut s, "own", "f1:0000000000000004");
        let deleted = s.history[0].id.clone();
        s.find_mut(&deleted).unwrap().copy_count = 3;
        let token = s.delete_reversible(&deleted).unwrap();
        capture_image(&mut s, "copy", "f1:0000000000000004");
        let copy = s.history[0].id.clone();

        s.undo_delete(&token).expect("undo succeeds");
        assert!(s.find(&deleted).is_none(), "it is back as the copy");
        assert_eq!(s.find(&copy).unwrap().copy_count, 4);
        assert_eq!(
            has_files(&s, "copy"),
            (true, true),
            "the survivor's files stay"
        );
        assert_eq!(has_files(&s, "own"), (false, false), "its own go");
        assert_eq!(
            Store::load(s.dir.clone()).find(&copy).unwrap().copy_count,
            4
        );
    }

    #[test]
    fn a_history_undo_folds_into_a_copy_pinned_meanwhile() {
        let mut s = Store::load(temp_dir());
        picture_files(&s, &["own", "copy"]);
        capture_image(&mut s, "own", "f1:0000000000000005");
        let deleted = s.history[0].id.clone();
        s.find_mut(&deleted).unwrap().copy_count = 3;
        let token = s.delete_reversible(&deleted).unwrap();
        capture_image(&mut s, "copy", "f1:0000000000000005");
        let copy = s.history[0].id.clone();
        assert!(s.toggle_pin(&copy));

        let standing = s.undo_delete(&token).expect("undo succeeds");
        assert_eq!(standing, copy, "folded into the pinned copy");
        assert!(s.find(&deleted).is_none());
        assert!(s.history.is_empty(), "not back in history beside its pin");
        assert_eq!(s.pinned[0].id, copy);
        assert_eq!(s.pinned[0].copy_count, 4, "the pin carries both counts");
        assert_eq!(has_files(&s, "copy"), (true, true));
        assert_eq!(has_files(&s, "own"), (false, false));
        let reloaded = Store::load(s.dir.clone());
        assert_eq!(reloaded.pinned[0].copy_count, 4);
    }

    #[test]
    fn a_history_undo_that_cannot_be_written_deletes_nothing_it_would_have_trimmed() {
        let mut s = Store::load(temp_dir());
        s.settings.history_limit = 2;
        picture_files(&s, &["old"]);
        capture_image(&mut s, "old", "f1:0000000000000006");
        let old = s.history[0].id.clone();
        capture_text(&mut s, "a");
        let a = s.history[0].id.clone();
        let token = s.delete_reversible(&a).unwrap();
        capture_text(&mut s, "b"); // b, old: «a» back would push «old» out
        s.save_history();
        fs::remove_file(s.dir.join(HISTORY_FILE)).unwrap();
        fs::create_dir(s.dir.join(HISTORY_FILE)).unwrap();

        assert!(s.undo_delete(&token).is_err());
        assert!(s.find(&a).is_none(), "memory rolled back");
        assert!(
            s.find(&old).is_some(),
            "the row it would have trimmed stays"
        );
        assert_eq!(has_files(&s, "old"), (true, true), "with its files");
        assert!(
            s.pending_delete.is_some(),
            "the receipt stays for another try"
        );
    }

    #[test]
    fn names_outside_are_disarmed_on_the_shelf_and_in_a_pin_journal() {
        let dir = temp_dir();
        let outside = dir.join("outside.png");
        fs::write(&outside, b"keep me").unwrap();
        let mut shelf = image_row("p1", "../outside.png", "../outside.png", Some("f1:1"));
        shelf["isPinned"] = serde_json::json!(true);
        fs::write(
            dir.join(PINNED_FILE),
            serde_json::to_vec(&serde_json::json!([shelf])).unwrap(),
        )
        .unwrap();
        let history = serde_json::json!([image_row("p2", "p2.png", "p2.thumb.png", Some("f1:2"))]);
        fs::write(
            dir.join(HISTORY_FILE),
            serde_json::to_vec(&history).unwrap(),
        )
        .unwrap();
        let journal = serde_json::json!({
            "item": image_row("p2", "p2.png", "p2.thumb.png", Some("f1:2")),
            "desired": true,
            "dropped": [image_row("d1", "../outside.png", "../outside.png", None)]
        });
        fs::write(
            dir.join(PENDING_PIN_FILE),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        let s = Store::load(dir.clone());
        let p1 = s.find("p1").expect("the pinned row stays");
        assert_eq!(
            (p1.image_file.as_ref(), p1.thumb_file.as_ref()),
            (None, None)
        );
        assert!(
            outside.exists(),
            "finishing the pin deletes nothing outside"
        );
        assert!(
            !dir.join(PENDING_PIN_FILE).exists(),
            "the journal is retired"
        );
    }

    // ت٤٦: a stop (power cut, crash) at any step of an undo ─────────────────

    /// The undo branches, by where the item was and where a copy of it is.
    #[derive(Clone, Copy, Debug)]
    enum Undo {
        History,
        Pinned,
        HistoryIntoCopy,
        HistoryIntoPinnedCopy,
        PinnedTakingCopy,
        PinnedTakingCopyItsOwnFileGone,
        PinnedTakingPinnedCopy,
    }

    const EVERY_UNDO: [Undo; 7] = [
        Undo::History,
        Undo::Pinned,
        Undo::HistoryIntoCopy,
        Undo::HistoryIntoPinnedCopy,
        Undo::PinnedTakingCopy,
        Undo::PinnedTakingCopyItsOwnFileGone,
        Undo::PinnedTakingPinnedCopy,
    ];

    /// A deleted picture waiting for its undo, in the shape `undo` names.
    fn deleted_picture(undo: Undo) -> (Store, String) {
        let mut s = Store::load(temp_dir());
        picture_files(&s, &["own", "copy"]);
        // Each capture is written down, as `capture_and_persist` does.
        capture_text(&mut s, "beside"); // history is never left empty
        capture_image(&mut s, "own", "f1:00000000000000aa");
        s.save_history();
        let id = s.history[0].id.clone();
        if matches!(
            undo,
            Undo::Pinned
                | Undo::PinnedTakingCopy
                | Undo::PinnedTakingCopyItsOwnFileGone
                | Undo::PinnedTakingPinnedCopy
        ) {
            assert!(s.set_pin_persisted(&id, true).unwrap());
        }
        if matches!(undo, Undo::PinnedTakingCopyItsOwnFileGone) {
            fs::remove_file(s.images_dir().join("own.png")).unwrap();
        }
        let token = s.delete_reversible(&id).unwrap();
        if !matches!(undo, Undo::History | Undo::Pinned) {
            capture_image(&mut s, "copy", "f1:00000000000000aa");
            s.save_history();
        }
        if matches!(
            undo,
            Undo::HistoryIntoPinnedCopy | Undo::PinnedTakingPinnedCopy
        ) {
            let copy = s.history[0].id.clone();
            assert!(s.set_pin_persisted(&copy, true).unwrap());
        }
        (s, token)
    }

    /// Runs the undo and stops the process right after its `after`-th step.
    fn undo_stopped_after(s: &mut Store, token: &str, after: usize) {
        stop::arm(after);
        let stopped =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.undo_delete(token)))
                .is_err();
        stop::disarm();
        assert!(stopped, "the undo has a step {after} to stop after");
    }

    fn assert_rows_have_their_files(s: &Store, label: &str) {
        let images = s.images_dir();
        for item in s.history.iter().chain(&s.pinned) {
            for file in [&item.image_file, &item.thumb_file].into_iter().flatten() {
                assert!(
                    images.join(file).exists(),
                    "{label}: {} lost {file}",
                    item.id
                );
            }
        }
    }

    /// Restarts, then deletes every row one at a time, restarting after each:
    /// no step may take a file another saved row still names, and at the end
    /// nothing is left behind.
    fn restart_and_empty(dir: &Path, label: &str) {
        let mut s = Store::load(dir.to_path_buf());
        assert!(
            s.pending_delete.is_none(),
            "{label}: the receipt is settled"
        );
        assert_rows_have_their_files(&s, label);
        let pictures = s
            .history
            .iter()
            .chain(&s.pinned)
            .filter(|i| i.kind == ItemKind::Image)
            .count();
        assert_eq!(pictures, 1, "{label}: one row of the picture");
        while let Some(id) = s.history.first().or(s.pinned.first()).map(|i| i.id.clone()) {
            let token = s.delete_reversible(&id).unwrap();
            s.commit_delete(&token).unwrap();
            s = Store::load(dir.to_path_buf());
            assert_rows_have_their_files(&s, label);
        }
        let left: Vec<_> = fs::read_dir(dir.join(IMAGES_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert!(left.is_empty(), "{label}: left behind {left:?}");
    }

    #[test]
    fn a_stop_between_the_writes_of_a_pinned_undo_loses_no_picture() {
        // The pinned picture's own file is gone, so it takes its copy's; the
        // shelf reaches the disk, then the process stops before history does.
        let (mut s, token) = deleted_picture(Undo::PinnedTakingCopyItsOwnFileGone);
        let pinned = s.pending_delete.as_ref().unwrap().item.id.clone();
        undo_stopped_after(&mut s, &token, 1);
        let dir = s.dir.clone();
        drop(s);

        let mut s = Store::load(dir.clone());
        let item = s.find(&pinned).expect("the pinned picture is back");
        assert_eq!(item.image_file.as_deref(), Some("copy.png"));
        assert_eq!(
            s.history
                .iter()
                .filter(|i| i.kind == ItemKind::Image)
                .count(),
            0,
            "the copy it took in is not left in history beside it"
        );
        // Whatever goes from history next, the pinned picture keeps its file.
        while let Some(id) = s.history.first().map(|i| i.id.clone()) {
            let token = s.delete_reversible(&id).unwrap();
            s.commit_delete(&token).unwrap();
        }
        let s = Store::load(dir);
        assert!(s.images_dir().join("copy.png").exists());
        assert!(s.images_dir().join("copy.thumb.png").exists());
        assert_eq!(s.find(&pinned).unwrap().copy_count, 2);
    }

    #[test]
    fn a_file_another_saved_row_names_is_never_deleted_with_a_row() {
        // However two rows came to name one file, deleting one keeps it.
        let mut s = Store::load(temp_dir());
        picture_files(&s, &["shared"]);
        capture_image(&mut s, "shared", "f1:00000000000000bb");
        let pinned = s.history[0].id.clone();
        assert!(s.set_pin_persisted(&pinned, true).unwrap());
        let mut twin = s.find(&pinned).unwrap().clone();
        twin.id = "twin".into();
        twin.is_pinned = false;
        s.history.insert(0, twin);
        s.save_history();

        let token = s.delete_reversible("twin").unwrap();
        s.commit_delete(&token).unwrap();
        assert_eq!(
            has_files(&s, "shared"),
            (true, true),
            "the pin still names them"
        );
        let mut s = Store::load(s.dir.clone());
        assert_eq!(
            has_files(&s, "shared"),
            (true, true),
            "and a restart keeps them"
        );

        let token = s.delete_reversible(&pinned).unwrap();
        s.commit_delete(&token).unwrap();
        assert_eq!(
            has_files(&s, "shared"),
            (false, false),
            "the last row takes them"
        );
    }

    #[test]
    fn every_stop_inside_an_undo_leaves_each_saved_row_its_files() {
        let mut stops = 0;
        for undo in EVERY_UNDO {
            let (mut s, token) = deleted_picture(undo);
            stop::arm(usize::MAX);
            s.undo_delete(&token)
                .expect("an uninterrupted undo succeeds");
            let steps = stop::disarm();
            assert!(steps >= 2, "{undo:?}: a layer and the receipt, at least");
            restart_and_empty(&s.dir.clone(), &format!("{undo:?}, uninterrupted"));

            for after in 1..=steps {
                let (mut s, token) = deleted_picture(undo);
                undo_stopped_after(&mut s, &token, after);
                let dir = s.dir.clone();
                drop(s);
                restart_and_empty(&dir, &format!("{undo:?}, stopped after step {after}"));
            }
            stops += steps;
            eprintln!("{undo:?}: {steps} steps, a stop after each");
        }
        eprintln!("{stops} stops across {} undo shapes", EVERY_UNDO.len());
    }

    // 016 ج2 ──────────────────────────────────────────────────────────────

    #[test]
    fn an_unreadable_journal_is_set_aside_then_removed() {
        let dir = temp_dir();
        fs::write(dir.join(PENDING_DELETE_FILE), b"{not json").unwrap();
        fs::write(dir.join(PENDING_PIN_FILE), b"[also not").unwrap();

        let _ = Store::load(dir.clone());
        for (journal, copy) in [
            (PENDING_DELETE_FILE, "pending-delete.json.corrupt"),
            (PENDING_PIN_FILE, "pending-pin.json.corrupt"),
        ] {
            assert!(
                !dir.join(journal).exists(),
                "{journal} does not linger to the next launch"
            );
            assert!(dir.join(copy).exists(), "{journal}'s bytes are kept aside");
        }
    }

    #[test]
    fn an_unreadable_journal_that_could_not_be_set_aside_stays() {
        let dir = temp_dir();
        fs::write(dir.join(PENDING_DELETE_FILE), b"{not json").unwrap();
        // The copy cannot be written: its staging name is taken by a folder.
        fs::create_dir(dir.join("pending-delete.json.corrupt.tmp")).unwrap();

        let _ = Store::load(dir.clone());
        assert!(
            dir.join(PENDING_DELETE_FILE).exists(),
            "its bytes are nowhere else, so it is not removed"
        );
    }
}
