//! Least-privilege IPC surface. The frontend can only do what these commands
//! allow; every mutation persists immediately and notifies all windows.

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::storage::{Appearance, ItemKind, Settings, SettingsPatch, Store};
use crate::{macos, panel, paste, AppState};

const PREVIEW_MAX_CHARS: usize = 1000;

/// Stable, detail-free error codes the panel turns into Arabic.
///
/// A storage failure carries an `io::Error` and the path it happened on.
/// Handing that string to a toast put a local path — and the shape of the
/// user's disk — into an Arabic interface, and made the wording of every
/// message a backend concern. The backend names the kind; the panel owns the
/// words.
pub mod err {
    pub const NOT_FOUND: &str = "raff/not-found";
    pub const SAVE_FAILED: &str = "raff/save-failed";
    pub const PASTE_FAILED: &str = "raff/paste-failed";
    /// A command called from a window that has no business calling it
    /// (`access`). Never reached from رفّ's own pages.
    pub const WRONG_WINDOW: &str = "raff/wrong-window";
    /// A shortcut with no modifier but ⇧.
    pub const HOTKEY_NEEDS_MODIFIER: &str = "raff/hotkey-needs-modifier";
    /// ⌘C, ⌘V, ⌘X, ⌘A, ⌘Z, ⌘Q or ⌘W.
    pub const HOTKEY_SHARED: &str = "raff/hotkey-shared";
    /// macOS would not register it.
    pub const HOTKEY_UNAVAILABLE: &str = "raff/hotkey-unavailable";
    /// Opening at login: macOS waits for the user's approval — رفّ is turned
    /// off in System Settings → General → Login Items (`login_item`).
    pub const LOGIN_ITEM_NEEDS_APPROVAL: &str = "raff/login-item-needs-approval";
    /// macOS would not change it, or this build has no app bundle to register.
    pub const LOGIN_ITEM_FAILED: &str = "raff/login-item-failed";
    /// The deleted item would leave history the moment it came back.
    pub const UNDO_NO_ROOM: &str = crate::storage::UNDO_NO_ROOM;
    /// The same, because it is past the retention period.
    pub const UNDO_RETENTION: &str = crate::storage::UNDO_RETENTION;
    /// A pinned item's name over its cap, or a name for what is not pinned.
    pub const LABEL_TOO_LONG: &str = crate::storage::LABEL_TOO_LONG;
    pub const LABEL_NOT_PINNED: &str = crate::storage::LABEL_NOT_PINNED;
    /// The delete was already made final (ت٤٥ ب٣).
    pub const UNDO_EXPIRED: &str = crate::storage::UNDO_EXPIRED;
    /// A test run of رفّ: it has no clipboard to copy to or paste from (ت٤٨).
    pub const CLIPBOARD_OFF: &str = "raff/clipboard-off";
    /// The picture is there — it still pastes — but no thumbnail exists and
    /// the original is too large to send to the panel.
    pub const PREVIEW_TOO_LARGE: &str = "raff/preview-too-large";
}

/// Keeps the detail where it is useful — the process log — and hands the
/// interface a kind.
fn save_failed(detail: String) -> String {
    eprintln!("raff: {detail}");
    err::SAVE_FAILED.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemKind,
    pub text: String,
    pub source_app: String,
    pub source_app_bundle_id: String,
    pub created_at: u64,
    pub is_pinned: bool,
    pub pinned_order: Option<u32>,
    pub copy_count: u32,
    pub paste_count: u32,
    pub last_used_at: u64,
    pub has_image: bool,
    /// A pinned item's name (IMP-07).
    pub label: Option<String>,
}

