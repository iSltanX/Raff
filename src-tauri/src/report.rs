//! In-app problem report — the shared channel's contract v1
//! (README in iSltanX/app-reports). Figma «10 — Reporting & Diagnostics».
//!
//! Compose → preview (the payload is built and frozen here, in Rust) →
//! confirm → `#id`. Sending, retrying and copying all use the frozen bytes,
//! with one `Idempotency-Key` per frozen payload: a retry after a lost answer
//! returns the same report instead of filing a second. The network is used
//! from Rust only; the webview's CSP keeps it offline. Nothing is sent before
//! the user confirms, and previewing or sending never touches the clipboard.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::diagnostics::{self, Diagnostics};
use crate::report_image::{self, ImageMeta, Prepared};

/// Fixed in release. A debug build may point elsewhere (a closed local port,
/// to prove the failure path) with `RAFF_REPORT_ENDPOINT`.
pub const ENDPOINT: &str = "https://app-reports.isultantf.workers.dev/v1/reports";
/// The window's limit (Gate 1). The contract allows 2000.
pub const MAX_DESCRIPTION_CHARS: usize = 1000;
const SEND_TIMEOUT: Duration = Duration::from_secs(20);
/// When a 429 carries no Retry-After (or an HTTP date), wait an hour (the
/// per-IP window). A hostile or broken value is capped at a day.
const DEFAULT_RETRY_AFTER_S: u64 = 3600;
const MAX_RETRY_AFTER_S: u64 = 86_400;

pub const KINDS: [&str; 4] = ["bug", "crash", "suggestion", "other"];
pub const CATEGORIES: [&str; 8] = [
    "panel", "search", "paste", "hotkey", "capture", "settings", "updates", "other",
];

pub fn endpoint() -> String {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("RAFF_REPORT_ENDPOINT") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    ENDPOINT.to_string()
}

/// Stable codes the window turns into Arabic.
pub mod err {
    pub const INVALID: &str = "raff/report-invalid";
    pub const NOT_PREPARED: &str = "raff/report-not-prepared";
    pub const COPY_FAILED: &str = "raff/copy-failed";
    pub const PASTED_FILE: &str = "raff/image-pasted-file";
}

#[derive(Serialize, Clone, Debug)]
struct Attachment {
    #[serde(rename = "type")]
    mime: &'static str,
    data: String,
}

/// The request body, field for field as the contract names them. Unknown
/// fields are rejected by the channel, so nothing else is ever added.
#[derive(Serialize, Clone, Debug)]
struct Payload {
    product: &'static str,
    app_version: String,
    os: &'static str,
    os_version: String,
    arch: &'static str,
    locale: &'static str,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<&'static str>,
    description: String,
    diagnostics: Diagnostics,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    test: Option<bool>,
}

/// Exactly what the preview shows — the frozen payload, decoded for display.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub kind: &'static str,
    pub category: Option<&'static str>,
    pub description: String,
    pub app_version: String,
    pub os: &'static str,
    pub os_version: String,
    pub arch: &'static str,
    pub locale: &'static str,
    pub test: bool,
    pub idempotency_key: String,
    /// The diagnostics object as it will be sent, pretty-printed.
    pub diagnostics_json: String,
    pub image: Option<ImageMeta>,
    pub endpoint_host: String,
}

struct Frozen {
    body: String,
    key: String,
    preview: Preview,
}

#[derive(Default)]
struct Session {
    image: Option<Prepared>,
    frozen: Option<Frozen>,
    blocked_until: Option<Instant>,
    /// Bumped by `reset()`. Work that started under an older epoch (an image
    /// still decoding, a send still in flight when the window closed) must not
    /// write into the report the user opens next.
    epoch: u64,
}

