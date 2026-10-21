//! Paste flow: hide the panel, restore the previously-frontmost app, write the
//! item to the pasteboard, then synthesize ⌘V (Accessibility permitting).
//! Without the permission the item still lands on the clipboard.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::ManagerExt;

use crate::storage::{ItemKind, Usage};
use crate::{macos, panel, AppState};

/// How long we give macOS to move focus back before synthesizing ⌘V.
const ACTIVATE_DELAY_MS: u64 = 150;
/// How long a paste may take to start before it is called off.
const PASTE_PATIENCE: Duration = Duration::from_secs(2);
/// How long a paste that started may take to finish — hide, activate, wait
/// `ACTIVATE_DELAY_MS`, press — before the panel stops waiting for it.
const PASTE_FINISH: Duration = Duration::from_secs(3);

/// Writes an item to the pasteboard. `plain` drops rich representations
/// ("لصق كنص عادي"). Returns false when the id is unknown.
///
/// Blocking: it reads the image file and may wait for a poll to finish its
/// read (`OwnWrites`), so it is only called from commands off the main thread.
pub fn write_item_to_clipboard(app: &AppHandle, id: &str, plain: bool) -> bool {
    let state = app.state::<AppState>();
    let (kind, text, html, rtf, image) = {
        let store = crate::lock_store(&state.store);
        let Some(item) = store.find(id) else {
            return false;
        };
        let image = item
            .image_file
            .as_ref()
            .and_then(|f| crate::storage::image_path(&store.images_dir(), f));
        if plain {
            (item.kind, item.text.clone(), None, None, image)
        } else {
            let rtf = item
                .rtf
                .as_ref()
                .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
            (item.kind, item.text.clone(), item.html.clone(), rtf, image)
        }
    };
    // Read with the store lock released: a large picture is tens of
    // milliseconds every capture and panel refresh would otherwise wait out.
    let png = image.and_then(|path| std::fs::read(path).ok());

    // Never turn a missing image file into a successful copy of its Arabic
    // metadata label. The user asked to copy the image itself.
    if kind == ItemKind::Image && png.is_none() {
        return false;
    }

    let is_image = png.is_some();
    state
        .own_writes
        .write(|| {
            macos::write_clip(
                if is_image { None } else { Some(&text) },
                html.as_deref(),
                rtf.as_deref(),
                png.as_deref(),
            )
        })
        .is_some()
}