impl ItemDto {
    fn from(item: &crate::storage::ClipItem) -> Self {
        let mut text: String = item.text.chars().take(PREVIEW_MAX_CHARS).collect();
        if item.text.chars().count() > PREVIEW_MAX_CHARS {
            text.push('…');
        }
        Self {
            id: item.id.clone(),
            kind: item.kind,
            text,
            source_app: item.source_app.clone(),
            source_app_bundle_id: item.source_app_bundle_id.clone(),
            created_at: item.created_at,
            is_pinned: item.is_pinned,
            pinned_order: item.pinned_order,
            copy_count: item.copy_count,
            paste_count: item.paste_count,
            last_used_at: item.last_used_at,
            has_image: item.image_file.is_some(),
            // Hidden while unpinned (kept for a pin that comes back).
            label: item.label.clone().filter(|_| item.is_pinned),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub pinned: Vec<ItemDto>,
    pub history: Vec<ItemDto>,
    pub settings: Settings,
    pub ax_trusted: bool,
    pub version: String,
    /// True when a layer of the shelf (history or pinned) could not be read on
    /// this launch. An empty list then means something very different, and
    /// the panel says so.
    pub unreadable_layer: bool,
    /// True while defaults stand in for a `settings.json` that could not be
    /// read, with capture held off until the user turns it back on.
    pub unreadable_settings: bool,
    /// False once the capture loop has given up. Distinct from
    /// `settings.capture_enabled`, which only says what the user asked for.
    pub capture_alive: bool,
    /// A pause in force, if any — its kind and minutes left, nothing it skipped.
    pub capture_pause: crate::PauseView,
    /// The delete receipt Rust still holds, if any: a panel showing «تراجع»
    /// for another one, or for none, drops it (ت٤٥ ب٣).
    pub undo_token: Option<String>,
}

/// What the Settings window actually needs: the preferences and the two states
/// it shows, and none of the shelf.
///
/// `get_state` carries up to 1000 rows of up to 1000 characters each, and the
/// Settings window used to refetch every one of them on every capture — to
/// keep five switches in sync.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    pub settings: Settings,
    pub ax_trusted: bool,
    pub version: String,
    pub unreadable_settings: bool,
    pub capture_alive: bool,
    pub capture_pause: crate::PauseView,
}

fn pause_view(state: &AppState) -> crate::PauseView {
    crate::lock_pause(&state.pause).view()
}

#[tauri::command]
pub fn get_settings(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<AppState>,
) -> Result<SettingsPayload, String> {
    crate::access::require(&window, "get_settings")?;
    // The switch shows what macOS will do at the next login, whatever was
    // changed in System Settings since.
    crate::login_item::sync_setting(&app);
    let store = crate::lock_store(&state.store);
    Ok(SettingsPayload {
        settings: store.settings.clone(),
        ax_trusted: ax_trusted_noted(),
        version: app.package_info().version.to_string(),
        unreadable_settings: store.unreadable_settings,
        capture_alive: state
            .capture_alive
            .load(std::sync::atomic::Ordering::SeqCst),
        capture_pause: pause_view(&state),
    })
}

#[tauri::command]
pub fn get_state(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<AppState>,
) -> Result<StatePayload, String> {
    crate::access::require(&window, "get_state")?;
    crate::startup_trace::mark("FRONTEND_CALLED_get_state");
    let store = crate::lock_store(&state.store);
    let mut pinned: Vec<&crate::storage::ClipItem> = store.pinned.iter().collect();
    pinned.sort_by_key(|i| i.pinned_order.unwrap_or(u32::MAX));
    Ok(StatePayload {
        pinned: pinned.into_iter().map(ItemDto::from).collect(),
        history: store.history.iter().map(ItemDto::from).collect(),
        settings: store.settings.clone(),
        ax_trusted: ax_trusted_noted(),
        version: app.package_info().version.to_string(),
        unreadable_layer: store.unreadable_shelf,
        unreadable_settings: store.unreadable_settings,
        capture_alive: state
            .capture_alive
            .load(std::sync::atomic::Ordering::SeqCst),
        capture_pause: pause_view(&state),
        undo_token: store.pending_delete_token(),
    })
}

/// Ids of the rows whose **full** text matches — everything the panel cannot
/// see, because what it holds is cut at `PREVIEW_MAX_CHARS`.
///
/// Ids and not rows: the panel already has the rows, and shipping the whole
/// text back so it could search it would undo the very cap this exists to work
/// around. The scan is linear over the shelf; the byte budget on the layer is
/// what keeps that bounded.
///
/// Off the main thread and out of the store lock (IMP-01): over the largest
/// history the scan measured 256–295 ms in release, once per keystroke. The
/// lock is held only to copy the rows out (~2 ms), and a newer search stops
/// an older one, whose answer the panel would drop anyway.
#[tauri::command]
pub async fn search_items(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<String>, String> {
    crate::access::require(&window, "search_items")?;
    let generation = SEARCH_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let current = move || SEARCH_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == generation;
    let rows = {
        let store = crate::lock_store(&state.store);
        // Overtaken while waiting for the lock: nothing to copy out for.
        if !current() {
            return Ok(Vec::new());
        }
        rows_to_search(&store)
    };
    let found = tauri::async_runtime::spawn_blocking(move || matching_in(&rows, &query, current))
        .await
        .map_err(|err| err.to_string())?;
    // Overtaken: the panel has already asked again, and drops this answer.
    Ok(found.unwrap_or_default())
}

/// Bumped by every deep search; a search still running when it moves on stops.
static SEARCH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Every row, shelf first, as (id, full text): what a search reads.
fn rows_to_search(store: &Store) -> Vec<(String, String)> {
    // Picture text is searched only while «اقرأ النص في الصور» is on.
    let ocr = store.settings.ocr_enabled;
    store
        .pinned
        .iter()
        .chain(store.history.iter())
        // A pinned item's name is searched with its text (IMP-07) — not the
        // name an unpinned row keeps hidden — and a picture with the text
        // read in it (IMP-09).
        .map(|item| {
            let mut text = item.text.clone();
            let ocr_text = if ocr { &item.ocr_text } else { &None };
            let label = if item.is_pinned { &item.label } else { &None };
            for extra in [label, ocr_text].into_iter().flatten() {
                text.push('\n');
                text.push_str(extra);
            }
            (item.id.clone(), text)
        })
        .collect()
}

/// The query trimmed and folded the way the panel's own filter does it, then
/// every row's full text. `None` once `keep_going` says a newer search began.
fn matching_in(
    rows: &[(String, String)],
    query: &str,
    keep_going: impl Fn() -> bool,
) -> Option<Vec<String>> {
    let needle = crate::storage::normalize_for_search(crate::storage::trim_query(query));
    if needle.is_empty() {
        return Some(Vec::new());
    }
    let mut ids = Vec::new();
    for (id, text) in rows {
        if !keep_going() {
            return None;
        }
        if crate::storage::normalize_for_search(text).contains(&needle) {
            ids.push(id.clone());
        }
    }
    Some(ids)
}

/// `search_items` over a store, as the tests hold one.
#[cfg(test)]
fn matching_ids(store: &Store, query: &str) -> Vec<String> {
    matching_in(&rows_to_search(store), query, || true).unwrap_or_default()
}

#[tauri::command]
pub async fn paste_item(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
    plain: bool,
    bare: Option<bool>,
) -> Result<paste::PasteOutcome, String> {
    crate::access::require(&window, "paste_item")?;
    let began = std::time::Instant::now();
    let form = if bare == Some(true) {
        paste::Form::Bare
    } else if plain {
        paste::Form::Plain
    } else {
        paste::Form::Rich
    };
    let result = paste::paste_item(&app, &id, form).await;
    let outcome = match result {
        Ok(paste::PasteOutcome::Pasted) => "ok",
        Ok(paste::PasteOutcome::Copied) => "clipboard-only",
        Ok(paste::PasteOutcome::CopiedOverRaff) => "clipboard-only-over-raff",
        // A repeat of the paste under way (DS-001), which records its own.
        Ok(paste::PasteOutcome::TargetTaken) => return result,
        Err(_) => "error",
    };
    crate::diagnostics::record("paste", outcome, began);
    result
}

/// Async, like `paste_item`: the write can wait out a poll's read and reads
/// the picture file, neither of which belongs on the main thread.
#[tauri::command]
pub async fn copy_item(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    crate::access::require(&window, "copy_item")?;
    let began = std::time::Instant::now();
    if macos::clipboard_inert() {
        crate::diagnostics::record("copy", "clipboard-off", began);
        return Err(err::CLIPBOARD_OFF.into());
    }
    if paste::write_item_to_clipboard(&app, &id, paste::Form::Rich) {
        paste::bump_copy_signals(&app, &id);
        crate::diagnostics::record("copy", "ok", began);
        Ok(())
    } else {
        crate::diagnostics::record("copy", "not-found", began);
        Err(err::NOT_FOUND.into())
    }
}

/// Rewrites the pinned shelf into the order the panel shows.
///
/// `pinned_order` was written on every pin and read by nothing, so the shelf
/// could only be rearranged by unpinning and pinning again in sequence.
#[tauri::command]
pub fn reorder_pinned(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    crate::access::require(&window, "reorder_pinned")?;
    {
        let mut store = crate::lock_store(&state.store);
        store.reorder_pinned_persisted(&ids).map_err(save_failed)?;
    }
    notify(&app);
    Ok(())
}

/// Names a pinned item, or clears its name (IMP-07). Off the main thread:
/// it writes the shelf.
#[tauri::command(async)]
pub fn set_label(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    label: Option<String>,
) -> Result<(), String> {
    crate::access::require(&window, "set_label")?;
    {
        let mut store = crate::lock_store(&state.store);
        store
            .set_label_persisted(&id, label.as_deref())
            .map_err(|e| {
                if e == err::LABEL_TOO_LONG || e == err::LABEL_NOT_PINNED {
                    e
                } else {
                    save_failed(e)
                }
            })?;
    }
    notify(&app);
    Ok(())
}

/// Where a pin change left the row. `removed` is an unpin that history did
/// not take back, and `reason` says why — past the retention period, older
/// than all of history, or let go by its limit — so the panel can say it.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinDto {
    pub is_pinned: bool,
    pub removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<crate::storage::UnpinRemoval>,
}

fn set_pin(store: &mut Store, id: &str, is_pinned: bool) -> Result<PinDto, String> {
    let is_pinned = store
        .set_pin_persisted(id, is_pinned)
        .map_err(save_failed)?;
    let removed = store.find(id).is_none();
    Ok(PinDto {
        is_pinned,
        removed,
        reason: if removed { store.unpin_removal() } else { None },
    })
}

/// Off the main thread, like `delete_item`: a pin writes its journal and two
/// layers before it returns (F-MAINTHREAD-COST). The panel sends its changes
/// one at a time, so this does not reorder them.
#[tauri::command(async)]
pub fn toggle_pin(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    is_pinned: bool,
) -> Result<PinDto, String> {
    crate::access::require(&window, "toggle_pin")?;
    let outcome = set_pin(&mut crate::lock_store(&state.store), &id, is_pinned)?;
    notify(&app);
    Ok(outcome)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReceiptDto {
    pub token: String,
}

/// Off the main thread: the journal is flushed to the device and the layer
/// rewritten before this returns — tens of milliseconds on a large history,
/// during which the main thread would draw nothing (F-MAINTHREAD-COST).
#[tauri::command(async)]
pub fn delete_item(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<DeleteReceiptDto, String> {
    crate::access::require(&window, "delete_item")?;
    let token = {
        let mut store = crate::lock_store(&state.store);
        store.delete_reversible(&id).map_err(save_failed)?
    };
    notify(&app);
    Ok(DeleteReceiptDto { token })
}

/// Off the main thread, like `delete_item`: it rewrites the layer.
#[tauri::command(async)]
pub fn undo_delete(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<String, String> {
    crate::access::require(&window, "undo_delete")?;
    let standing = {
        let mut store = crate::lock_store(&state.store);
        store.undo_delete(&token).map_err(|e| {
            if e == err::UNDO_NO_ROOM || e == err::UNDO_RETENTION || e == err::UNDO_EXPIRED {
                e
            } else {
                save_failed(e)
            }
        })?
    };
    notify(&app);
    Ok(standing)
}

/// Off the main thread, like `delete_item`: it deletes files and the journal.
#[tauri::command(async)]
pub fn commit_delete(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    crate::access::require(&window, "commit_delete")?;
    let mut store = crate::lock_store(&state.store);
    store.commit_delete(&token).map_err(save_failed)
}

#[tauri::command]
pub fn clear_history(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    crate::access::require(&window, "clear_history")?;
    {
        let mut store = crate::lock_store(&state.store);
        store.clear_history_persisted().map_err(save_failed)?;
    }
    notify(&app);
    Ok(())
}

#[tauri::command]
pub fn clear_learning(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    crate::access::require(&window, "clear_learning")?;
    {
        let mut store = crate::lock_store(&state.store);
        store.clear_learning_persisted().map_err(save_failed)?;
    }
    notify(&app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnDto {
    pub text: String,
    #[serde(rename = "type")]
    pub kind: ItemKind,
    pub copy_count: u32,
    pub paste_count: u32,
    pub last_used_at: u64,
}

/// "عرض ما تعلّمه رفّ" — the plan requires the user can see what is being
/// learned. Returns the most-used items with their raw signals.
#[tauri::command]
pub fn learning_summary(
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<Vec<LearnDto>, String> {
    crate::access::require(&window, "learning_summary")?;
    let store = crate::lock_store(&state.store);
    let mut items: Vec<&crate::storage::ClipItem> = store
        .pinned
        .iter()
        .chain(store.history.iter())
        .filter(|i| i.copy_count + i.paste_count > 1)
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.copy_count + i.paste_count));
    Ok(items
        .into_iter()
        .take(10)
        .map(|i| LearnDto {
            text: i.text.chars().take(80).collect(),
            kind: i.kind,
            copy_count: i.copy_count,
            paste_count: i.paste_count,
            last_used_at: i.last_used_at,
        })
        .collect())
}

/// Changes the settings named in `settings` and leaves every other one as the
/// store holds it (H6): callers send what changed, not their last full view.
///
/// Like every synchronous command this runs on the main thread, where the
/// menu bar's handlers run too, so nothing lands between reading the current
/// settings here and persisting the result below.
#[tauri::command]
pub fn update_settings(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<AppState>,
    settings: SettingsPatch,
) -> Result<(), String> {
    crate::access::require(&window, "update_settings")?;
    if !crate::access::patch_allowed(window.label(), &settings) {
        return Err(err::WRONG_WINDOW.into());
    }
    apply_settings(app, state, settings)
}

/// `update_settings` past its window check: also the menu bar's way in.
fn apply_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: SettingsPatch,
) -> Result<(), String> {
    let (old, settings) = {
        let store = crate::lock_store(&state.store);
        (store.settings.clone(), settings.applied_to(&store.settings))
    };
    validate_settings(&settings)?;

    // Hotkey first: if the new accelerator cannot be registered, fail without
    // persisting anything — and re-register the old one, because registration
    // starts with unregister_all (the app must never lose its entry point).
    // Only a shortcut being changed is weighed: one saved before these rules
    // must not stand in the way of every other setting.
    if settings.hotkey != old.hotkey {
        if let Some(refusal) = hotkey_refusal(&settings.hotkey) {
            return Err(refusal.into());
        }
        if let Err(err) = register_hotkey(&app, &settings.hotkey) {
            eprintln!("raff: could not register {}: {err}", settings.hotkey);
            let _ = register_hotkey(&app, &old.hotkey);
            return Err(err::HOTKEY_UNAVAILABLE.into());
        }
    }

    let mut autostart_changed = false;
    if settings.launch_at_login != old.launch_at_login {
        crate::login_item::apply(&app, settings.launch_at_login).map_err(|kind| {
            if settings.hotkey != old.hotkey {
                let _ = register_hotkey(&app, &old.hotkey);
            }
            kind.to_string()
        })?;
        autostart_changed = true;
    }

    // Persist only after fallible system integration succeeds. If storage
    // fails, restore both external side effects so Settings cannot claim a
    // configuration macOS or the next launch will not actually honor.
    let persisted = crate::lock_store(&state.store)
        .update_settings_persisted(settings.clone())
        .map_err(save_failed);
    if let Err(err) = persisted {
        if autostart_changed {
            let _ = crate::login_item::apply(&app, old.launch_at_login);
        }
        if settings.hotkey != old.hotkey {
            let _ = register_hotkey(&app, &old.hotkey);
        }
        return Err(err);
    }

    if settings.follow_system != old.follow_system || settings.appearance != old.appearance {
        sync_appearance(&app);
    }
    crate::tray::note_capture_enabled(settings.capture_enabled);

    notify(&app);
    Ok(())
}

/// Turns capture on or off from outside Settings (the menu bar's «تفعيل
/// الالتقاط»), through the same validated, persisted path.
pub fn set_capture_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let patch = SettingsPatch {
        capture_enabled: Some(enabled),
        ..SettingsPatch::default()
    };
    apply_settings(app.clone(), app.state::<AppState>(), patch)
}

/// Ends a pause from the panel strip or Settings.
#[tauri::command]
pub fn resume_capture(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::access::require(&window, "resume_capture")?;
    crate::tray::resume_capture();
    Ok(())
}

/// «إعادة تشغيل رفّ» — the remedy when the capture loop has stopped. Asked
/// from Settings, the new process brings Settings back; from the panel, رفّ
/// simply returns to the menu bar.
#[tauri::command]
pub fn restart_app(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::access::require(&window, "restart_app")?;
    crate::relaunch(&app, window.label() == "settings")
}

/// Why `accel` cannot be رفّ's global shortcut, or `None` when it can.
///
/// A global shortcut is taken from every app on the Mac while رفّ runs. With
/// no modifier but ⇧ it would take a capital letter from all typing; ⌘ with C,
/// V, X, A, Z, Q or W, the edit and window commands every app relies on. The
/// recorder's own ⌘V — pressed to paste into a field — became the shortcut
/// that way (live UI audit, issue 1). The panel refuses the same ones
/// (`hotkeyRefusal` in logic.js).
fn hotkey_refusal(accel: &str) -> Option<&'static str> {
    let parts: Vec<String> = accel
        .split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .collect();
    let (key, mods) = parts.split_last()?;
    let key = key
        .strip_prefix("key")
        .filter(|letter| letter.len() == 1)
        .unwrap_or(key);
    let has = |names: &[&str]| mods.iter().any(|m| names.contains(&m.as_str()));
    let command = has(&[
        "super",
        "cmd",
        "command",
        "meta",
        "cmdorctrl",
        "cmdorcontrol",
        "commandorctrl",
        "commandorcontrol",
    ]);
    let other = has(&["ctrl", "control", "alt", "option"]);
    if !command && !other {
        return Some(err::HOTKEY_NEEDS_MODIFIER);
    }
    if command && !other && !has(&["shift"]) && ["c", "v", "x", "a", "z", "q", "w"].contains(&key) {
        return Some(err::HOTKEY_SHARED);
    }
    None
}

/// `validate_settings` for a backup's settings (IMP-05).
pub(crate) fn check_settings(settings: &Settings) -> Result<(), String> {
    validate_settings(settings)
}

/// A storage failure as the code the pages word (`save_failed`).
pub(crate) fn save_failed_code(detail: &str) -> String {
    save_failed(detail.to_string())
}

fn validate_settings(settings: &Settings) -> Result<(), String> {
    if !matches!(settings.history_limit, 200 | 500 | 1000) {
        return Err("حد السجل غير صالح".into());
    }
    if !matches!(settings.retention_days, 0 | 7 | 30 | 90) {
        return Err("مدة الاحتفاظ غير صالحة".into());
    }
    if settings.hotkey.is_empty() || settings.hotkey.len() > 128 {
        return Err("اختصار لوحة المفاتيح غير صالح".into());
    }
    if settings.excluded_apps.len() > 128
        || settings.excluded_apps.iter().any(|bundle| {
            bundle.is_empty()
                || bundle.len() > 255
                || bundle.chars().any(char::is_control)
                || bundle.chars().any(char::is_whitespace)
        })
    {
        return Err("قائمة التطبيقات المستثناة غير صالحة".into());
    }
    Ok(())
}

/// No picture crosses the bridge past this size, for the list or the preview:
/// a data URL is one string that the main thread evaluates, so a large
/// screenshot would stall it — and the list keeps what it gets for the whole
/// session.
const PREVIEW_IMAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// `full` is the preview's request for the original picture. Off the main
/// thread (`async`), and the files are read with the store lock released:
/// reading and encoding a few megabytes would otherwise hold up every capture
/// and panel refresh, and on the main thread the menu-bar icon and every
/// window.
///
/// `Ok(None)`: nothing to show — no such image, or its file is gone.
/// `Err(PREVIEW_TOO_LARGE)`: the original is there, too large to send, and has
/// no thumbnail; the item still pastes.
#[tauri::command(async)]
pub fn get_image(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    full: Option<bool>,
) -> Result<Option<String>, String> {
    crate::access::require(&window, "get_image")?;
    let files = ImageFiles::of(&crate::lock_store(&state.store), &id);
    files.map_or(Ok(None), |files| files.data_url(full.unwrap_or(false)))
}

/// Where an image item's picture and thumbnail are, taken under the lock.
/// Every name goes through `image_path` (005): one outside images/ is `None`.
struct ImageFiles {
    original: Option<std::path::PathBuf>,
    thumbnail: Option<std::path::PathBuf>,
}

impl ImageFiles {
    fn of(store: &Store, id: &str) -> Option<Self> {
        let item = store.find(id)?;
        let dir = store.images_dir();
        let path = |file: &Option<String>| {
            file.as_ref()
                .and_then(|f| crate::storage::image_path(&dir, f))
        };
        Some(Self {
            original: path(&item.image_file),
            thumbnail: path(&item.thumb_file),
        })
    }

    /// The thumbnail first, the original only while it fits the limit — or,
    /// with `full`, the other way round. Older history files can legitimately
    /// name a `thumbFile` that is gone, so the fallback is decided by what
    /// reads, not by which names are recorded.
    fn data_url(&self, full: bool) -> Result<Option<String>, String> {
        let size = |p: &std::path::PathBuf| std::fs::metadata(p).ok().map(|m| m.len());
        let small = self
            .original
            .as_ref()
            .filter(|p| size(p).is_some_and(|n| n <= PREVIEW_IMAGE_MAX_BYTES));
        let order = if full {
            [small, self.thumbnail.as_ref()]
        } else {
            [self.thumbnail.as_ref(), small]
        };
        if let Some(bytes) = order
            .into_iter()
            .flatten()
            .find_map(|p| std::fs::read(p).ok())
        {
            return Ok(Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )));
        }
        // Nothing sendable. A picture that is there but too large is not a
        // missing file: it pastes, and the panel says something else.
        let too_large = self
            .original
            .as_ref()
            .and_then(size)
            .is_some_and(|n| n > PREVIEW_IMAGE_MAX_BYTES);
        if too_large {
            Err(err::PREVIEW_TOO_LARGE.into())
        } else {
            Ok(None)
        }
    }
}