fn session() -> &'static Mutex<Session> {
    static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(Session::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Session> {
    session().lock().unwrap_or_else(|p| p.into_inner())
}

/// What a send ended in. The window decides the words.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SendOutcome {
    /// 201, or 200 for a replayed key.
    Sent { id: u64 },
    /// 400 / 413 / 415 — sending again would not change the answer.
    Rejected { code: u16, error: Option<String>, field: Option<String> },
    /// 429 — try again after `retry_after_s`.
    #[serde(rename_all = "camelCase")]
    RateLimited { retry_after_s: u64 },
    /// 5xx, a success without an id, a timeout, or no connection.
    Failed { reason: &'static str },
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

fn os_version() -> String {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION
        .get_or_init(|| {
            std::process::Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().chars().filter(|c| c.is_ascii_digit() || *c == '.').take(16).collect())
                .filter(|s: &String| !s.is_empty())
                .unwrap_or_else(|| "unknown".into())
        })
        .clone()
}

fn host_of(endpoint: &str) -> String {
    endpoint
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("")
        .to_string()
}

/// Validates the user's answers and the image, builds the payload and
/// freezes it with a fresh key. Pure over its inputs, so it is tested.
fn freeze(
    kind: &str,
    category: Option<&str>,
    description: &str,
    diagnostics: Diagnostics,
    image: Option<&Prepared>,
    app_version: String,
    os_version: String,
    endpoint: &str,
) -> Result<Frozen, String> {
    let kind = KINDS.iter().copied().find(|k| *k == kind).ok_or(err::INVALID)?;
    let category = match category.filter(|c| !c.is_empty()) {
        None => None,
        Some(c) => Some(CATEGORIES.iter().copied().find(|k| *k == c).ok_or(err::INVALID)?),
    };
    let description = description.trim().to_string();
    let length = description.chars().count();
    if length == 0 || length > MAX_DESCRIPTION_CHARS {
        return Err(err::INVALID.into());
    }
    let test = cfg!(debug_assertions);
    let attachments = image
        .map(|img| {
            vec![Attachment {
                mime: img.mime,
                data: base64::engine::general_purpose::STANDARD.encode(&img.bytes),
            }]
        })
        .unwrap_or_default();
    let diagnostics_json =
        serde_json::to_string_pretty(&diagnostics).map_err(|_| err::INVALID.to_string())?;
    let payload = Payload {
        product: "raff",
        app_version: app_version.clone(),
        os: "macos",
        os_version: os_version.clone(),
        arch: arch(),
        locale: "ar",
        kind,
        category,
        description: description.clone(),
        diagnostics,
        attachments,
        test: test.then_some(true),
    };
    let body = serde_json::to_string(&payload).map_err(|_| err::INVALID.to_string())?;
    let key = uuid::Uuid::new_v4().to_string();
    Ok(Frozen {
        preview: Preview {
            kind,
            category,
            description,
            app_version,
            os: "macos",
            os_version,
            arch: arch(),
            locale: "ar",
            test,
            idempotency_key: key.clone(),
            diagnostics_json,
            image: image.map(|i| i.meta()),
            endpoint_host: host_of(endpoint),
        },
        body,
        key,
    })
}

/// «انسخ البلاغ»: the same JSON, pretty-printed, with each attachment's
/// base64 replaced by its type and size.
fn copy_text(body: &str) -> String {
    let mut value: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    if let Some(list) = value.get_mut("attachments").and_then(|a| a.as_array_mut()) {
        for attachment in list.iter_mut() {
            let mime = attachment.get("type").cloned().unwrap_or_default();
            let bytes = attachment
                .get("data")
                .and_then(|d| d.as_str())
                .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
                .map(|b| b.len())
                .unwrap_or(0);
            *attachment = serde_json::json!({ "type": mime, "bytes": bytes });
        }
    }
    serde_json::to_string_pretty(&value).unwrap_or_default()
}

fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn retry_after_seconds(value: Option<&reqwest::header::HeaderValue>) -> u64 {
    value
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_RETRY_AFTER_S)
        .min(MAX_RETRY_AFTER_S)
}

