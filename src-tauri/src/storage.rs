//! Local JSON storage: history.json (capped), pinned.json (never auto-pruned),
//! settings.json, and an images/ directory for captured PNGs.
//! All files live in the app data dir. No network, ever.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const HISTORY_FILE: &str = "history.json";
pub const PINNED_FILE: &str = "pinned.json";
pub const SETTINGS_FILE: &str = "settings.json";
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

/// أيقونة التطبيق — which app-icon variant Finder shows. Independent from the
/// theme: `Auto` follows the app's *effective* appearance, the other two pin
/// one variant regardless of theme.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppIconPref {
    #[default]
    Auto,
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
    /// أيقونة التطبيق — auto / light / dark.
    pub app_icon: AppIconPref,
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
            app_icon: AppIconPref::Auto,
        }
    }
}

#[derive(PartialEq, Eq, Debug)]
pub enum CaptureOutcome {
    /// Existing item bumped/moved — no new row.
    Deduped,
    Added,
}

pub struct Store {
    dir: PathBuf,
    pub history: Vec<ClipItem>,
    pub pinned: Vec<ClipItem>,
    pub settings: Settings,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
        "const ", "let ", "var ", "function ", "fn ", "def ", "class ", "import ", "export ",
        "#include", "<?php", "select ", "insert ", "update ", "delete from", "package ", "use ",
        "pub ", "async ", "public ", "private ", "#!/",
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

fn load_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    if !path.exists() {
        return T::default();
    }
    match fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|s| {
        serde_json::from_str::<T>(&s).map_err(|e| e.to_string())
    }) {
        Ok(v) => v,
        Err(err) => {
            // Never destroy user data silently: keep the unreadable file aside.
            let corrupt = path.with_extension("json.corrupt");
            let _ = fs::copy(path, &corrupt);
            eprintln!(
                "raff: unreadable {} ({err}); copied to {}",
                path.display(),
                corrupt.display()
            );
            T::default()
        }
    }
}

fn save_json<T: Serialize>(path: &Path, value: &T) {
    let tmp = path.with_extension("json.tmp");
    match serde_json::to_vec_pretty(value) {
        Ok(bytes) => {
            if fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, path)).is_err() {
                eprintln!("raff: failed writing {}", path.display());
            }
        }
        Err(e) => eprintln!("raff: serialize {}: {e}", path.display()),
    }
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join(IMAGES_DIR));
        let history: Vec<ClipItem> = load_json(&dir.join(HISTORY_FILE));
        let pinned: Vec<ClipItem> = load_json(&dir.join(PINNED_FILE));
        let settings: Settings = load_json(&dir.join(SETTINGS_FILE));
        Self {
            dir,
            history,
            pinned,
            settings,
        }
    }

    pub fn images_dir(&self) -> PathBuf {
        self.dir.join(IMAGES_DIR)
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
    pub fn capture(
        &mut self,
        kind: ItemKind,
        text: String,
        html: Option<String>,
        rtf: Option<String>,
        image_file: Option<String>,
        thumb_file: Option<String>,
        hash: Option<String>,
        source: (String, String), // (name, bundle_id)
    ) -> CaptureOutcome {
        let now = now_ms();
        let learning = self.settings.learning_enabled;

        if let Some(p) = self
            .pinned
            .iter_mut()
            .find(|i| Self::same_content(i, kind, &text, hash.as_deref()))
        {
            if learning {
                p.copy_count += 1;
                p.last_used_at = now;
            }
            return CaptureOutcome::Deduped;
        }

        if let Some(pos) = self
            .history
            .iter()
            .position(|i| Self::same_content(i, kind, &text, hash.as_deref()))
        {
            let mut item = self.history.remove(pos);
            if learning {
                item.copy_count += 1;
            }
            item.created_at = now;
            item.last_used_at = now;
            self.history.insert(0, item);
            return CaptureOutcome::Deduped;
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
        self.trim_history();
        CaptureOutcome::Added
    }

    fn delete_files(&self, item: &ClipItem) {
        for f in [&item.image_file, &item.thumb_file].into_iter().flatten() {
            let _ = fs::remove_file(self.images_dir().join(f));
        }
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
            self.trim_history();
            return true;
        }
        false
    }

    pub fn delete(&mut self, id: &str) -> bool {
        if let Some(pos) = self.history.iter().position(|i| i.id == id) {
            let item = self.history.remove(pos);
            self.delete_files(&item);
            return true;
        }
        if let Some(pos) = self.pinned.iter().position(|i| i.id == id) {
            let item = self.pinned.remove(pos);
            self.delete_files(&item);
            return true;
        }
        false
    }

    pub fn clear_history(&mut self) {
        for item in &self.history {
            self.delete_files(item);
        }
        self.history.clear();
    }

    /// "مسح بيانات التعلّم" — resets the silent signals on every item.
    pub fn clear_learning(&mut self) {
        for item in self.pinned.iter_mut().chain(self.history.iter_mut()) {
            item.copy_count = 0;
            item.paste_count = 0;
            item.last_used_at = item.created_at;
        }
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
        assert_eq!(s.history[1].text, "keep me");
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
    fn settings_from_older_versions_get_appearance_defaults() {
        let dir = std::env::temp_dir().join(format!("raff-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"hotkey":"shift+super+v"}"#).unwrap();
        let s = Store::load(dir);
        assert!(s.settings.follow_system);
        assert_eq!(s.settings.appearance, Appearance::Light);
        assert_eq!(s.settings.app_icon, AppIconPref::Auto);
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
