// The welcome (Figma «09 — Onboarding» 273:8): five steps — the idea, the way
// in, the capture decision, the optional paste permission, and first use.
//
// Two answers, never confused: whether رفّ may capture, and whether it may
// paste for you. A granted permission is not a capture decision, a failed
// decision is not a finished setup, and nothing here closes on a timer.

import { api } from './store.js';
import { ACCESSIBILITY, ALERT, CHECK, CLEAR, createIcon } from './icons.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

const el = (id) => document.getElementById(id);

el('capture-error-icon').replaceChildren(createIcon(ALERT));
el('permission-glyph').replaceChildren(createIcon(ACCESSIBILITY));
el('permission-granted-icon').replaceChildren(createIcon(CHECK));

const steps = [...document.querySelectorAll('.step')];
const progressDots = [...el('progress').children];
const backBtn = el('back');
const nextBtn = el('next');
const laterBtn = el('later');
const openSettingsBtn = el('open-settings');
const finishBtn = el('finish');
const openRaffBtn = el('open-raff');
const captureAccept = el('capture-accept');
const captureDecline = el('capture-decline');
const captureError = el('capture-error');
const permissionStatus = el('permission-status');
const permissionStatusText = el('permission-status-text');
const permissionRetry = el('permission-retry');
const permissionGranted = el('permission-granted');
const permissionGrantedTitle = el('permission-granted-title');
const permissionSteps = el('permission-steps');

const STEP_CAPTURE = 3;
const STEP_PERMISSION = 4;
const STEP_READY = 5;
const POLL_DELAY_MS = 1500;
const MAX_CONSECUTIVE_FAILURES = 3;

let current = 1;
let captureChoice = null; // true = keep capturing, false = stopped
// What the store holds — on by default, read below in case Settings or the
// menu changed it while the welcome was open. Only a change is written,
// including going back after «أوقفه» and choosing «أبقِه يعمل».
let savedCapture = true;
let granted = false;
let grantedBeforeAsking = null; // first answer, to say «ممنوح مسبقًا»
let watcher = null;
let checking = false;
let consecutiveFailures = 0;

// ─── Steps ────────────────────────────────────────────────────────────────

function show(step) {
  current = step;
  for (const section of steps) section.hidden = Number(section.dataset.step) !== step;
  progressDots.forEach((dot, index) => dot.classList.toggle('is-current', index + 1 === step));

  backBtn.hidden = step === 1 || step === STEP_READY;
  // The capture step has no «التالي»: choosing is how it moves on.
  nextBtn.hidden = step === STEP_CAPTURE || step === STEP_READY || (step === STEP_PERMISSION && !granted);
  laterBtn.hidden = step !== STEP_PERMISSION || granted;
  openSettingsBtn.hidden = step !== STEP_PERMISSION || granted;
  finishBtn.hidden = step !== STEP_READY;
  openRaffBtn.hidden = step !== STEP_READY;
  if (step === STEP_READY) renderSummary();

  const heading = steps[step - 1].querySelector('.title');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
}

nextBtn.addEventListener('click', () => show(Math.min(current + 1, STEP_READY)));
backBtn.addEventListener('click', () => show(Math.max(current - 1, 1)));
laterBtn.addEventListener('click', () => show(STEP_READY));

// ─── Capture decision ─────────────────────────────────────────────────────

/**
 * Only a change is written: agreeing to the default needs no save (which
 * could only fail). Declining must be saved — and if the save fails, the
 * question stays answerable and says plainly that capture is still running.
 */
async function answerCaptureConsent(enabled) {
  captureAccept.disabled = true;
  captureDecline.disabled = true;
  captureError.hidden = true;
  try {
    if (enabled !== savedCapture) {
      const { settings } = await api.getSettings();
      await api.updateSettings({ ...settings, captureEnabled: enabled });
      savedCapture = enabled;
    }
    captureChoice = enabled;
    show(STEP_PERMISSION);
  } catch (err) {
    console.error('raff: could not stop capture', err);
    captureError.hidden = false;
    show(STEP_CAPTURE);
  } finally {
    captureAccept.disabled = false;
    captureDecline.disabled = false;
  }
}

captureAccept.addEventListener('click', () => void answerCaptureConsent(true));
captureDecline.addEventListener('click', () => void answerCaptureConsent(false));

// ─── Optional permission ──────────────────────────────────────────────────

function showPermissionStatus(message, { error = false, retry = false } = {}) {
  permissionStatus.hidden = false;
  permissionStatus.classList.toggle('is-error', error);
  permissionStatus.setAttribute('role', error ? 'alert' : 'status');
  permissionStatus.setAttribute('aria-live', error ? 'assertive' : 'polite');
  permissionStatusText.textContent = message;
  permissionRetry.hidden = !retry;
  permissionRetry.disabled = false;
}