/// One POST of a frozen body. Separate from the session so it is tested
/// against a local server.
async fn send_to(endpoint: &str, body: &str, key: &str, timeout: Duration) -> SendOutcome {
    ensure_crypto_provider();
    // No redirects: a 307/308 would re-post the report (image included) to
    // whatever host the answer names.
    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => return SendOutcome::Failed { reason: "network" },
    };
    let response = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", key)
        .body(body.to_string())
        .send()
        .await;
    let response = match response {
        Ok(r) => r,
        Err(e) if e.is_timeout() => return SendOutcome::Failed { reason: "timeout" },
        Err(_) => return SendOutcome::Failed { reason: "network" },
    };
    let code = response.status().as_u16();
    let retry_after = retry_after_seconds(response.headers().get(reqwest::header::RETRY_AFTER));
    let json: serde_json::Value = response.json().await.unwrap_or_default();
    match code {
        200 | 201 => match json.get("id").and_then(|id| id.as_u64()) {
            Some(id) => SendOutcome::Sent { id },
            None => SendOutcome::Failed { reason: "server" },
        },
        400 | 413 | 415 => SendOutcome::Rejected {
            code,
            error: json.get("error").and_then(|v| v.as_str()).map(|s| s.chars().take(64).collect()),
            field: json.get("field").and_then(|v| v.as_str()).map(|s| s.chars().take(64).collect()),
        },
        429 => SendOutcome::RateLimited { retry_after_s: retry_after },
        _ => SendOutcome::Failed { reason: "server" },
    }
}

/// Writes text to the clipboard the way رفّ writes everything it pastes: the
/// change count is recorded so the capture loop skips رفّ's own write.
fn write_clipboard(app: &AppHandle, text: &str) -> Result<(), String> {
    let count = crate::macos::write_clip(Some(text), None, None, None)
        .ok_or_else(|| err::COPY_FAILED.to_string())?;
    let state = app.state::<crate::AppState>();
    state
        .skip_change_count
        .store(count as i64, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

// ─── Commands ─────────────────────────────────────────────────────────────

/// Only the report window may drive a report (and Settings may copy the
/// diagnostics): the panel, which renders clipboard content, may not.
fn require_window(window: &tauri::WebviewWindow, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&window.label()) {
        Ok(())
    } else {
        Err(err::INVALID.into())
    }
}

/// Reads the macOS version once, off the main thread, at launch.
pub fn warm() {
    std::thread::spawn(|| {
        let _ = os_version();
    });
}

/// Builds and freezes the payload; returns what the preview shows. Async so
/// encoding a large image never runs on the main thread.
#[tauri::command]
pub async fn report_prepare(
    app: AppHandle,
    window: tauri::WebviewWindow,
    kind: String,
    category: Option<String>,
    description: String,
) -> Result<Preview, String> {
    require_window(&window, &["report"])?;
    let diagnostics = diagnostics::collect(&app);
    let version = app.package_info().version.to_string();
    let mut session = lock();
    let frozen = freeze(
        &kind,
        category.as_deref(),
        &description,
        diagnostics,
        session.image.as_ref(),
        version,
        os_version(),
        &endpoint(),
    )?;
    let preview = frozen.preview.clone();
    session.frozen = Some(frozen);
    Ok(preview)
}

/// Sends the frozen payload (or re-sends it, with the same key).
#[tauri::command]
pub async fn report_send(window: tauri::WebviewWindow) -> Result<SendOutcome, String> {
    require_window(&window, &["report"])?;
    let (body, key, blocked, epoch) = {
        let session = lock();
        let frozen = session.frozen.as_ref().ok_or(err::NOT_PREPARED)?;
        (frozen.body.clone(), frozen.key.clone(), session.blocked_until, session.epoch)
    };
    if let Some(until) = blocked {
        let left = until.saturating_duration_since(Instant::now()).as_secs();
        if left > 0 {
            return Ok(SendOutcome::RateLimited { retry_after_s: left });
        }
    }
    let began = Instant::now();
    let outcome = send_to(&endpoint(), &body, &key, SEND_TIMEOUT).await;
    diagnostics::record(
        "report",
        match outcome {
            SendOutcome::Sent { .. } => "ok",
            _ => "error",
        },
        began,
    );
    let mut session = lock();
    match &outcome {
        // Only the report that was sent is forgotten — never one the user
        // started after closing the window mid-send.
        SendOutcome::Sent { .. } if session.epoch == epoch => {
            session.image = None;
            session.frozen = None;
        }
        // A rate limit is the server's answer about this Mac, whatever window
        // is open now.
        SendOutcome::RateLimited { retry_after_s } => {
            session.blocked_until =
                Instant::now().checked_add(Duration::from_secs(*retry_after_s));
        }
        _ => {}
    }
    Ok(outcome)
}

/// «نسخ البلاغ» — the frozen payload, attachments as {type, bytes}.
#[tauri::command]
pub async fn report_copy(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    require_window(&window, &["report"])?;
    let text = {
        let session = lock();
        copy_text(&session.frozen.as_ref().ok_or(err::NOT_PREPARED)?.body)
    };
    write_clipboard(&app, &text)
}

/// «نسخ الرقم» — `#id`, through the same skipped write.
#[tauri::command]
pub fn report_copy_number(app: AppHandle, window: tauri::WebviewWindow, id: u64) -> Result<(), String> {
    require_window(&window, &["report"])?;
    write_clipboard(&app, &format!("#{id}"))
}

/// «معلومات التشخيص ← نسخ» — the diagnostics object alone. Sends nothing.
#[tauri::command]
pub async fn diagnostics_copy(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    require_window(&window, &["settings", "report"])?;
    let text = serde_json::to_string_pretty(&diagnostics::collect(&app))
        .map_err(|_| err::COPY_FAILED.to_string())?;
    write_clipboard(&app, &text)
}

async fn prepare_off_main(bytes: Vec<u8>, from_pasteboard: bool) -> Result<ImageMeta, String> {
    let epoch = lock().epoch;
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        report_image::prepare(&bytes, from_pasteboard)
    })
    .await
    .map_err(|_| report_image::ImageError::Unreadable.code().to_string())?
    .map_err(|e| e.code().to_string())?;
    let meta = prepared.meta();
    store_image(epoch, prepared);
    Ok(meta)
}