/// Full paste: clipboard write + focus restore + ⌘V + silent learning signals.
/// The boolean distinguishes a real synthesized paste from clipboard-only
/// fallback, using a fresh Accessibility check instead of stale panel state.
pub async fn paste_item(app: &AppHandle, id: &str, plain: bool) -> Result<bool, String> {
    crate::startup_trace::mark("PASTE row_click_invoke");
    // Before anything moves: no hide, no other app brought forward (ت٤٨).
    if macos::clipboard_inert() {
        return Err(crate::commands::err::CLIPBOARD_OFF.into());
    }
    if !write_item_to_clipboard(app, id, plain) {
        crate::startup_trace::mark("PASTE write_item_to_clipboard FAILED (unknown id)");
        return Err(crate::commands::err::NOT_FOUND.into());
    }
    crate::startup_trace::mark("PASTE NSPasteboard write completed");

    let trusted = macos::ax_trusted();
    crate::startup_trace::mark(&format!("PASTE ax_trusted={trusted}"));
    if !trusted {
        crate::startup_trace::mark("PASTE STOPPED HERE: no Accessibility trust — panel stays visible, no hide, no activate, no paste");
        bump_paste_signals(app, id);
        return Ok(false);
    }

    let state = app.state::<AppState>();
    let own = std::process::id() as i32;
    let previous_pid = match take_target(&state.previous_app, own) {
        Target::App(pid) => pid,
        Target::Raff => {
            crate::startup_trace::mark(
                "PASTE STOPPED HERE: the panel was opened over Raff itself — copied only",
            );
            bump_paste_signals(app, id);
            return Ok(false);
        }
    };
    crate::startup_trace::mark_with(|| {
        format!("PASTE previous app remembered={}", previous_pid.is_some())
    });

    let handle = app.clone();
    let item = id.to_string();
    let attempt = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let ticket = Arc::new(PasteTicket::new());
        let ours = Arc::clone(&ticket);
        let presser = Arc::clone(&ticket);
        // Not `run_on_main_thread`: tao drains that queue only while it is
        // processing events, the queue that once held a panel show for 2.5s
        // (`macos::dispatch_to_main`).
        macos::dispatch_to_main(move || {
            if_claimed(&ours, move || {
                crate::startup_trace::mark("PASTE panel_hide requested");
                panel::hide(&handle);
                crate::startup_trace::mark(&format!(
                    "PASTE panel_hide done; panel.is_visible()={:?}",
                    handle
                        .get_webview_panel(panel::PANEL_LABEL)
                        .map(|p| p.is_visible())
                ));
                if let Some(previous) = previous_pid {
                    crate::startup_trace::mark("PASTE activate_app requested");
                    macos::activate_app(previous);
                    crate::startup_trace::mark("PASTE activate_app call returned");
                } else {
                    crate::startup_trace::mark(
                        "PASTE no previous app to activate — never remembered or already consumed",
                    );
                }
                crate::startup_trace::mark_with(|| {
                    format!(
                        "PASTE front is the previous app immediately after activate: {}",
                        previous_pid == Some(macos::frontmost_app().pid)
                    )
                });
                let handle2 = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ACTIVATE_DELAY_MS));
                    let front_before_paste = macos::frontmost_app();
                    crate::startup_trace::mark_with(|| {
                        format!(
                            "PASTE front is the previous app after {ACTIVATE_DELAY_MS}ms wait: {}",
                            previous_pid == Some(front_before_paste.pid)
                        )
                    });
                    // The point of no return: past it the wait sees this
                    // through; short of it, the wait has already told the
                    // user, and nothing may be pressed now.
                    if !presser.press() {
                        crate::startup_trace::mark(
                            "PASTE abandoned before the keystroke — nothing pressed",
                        );
                        return;
                    }
                    let still_trusted = macos::ax_trusted();
                    let sent = if may_press_paste(still_trusted, front_before_paste.pid, own) {
                        macos::send_cmd_v()
                    } else {
                        false
                    };
                    crate::startup_trace::mark(&format!(
                        "PASTE CGEvent cmd-v: still_trusted={still_trusted} sent={sent}"
                    ));
                    let pasted =
                        paste_confirmed(still_trusted, sent, previous_pid, front_before_paste.pid);
                    crate::startup_trace::mark(&format!("PASTE COMPLETE pasted={pasted}"));
                    // Answered first: the counter waits for the store lock,
                    // and the panel's answer must not wait with it.
                    let _ = tx.send(pasted);
                    bump_paste_signals(&handle2, &item);
                });
            })
        });
        await_paste(&rx, &ticket, PASTE_PATIENCE, PASTE_FINISH)
    })
    .await
    .map_err(paste_failed)
    .and_then(|result| result.map_err(paste_failed));

    let pasted = match attempt {
        Ok(pasted) => pasted,
        Err(err) => {
            crate::startup_trace::mark(&format!("PASTE ERROR {err} — reshowing panel"));
            // The item was written before any of this, as the message says:
            // counted as used, like every other paste that ends as a copy.
            bump_paste_signals(app, id);
            panel::show(app);
            return Err(err);
        }
    };

    if !pasted {
        crate::startup_trace::mark("PASTE not pasted — reshowing panel");
        panel::show(app);
    }
    Ok(pasted)
}

/// One paste's claims on the panel and on the keystroke (015). The work and
/// the wait for it race for each, and one side wins each race:
///
/// - **Start** — taken by the main-thread work before it hides the panel, or
///   by the wait once `PASTE_PATIENCE` runs out. Called off here, the paste
///   never moves anything: no hide, no activation, no ⌘V.
/// - **Press** — taken by the work immediately before ⌘V, or by the wait once
///   `PASTE_FINISH` runs out too. Abandoned here, the panel was hidden and the
///   old app brought forward, but nothing is pressed, then or later.
///
/// The press claim is the point of no return. Once the work holds it, the
/// keystroke is out or going out, and the wait waits for the answer that
/// follows it rather than report a failure that already pasted. So the user is
/// never told a paste failed before a ⌘V that then lands.
struct PasteTicket(AtomicU8);

