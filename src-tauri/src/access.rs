//! Which window may call which command (014, IMP-04).
//!
//! Every page talks to Rust through the same IPC bridge, so without a check
//! any window could call any command: the report window, which shows a
//! server's answers, could read the whole shelf; Settings could paste. Tauri's
//! own permission files cannot draw that line for app commands without a
//! command manifest in the build, so the line is drawn here, in one table
//! read by the commands themselves, by a test over every registered command,
//! and by a test over every page's calls (`tests/command-windows.test.mjs`).
//!
//! A command missing from the table is refused everywhere, so a new one
//! cannot slip through unguarded; `OPEN` lists the few any window may call,
//! which open a window or a page in the browser, or only read whether
//! Accessibility is granted.

/// Command → the windows that may call it.
pub const WINDOWS: &[(&str, &[&str])] = &[
    // The shelf: only the panel shows it, reads it, pastes from it, changes it.
    ("get_state", &["panel"]),
    ("search_items", &["panel"]),
    ("paste_item", &["panel"]),
    ("copy_item", &["panel"]),
    ("toggle_pin", &["panel"]),
    ("reorder_pinned", &["panel"]),
    ("set_label", &["panel"]),
    ("delete_item", &["panel"]),
    ("undo_delete", &["panel"]),
    ("commit_delete", &["panel"]),
    ("get_image", &["panel"]),
    ("hide_panel", &["panel"]),
    ("panel_preview_side", &["panel"]),
    ("set_panel_preview", &["panel"]),
    // Preferences and what they reach.
    ("get_settings", &["settings", "firstrun", "about"]),
    ("update_settings", &["panel", "settings", "firstrun"]),
    ("resume_capture", &["panel", "settings"]),
    ("restart_app", &["panel", "settings"]),
    ("clear_history", &["settings"]),
    ("clear_learning", &["settings"]),
    ("learning_summary", &["settings"]),
    ("list_running_apps", &["settings"]),
    ("firstrun_done", &["firstrun"]),
    // Updates: anyone may ask whether there is one; only its window installs.
    ("check_for_update", &["settings", "about", "update"]),
    ("download_and_install_update", &["update"]),
    ("restart_to_update", &["update"]),
    ("consume_update_intent", &["update"]),
    // The problem report, and the diagnostics Settings may copy.
    ("report_prepare", &["report"]),
    ("report_send", &["report"]),
    ("report_copy", &["report"]),
    ("report_copy_number", &["report"]),
    ("report_pick_image", &["report"]),
    ("report_paste_image", &["report"]),
    ("report_remove_image", &["report"]),
    ("diagnostics_copy", &["settings", "report"]),
];

/// Commands any window may call: they open a window, open one fixed page in
/// the browser, or answer whether Accessibility is granted. Nothing checks
/// it at run time; the tests on both sides read it, so no command is left out
/// of both lists by accident.
#[cfg_attr(not(test), allow(dead_code))]
pub const OPEN: &[&str] = &[
    "show_panel",
    "open_settings",
    "open_about",
    "open_report",
    "open_updates",
    "open_repository",
    "open_privacy_policy",
    "ax_status",
    "request_accessibility",
    "open_accessibility_settings",
];

/// Whether the window labelled `label` may call `command`. Unknown commands
/// are refused.
pub fn allowed(label: &str, command: &str) -> bool {
    WINDOWS
        .iter()
        .find(|(name, _)| *name == command)
        .is_some_and(|(_, windows)| windows.contains(&label))
}

/// What a window other than Settings may change: capture on or off — the
/// panel's «تفعيل الالتقاط» and the welcome's answer — and nothing else. Every
/// field is named, so a new one cannot join the patch unseen.
pub fn patch_allowed(label: &str, patch: &crate::storage::SettingsPatch) -> bool {
    let crate::storage::SettingsPatch {
        hotkey,
        launch_at_login,
        history_limit,
        capture_enabled: _,
        respect_concealed,
        excluded_apps,
        learning_enabled,
        first_run_shown,
        appearance,
        follow_system,
        retention_days,
    } = patch;
    label == "settings"
        || (hotkey.is_none()
            && launch_at_login.is_none()
            && history_limit.is_none()
            && respect_concealed.is_none()
            && excluded_apps.is_none()
            && learning_enabled.is_none()
            && first_run_shown.is_none()
            && appearance.is_none()
            && follow_system.is_none()
            && retention_days.is_none())
}

