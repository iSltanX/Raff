// First-run permission screen: opens the Accessibility pane, then watches for
// the permission and closes itself once granted.

import { api } from './store.js';
import { SHIELD, createIcon } from './icons.js';

// The native WKWebView menu is English ("Reload") — never shown in Raff.
window.addEventListener('contextmenu', (e) => e.preventDefault());

document.getElementById('shield').replaceChildren(createIcon(SHIELD));

const openSettingsBtn = document.getElementById('open-settings');
const laterBtn = document.getElementById('later');
const permissionStatus = document.getElementById('permission-status');
const permissionStatusText = document.getElementById('permission-status-text');
const permissionRetry = document.getElementById('permission-retry');
const captureConsent = document.getElementById('capture-consent');
const captureAccept = document.getElementById('capture-accept');
const captureDecline = document.getElementById('capture-decline');
const completion = document.getElementById('completion');
const openRaffBtn = document.getElementById('open-raff');

const POLL_DELAY_MS = 1500;
const MAX_CONSECUTIVE_FAILURES = 3;

let watcher = null;
let checking = false;
let consecutiveFailures = 0;
let completionTimer = null;

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

async function finishFirstRun() {
  laterBtn.disabled = true;
  try {
    await api.firstrunDone();
  } catch (err) {
    console.error('raff: finishing first run failed', err);
    showPermissionStatus('تعذّر إكمال الإعداد. حاول الضغط على «لاحقًا» مرة أخرى.', {
      error: true,
    });
    laterBtn.disabled = false;
  }
}

async function checkGranted({ manual = false } = {}) {
  if (checking) return false;
  checking = true;
  permissionRetry.disabled = true;
  if (manual) showPermissionStatus('جارٍ إعادة التحقق…');

  try {
    const granted = await api.axStatus();
    consecutiveFailures = 0;

    if (granted) {
      stopWatcher();
      openSettingsBtn.disabled = true;
      laterBtn.disabled = true;
      showPermissionStatus('✓ تم منح الإذن — رفّ جاهز');
      if (completionTimer !== null) window.clearTimeout(completionTimer);
      completionTimer = window.setTimeout(() => {
        completionTimer = null;
        void finishFirstRun();
      }, 1200);
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
      showPermissionStatus('تعذّر التحقق من إذن تسهيل الوصول.', {
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

/**
 * Answers the capture question, then teaches the way back in.
 *
 * `enabled` is the default, so agreeing writes nothing: an unnecessary save
 * could only fail, and a failed save on the welcome screen is a worse first
 * minute than no save at all.
 */
async function answerCaptureConsent(enabled) {
  captureAccept.disabled = true;
  captureDecline.disabled = true;
  if (!enabled) {
    try {
      const { settings } = await api.getSettings();
      await api.updateSettings({ ...settings, captureEnabled: false });
    } catch (err) {
      console.error('raff: could not stop capture', err);
      showPermissionStatus('تعذّر إيقاف الالتقاط. يمكنك إيقافه من الإعدادات.', {
        error: true,
      });
    }
  }
  captureConsent.hidden = true;
  completion.hidden = false;
}

captureAccept.addEventListener('click', () => void answerCaptureConsent(true));
captureDecline.addEventListener('click', () => void answerCaptureConsent(false));

openRaffBtn.addEventListener('click', async () => {
  await api.showPanel().catch(() => {});
  void finishFirstRun();
});

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
    openSettingsBtn.disabled = false;
  }
});

laterBtn.addEventListener('click', () => {
  void finishFirstRun();
});

permissionRetry.addEventListener('click', () => {
  consecutiveFailures = 0;
  void checkGranted({ manual: true });
});

// Watch from the start: the user may grant the permission directly in System
// Settings without ever pressing the button. Self-scheduling after each
// settled request prevents overlapping IPC calls.
scheduleCheck(0);
