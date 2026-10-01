//! Diagnostics for a problem report — a closed, typed list (Figma «10 —
//! Reporting & Diagnostics» 279:315), shown in full before anything is sent
//! and copyable on its own.
//!
//! PRIVACY: nothing here may carry clipboard content or anything derived from
//! it — no text, previews, hashes, ids, search, pinned items, app or window
//! names, paths, the exclusion list (its size only), learning details, or any
//! persistent identifier of the user or the Mac. A change skipped on purpose
//! leaves no trace here either. An absent value is `null`, never a guess.
//!
//! The live logs (`diag.js`, `startup_trace.rs`) are not a payload and are
//! never read from here.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

use crate::storage::{Appearance, Settings, Store};
use crate::Pause;

/// Bumped when a field is added, renamed or removed.
pub const SCHEMA: u32 = 1;
/// How many recent outcomes are kept — in memory only, for this session.
const RECENT_LIMIT: usize = 10;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub schema: u32,
    pub build: &'static str,
    pub accessibility: Option<&'static str>,
    pub capture: CaptureState,
    pub settings: SettingsSummary,
    pub counts: Counts,
    pub storage: StorageState,
    pub recent: Vec<Outcome>,
    pub uptime_s: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureState {
    pub enabled: bool,
    pub alive: bool,
    /// "off" | "skipNext" | "timed" | "untilRestart" — never when it ends.
    pub paused: &'static str,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSummary {
    pub history_limit: usize,
    pub retention_days: u32,
    pub appearance: &'static str,
    pub launch_at_login: bool,
    pub learning_enabled: bool,
    pub respect_concealed: bool,
    /// How many apps are excluded — never which: bundle ids reveal what is installed.
    pub excluded_count: usize,
    /// Whether the shortcut is the default — never which keys.
    pub hotkey_is_default: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub history: usize,
    pub pinned: usize,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageState {
    pub unreadable_layer: bool,
}

/// One recent operation, by code only.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// "paste" | "copy" | "update-check" | "report"
    pub op: &'static str,
    /// "ok" | "clipboard-only" | "not-found" | "available" | "error"
    pub result: &'static str,
    pub ms: u64,
    pub ago_s: u64,
}

struct Recorded {
    at: Instant,
    op: &'static str,
    result: &'static str,
    ms: u64,
}

fn recent_log() -> &'static Mutex<VecDeque<Recorded>> {
    static LOG: OnceLock<Mutex<VecDeque<Recorded>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(RECENT_LIMIT)))
}

fn started_at() -> Instant {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    *STARTED.get_or_init(Instant::now)
}

/// Starts the uptime clock; called once at launch.
pub fn init() {
    let _ = started_at();
}

/// Records an outcome. Takes codes only: there is no parameter that could
/// carry text, so no caller can spill content into a report.
pub fn record(op: &'static str, result: &'static str, began: Instant) {
    let mut log = recent_log().lock().unwrap_or_else(|p| p.into_inner());
    if log.len() == RECENT_LIMIT {
        log.pop_front();
    }
    log.push_back(Recorded {
        at: Instant::now(),
        op,
        result,
        ms: began.elapsed().as_millis() as u64,
    });
}

fn recent() -> Vec<Outcome> {
    let now = Instant::now();
    recent_log()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .map(|r| Outcome {
            op: r.op,
            result: r.result,
            ms: r.ms,
            ago_s: now.saturating_duration_since(r.at).as_secs(),
        })
        .collect()
}

fn appearance(settings: &Settings) -> &'static str {
    if settings.follow_system {
        "auto"
    } else {
        match settings.appearance {
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }
}