function hidePermissionStatus() {
  permissionStatus.hidden = true;
  permissionRetry.hidden = true;
}

function stopWatcher() {
  if (watcher !== null) window.clearTimeout(watcher);
  watcher = null;
}

function scheduleCheck(delay = POLL_DELAY_MS) {
  stopWatcher();
  watcher = window.setTimeout(() => {
    watcher = null;
    void checkGranted();
  }, delay);
}

function markGranted() {
  granted = true;
  stopWatcher();
  openSettingsBtn.disabled = true;
  laterBtn.disabled = true;
  permissionSteps.hidden = true;
  permissionGranted.hidden = false;
  permissionGrantedTitle.textContent = grantedBeforeAsking ? 'الإذن ممنوح مسبقًا' : 'الإذن ممنوح';
  showPermissionStatus('✓ تم منح الإذن');
  // The user moves on when ready — a permission is not an answer to anything
  // else, and the window never closes itself.
  if (current === STEP_PERMISSION) show(STEP_PERMISSION);
  if (current === STEP_READY) renderSummary();
}

async function checkGranted({ manual = false } = {}) {
  if (checking) return false;
  checking = true;
  permissionRetry.disabled = true;
  if (manual) showPermissionStatus('جارٍ إعادة التحقق…');

  try {
    const isGranted = await api.axStatus();
    consecutiveFailures = 0;
    if (grantedBeforeAsking === null) grantedBeforeAsking = isGranted;

    if (isGranted) {
      markGranted();
      return true;
    }

    if (manual) {
      showPermissionStatus('لم يُمنح الإذن بعد. فعّل رفّ في إعدادات النظام ثم أعد التحقق.');
    } else {
      hidePermissionStatus();
    }
    scheduleCheck();
    return false;
  } catch (err) {
    console.error('raff: accessibility status check failed', err);
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stopWatcher();
      // Optional permission: a failed check is information, never a failure
      // of رفّ — saving is unaffected, and the step says so.
      showPermissionStatus('تعذّر التحقق من الإذن. الحفظ يعمل كالمعتاد.', {
        error: true,
        retry: true,
      });
    } else {
      // Back off after transient bridge failures and never overlap requests.
      scheduleCheck(POLL_DELAY_MS * 2 ** (consecutiveFailures - 1));
    }
    return false;
  } finally {
    checking = false;
    if (!permissionRetry.hidden) permissionRetry.disabled = false;
  }
}

openSettingsBtn.addEventListener('click', async () => {
  openSettingsBtn.disabled = true;
  try {
    await api.requestAccessibility(); // registers Raff in the list + system prompt
    await api.openAccessibilitySettings();
    consecutiveFailures = 0;
    hidePermissionStatus();
    scheduleCheck();
  } catch (err) {
    console.error('raff: opening Accessibility settings failed', err);
    showPermissionStatus('تعذّر فتح إعدادات تسهيل الوصول. حاول مرة أخرى.', { error: true });
  } finally {
    if (!granted) openSettingsBtn.disabled = false;
  }
});

permissionRetry.addEventListener('click', () => {
  consecutiveFailures = 0;
  void checkGranted({ manual: true });
});

// ─── Ready ────────────────────────────────────────────────────────────────

function renderSummary() {
  const lines = [
    [captureChoice !== false, captureChoice === false ? 'الالتقاط: متوقف — شغّله من الإعدادات متى شئت' : 'الالتقاط: يعمل'],
    [granted, granted ? 'اللصق التلقائي: مفعّل' : 'اللصق التلقائي: غير مفعّل — تلصق أنت بـ ⁦⌘V⁩'],
  ];
  el('completion-summary').replaceChildren(
    ...lines.map(([on, text]) => {
      const li = document.createElement('li');
      li.classList.toggle('is-on', on);
      li.append(createIcon(on ? CHECK : CLEAR), document.createTextNode(text));
      return li;
    })
  );
}

async function finishFirstRun() {
  finishBtn.disabled = true;
  openRaffBtn.disabled = true;
  el('finish-error').hidden = true;
  try {
    await api.firstrunDone();
  } catch (err) {
    console.error('raff: finishing first run failed', err);
    el('finish-error').hidden = false;
    finishBtn.disabled = false;
    openRaffBtn.disabled = false;
  }
}

finishBtn.addEventListener('click', () => void finishFirstRun());
openRaffBtn.addEventListener('click', async () => {
  await api.showPanel().catch(() => {});
  void finishFirstRun();
});

// Watch from the start: the user may grant the permission directly in System
// Settings without ever pressing the button. Self-scheduling after each
// settled request prevents overlapping IPC calls.
show(1);
scheduleCheck(0);
api
  .getSettings()
  .then(({ settings }) => {
    if (typeof settings?.captureEnabled === 'boolean') savedCapture = settings.captureEnabled;
  })
  .catch(() => {}); // unreadable: keep the default, and a decline still saves