/// Opens the shelf, for the first-run window's "open رفّ now".
///
/// رفّ is an accessory app: no Dock icon, no ⌘Tab entry. Once the first-run
/// window closes, the hotkey and the menu-bar icon are the only two ways in,
/// so the window that teaches them offers the first use itself.
#[tauri::command]
pub fn show_panel(app: AppHandle) {
    panel::show(&app);
}

#[tauri::command]
pub fn hide_panel(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    crate::access::require(&window, "hide_panel")?;
    panel::hide(&app);
    Ok(())
}

/// The side of the panel with room for the preview, or none (Figma
/// «05 · التفاصيل» 45:5325).
#[tauri::command]
pub fn panel_preview_side(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Option<panel::PreviewSide>, String> {
    crate::access::require(&window, "panel_preview_side")?;
    Ok(panel::preview_side(&app))
}

/// Widens the panel window for the preview on `side`, or narrows it back.
#[tauri::command]
pub fn set_panel_preview(
    window: tauri::WebviewWindow,
    app: AppHandle,
    side: Option<panel::PreviewSide>,
) -> Result<(), String> {
    crate::access::require(&window, "set_panel_preview")?;
    panel::set_preview(&app, side);
    Ok(())
}

#[tauri::command]
pub fn ax_status() -> bool {
    ax_trusted_noted()
}

/// Reads the Accessibility answer and lets the menu-bar icon reflect it.
///
/// Raff does not watch the permission live, so the icon is only ever as fresh
/// as the last time something asked — which is every state read, every paste
/// attempt, and launch.
fn ax_trusted_noted() -> bool {
    let trusted = macos::ax_trusted();
    crate::tray::note_permission(trusted);
    trusted
}

#[tauri::command]
pub fn request_accessibility() -> bool {
    macos::ax_prompt()
}

#[tauri::command]
pub fn open_accessibility_settings() {
    macos::open_accessibility_pane();
}

#[tauri::command]
pub fn firstrun_done(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<AppState>,
    open_panel: Option<bool>,
) -> Result<(), String> {
    crate::access::require(&window, "firstrun_done")?;
    {
        let mut store = crate::lock_store(&state.store);
        store
            .mark_first_run_shown_persisted()
            .map_err(save_failed)?;
    }
    // «افتح رفّ»: only now, with the welcome finished, and before it closes.
    if open_panel == Some(true) {
        panel::show(&app);
    }
    if let Some(w) = app.get_webview_window("firstrun") {
        w.close().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub name: String,
    pub bundle_id: String,
}

#[tauri::command]
pub fn list_running_apps(window: tauri::WebviewWindow) -> Result<Vec<RunningApp>, String> {
    crate::access::require(&window, "list_running_apps")?;
    Ok(macos::running_apps()
        .into_iter()
        .map(|(name, bundle_id)| RunningApp { name, bundle_id })
        .collect())
}

// ─── helpers shared with main/tray ───────────────────────────────────────────

fn notify(app: &AppHandle) {
    let _ = app.emit("raff://changed", ());
}

/// The native theme override for a settings snapshot: `None` means "follow
/// the system", matching `AppHandle::set_theme`'s own convention.
pub fn theme_for(settings: &Settings) -> Option<tauri::Theme> {
    if settings.follow_system {
        None
    } else {
        Some(match settings.appearance {
            Appearance::Dark => tauri::Theme::Dark,
            Appearance::Light => tauri::Theme::Light,
        })
    }
}

// ─── Appearance ───────────────────────────────────────────────────────────────

/// Applies the native appearance override on the main thread. Raff v4 has one
/// approved application icon, so appearance changes never rewrite the bundle
/// icon or relaunch the process.
fn sync_appearance(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let theme = {
            let state = handle.state::<AppState>();
            let store = crate::lock_store(&state.store);
            theme_for(&store.settings)
        };
        handle.set_theme(theme);
    });
}

