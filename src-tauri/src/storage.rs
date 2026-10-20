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
    /// Milliseconds since epoch: when the row took its place in the timeline.
    /// History is ordered by it, and the age limit counts from it.
    pub created_at: u64,
    /// When the content was captured, if that is not `created_at`: a row
    /// unpinned back to the top of history keeps the date it was copied on.
    /// Absent from older files and from every row never unpinned; a new copy
    /// of the same content clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<u64>,
    pub is_pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_order: Option<u32>,
    // Silent learning signals (v1: logging only — no adaptive behavior).
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
    PinnedBumped {
        index: usize,
        previous: Box<ClipItem>,
    },
    /// The history row at `index` was moved to the head and overwritten.
    HistoryBumped {
        index: usize,
        previous: Box<ClipItem>,
    },
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
        match item.hash.as_deref() {
            Some(hash) if !hash.starts_with(HASH_PREFIX) => {
                item.hash = item
                    .image_file
                    .as_ref()
                    .and_then(|file| fs::read(images_dir.join(file)).ok())
                    .map(|bytes| content_hash(&bytes));
                changed = true;
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
    Ok(())
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
        let (mut settings, settings_loaded): (Settings, bool) =
            load_json_with_status(&dir.join(SETTINGS_FILE));
        if !settings_loaded {
            settings.capture_enabled = false;
            settings.settings_recovered = true;
            // A file that existed means the welcome already ran; reopening it
            // would put its «أبقِه يعمل» ahead of the review this calls for.
            settings.first_run_shown = true;
        }
        let pending_delete: Option<PendingDelete> = load_json(&dir.join(PENDING_DELETE_FILE));
        let pending_pin: Option<PendingPin> = load_json(&dir.join(PENDING_PIN_FILE));
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
        };

        store.resolve_interrupted_pin();
        // A toast cannot survive a process restart, so a journal from the
        // previous process is resolved immediately. Transaction ordering makes
        // this safe in both crash windows:
        // - item still on disk => delete never committed; preserve its files
        // - item absent on disk => deletion committed; clean up its files
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
            return CaptureResult {
                outcome: CaptureOutcome::Failed,
                dropped: Vec::new(),
                layer: None,
                undo: CaptureUndo::Nothing,
            };
        }
        let now = self.next_stamp();
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
            p.captured_at = None;
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
            item.captured_at = None;
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
            captured_at: None,
            is_pinned: false,
            pinned_order: None,
            copy_count: 1,
            paste_count: 0,
            last_used_at: now,
        };
        self.history.insert(0, item);
        CaptureResult {
            outcome: CaptureOutcome::Added,
            dropped: self.prune_history(),
            layer: Some(DeletedLayer::History),
            undo: CaptureUndo::Added,
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

    /// Applies the retention policy now and writes the result.
    ///
    /// The entry point for every prune that is not a capture: a shrunk limit,
    /// a shortened retention window, launch, and the hourly sweep. Time-based
    /// retention cannot ride on captures the way the count could — a sensitive
    /// copy followed by a fortnight away from the machine is precisely the
    /// case the promise was made for, and precisely the case with no capture
    /// to hang a prune on.
    pub fn trim_history(&mut self) {
        let dropped = self.prune_history();
        if dropped.is_empty() {
            return;
        }
        self.save_history();
        for item in &dropped {
            self.delete_files(item);
        }
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

    /// Pin moves the item from the recent layer to the pinned shelf (the
    /// two layers). Unpin returns it to the top of history, as a new copy
    /// would arrive, while it keeps showing the date it was captured.
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
            let stamp = self.next_stamp();
            let mut item = self.pinned.remove(pos);
            item.is_pinned = false;
            item.pinned_order = None;
            // The first capture date survives any number of pin/unpin rounds.
            item.captured_at.get_or_insert(item.created_at);
            item.created_at = stamp;
            self.history.insert(0, item);
            return true;
        }
        false
    }

    /// Moves an item between the two persisted layers without ever reporting
    /// success for an in-memory-only change. The destination is written first
    /// (a crash can at worst leave a recoverable duplicate, never lose the
    /// item); any write failure restores both vectors and best-effort rewrites
    /// their previous durable snapshots before returning an error to the UI.
    /// History is trimmed by the whole retention policy (`prune_history`); an
    /// unpinned row is on top with a fresh place in the timeline, so it is
    /// never the one that goes — the oldest row makes room, as for a copy.
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

        let dropped = self.prune_history();

        // From here on every early return puts both layers back first.
        let Some(moved) = self.find(id).cloned() else {
            self.history = old_history;
            self.pinned = old_pinned;
            return Err("العنصر غير موجود".into());
        };
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
            item.last_used_at = item.captured_at.unwrap_or(item.created_at);
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

        s.trim_history();

        assert_eq!(s.history.len(), 1, "0 means the age limit is not in play");
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
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        s.settings.history_limit = 1;
        capture_text(&mut s, "pinned item");
        let pinned_id = s.history[0].id.clone();
        assert!(s.toggle_pin(&pinned_id));
        capture_text(&mut s, "old history");
        let old_id = s.history[0].id.clone();
        // Cap is now satisfied by one historical item + one pinned item. The
        // unpin below puts the pinned item on top, so the old row is the one
        // the full history evicts.
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

    /// A full history (limit 2, in memory only), and a pinned row captured
    /// before everything in it (`created_at` 1).
    fn full_history_and_an_older_pinned_row() -> (Store, String) {
        let mut s = store();
        s.settings.history_limit = 2;
        capture_text(&mut s, "pinned long ago");
        let id = s.history[0].id.clone();
        s.set_pin_persisted(&id, true).unwrap();
        s.find_mut(&id).unwrap().created_at = 1;
        s.save_pinned();
        capture_text(&mut s, "recent a");
        capture_text(&mut s, "recent b");
        s.save_history();
        (s, id)
    }

    fn layer_on_disk(s: &Store, file: &str) -> Vec<ClipItem> {
        serde_json::from_slice(&fs::read(s.dir.join(file)).unwrap()).unwrap()
    }

    /// Two pinned rows older than everything in a full history, with the
    /// limit (3) written to disk so a reload keeps it.
    fn full_history_and_two_older_pinned_rows() -> (Store, String, String) {
        let mut s = store();
        let mut settings = s.settings.clone();
        settings.history_limit = 3;
        s.update_settings_persisted(settings).unwrap();
        let mut pinned = Vec::new();
        for (text, at) in [("first pinned long ago", 1), ("second pinned long ago", 2)] {
            capture_text(&mut s, text);
            let id = s.history[0].id.clone();
            s.set_pin_persisted(&id, true).unwrap();
            s.find_mut(&id).unwrap().created_at = at;
            pinned.push(id);
        }
        s.save_pinned();
        for text in ["recent a", "recent b", "recent c"] {
            capture_text(&mut s, text);
        }
        s.save_history();
        assert_eq!(s.history.len(), 3);
        (s, pinned[0].clone(), pinned[1].clone())
    }

    fn history_ids(s: &Store) -> Vec<String> {
        s.history.iter().map(|item| item.id.clone()).collect()
    }

    #[test]
    fn unpinning_returns_the_row_to_the_top_and_the_oldest_row_makes_room() {
        let (mut s, id) = full_history_and_an_older_pinned_row();
        let newest_before = s.history[0].created_at;
        let kept = s.history[0].id.clone();
        let oldest = s.history[1].id.clone();

        assert_eq!(s.set_pin_persisted(&id, false), Ok(false));

        assert_eq!(s.history.len(), 2, "the limit holds");
        assert_eq!(s.history[0].id, id, "back at the top");
        assert!(!s.history[0].is_pinned);
        assert_eq!(
            s.history[0].captured_at,
            Some(1),
            "its capture date is kept"
        );
        assert!(
            s.history[0].created_at > newest_before,
            "its place in the timeline is now"
        );
        assert!(s.find(&kept).is_some());
        assert!(
            s.find(&oldest).is_none(),
            "the oldest row makes room, as for any new copy"
        );
        let on_disk = layer_on_disk(&s, HISTORY_FILE);
        assert_eq!(on_disk[0].id, id, "written down, not only kept in memory");
        assert_eq!(on_disk[0].captured_at, Some(1));
        assert!(layer_on_disk(&s, PINNED_FILE).is_empty());
        assert!(!s.dir.join(PENDING_PIN_FILE).exists());
    }

    #[test]
    fn returned_rows_survive_the_next_unpin_a_settings_change_the_sweep_a_capture_and_a_reload() {
        let (mut s, first, second) = full_history_and_two_older_pinned_rows();

        s.set_pin_persisted(&first, false).unwrap();
        s.set_pin_persisted(&second, false).unwrap();
        assert_eq!(history_ids(&s)[..2], [second.clone(), first.clone()]);
        assert_eq!(s.history.len(), 3);

        let mut settings = s.settings.clone();
        settings.learning_enabled = !settings.learning_enabled;
        s.update_settings_persisted(settings).unwrap();
        s.trim_history(); // what the hourly sweep runs
        assert_eq!(history_ids(&s)[..2], [second.clone(), first.clone()]);

        let result = s.capture(
            ItemKind::Text,
            "recent d".into(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        let dir = s.dir.clone();
        let store = std::sync::Mutex::new(s);
        persist_capture(&store, result).unwrap();
        let s = store.into_inner().unwrap();
        assert_eq!(s.history.len(), 3, "the limit holds");
        assert_eq!(history_ids(&s)[1..], [second.clone(), first.clone()]);

        let reloaded = Store::load(dir);
        assert_eq!(history_ids(&reloaded)[1..], [second.clone(), first.clone()]);
        assert_eq!(reloaded.find(&first).unwrap().captured_at, Some(1));
        assert_eq!(reloaded.find(&second).unwrap().captured_at, Some(2));
    }

    #[test]
    fn the_age_limit_counts_from_the_return_not_from_the_capture() {
        let mut s = store();
        let mut settings = s.settings.clone();
        settings.retention_days = 7;
        s.update_settings_persisted(settings).unwrap();
        capture_text(&mut s, "a month on the pinned shelf");
        let id = s.history[0].id.clone();
        s.set_pin_persisted(&id, true).unwrap();
        let month_ago = now_ms() - 30 * 24 * 60 * 60 * 1000;
        s.find_mut(&id).unwrap().created_at = month_ago;
        s.save_pinned();

        s.set_pin_persisted(&id, false).unwrap();
        s.trim_history();

        assert_eq!(
            s.find(&id).and_then(|item| item.captured_at),
            Some(month_ago)
        );
        let reloaded = Store::load(s.dir.clone());
        let item = reloaded
            .find(&id)
            .expect("still there after the sweep and a reload");
        assert_eq!(item.captured_at, Some(month_ago));
    }

    #[test]
    fn pinning_and_unpinning_again_keeps_the_first_capture_date() {
        let mut s = store();
        capture_text(&mut s, "back and forth");
        let id = s.history[0].id.clone();
        let captured = s.history[0].created_at;

        for round in 0..3 {
            s.set_pin_persisted(&id, true).unwrap();
            assert_eq!(
                s.find(&id).unwrap().captured_at,
                (round > 0).then_some(captured),
                "round {round}: pinning does not touch it"
            );
            capture_text(&mut s, &format!("copied while pinned {round}"));
            s.set_pin_persisted(&id, false).unwrap();
            assert_eq!(s.history[0].id, id, "round {round}: back on top");
            assert_eq!(
                s.history[0].captured_at,
                Some(captured),
                "round {round}: the first capture date, not the last return"
            );
        }

        let reloaded = Store::load(s.dir.clone());
        assert_eq!(reloaded.history[0].id, id);
        assert_eq!(reloaded.history[0].captured_at, Some(captured));
    }

    #[test]
    fn copying_a_returned_row_again_is_a_fresh_capture() {
        let (mut s, id) = full_history_and_an_older_pinned_row();
        s.set_pin_persisted(&id, false).unwrap();
        assert_eq!(s.find(&id).unwrap().captured_at, Some(1));
        assert_eq!(
            capture_text(&mut s, "pinned long ago"),
            CaptureOutcome::Deduped
        );
        assert_eq!(
            s.find(&id).unwrap().captured_at,
            None,
            "in history: a new copy is a new capture date"
        );

        let (mut s, id) = full_history_and_an_older_pinned_row();
        s.set_pin_persisted(&id, false).unwrap();
        s.set_pin_persisted(&id, true).unwrap();
        assert_eq!(s.find(&id).unwrap().captured_at, Some(1));
        assert_eq!(
            capture_text(&mut s, "pinned long ago"),
            CaptureOutcome::Deduped
        );
        assert_eq!(
            s.find(&id).unwrap().captured_at,
            None,
            "on the pinned shelf as well"
        );
    }

    #[test]
    fn undoing_the_delete_of_a_returned_row_puts_it_back_on_top_with_its_date() {
        let (mut s, id) = full_history_and_an_older_pinned_row();
        s.set_pin_persisted(&id, false).unwrap();
        let before = history_ids(&s);

        let token = s.delete_reversible(&id).unwrap();
        assert!(s.find(&id).is_none());
        s.undo_delete(&token).unwrap();

        assert_eq!(history_ids(&s), before, "exactly where it was");
        assert_eq!(s.history[0].id, id);
        assert_eq!(s.history[0].captured_at, Some(1));
        assert!(s.history.len() <= s.settings.history_limit);
        let reloaded = Store::load(s.dir.clone());
        assert_eq!(reloaded.history[0].id, id);
        assert_eq!(reloaded.history[0].captured_at, Some(1));
    }

    #[test]
    fn a_refused_unpin_leaves_the_row_pinned_with_its_dates_and_drops_nothing() {
        let (mut s, id) = full_history_and_an_older_pinned_row();
        let before = s.find(&id).unwrap().clone();
        let history_before = history_ids(&s);
        fs::create_dir(s.dir.join(PENDING_PIN_FILE)).unwrap();

        assert!(s.set_pin_persisted(&id, false).is_err());

        let item = s.find(&id).unwrap();
        assert!(item.is_pinned);
        assert_eq!(item.created_at, before.created_at, "its place is restored");
        assert_eq!(item.captured_at, None, "and no capture date was invented");
        assert_eq!(history_ids(&s), history_before, "nothing made room for it");
    }

    #[test]
    fn clearing_learning_dates_a_returned_row_by_its_capture() {
        let (mut s, id) = full_history_and_an_older_pinned_row();
        s.set_pin_persisted(&id, false).unwrap();

        s.clear_learning();

        assert_eq!(s.find(&id).unwrap().last_used_at, 1);
    }

    #[test]
    fn an_interrupted_unpin_comes_back_on_top_with_its_capture_date() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        let mut s = Store::load(dir.clone());
        capture_text(&mut s, "pinned item");
        let id = s.history[0].id.clone();
        s.set_pin_persisted(&id, true).unwrap();
        s.find_mut(&id).unwrap().created_at = 1;
        s.save_pinned();
        capture_text(&mut s, "newer");
        s.save_history();

        // What set_pin_persisted does up to the crash: the move in memory,
        // the journal, and only the destination layer on disk.
        assert!(s.toggle_pin(&id));
        s.pending_pin = Some(PendingPin {
            item: s.find(&id).unwrap().clone(),
            desired: false,
            dropped: Vec::new(),
        });
        s.try_save_pending_pin().unwrap();
        s.save_history();
        drop(s);

        let recovered = Store::load(dir.clone());
        assert_eq!(recovered.history[0].id, id);
        assert_eq!(recovered.history[0].captured_at, Some(1));
        assert!(recovered.pinned.is_empty());
        assert!(!dir.join(PENDING_PIN_FILE).exists());
    }

    #[test]
    fn rows_saved_before_captured_at_still_load_and_ordinary_rows_never_carry_it() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"id":"old","type":"text","text":"من إصدار سابق","sourceAppBundleId":"com.apple.Notes","sourceApp":"Notes","createdAt":5,"isPinned":false,"copyCount":1,"pasteCount":0,"lastUsedAt":5}]"#,
        )
        .unwrap();

        let mut s = Store::load(dir.clone());
        assert!(!s.unreadable_shelf);
        assert_eq!(s.history[0].id, "old");
        assert_eq!(s.history[0].captured_at, None);

        capture_text(&mut s, "نسخة جديدة");
        s.save_history();
        let written = fs::read_to_string(dir.join(HISTORY_FILE)).unwrap();
        assert!(
            !written.contains("capturedAt"),
            "only a returned row writes the field"
        );
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
}

// ---------------------------------------------------------------------------
// وحدة اختبارات التدقيق (RAFF-COPILOT-AUDIT). اختبارات فقط؛ لا تغيّر سلوك المنتج.
// الاختبارات المعلَّمة #[ignore = "RAFF-AUD-00N: ..."] تعيد إنتاج خلل مؤكد،
// وتفشل حتى يُصلَح. تُشغَّل بـ: cargo test audit_tests -- --ignored
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

    #[test]
    fn aud001_unpin_at_cap_keeps_item_or_refuses_without_side_effects() {
        let dir = tmp_dir("aud001");
        let (mut s, pinned_id) = full_history_with_old_pinned(&dir);
        let before = (ids(&s.history), ids(&s.pinned));
        match s.set_pin_persisted(&pinned_id, false) {
            Ok(_) => assert!(s.find(&pinned_id).is_some(), "نجاح يجب ألا يفقد العنصر"),
            Err(_) => assert_eq!(
                (ids(&s.history), ids(&s.pinned)),
                before,
                "الرفض يجب أن يعيد الطبقتين كما كانتا"
            ),
        }
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