const WAITING: u8 = 0;
const STARTED: u8 = 1;
const CALLED_OFF: u8 = 2;
const PRESSING: u8 = 3;
const ABANDONED: u8 = 4;

impl PasteTicket {
    fn new() -> Self {
        Self(AtomicU8::new(WAITING))
    }

    /// The work's side, before anything moves: false once the paste was
    /// called off.
    fn start(&self) -> bool {
        self.claim(WAITING, STARTED)
    }

    /// The wait's side, once its patience runs out: true when the work had
    /// not started, and now never will.
    fn call_off(&self) -> bool {
        self.claim(WAITING, CALLED_OFF)
    }

    /// The work's side, immediately before the keystroke: false once the
    /// wait gave up on it.
    fn press(&self) -> bool {
        self.claim(STARTED, PRESSING)
    }

    /// The wait's side, once the started work has also outlasted
    /// `PASTE_FINISH`: true when the keystroke had not been claimed, and now
    /// never will be.
    fn abandon(&self) -> bool {
        self.claim(STARTED, ABANDONED)
    }

    fn claim(&self, from: u8, to: u8) -> bool {
        self.0
            .compare_exchange(from, to, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

/// Runs the paste's main-thread work only when it wins the claim.
fn if_claimed(ticket: &PasteTicket, work: impl FnOnce()) {
    if ticket.start() {
        work();
    } else {
        crate::startup_trace::mark(
            "PASTE called off before it started — nothing hidden, nothing pressed",
        );
    }
}

/// Waits for the paste's answer. A paste that has not started within
/// `patience` is called off; one that started but has not claimed its
/// keystroke within `finish` more is abandoned. Either is reported as failed —
/// the item is on the clipboard already, which is what the failure message
/// says — and neither presses anything afterwards. One whose keystroke is out
/// is waited for once more, for the answer that comes right after it. Past
/// that third wait the failure is reported even so; the keystroke, claimed
/// and beyond recall, takes milliseconds, so that wait is never near spent.
fn await_paste(
    rx: &Receiver<bool>,
    ticket: &PasteTicket,
    patience: Duration,
    finish: Duration,
) -> Result<bool, String> {
    match rx.recv_timeout(patience) {
        Ok(pasted) => Ok(pasted),
        Err(err) if ticket.call_off() => Err(err.to_string()),
        Err(_) => match rx.recv_timeout(finish) {
            Ok(pasted) => Ok(pasted),
            Err(err) if ticket.abandon() => Err(err.to_string()),
            Err(_) => rx.recv_timeout(finish).map_err(|err| err.to_string()),
        },
    }
}

/// Where a paste goes: back to the app the panel was opened over, or nowhere
/// because that was رفّ.
#[derive(Debug, PartialEq)]
enum Target {
    Raff,
    App(Option<i32>),
}

/// Takes the remembered app for this paste. A panel opened over رفّ keeps
/// that answer for its next click as well: the panel stays open after a copy,
/// and a second click finding nothing remembered would hide it, press nothing
/// and show it again.
fn take_target(previous_app: &std::sync::Mutex<Option<i32>>, own: i32) -> Target {
    let mut previous = crate::lock_previous_app(previous_app);
    if opened_over_raff(*previous, own) {
        return Target::Raff;
    }
    Target::App(previous.take())
}

/// Whether the panel was opened over one of رفّ's own windows — Settings in
/// front, say (009). There is no other app to paste into then, and ⌘V would
/// land in رفّ itself, so the item is only copied, exactly as without the
/// Accessibility permission.
fn opened_over_raff(previous_pid: Option<i32>, own: i32) -> bool {
    previous_pid == Some(own)
}

/// ⌘V is never synthesized into رفّ itself, whatever put it in front by the
/// time the keystroke would go out.
fn may_press_paste(still_trusted: bool, front_pid: i32, own: i32) -> bool {
    still_trusted && front_pid != own
}

/// Whether a paste may be reported as done.
///
/// `sent` only means a CGEvent was posted: nothing in that says it was
/// delivered, or to whom. The one thing that can be checked is where it was
/// aimed — if the app that held the front before the panel opened is not the
/// app in front when the keystroke goes out, then activation did not take and
/// the keystroke went somewhere else entirely. Calling that a successful paste
/// is a claim رفّ cannot make, and the fallback it triggers instead is true in
/// every case: the content is on the clipboard.
///
/// A missing `previous_pid` means nothing was ever claimed about the target,
/// so there is nothing to contradict.
fn paste_confirmed(
    still_trusted: bool,
    sent: bool,
    previous_pid: Option<i32>,
    front_pid: i32,
) -> bool {
    still_trusted && sent && previous_pid.is_none_or(|pid| pid == front_pid)
}

fn bump_paste_signals(app: &AppHandle, id: &str) {
    bump_signals(app, id, Usage::Paste);
}

/// Copying through رفّ (panel ⌘C, tray item click) is a usage signal exactly
/// like pasting — recorded explicitly instead of re-capturing our own write.
/// A paste that could not be carried out. The cause is logged, not shown: it
/// is an OS-level string the user cannot act on, in a language رفّ does not
/// speak to them in.
fn paste_failed(detail: impl std::fmt::Display) -> String {
    eprintln!("raff: paste failed: {detail}");
    crate::commands::err::PASTE_FAILED.to_string()
}

pub fn bump_copy_signals(app: &AppHandle, id: &str) {
    bump_signals(app, id, Usage::Copy);
}

fn bump_signals(app: &AppHandle, id: &str, usage: Usage) {
    let state = app.state::<AppState>();
    let mut store = crate::lock_store(&state.store);
    if let Err(err) = store.finish_pending_pin() {
        eprintln!("raff: usage signal deferred: {err}");
        return;
    }
    // Not written here: a counter bump is not worth rewriting a layer. The
    // flusher in `monitor` writes it once the user pauses.
    if !store.count_use(id, usage) {
        return;
    }
    drop(store);
    let _ = app.emit("raff://changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: i32 = 4242;

    #[test]
    fn a_keystroke_aimed_at_the_wrong_app_is_not_a_successful_paste() {
        // Everything Raff used to look at says yes: the permission is there
        // and the event was posted. But activation did not take, so ⌘V went to
        // whatever happened to be in front.
        assert!(!paste_confirmed(true, true, Some(TARGET), 99));
    }

    #[test]
    fn the_target_being_in_front_is_what_makes_it_a_paste() {
        assert!(paste_confirmed(true, true, Some(TARGET), TARGET));
    }

    #[test]
    fn nothing_claimed_about_the_target_leaves_nothing_to_contradict() {
        assert!(paste_confirmed(true, true, None, 99));
    }

    const OWN: i32 = 777;
    const PATIENCE: Duration = Duration::from_millis(100);

    /// 015: the main thread got to the paste only after the wait gave up and
    /// the panel was shown again. The work still hid it, brought the old app
    /// forward and pressed ⌘V into whatever was in front by then.
    #[test]
    fn a_paste_called_off_never_starts_late() {
        let (tx, rx) = std::sync::mpsc::channel();
        let ticket = Arc::new(PasteTicket::new());
        let (ours, pressed) = (Arc::clone(&ticket), Arc::new(AtomicU8::new(0)));
        let presses = Arc::clone(&pressed);
        let late = std::thread::spawn(move || {
            std::thread::sleep(PATIENCE * 3);
            if_claimed(&ours, || {
                presses.fetch_add(1, Ordering::SeqCst);
                let _ = tx.send(true);
            });
        });

        assert!(await_paste(&rx, &ticket, PATIENCE, PATIENCE).is_err());
        late.join().unwrap();
        assert_eq!(
            pressed.load(Ordering::SeqCst),
            0,
            "nothing pressed after the wait gave up"
        );
    }

    /// A paste that started just inside the patience is seen through, not
    /// reported as failed while its keystroke is still on the way.
    #[test]
    fn a_paste_that_started_is_waited_out() {
        let (tx, rx) = std::sync::mpsc::channel();
        let ticket = Arc::new(PasteTicket::new());
        let ours = Arc::clone(&ticket);
        let slow = std::thread::spawn(move || {
            assert!(ours.start());
            std::thread::sleep(PATIENCE * 3);
            let _ = tx.send(true);
        });

        assert_eq!(await_paste(&rx, &ticket, PATIENCE, PATIENCE * 10), Ok(true));
        slow.join().unwrap();
    }

    /// Review م١: a paste that started and never answered — its thread stuck
    /// behind a lock — must not leave the panel waiting forever.
    #[test]
    fn a_paste_that_started_and_never_answers_is_not_waited_on_forever() {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let ticket = Arc::new(PasteTicket::new());
        assert!(ticket.start());
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter = Arc::clone(&ticket);
        std::thread::spawn(move || {
            let _ = done_tx.send(await_paste(&rx, &waiter, PATIENCE, PATIENCE));
        });
        let answer = done_rx.recv_timeout(PATIENCE * 10);
        drop(tx);
        assert!(matches!(answer, Ok(Err(_))), "{answer:?}");
    }

    /// Review م٢: the panel stays open after a copy over رفّ, and its next
    /// click must be judged the same way, not as a paste with no target.
    #[test]
    fn a_second_click_over_raff_is_still_only_a_copy() {
        let slot = std::sync::Mutex::new(Some(OWN));
        assert_eq!(take_target(&slot, OWN), Target::Raff);
        assert_eq!(take_target(&slot, OWN), Target::Raff);

        let other = std::sync::Mutex::new(Some(TARGET));
        assert_eq!(take_target(&other, OWN), Target::App(Some(TARGET)));
        assert_eq!(take_target(&other, OWN), Target::App(None), "spent");
    }

    /// A paste run with chosen delays: when the main-thread work starts, how
    /// long from hiding the panel to the keystroke, and from the keystroke to
    /// the answer. Returns what the wait answered, and in order what the work
    /// did and when the user was told.
    fn run_paste(
        patience: Duration,
        start_after: Duration,
        press_after: Duration,
        answer_after: Duration,
    ) -> (Result<bool, String>, Vec<&'static str>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let ticket = Arc::new(PasteTicket::new());
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (ours, log) = (Arc::clone(&ticket), Arc::clone(&events));
        let work = std::thread::spawn(move || {
            std::thread::sleep(start_after);
            let presser = Arc::clone(&ours);
            if_claimed(&ours, move || {
                log.lock().unwrap().push("hidden");
                std::thread::sleep(press_after);
                if presser.press() {
                    log.lock().unwrap().push("pressed");
                    std::thread::sleep(answer_after);
                    let _ = tx.send(true);
                } else {
                    log.lock().unwrap().push("held back");
                }
            });
        });
        let answer = await_paste(&rx, &ticket, patience, patience);
        events.lock().unwrap().push("told");
        work.join().unwrap();
        let events = events.lock().unwrap().clone();
        (answer, events)
    }

    /// Still queued when the patience ran out: called off whole. Nothing is
    /// hidden and nothing pressed, then or later.
    #[test]
    fn a_paste_still_queued_at_the_timeout_never_moves_anything() {
        let (answer, events) = run_paste(PATIENCE, PATIENCE * 3, Duration::ZERO, Duration::ZERO);
        assert!(answer.is_err());
        assert_eq!(events, ["told"]);
    }

    /// Started, then stuck between hiding the panel and the keystroke past
    /// both waits: the user is told the paste failed, so the keystroke must
    /// not go out after that — into whatever is in front by then.
    #[test]
    fn a_paste_that_started_and_stalled_presses_nothing_after_the_user_is_told() {
        let (answer, events) = run_paste(PATIENCE, Duration::ZERO, PATIENCE * 4, Duration::ZERO);
        assert!(answer.is_err());
        assert_eq!(events, ["hidden", "told", "held back"]);
    }

    /// Past the point of no return — the keystroke claimed — the wait does
    /// not report a failure that already went out as a paste: it waits for
    /// the answer that follows the keystroke.
    #[test]
    fn a_keystroke_that_went_out_is_waited_for_not_reported_failed() {
        let (answer, events) = run_paste(
            // Wider here: the answer must land between the second wait's end
            // (2×) and the third's (3×), with room either side under load.
            PATIENCE * 4,
            Duration::ZERO,
            Duration::ZERO,
            PATIENCE * 10,
        );
        assert_eq!(answer, Ok(true));
        assert_eq!(events, ["hidden", "pressed", "told"]);
    }

    #[test]
    fn the_claim_is_won_once() {
        let started = PasteTicket::new();
        assert!(started.start());
        assert!(!started.call_off());
        assert!(!started.start(), "and started once");
        assert!(started.press());
        assert!(!started.abandon(), "a keystroke claimed is not abandoned");

        let abandoned = PasteTicket::new();
        assert!(abandoned.start());
        assert!(abandoned.abandon());
        assert!(!abandoned.press(), "nor pressed once abandoned");

        let never_started = PasteTicket::new();
        assert!(!never_started.press(), "no keystroke without a start");

        let called_off = PasteTicket::new();
        assert!(called_off.call_off());
        assert!(!called_off.start());
    }

    /// The main-thread work asks for the claim before it hides the panel.
    #[test]
    fn the_work_claims_the_paste_before_anything_moves() {
        let src = include_str!("paste.rs");
        let flow = &src
            [src.find("pub async fn paste_item").unwrap()..src.find("struct PasteTicket").unwrap()];
        let claims = flow.find("if_claimed(&ours, move ||").expect("claimed");
        assert!(claims < flow.find("panel::hide").unwrap());
        assert!(flow.contains("await_paste(&rx, &ticket, PASTE_PATIENCE, PASTE_FINISH)"));
        assert!(!flow.contains(".run_on_main_thread("));
        let claimed = flow
            .find("if !presser.press()")
            .expect("the keystroke is claimed");
        assert!(claimed < flow.find("macos::send_cmd_v()").unwrap());
        // A paste that ends in the failure message is still a copy (م٣).
        let failed = &flow[flow.find("PASTE ERROR").unwrap()..];
        let counted = failed.find("bump_paste_signals(app, id)").expect("counted");
        assert!(counted < failed.find("panel::show(app)").unwrap());
    }

    /// 009: Settings was in front when the panel opened, so the app to go
    /// back to is رفّ. It used to activate itself, find itself in front as
    /// expected, press ⌘V into its own window and call that a paste.
    #[test]
    fn a_panel_opened_over_raff_only_copies() {
        assert!(opened_over_raff(Some(OWN), OWN));
        assert!(!opened_over_raff(Some(TARGET), OWN));
        assert!(!opened_over_raff(None, OWN));
    }

    #[test]
    fn no_keystroke_is_pressed_into_raff_itself() {
        assert!(!may_press_paste(true, OWN, OWN));
        assert!(may_press_paste(true, TARGET, OWN));
        assert!(!may_press_paste(false, TARGET, OWN));
    }

    /// And the paste flow asks both before anything moves or is pressed.
    #[test]
    fn the_paste_flow_asks_both() {
        let src = include_str!("paste.rs");
        let flow = &src[src.find("pub async fn paste_item").unwrap()
            ..src.find("fn opened_over_raff").unwrap()];
        let asks = flow
            .find("take_target(&state.previous_app, own)")
            .expect("asked");
        assert!(
            asks < flow.find("panel::hide").unwrap(),
            "before the panel hides"
        );
        assert!(flow.contains("may_press_paste(still_trusted, front_before_paste.pid, own)"));
    }

    #[test]
    fn the_old_conditions_still_have_to_hold() {
        assert!(!paste_confirmed(false, true, Some(TARGET), TARGET));
        assert!(!paste_confirmed(true, false, Some(TARGET), TARGET));
    }
}