pub fn register_hotkey(app: &AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let shortcut: Shortcut = accel.parse().map_err(|e| format!("اختصار غير صالح: {e}"))?;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.on_shortcut(shortcut, move |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            panel::toggle(app);
        }
    })
    .map_err(|e| e.to_string())
}

/// How long a hidden window may stay unrevealed before the watchdog shows it
/// anyway (a lost page-load event must never leave the window invisible).
const WINDOW_REVEAL_FALLBACK_MS: u64 = 1500;

/// Builds a secondary window *hidden* and reveals it only once its content has
/// actually loaded. Showing at build time raced the WKWebView's first paint
/// and could present a permanently white window (especially when triggered
/// from the tray menu, whose tracking run loop is still unwinding).
///
/// Every secondary window uses the native title bar in overlay mode: real
/// traffic lights and window dragging from macOS, with the page drawing the
/// whole content area underneath.
fn open_window_when_ready(app: &AppHandle, label: &str, page: &str, title: &str, size: (f64, f64)) {
    if let Some(w) = app.get_webview_window(label) {
        // Visible → just focus it. Hidden → it is still loading; the
        // page-load handler (or the watchdog below) will reveal it.
        if w.is_visible().unwrap_or(false) {
            let _ = w.set_focus();
        }
        return;
    }
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .visible(false);
    let result = builder
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build();
    match result {
        Ok(w) => {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(WINDOW_REVEAL_FALLBACK_MS));
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
        }
        Err(err) => eprintln!("raff: failed to open {label} window: {err}"),
    }
}