/// Attaches a finished image — unless the window it was meant for is gone.
fn store_image(epoch: u64, prepared: Prepared) {
    let mut session = lock();
    if session.epoch == epoch {
        session.image = Some(prepared);
        session.frozen = None; // a new image is a new payload
    }
}

/// A failed attach leaves no image behind: the window then says there is
/// none, and a preview must never carry an earlier one it no longer shows.
fn forget_image_on_error<T>(result: Result<T, String>) -> Result<T, String> {
    if result.is_err() {
        let mut session = lock();
        session.image = None;
        session.frozen = None;
    }
    result
}

/// «اختر صورة…» — a native open panel; the path never reaches the webview.
/// Cancelling keeps whatever was attached.
#[tauri::command]
pub async fn report_pick_image(window: tauri::WebviewWindow) -> Result<Option<ImageMeta>, String> {
    require_window(&window, &["report"])?;
    forget_image_on_error(pick_image().await)
}

/// Reads at most the input ceiling plus one byte from a regular file, so a
/// special file or a symlink to one cannot feed an endless stream.
fn read_capped(path: &std::path::Path) -> Result<Vec<u8>, report_image::ImageError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| report_image::ImageError::Unreadable)?;
    let meta = file.metadata().map_err(|_| report_image::ImageError::Unreadable)?;
    if !meta.is_file() {
        return Err(report_image::ImageError::Unreadable);
    }
    let mut bytes = Vec::new();
    file.take(report_image::MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| report_image::ImageError::Unreadable)?;
    if bytes.len() > report_image::MAX_INPUT_BYTES {
        return Err(report_image::ImageError::TooLarge);
    }
    Ok(bytes)
}

async fn pick_image() -> Result<Option<ImageMeta>, String> {
    // The panel runs on the GCD main queue, not inside Tauri's event-loop
    // task: a modal loop nested in that task can re-enter the runtime's
    // locked event handler (a redraw while the panel is up) and hang.
    let (tx, rx) = std::sync::mpsc::channel();
    crate::macos::dispatch_to_main(move || {
        let _ = tx.send(crate::macos::choose_image_file());
    });
    let path = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten();
    let Some(path) = path else { return Ok(None) };
    let bytes = tauri::async_runtime::spawn_blocking(move || read_capped(std::path::Path::new(&path)))
        .await
        .map_err(|_| report_image::ImageError::Unreadable.code().to_string())?
        .map_err(|e| e.code().to_string())?;
    prepare_off_main(bytes, false).await.map(Some)
}