/// Everything a report says about the app, from its parts. Pure, so the
/// closed list and the absence of content are tested without a running app.
pub fn from_parts(
    store: &Store,
    capture_alive: bool,
    pause: Pause,
    ax_trusted: Option<bool>,
    recent: Vec<Outcome>,
    uptime_s: u64,
) -> Diagnostics {
    let s = &store.settings;
    Diagnostics {
        schema: SCHEMA,
        build: if cfg!(debug_assertions) { "debug" } else { "release" },
        accessibility: ax_trusted.map(|t| if t { "granted" } else { "missing" }),
        capture: CaptureState {
            enabled: s.capture_enabled,
            alive: capture_alive,
            paused: pause.view().kind,
        },
        settings: SettingsSummary {
            history_limit: s.history_limit,
            retention_days: s.retention_days,
            appearance: appearance(s),
            launch_at_login: s.launch_at_login,
            learning_enabled: s.learning_enabled,
            respect_concealed: s.respect_concealed,
            excluded_count: s.excluded_apps.len(),
            hotkey_is_default: s.hotkey == Settings::default().hotkey,
        },
        counts: Counts {
            history: store.history.len(),
            pinned: store.pinned.len(),
        },
        storage: StorageState {
            unreadable_layer: store.unreadable_layer,
        },
        recent,
        uptime_s,
    }
}

/// The live snapshot.
pub fn collect(app: &tauri::AppHandle) -> Diagnostics {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let pause = *crate::lock_pause(&state.pause);
    let alive = state.capture_alive.load(std::sync::atomic::Ordering::SeqCst);
    let ax = Some(crate::macos::ax_trusted());
    let store = crate::lock_store(&state.store);
    from_parts(&store, alive, pause, ax, recent(), started_at().elapsed().as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_content() -> Store {
        let dir = std::env::temp_dir().join(format!("raff-diag-test-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir);
        store.settings.excluded_apps = vec!["com.example.secret-vault".into()];
        store.settings.hotkey = "ctrl+alt+k".into();
        store
    }

    fn keys(value: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    #[test]
    fn the_field_list_is_closed() {
        let d = from_parts(&store_with_content(), true, Pause::Off, Some(true), vec![], 7);
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(
            keys(&json),
            ["accessibility", "build", "capture", "counts", "recent", "schema", "settings", "storage", "uptimeS"]
        );
        assert_eq!(keys(&json["capture"]), ["alive", "enabled", "paused"]);
        assert_eq!(
            keys(&json["settings"]),
            [
                "appearance",
                "excludedCount",
                "historyLimit",
                "hotkeyIsDefault",
                "launchAtLogin",
                "learningEnabled",
                "respectConcealed",
                "retentionDays"
            ]
        );
        assert_eq!(keys(&json["counts"]), ["history", "pinned"]);
        assert_eq!(keys(&json["storage"]), ["unreadableLayer"]);
    }

    #[test]
    fn an_outcome_carries_codes_and_times_only() {
        let o = serde_json::to_value(Outcome { op: "paste", result: "ok", ms: 120, ago_s: 4 }).unwrap();
        assert_eq!(keys(&o), ["agoS", "ms", "op", "result"]);
    }

    #[test]
    fn an_unknown_value_is_null_not_a_guess() {
        let d = from_parts(&store_with_content(), true, Pause::Off, None, vec![], 0);
        assert!(serde_json::to_value(&d).unwrap()["accessibility"].is_null());
    }

    #[test]
    fn no_content_names_or_identifiers_reach_the_report() {
        let mut store = store_with_content();
        let secret = "SECRET-CLIP-4242 كلمة سرّ";
        store.capture(
            crate::storage::ItemKind::Text,
            secret.into(),
            None,
            None,
            None,
            None,
            None,
            ("SecretApp".into(), "com.example.secretapp".into()),
        );
        assert_eq!(store.history.len(), 1, "the fixture really holds content");
        let d = from_parts(&store, true, Pause::Until(None), Some(false), recent(), 3);
        let text = serde_json::to_string(&d).unwrap();
        for forbidden in ["SECRET-CLIP", "كلمة", "SecretApp", "com.example", "secret-vault", "ctrl+alt+k", "/"] {
            assert!(!text.contains(forbidden), "diagnostics must not contain {forbidden:?}: {text}");
        }
        assert!(text.contains("\"excludedCount\":1"), "the exclusions are a count");
        assert!(text.contains("\"hotkeyIsDefault\":false"));
        assert!(text.contains("\"paused\":\"untilRestart\""));
    }

    #[test]
    fn the_recent_log_is_bounded() {
        for _ in 0..(RECENT_LIMIT + 5) {
            record("copy", "ok", Instant::now());
        }
        assert!(recent().len() <= RECENT_LIMIT);
    }
}