/// Opens the official Raff repository in the user's browser. Takes no
/// argument — the URL lives in Rust, so this can only ever open that one page.
#[tauri::command]
pub fn open_repository() {
    macos::open_repository();
}

/// Opens PRIVACY.md. Takes no argument, like `open_repository`.
#[tauri::command]
pub fn open_privacy_policy() {
    macos::open_privacy_policy();
}

/// The panel header's gear (Figma «08», Header-Actions 2:7695).
#[tauri::command]
pub fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

/// «عن رفّ» from the Settings window's own action.
#[tauri::command]
pub fn open_about(app: AppHandle) {
    open_about_window(&app);
}

/// «أبلغ عن مشكلة…» from Settings and the About window.
#[tauri::command]
pub fn open_report(app: AppHandle) {
    open_report_window(&app);
}

pub fn open_settings_window(app: &AppHandle) {
    // Deferred one event-loop tick: never build a webview synchronously
    // inside the tray-menu callback (see open_window_when_ready).
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        open_window_when_ready(
            &handle,
            "settings",
            "settings.html",
            "إعدادات رفّ",
            (560.0, 440.0),
        );
    });
}

/// «عن رفّ» — the About window from Figma «08 — Product Screens», screen ٦.
/// Opened from the menu bar's contextual menu. Deferred to the main thread for
/// the same reason as settings: never build a webview inside the menu's
/// tracking run loop.
pub fn open_about_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        open_window_when_ready(&handle, "about", "about.html", "عن رفّ", (320.0, 420.0));
    });
}

/// «أبلغ عن مشكلة…» — Figma «10 — Reporting & Diagnostics» 276:8. Its own
/// window, so a report never shares a webview with the clipboard's content.
/// Deferred to the main thread like Settings (the menu can open it).
pub fn open_report_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        // A new window starts a new report: nothing left over from the last.
        if handle.get_webview_window("report").is_none() {
            crate::report::reset();
        }
        open_window_when_ready(
            &handle,
            "report",
            "report.html",
            "أبلغ عن مشكلة",
            (460.0, 600.0),
        );
    });
}

pub fn open_firstrun_window(app: &AppHandle) {
    open_window_when_ready(app, "firstrun", "firstrun.html", "رفّ", (460.0, 520.0));
}