/// A paste in the report window: the pasteboard is read at that moment, for
/// that purpose only. `Ok(None)` when it holds no image (what was attached
/// stays).
#[tauri::command]
pub async fn report_paste_image(window: tauri::WebviewWindow) -> Result<Option<ImageMeta>, String> {
    require_window(&window, &["report"])?;
    let result = match crate::macos::read_image_for_report() {
        crate::macos::PastedImage::Image(bytes) => prepare_off_main(bytes, true).await.map(Some),
        crate::macos::PastedImage::File => Err(err::PASTED_FILE.into()),
        crate::macos::PastedImage::Nothing => Ok(None),
    };
    forget_image_on_error(result)
}

#[tauri::command]
pub fn report_remove_image(window: tauri::WebviewWindow) {
    if require_window(&window, &["report"]).is_err() {
        return;
    }
    let mut session = lock();
    session.image = None;
    session.frozen = None;
}

/// Forgets everything — called when the report window closes and before a
/// new one opens. A rate limit outlives the window; late work is fenced off
/// by the new epoch.
pub fn reset() {
    let mut session = lock();
    *session = Session {
        blocked_until: session.blocked_until,
        epoch: session.epoch.wrapping_add(1),
        ..Session::default()
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn diag() -> Diagnostics {
        let dir = std::env::temp_dir().join(format!("raff-report-test-{}", uuid::Uuid::new_v4()));
        let store = crate::storage::Store::load(dir.clone());
        let diagnostics = diagnostics::from_parts(&store, true, crate::Pause::Off, Some(true), vec![], 1);
        let _ = std::fs::remove_dir_all(dir);
        diagnostics
    }

    fn frozen(description: &str, image: Option<&Prepared>) -> Frozen {
        freeze("bug", Some("hotkey"), description, diag(), image, "5.1.0".into(), "15.4".into(), ENDPOINT)
            .expect("valid")
    }

    struct Seen {
        head: String,
        body: String,
    }

    /// A one-shot local HTTP server: answers with `status`, `extra` headers
    /// and `body`, and reports what it received. `respond: false` accepts and
    /// never answers (a timeout).
    fn server(status: &str, extra: &str, body: &str, respond: bool) -> (String, mpsc::Receiver<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/reports", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let (status, extra, body) = (status.to_string(), extra.to_string(), body.to_string());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head, mut rest) = loop {
                let n = stream.read(&mut chunk).unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break (String::from_utf8_lossy(&buf[..i]).to_string(), buf[i + 4..].to_vec());
                }
            };
            let length: usize = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .unwrap_or(0);
            while rest.len() < length {
                let n = stream.read(&mut chunk).unwrap();
                rest.extend_from_slice(&chunk[..n]);
            }
            let _ = tx.send(Seen { head, body: String::from_utf8_lossy(&rest).to_string() });
            if respond {
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            } else {
                std::thread::sleep(Duration::from_secs(3));
            }
        });
        (url, rx)
    }

    fn send(url: &str, f: &Frozen) -> SendOutcome {
        tauri::async_runtime::block_on(send_to(url, &f.body, &f.key, Duration::from_millis(800)))
    }

    #[test]
    fn a_created_report_returns_its_number_and_sends_exactly_the_frozen_bytes() {
        let f = frozen("الاختصار لا يفتح اللوحة بعد إعادة التشغيل", None);
        let (url, seen) = server("201 Created", "", r#"{"id":12}"#, true);
        assert_eq!(send(&url, &f), SendOutcome::Sent { id: 12 });
        let seen = seen.recv().unwrap();
        assert_eq!(seen.body, f.body, "the request body is the frozen preview, byte for byte");
        let head = seen.head.to_ascii_lowercase();
        assert!(head.contains("content-type: application/json"));
        assert!(head.contains(&format!("idempotency-key: {}", f.key)));
    }

    #[test]
    fn a_replayed_key_answers_200_with_the_same_number() {
        let f = frozen("مرة ثانية بعد ضياع الرد", None);
        let (url, seen) = server("200 OK", "", r#"{"id":12}"#, true);
        assert_eq!(send(&url, &f), SendOutcome::Sent { id: 12 }, "200 is a replay, not a failure");
        assert!(seen.recv().unwrap().head.to_ascii_lowercase().contains(&format!("idempotency-key: {}", f.key)));
    }

    #[test]
    fn a_retry_after_is_capped_and_a_date_falls_back_to_the_hour() {
        let f = frozen("كثير جدًا", None);
        let (url, _) = server("429 Too Many Requests", "Retry-After: 999999999999\r\n", "", true);
        assert_eq!(send(&url, &f), SendOutcome::RateLimited { retry_after_s: MAX_RETRY_AFTER_S });
        let (url, _) = server("429 Too Many Requests", "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT\r\n", "", true);
        assert_eq!(send(&url, &f), SendOutcome::RateLimited { retry_after_s: DEFAULT_RETRY_AFTER_S });
    }

    #[test]
    fn a_redirect_is_not_followed_with_the_report() {
        let f = frozen("إعادة توجيه", None);
        let (elsewhere, seen_elsewhere) = server("201 Created", "", r#"{"id":99}"#, true);
        let location = format!("Location: {elsewhere}\r\n");
        let (url, _) = server("307 Temporary Redirect", &location, "", true);
        assert_eq!(send(&url, &f), SendOutcome::Failed { reason: "server" });
        assert!(
            seen_elsewhere.recv_timeout(Duration::from_millis(300)).is_err(),
            "the body never reaches the host a redirect names"
        );
    }

    #[test]
    fn a_closed_window_fences_off_late_work_but_keeps_a_rate_limit() {
        let image = || Prepared { mime: "image/png", bytes: vec![1], width: 1, height: 1, thumb: String::new() };
        let before = lock().epoch;
        lock().blocked_until = Instant::now().checked_add(Duration::from_secs(60));
        reset();
        {
            let session = lock();
            assert_eq!(session.epoch, before.wrapping_add(1), "a reset starts a new epoch");
            assert!(session.blocked_until.is_some(), "the server's limit outlives the window");
        }
        store_image(before, image());
        assert!(lock().image.is_none(), "an image decoded for the closed window is dropped");
        store_image(before.wrapping_add(1), image());
        assert!(lock().image.is_some(), "one for the open window is kept");
        reset();
        lock().blocked_until = None;
    }

    #[test]
    fn a_success_without_a_number_is_treated_as_retryable() {
        let f = frozen("نجاح بلا رقم", None);
        let (url, _) = server("201 Created", "", r#"{}"#, true);
        assert_eq!(send(&url, &f), SendOutcome::Failed { reason: "server" });
    }

    #[test]
    fn rejections_carry_the_reason_and_are_final() {
        for (status, body, code, error, field) in [
            ("400 Bad Request", r#"{"error":"invalid_field","field":"description"}"#, 400, Some("invalid_field"), Some("description")),
            ("400 Bad Request", r#"{"error":"unknown_product"}"#, 400, Some("unknown_product"), None),
            ("413 Payload Too Large", r#"{"error":"too_large"}"#, 413, Some("too_large"), None),
            ("415 Unsupported Media Type", r#"{"error":"unsupported_media_type"}"#, 415, Some("unsupported_media_type"), None),
        ] {
            let f = frozen("مرفوض", None);
            let (url, _) = server(status, "", body, true);
            assert_eq!(
                send(&url, &f),
                SendOutcome::Rejected { code, error: error.map(Into::into), field: field.map(Into::into) },
                "{status}"
            );
        }
    }

    #[test]
    fn a_rate_limit_reports_when_to_try_again() {
        let f = frozen("كثير", None);
        let (url, _) = server("429 Too Many Requests", "Retry-After: 120\r\n", r#"{"error":"rate_limited"}"#, true);
        assert_eq!(send(&url, &f), SendOutcome::RateLimited { retry_after_s: 120 });
        let (url, _) = server("429 Too Many Requests", "", r#"{"error":"rate_limited"}"#, true);
        assert_eq!(send(&url, &f), SendOutcome::RateLimited { retry_after_s: DEFAULT_RETRY_AFTER_S });
    }

    #[test]
    fn server_errors_timeouts_and_closed_ports_are_retryable() {
        let f = frozen("عطل", None);
        for status in ["500 Internal Server Error", "502 Bad Gateway"] {
            let (url, _) = server(status, "", "", true);
            assert_eq!(send(&url, &f), SendOutcome::Failed { reason: "server" }, "{status}");
        }
        let (url, _) = server("201 Created", "", "", false);
        assert_eq!(send(&url, &f), SendOutcome::Failed { reason: "timeout" });
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/v1/reports", l.local_addr().unwrap())
        };
        assert_eq!(send(&closed, &f), SendOutcome::Failed { reason: "network" });
    }

    #[test]
    fn a_retry_reuses_the_key_and_a_new_payload_gets_a_new_one() {
        let f = frozen("نفس البلاغ", None);
        let (url1, seen1) = server("502 Bad Gateway", "", "", true);
        let _ = send(&url1, &f);
        let (url2, seen2) = server("201 Created", "", r#"{"id":3}"#, true);
        assert_eq!(send(&url2, &f), SendOutcome::Sent { id: 3 });
        let key = |s: Seen| s.head.lines().find(|l| l.to_ascii_lowercase().starts_with("idempotency-key")).unwrap().to_string();
        assert_eq!(key(seen1.recv().unwrap()), key(seen2.recv().unwrap()));
        let g = frozen("بلاغ مختلف", None);
        assert_ne!(f.key, g.key);
        assert!(uuid::Uuid::parse_str(&g.key).is_ok_and(|u| u.get_version_num() == 4));
    }

    #[test]
    fn the_body_follows_the_contract_and_nothing_more() {
        let f = frozen("وصف", None);
        let v: serde_json::Value = serde_json::from_str(&f.body).unwrap();
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        let mut expected = vec![
            "app_version", "arch", "category", "description", "diagnostics", "kind", "locale", "os", "os_version", "product",
        ];
        if cfg!(debug_assertions) {
            expected.push("test");
        }
        expected.sort();
        assert_eq!(keys, expected);
        assert_eq!(v["product"], "raff");
        assert_eq!(v["os"], "macos");
        assert_eq!(v["locale"], "ar");
        assert_eq!(v.get("test").is_some(), cfg!(debug_assertions), "test: true in debug builds only");
    }

    #[test]
    fn the_window_limits_are_enforced_before_freezing() {
        let d = || diag();
        let ok = |k: &str, c: Option<&str>, t: &str| freeze(k, c, t, d(), None, "5.1.0".into(), "15.4".into(), ENDPOINT).is_ok();
        assert!(!ok("bug", None, "   "), "an empty description");
        assert!(!ok("bug", None, &"ب".repeat(MAX_DESCRIPTION_CHARS + 1)), "over 1000 characters");
        assert!(ok("bug", None, &"ب".repeat(MAX_DESCRIPTION_CHARS)));
        assert!(!ok("feature", None, "وصف"), "an unknown kind");
        assert!(!ok("bug", Some("clipboard-content"), "وصف"), "an unknown category");
        assert!(ok("suggestion", None, "وصف"));
    }

    #[test]
    fn copying_replaces_image_data_with_its_type_and_size() {
        let img = report_image::prepare(
            &{
                let mut out = Vec::new();
                image::DynamicImage::new_rgba8(4, 4)
                    .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                    .unwrap();
                out
            },
            false,
        )
        .unwrap();
        let f = frozen("مع صورة", Some(&img));
        assert!(f.body.contains("\"data\":\""), "the body carries the image");
        let copied = copy_text(&f.body);
        let v: serde_json::Value = serde_json::from_str(&copied).unwrap();
        assert_eq!(v["attachments"][0], serde_json::json!({ "type": "image/png", "bytes": img.bytes.len() }));
        assert!(!copied.contains("\"data\""));
        assert!(copied.contains('\n'), "pretty-printed");
    }

    #[test]
    fn the_endpoint_is_fixed_unless_a_debug_build_overrides_it() {
        assert_eq!(host_of(ENDPOINT), "app-reports.isultantf.workers.dev");
        if !cfg!(debug_assertions) {
            assert_eq!(endpoint(), ENDPOINT);
        }
    }
}