/// The check each guarded command makes first.
pub fn require(window: &tauri::WebviewWindow, command: &str) -> Result<(), String> {
    if allowed(window.label(), command) {
        Ok(())
    } else {
        Err(crate::commands::err::WRONG_WINDOW.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_reaches_only_what_the_table_gives_it() {
        assert!(allowed("panel", "get_state"));
        assert!(
            !allowed("report", "get_state"),
            "the report window reads no shelf"
        );
        assert!(
            !allowed("settings", "paste_item"),
            "Settings pastes nothing"
        );
        assert!(allowed("settings", "diagnostics_copy"));
        assert!(!allowed("panel", "download_and_install_update"));
        assert!(!allowed("panel", "no_such_command"), "unknown is refused");
    }

    /// The panel shows clipboard content; it may turn capture on, not change
    /// the shortcut or the exclusions (review of م٥).
    #[test]
    fn only_settings_changes_more_than_capture() {
        use crate::storage::SettingsPatch;
        let capture = SettingsPatch {
            capture_enabled: Some(true),
            ..SettingsPatch::default()
        };
        let hotkey = SettingsPatch {
            hotkey: Some("Cmd+Shift+V".into()),
            ..SettingsPatch::default()
        };
        let exclusions = SettingsPatch {
            excluded_apps: Some(vec![]),
            capture_enabled: Some(true),
            ..SettingsPatch::default()
        };
        for label in ["panel", "firstrun"] {
            assert!(patch_allowed(label, &capture), "{label}");
            assert!(!patch_allowed(label, &hotkey), "{label}");
            assert!(!patch_allowed(label, &exclusions), "{label}");
        }
        assert!(patch_allowed("settings", &hotkey));
        assert!(patch_allowed("settings", &exclusions));
        assert!(body_of("update_settings").contains("patch_allowed(window.label(), &settings)"));
    }

    /// The commands registered with Tauri, read from `main.rs`.
    fn registered() -> Vec<String> {
        let main = include_str!("main.rs");
        let list = &main[main.find("generate_handler![").unwrap()..];
        let list = &list[..list.find(']').unwrap()];
        list.split(',')
            .filter_map(|entry| entry.trim().rsplit("::").next())
            .filter(|name| !name.is_empty() && !name.contains('['))
            .map(str::to_string)
            .collect()
    }

    /// The body of `fn name` in whichever source file defines it.
    fn body_of(name: &str) -> &'static str {
        const SOURCES: [&str; 3] = [
            include_str!("commands.rs"),
            include_str!("report.rs"),
            include_str!("updater.rs"),
        ];
        let header = format!("fn {name}(");
        for src in SOURCES {
            if let Some(at) = src.find(&header) {
                let rest = &src[at..];
                let open = rest.find("{\n").unwrap();
                let end = rest.find("\n}\n").unwrap();
                return &rest[open..end];
            }
        }
        panic!("no fn {name}");
    }

    /// Every registered command is either in the table or open to all, and
    /// nothing in either is stale.
    #[test]
    fn every_registered_command_is_placed() {
        let registered = registered();
        assert!(registered.len() > 30, "{registered:?}");
        for name in &registered {
            let guarded = WINDOWS.iter().any(|(c, _)| c == name);
            let open = OPEN.contains(&name.as_str());
            assert!(guarded ^ open, "{name}: guarded={guarded} open={open}");
        }
        for (name, _) in WINDOWS {
            assert!(registered.iter().any(|r| r == name), "stale: {name}");
        }
        for name in OPEN {
            assert!(registered.iter().any(|r| r == name), "stale: {name}");
        }
    }

    /// And every guarded command checks before it does anything.
    #[test]
    fn every_guarded_command_checks_its_window_first() {
        for (name, _) in WINDOWS {
            let body = body_of(name);
            let first = body
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && *l != "{" && !l.starts_with("//"))
                .unwrap_or_default();
            // The check exactly, with its `?`: a `let _ =` would pass any
            // looser test and guard nothing. The one command with nothing to
            // return refuses by returning early.
            let returns = format!("crate::access::require(&window, \"{name}\")?;");
            let silent = format!("if !crate::access::allowed(window.label(), \"{name}\") {{");
            assert!(
                first == returns || first == silent,
                "{name} starts with: {first}"
            );
        }
    }
}