/// Small, tab-less window dedicated to the update cycle (opened by the tray's
/// «التحقق من وجود تحديثات…»). Unlike settings/firstrun, this window is
/// hidden — not destroyed — when the user closes it (see main.rs's
/// `CloseRequested` handler), so "exists but hidden" here usually means "the
/// user closed it earlier", not "still loading". Reusing
/// `open_window_when_ready`'s existing-window branch as-is would leave it
/// hidden forever in that case (it only re-focuses *visible* windows), so an
/// existing window is shown + focused unconditionally instead.
///
/// Built at the *compact* height: the window always opens on the brief
/// "جارٍ التحقق…" state, and `update.js` grows it once (to the taller
/// "available/downloading" size) only if that turns out to be needed —
/// matching this same 280px default avoids a visible resize on first paint.
pub fn open_update_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("update") {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        open_window_when_ready(&handle, "update", "update.html", "تحديث رفّ", (360.0, 280.0));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_storage_failure_crosses_ipc_as_a_kind_not_as_its_detail() {
        // Exactly the shape `try_save_json` produces.
        let detail = "\u{062a}\u{0639}\u{0630}\u{0631} \u{062d}\u{0641}\u{0638} /Users/someone/Library/Application Support/com.raff.app/history.json: No space left on device";

        let crossed = save_failed(detail.to_string());

        assert_eq!(crossed, err::SAVE_FAILED);
        assert!(!crossed.contains("/Users/"), "no path survives");
        assert!(!crossed.contains("history"), "and no file name either");
    }

    /// IMP-01's measurement, before anything is changed for it: the deep
    /// search over the largest history رفّ keeps — 1000 rows near the 64 MB
    /// cap — for a query found nowhere (every row read to its end) and one
    /// found early. Run in release: `cargo test --release search_probe --
    /// --ignored --nocapture`. A number, not a pass: it decides whether the
    /// command leaves the main thread (roadmap: past ~16 ms).
    #[test]
    #[ignore = "a measurement, run by hand in release"]
    fn search_probe() {
        let unit = "نصّ عربي طويل يتكرر مع English words و١٢٣ أرقام، ";
        let row = unit.repeat(60_000 / unit.len());
        let dir = std::env::temp_dir().join(format!("raff-search-probe-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir.clone());
        store.settings.history_limit = 1000;
        for i in 0..1000 {
            store.capture(
                ItemKind::Text,
                format!("{i} {row}"),
                None,
                None,
                None,
                None,
                None,
                ("Notes".into(), "com.apple.Notes".into()),
            );
        }
        let rows = store.history.len();
        let bytes: usize = store.history.iter().map(|i| i.text.len()).sum();
        for (label, query) in [("nowhere", "لا يوجد هذا أبدًا"), ("early", "999 نص")]
        {
            let mut times: Vec<f64> = (0..7)
                .map(|_| {
                    let began = std::time::Instant::now();
                    let found = matching_ids(&store, query).len();
                    std::hint::black_box(found);
                    began.elapsed().as_secs_f64() * 1000.0
                })
                .collect();
            times.sort_by(f64::total_cmp);
            println!(
                "search_probe {label}: rows={rows} bytes={bytes} median={:.1}ms min={:.1}ms max={:.1}ms",
                times[3], times[0], times[6]
            );
        }
        // What holding the lock only to copy the rows out would cost.
        let mut copies: Vec<f64> = (0..7)
            .map(|_| {
                let began = std::time::Instant::now();
                let rows: Vec<(String, String)> = store
                    .pinned
                    .iter()
                    .chain(store.history.iter())
                    .map(|i| (i.id.clone(), i.text.clone()))
                    .collect();
                std::hint::black_box(rows.len());
                began.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        copies.sort_by(f64::total_cmp);
        println!(
            "search_probe copy-out: median={:.1}ms max={:.1}ms",
            copies[3], copies[6]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A newer search stops an older one where it is: typing fast does not
    /// pile up full scans of a large history (IMP-01).
    #[test]
    fn a_search_overtaken_by_a_newer_one_stops() {
        let rows: Vec<(String, String)> = (0..100)
            .map(|i| (format!("id{i}"), format!("نص {i}")))
            .collect();
        assert_eq!(
            matching_in(&rows, "نص 5", || true).map(|ids| ids.len()),
            Some(1 + 10), // «نص 5» and «نص 50» … «نص 59»
            "a search left alone runs to the end"
        );
        let seen = std::cell::Cell::new(0);
        let overtaken = matching_in(&rows, "نص", || {
            seen.set(seen.get() + 1);
            seen.get() < 10
        });
        assert_eq!(overtaken, None, "overtaken, it answers nothing");
        assert!(seen.get() <= 11, "and stops there, not after every row");
    }

    /// IMP-07: a pinned item is found by its name as by its text.
    #[test]
    fn the_deep_search_finds_a_pinned_item_by_its_name() {
        let mut store = store_with_rows(&["نص لا يذكر الاسم"]);
        let id = store.history[0].id.clone();
        assert!(store.toggle_pin(&id));
        store.save_pinned();
        store.save_history();
        store
            .set_label_persisted(&id, Some("عنوان المكتب"))
            .unwrap();
        assert_eq!(ids_matching(&store, "المكتب"), vec![id.clone()]);
        assert_eq!(ids_matching(&store, "يذكر"), vec![id]);
    }

    /// A name kept by an unpinned row is hidden: neither shown nor searched
    /// until the row is pinned again (Sultan, 2026-10-22).
    #[test]
    fn a_hidden_name_is_neither_sent_nor_searched() {
        let mut store = store_with_rows(&["نص بلا ذكر للاسم"]);
        let id = store.history[0].id.clone();
        store.history[0].label = Some("المكتب".into());
        assert!(ids_matching(&store, "المكتب").is_empty());
        assert_eq!(ItemDto::from(&store.history[0]).label, None);
        assert!(store.toggle_pin(&id));
        assert_eq!(ids_matching(&store, "المكتب"), vec![id.clone()]);
        assert_eq!(
            ItemDto::from(&store.pinned[0]).label.as_deref(),
            Some("المكتب")
        );
    }

    /// IMP-09: a picture is found by the text read in it.
    #[test]
    fn the_deep_search_finds_a_picture_by_its_text() {
        let mut store = store_with_rows(&["سطر عادي"]);
        store.capture(
            ItemKind::Image,
            "صورة 10×10".into(),
            None,
            None,
            None,
            None,
            Some("h".into()),
            ("Preview".into(), "com.apple.Preview".into()),
        );
        let id = store.history[0].id.clone();
        store.history[0].ocr_text = Some("فاتورة الكهرباء\nTotal 42".into());
        store.settings.ocr_enabled = true;
        assert_eq!(ids_matching(&store, "الكهرباء"), vec![id.clone()]);
        assert_eq!(ids_matching(&store, "total 42"), vec![id]);
        // Off: picture text is not looked at, wherever a copy of it remains.
        store.settings.ocr_enabled = false;
        assert!(ids_matching(&store, "الكهرباء").is_empty());
    }

    /// The store-side half of `search_items`: everything except taking the lock.
    fn ids_matching(store: &Store, query: &str) -> Vec<String> {
        matching_ids(store, query)
    }

    fn store_with_rows(texts: &[&str]) -> Store {
        let dir = std::env::temp_dir().join(format!("raff-search-test-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir);
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
        }
        store
    }

    /// Mirrors `tests/audit-normalize-parity.test.mjs`: the panel's own filter
    /// finds «ΟΔΟΣ» by «οδος» and not by «οδοσ» (RAFF-AUD-007).
    #[test]
    fn a_final_sigma_is_found_by_the_same_query_on_both_sides() {
        let store = store_with_rows(&["\u{039F}\u{0394}\u{039F}\u{03A3}"]); // ΟΔΟΣ
        assert_eq!(
            ids_matching(&store, "\u{03BF}\u{03B4}\u{03BF}\u{03C2}").len(),
            1
        ); // οδος
        assert!(ids_matching(&store, "\u{03BF}\u{03B4}\u{03BF}\u{03C3}").is_empty());
        // οδοσ
    }

    /// A query pasted with a byte-order mark is the query without it, as in
    /// the panel (RAFF-AUD-008).
    #[test]
    fn a_leading_byte_order_mark_is_trimmed_from_the_query() {
        let store = store_with_rows(&["\u{0631}\u{0641}\u{0651}"]); // رفّ
        assert_eq!(ids_matching(&store, "\u{FEFF}\u{0631}\u{0641}").len(), 1);
    }

    #[test]
    fn search_reaches_past_the_preview_the_panel_can_see() {
        let mut store = Store::load(
            std::env::temp_dir().join(format!("raff-search-test-{}", uuid::Uuid::new_v4())),
        );
        // The distinctive word sits at character 2500 — well past the cut.
        let mut text = "\u{0645} ".repeat(1_250);
        text.push_str(
            "\u{0634}\u{0641}\u{0631}\u{0629}\u{0627}\u{0644}\u{062e}\u{0632}\u{0646}\u{0629}",
        );
        text.push_str(&"\u{0645} ".repeat(250));
        assert!(text.chars().count() > 3_000);
        store.capture(
            ItemKind::Text,
            text.clone(),
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );
        let id = store.history[0].id.clone();

        assert_eq!(
            ids_matching(
                &store,
                "\u{0634}\u{0641}\u{0631}\u{0629}\u{0627}\u{0644}\u{062e}\u{0632}\u{0646}\u{0629}"
            ),
            vec![id],
            "the shelf is searched, not the preview"
        );

        // ...and the row the panel is handed is still cut where it was.
        let dto = ItemDto::from(&store.history[0]);
        assert_eq!(
            dto.text.chars().count(),
            PREVIEW_MAX_CHARS + 1,
            "the preview did not grow: 1000 characters plus the ellipsis"
        );
        assert!(dto.text.ends_with('\u{2026}'));
    }

    #[test]
    fn an_unpin_says_whether_history_took_the_row_back() {
        let dir = std::env::temp_dir().join(format!("raff-pin-dto-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir);
        for text in [
            "\u{0623}\u{0642}\u{062f}\u{0645}",
            "\u{0623}\u{062d}\u{062f}\u{062b}",
        ] {
            store.capture(
                ItemKind::Text,
                text.into(),
                None,
                None,
                None,
                None,
                None,
                ("Notes".into(), "com.apple.Notes".into()),
            );
        }
        let (newer, older) = (store.history[0].id.clone(), store.history[1].id.clone());

        let pinned = set_pin(&mut store, &newer, true).unwrap();
        assert_eq!(
            pinned,
            PinDto {
                is_pinned: true,
                removed: false,
                reason: None,
            }
        );
        assert_eq!(
            set_pin(&mut store, &newer, false).unwrap(),
            PinDto {
                is_pinned: false,
                removed: false,
                reason: None,
            },
            "newer than the history it returns to: taken back"
        );

        set_pin(&mut store, &older, true).unwrap();
        store.find_mut(&older).unwrap().created_at = 1;
        assert_eq!(
            set_pin(&mut store, &older, false).unwrap(),
            PinDto {
                is_pinned: false,
                removed: true,
                reason: Some(crate::storage::UnpinRemoval::OlderThanHistory),
            },
            "older than all of it: gone"
        );
        assert_eq!(
            serde_json::to_value(PinDto {
                is_pinned: false,
                removed: false,
                reason: None,
            })
            .unwrap(),
            serde_json::json!({ "isPinned": false, "removed": false }),
            "no reason on the wire when there is none"
        );
        for (reason, word) in [
            (crate::storage::UnpinRemoval::Retention, "retention"),
            (
                crate::storage::UnpinRemoval::OlderThanHistory,
                "olderThanHistory",
            ),
            (crate::storage::UnpinRemoval::Limit, "limit"),
        ] {
            assert_eq!(
                serde_json::to_value(PinDto {
                    is_pinned: false,
                    removed: true,
                    reason: Some(reason),
                })
                .unwrap(),
                serde_json::json!({ "isPinned": false, "removed": true, "reason": word })
            );
        }
    }

    #[test]
    fn search_folds_spelling_the_same_way_the_panel_does() {
        let mut store = Store::load(
            std::env::temp_dir().join(format!("raff-search-test-{}", uuid::Uuid::new_v4())),
        );
        store.capture(
            ItemKind::Text,
            "\u{0623}\u{0643}\u{062a}\u{0628}".into(), // أكتب
            None,
            None,
            None,
            None,
            None,
            ("Notes".into(), "com.apple.Notes".into()),
        );

        assert_eq!(
            ids_matching(&store, "\u{0627}\u{0643}\u{062a}\u{0628}").len(), // اكتب
            1,
            "a query written with bare alef still finds it"
        );
        assert!(ids_matching(&store, "\u{0645}\u{062f}\u{0631}\u{0633}\u{0647}").is_empty());
    }

    fn image_data_url(store: &Store, id: &str, full: bool) -> Result<Option<String>, String> {
        ImageFiles::of(store, id).map_or(Ok(None), |files| files.data_url(full))
    }

    fn data_url_of(bytes: &[u8]) -> Result<Option<String>, String> {
        Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }

    fn image_store(original: &[u8], thumb: Option<(&str, &[u8])>) -> (Store, String) {
        let root = std::env::temp_dir().join(format!("raff-image-test-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(root);
        std::fs::write(store.images_dir().join("original.png"), original).unwrap();
        if let Some((name, bytes)) = thumb {
            std::fs::write(store.images_dir().join(name), bytes).unwrap();
        }
        store.capture(
            ItemKind::Image,
            "image".into(),
            None,
            None,
            Some("original.png".into()),
            Some("preview.thumb.png".into()),
            Some("hash".into()),
            ("Test".into(), "com.test".into()),
        );
        let id = store.history[0].id.clone();
        (store, id)
    }

    #[test]
    fn get_image_prefers_the_persisted_thumbnail() {
        let (store, id) = image_store(b"original", Some(("preview.thumb.png", b"thumbnail")));
        assert_eq!(
            image_data_url(&store, &id, false),
            data_url_of(b"thumbnail")
        );
    }

    // The preview beside the panel is 308pt wide: it asks for the original,
    // which beats a 128×80 thumbnail — up to a size a data URL can carry.
    #[test]
    fn the_preview_gets_the_original_picture_up_to_its_limit() {
        let (store, id) = image_store(b"original", Some(("preview.thumb.png", b"thumbnail")));
        assert_eq!(image_data_url(&store, &id, true), data_url_of(b"original"));

        let huge = vec![0u8; PREVIEW_IMAGE_MAX_BYTES as usize + 1];
        let (store, id) = image_store(&huge, Some(("preview.thumb.png", b"thumbnail")));
        assert_eq!(
            image_data_url(&store, &id, true),
            data_url_of(b"thumbnail"),
            "too large for the bridge: the thumbnail instead"
        );

        let (store, id) = image_store(&huge, None);
        assert_eq!(
            image_data_url(&store, &id, true),
            Err(err::PREVIEW_TOO_LARGE.into()),
            "and with no thumbnail, no picture rather than the oversized original"
        );
    }

    /// F-THUMB-FALLBACK (audit 2026-10-21): the list's own request, with the
    /// recorded thumbnail gone, used to send the original whatever its size —
    /// the 64 MiB case was an 89-million-character string across the bridge.
    /// Now nothing is sent, and the answer says why: the picture is there, it
    /// is the preview that is not — the file is neither missing nor touched.
    #[test]
    fn a_card_never_gets_an_original_past_the_limit() {
        let huge = vec![0u8; PREVIEW_IMAGE_MAX_BYTES as usize + 1];
        let (store, id) = image_store(&huge, None);
        assert_eq!(
            image_data_url(&store, &id, false),
            Err(err::PREVIEW_TOO_LARGE.into())
        );
        let original = store.images_dir().join("original.png");
        assert_eq!(std::fs::read(original).unwrap().len(), huge.len());

        let at_limit = vec![0u8; PREVIEW_IMAGE_MAX_BYTES as usize];
        let (store, id) = image_store(&at_limit, None);
        assert_eq!(image_data_url(&store, &id, false), data_url_of(&at_limit));
    }

    #[test]
    fn get_image_falls_back_when_the_recorded_thumbnail_is_missing() {
        let (store, id) = image_store(b"original", None);
        assert_eq!(image_data_url(&store, &id, false), data_url_of(b"original"));
    }

    /// A missing file is told apart from a picture too large to send.
    #[test]
    fn a_missing_picture_is_nothing_not_too_large() {
        let (store, id) = image_store(b"original", None);
        std::fs::remove_file(store.images_dir().join("original.png")).unwrap();
        assert_eq!(image_data_url(&store, &id, false), Ok(None));
        assert_eq!(image_data_url(&store, &id, true), Ok(None));
        assert_eq!(image_data_url(&store, "no-such-id", false), Ok(None));
    }
}

// وحدة اختبارات التدقيق (RAFF-COPILOT-AUDIT). اختبارات فقط.
#[cfg(test)]
mod audit_tests {
    use super::*;

    fn valid() -> Settings {
        Settings::default()
    }

    #[test]
    fn a_global_shortcut_needs_more_than_shift_and_leaves_every_app_its_edits() {
        for accel in ["shift+a", "shift+space", "shift+5", "Shift+F6", "a"] {
            assert_eq!(
                hotkey_refusal(accel),
                Some(err::HOTKEY_NEEDS_MODIFIER),
                "{accel}"
            );
        }
        for accel in [
            "super+c",
            "super+v",
            "super+x",
            "super+a",
            "super+z",
            "super+q",
            "super+w",
            "Cmd+V",
            "command+KeyV",
            "CmdOrCtrl+Q",
            "CommandOrCtrl+V",
            "CmdOrControl+X",
        ] {
            assert_eq!(hotkey_refusal(accel), Some(err::HOTKEY_SHARED), "{accel}");
        }
        for accel in [
            "shift+super+v",
            "alt+super+v",
            "ctrl+v",
            "alt+5",
            "super+k",
            "super+F6",
            "ctrl+shift+a",
        ] {
            assert_eq!(hotkey_refusal(accel), None, "{accel}");
        }
    }

    #[test]
    fn validate_settings_boundaries() {
        assert!(validate_settings(&valid()).is_ok());
        for limit in [0usize, 1, 199, 201, 499, 999, 1001, usize::MAX] {
            let mut s = valid();
            s.history_limit = limit;
            assert!(validate_settings(&s).is_err(), "history_limit={limit}");
        }
        for days in [1u32, 6, 8, 29, 31, 89, 91, u32::MAX] {
            let mut s = valid();
            s.retention_days = days;
            assert!(validate_settings(&s).is_err(), "retention_days={days}");
        }
        let mut s = valid();
        s.hotkey = "a".repeat(128);
        assert!(validate_settings(&s).is_ok(), "128 حرفًا مسموح");
        s.hotkey = "a".repeat(129);
        assert!(validate_settings(&s).is_err());
        s.hotkey.clear();
        assert!(validate_settings(&s).is_err());

        let mut s = valid();
        s.excluded_apps = (0..128).map(|i| format!("com.app{i}")).collect();
        assert!(validate_settings(&s).is_ok(), "128 تطبيقًا مسموح");
        s.excluded_apps.push("com.extra".into());
        assert!(validate_settings(&s).is_err());
        for bad in [
            "",
            "com.a b",
            "com.a\u{0000}",
            "com.a\t",
            "com.\u{00A0}x",
            "com.\u{2028}x",
        ] {
            let mut s = valid();
            s.excluded_apps = vec![bad.into()];
            assert!(validate_settings(&s).is_err(), "{bad:?}");
        }
        let mut s = valid();
        s.excluded_apps = vec!["a".repeat(255)];
        assert!(validate_settings(&s).is_ok());
        s.excluded_apps = vec!["a".repeat(256)];
        assert!(validate_settings(&s).is_err());
    }

    #[test]
    fn observation_bidi_controls_pass_bundle_validation() {
        // U+202E (RLO) ليس control ولا whitespace في Rust، فيقبله المدقق.
        // ملاحظة فقط: معرّف الحزمة لا يُعرض كنص منسَّق في واجهة الالتقاط.
        let mut s = valid();
        s.excluded_apps = vec!["com.\u{202E}evil".into()];
        assert!(validate_settings(&s).is_ok());
    }

    /// RAFF-AUD-004: موضع واحد في الملف يقفل المخزن بـ unwrap بدل crate::lock_store.
    fn raw_unwrap_lock_sites() -> usize {
        let src = include_str!("commands.rs");
        let product = src.split("#[cfg(test)]").next().unwrap();
        let compact: String = product.chars().filter(|c| !c.is_whitespace()).collect();
        compact.matches("store.lock().unwrap()").count()
    }

    #[test]
    fn aud004_no_raw_unwrap_lock() {
        assert_eq!(raw_unwrap_lock_sites(), 0);
    }
}
