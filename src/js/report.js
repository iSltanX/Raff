// The problem-report window (Figma «10» 276:8 · 277:146 · 278:243).
//
// The webview never talks to the network and never holds the image: Rust
// builds and freezes the payload at «التالي: المعاينة», sends exactly those
// bytes (retries reuse its key), and writes every copy to the clipboard
// itself so رفّ does not capture its own write. This file only shows what
// Rust hands back.

import { api } from './store.js';
import { arabicDigits } from './logic.js';
import { ABOUT, ALERT, ATTACH_IMAGE, CHECK, CLOCK, createIcon } from './icons.js';

window.addEventListener('contextmenu', (e) => {
  const target = e.target;
  if (target?.closest?.('textarea, .json, .report-number-value')) return;
  e.preventDefault();
});

const el = (id) => document.getElementById(id);
const MAX_CHARS = 1000;

const views = { compose: el('view-compose'), preview: el('view-preview'), result: el('view-result') };
const buttons = {
  cancel: el('cancel'),
  back: el('back'),
  copy: el('copy-report'),
  retry: el('retry'),
  next: el('next'),
  send: el('send'),
  done: el('done'),
};
const description = el('description');
const counter = el('description-count');
const descriptionError = el('description-error');
const category = el('category');
const statusLine = el('status-line');
const kinds = [...document.querySelectorAll('.kind')];

const footer = el('footer');
const counterHint = Object.assign(document.createElement('span'), { className: 'sr-only', textContent: ' حرف' });

let kind = null;
let busy = false;
let attaching = false;
let hasImage = false;
let lastMeta = null; // what is attached, to show again when a pick is cancelled
let retryTimer = null;
let copiedTimer = null;

el('preview-info-icon').replaceChildren(createIcon(ABOUT));
el('success-icon').replaceChildren(createIcon(CHECK));

const CATEGORY_LABELS = Object.fromEntries([...category.options].map((o) => [o.value, o.textContent]));
const KIND_LABELS = { bug: 'خلل', crash: 'تعطّل', suggestion: 'اقتراح', other: 'أخرى' };

// What the backend can say, and what رفّ says about it.
const ERRORS = {
  'raff/report-invalid': 'تحقّق من النوع والوصف ثم حاول مرة أخرى.',
  'raff/report-not-prepared': 'انتهت جلسة المعاينة. ارجع وأعد المعاينة.',
  'raff/copy-failed': 'تعذّر النسخ إلى الحافظة.',
  'raff/image-unsupported': 'ليست صورة PNG أو JPEG.',
  'raff/image-too-large': 'الصورة أكبر من ٣ م.ب حتى بعد التصغير.',
  'raff/image-unreadable': 'تعذّرت قراءة الصورة.',
  'raff/image-pasted-file': 'لصقتَ ملفًّا لا صورة. اختره بـ «اختر صورة…».',
};
const message = (err) => ERRORS[String(err)] ?? 'تعذّر إتمام العملية. حاول مرة أخرى.';

const REJECTIONS = {
  too_large: 'البلاغ أكبر مما يقبله الخادم.',
  unsupported_media_type: 'نوع الصورة لا يقبله الخادم.',
  invalid_json: 'تعذّر على الخادم قراءة البلاغ.',
  unknown_product: 'صندوق البلاغات لا يستقبل بلاغات رفّ بعد.',
  invalid_field: 'في البلاغ حقل لم يقبله الخادم',
};

const bytesLabel = (n) =>
  n >= 1024 * 1024
    ? `${arabicDigits((n / (1024 * 1024)).toFixed(1)).replace('.', '٫')} م.ب`
    : `${arabicDigits(Math.max(1, Math.round(n / 1024)))} ك.ب`;
const typeLabel = (mime) => (mime === 'image/jpeg' ? 'JPEG' : 'PNG');

/** «بعد …» with the count agreeing: دقيقة واحدة، دقيقتين، ٣ دقائق، ١١ دقيقة. */
function minutesPhrase(n) {
  if (n <= 1) return 'دقيقة واحدة';
  if (n === 2) return 'دقيقتين';
  if (n <= 10) return `${arabicDigits(n)} دقائق`;
  return `${arabicDigits(n)} دقيقة`;
}

/** A sentence with one Latin fragment kept in its own direction. */
function withLatin(before, latin, after) {
  return [before, Object.assign(document.createElement('bdi'), { textContent: latin }), after];
}

// ─── Views and actions ────────────────────────────────────────────────────

function showView(name) {
  for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
  setStatus('');
}

for (const button of Object.values(buttons)) button.dataset.baseClass = button.className;

/**
 * Shows these actions; one of them leads. The visible buttons are re-appended
 * in reading order with the primary last, so it ends the row (the left edge
 * in RTL) and Tab meets the buttons in the order the eye does.
 */
function showButtons(visible, { primary = null } = {}) {
  const lead = primary ?? visible.find((name) => buttons[name].dataset.baseClass.includes('btn-primary'));
  for (const [name, button] of Object.entries(buttons)) {
    button.hidden = !visible.includes(name);
    if (primary === null) button.className = button.dataset.baseClass;
    else button.className = name === primary ? 'btn btn-primary' : button.dataset.baseClass.replace('btn-primary', '').trim();
  }
  for (const name of [...visible.filter((n) => n !== lead), lead]) footer.append(buttons[name]);
}

// The line stays rendered: a live region unhidden and filled in the same
// tick is often missed by VoiceOver.
function setStatus(text, { error = false } = {}) {
  statusLine.textContent = text;
  statusLine.classList.toggle('is-error', error);
}

function closeWindow() {
  window.__TAURI__?.window.getCurrentWindow().close();
}

/** Escape closes only when nothing the user wrote or chose would be lost. */
function nothingToLose() {
  if (!views.result.hidden) return !el('result-success').hidden;
  return views.compose.hidden === false && description.value.trim() === '' && !hasImage;
}

// ─── Compose ──────────────────────────────────────────────────────────────

function selectKind(button, { focus = false } = {}) {
  kind = button.dataset.kind;
  for (const k of kinds) {
    const on = k === button;
    k.setAttribute('aria-checked', String(on));
    k.tabIndex = on ? 0 : -1;
  }
  if (focus) button.focus();
  syncCompose();
}

const checkedKind = () => kinds.find((k) => k.getAttribute('aria-checked') === 'true') ?? kinds[0];

el('kinds').addEventListener('click', (e) => {
  const button = e.target.closest('.kind');
  if (button) selectKind(button);
});

el('kinds').addEventListener('keydown', (e) => {
  const index = kinds.indexOf(document.activeElement);
  if (index < 0) return;
  // A 2×2 grid read right to left: ArrowLeft moves forward.
  if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    selectKind(e.key === 'Home' ? kinds[0] : kinds[kinds.length - 1], { focus: true });
    return;
  }
  const step = { ArrowLeft: 1, ArrowDown: 2, ArrowRight: -1, ArrowUp: -2 }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  selectKind(kinds[(index + step + kinds.length) % kinds.length], { focus: true });
});

function syncCompose() {
  const length = [...description.value.trim()].length;
  const over = length > MAX_CHARS;
  counter.replaceChildren(`${arabicDigits(length)} / ${arabicDigits(MAX_CHARS)}`, counterHint);
  counter.classList.toggle('is-over', over);
  descriptionError.hidden = !over;
  description.setAttribute('aria-invalid', String(over));
  // A hidden node named here is still read, so the error joins only when shown.
  description.setAttribute('aria-describedby', over ? 'description-count description-error' : 'description-count');
  buttons.next.disabled = busy || attaching || !kind || length === 0 || over;
}

description.addEventListener('input', syncCompose);

function renderAttachment(state, meta = null, error = null) {
  const box = el('attachment');
  box.dataset.state = state;
  const thumb = el('attachment-thumb');
  const art = el('attachment-art');
  thumb.hidden = state !== 'attached';
  art.hidden = state === 'attached';
  art.replaceChildren(state === 'processing' ? '' : createIcon(state === 'error' ? ALERT : ATTACH_IMAGE));
  el('attach-remove').hidden = state !== 'attached';
  el('attach-choose').hidden = state === 'attached' || state === 'processing';
  el('attach-choose').textContent = state === 'error' ? 'اختر صورة أخرى…' : 'اختر صورة…';
  const title = el('attachment-title');
  const detail = el('attachment-detail');
  if (state === 'attached') {
    thumb.src = meta.thumb;
    title.textContent = 'صورة مرفقة';
    detail.textContent = `${typeLabel(meta.mime)} · ${bytesLabel(meta.bytes)} · ${arabicDigits(meta.width)}×${arabicDigits(meta.height)} · بلا بيانات وصفية`;
  } else if (state === 'processing') {
    title.textContent = 'جارٍ تجهيز الصورة…';
    detail.textContent = 'تُعاد كتابتها لإزالة البيانات الوصفية واسم الملف.';
  } else if (state === 'error') {
    title.textContent = 'تعذّر إرفاق الصورة';
    detail.textContent = message(error);
  } else {
    title.textContent = 'صورة (اختيارية)';
    detail.replaceChildren(
      'PNG أو JPEG من ملف، أو الصقها بـ ',
      Object.assign(document.createElement('bdi'), { textContent: '⌘V' }),
      ' هنا. لا تُلتقط الشاشة.'
    );
  }
}

async function attach(request, { fromPaste = false } = {}) {
  if (attaching) return;
  attaching = true;
  const keepFocus = document.activeElement === document.body || el('attachment').contains(document.activeElement);
  renderAttachment('processing');
  syncCompose();
  let state = 'empty';
  try {
    const meta = await request();
    if (meta) {
      state = 'attached';
      hasImage = true;
      renderAttachment('attached', meta);
    } else {
      renderAttachment(hasImage ? 'attached' : 'empty', lastMeta);
      state = hasImage ? 'attached' : 'empty';
      if (fromPaste) setStatus('لا صورة في الحافظة يمكن إرفاقها.', { error: true });
    }
    if (meta) lastMeta = meta;
  } catch (err) {
    state = 'error';
    hasImage = false;
    renderAttachment('error', null, err);
  } finally {
    attaching = false;
    syncCompose();
    // The chooser hides while working: hand focus to what replaced it.
    if (keepFocus) el(state === 'attached' ? 'attach-remove' : 'attach-choose').focus();
  }
}

el('attach-choose').addEventListener('click', () => void attach(() => api.reportPickImage()));
el('attach-remove').addEventListener('click', async () => {
  await api.reportRemoveImage().catch(() => {});
  hasImage = false;
  lastMeta = null;
  renderAttachment('empty');
  el('attach-choose').focus();
});

// A deliberate paste of an image anywhere in the compose view attaches it;
// text pastes into the description as usual — including a rich copy that
// carries both, when the description is where the paste lands.
window.addEventListener('paste', (e) => {
  if (views.compose.hidden || attaching) return;
  const types = [...(e.clipboardData?.types ?? [])];
  const isImage = types.includes('Files') || types.some((t) => t.startsWith('image/'));
  if (!isImage) return;
  if (e.target === description && types.includes('text/plain')) return;
  e.preventDefault();
  void attach(() => api.reportPasteImage(), { fromPaste: true });
});

// ─── Preview ──────────────────────────────────────────────────────────────

function fieldRows(target, rows) {
  target.replaceChildren(
    ...rows.flatMap(([label, value, arabic]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      if (/^[\x20-\x7e]+$/u.test(label)) dt.className = 'is-latin';
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (arabic) dd.className = 'is-arabic';
      return [dt, dd];
    })
  );
}

function renderPreview(p) {
  el('preview-destination').replaceChildren(
    ...withLatin(
      'يُرسل إلى صندوق بلاغات خاص بتطبيقات الصانع: مستودع GitHub خاص، عبر خادم على Cloudflare (',
      p.endpointHost,
      '). لا يُرسل شيء غير ما تراه هنا.'
    )
  );
  el('preview-test').hidden = !p.test;
  fieldRows(el('preview-report'), [
    ['النوع', `${p.kind} · ${KIND_LABELS[p.kind]}`],
    ...(p.category ? [['الجزء', `${p.category} · ${CATEGORY_LABELS[p.category]}`]] : []),
  ]);
  el('preview-description').textContent = p.description;
  el('preview-image-section').hidden = !p.image;
  if (p.image) {
    el('preview-image').src = p.image.thumb;
    el('preview-image-meta').textContent =
      `${p.image.mime} · ${bytesLabel(p.image.bytes)} · ${arabicDigits(p.image.width)}×${arabicDigits(p.image.height)} — أُعيد ترميزها: بلا EXIF ولا موقع ولا اسم ملف.`;
  }
  fieldRows(el('preview-envelope'), [
    ['product', 'raff'],
    ['app_version', p.appVersion],
    ['os · os_version', `${p.os} · ${p.osVersion}`],
    ['arch', p.arch],
    ['locale', p.locale],
    ['Idempotency-Key', p.idempotencyKey],
  ]);
  el('preview-diagnostics').textContent = p.diagnosticsJson;
}

async function toPreview() {
  if (buttons.next.disabled) return;
  busy = true;
  buttons.next.setAttribute('aria-busy', 'true');
  syncCompose();
  try {
    const preview = await api.reportPrepare(kind, category.value || null, description.value);
    renderPreview(preview);
    showView('preview');
    showButtons(['back', 'copy', 'send']);
    views.preview.scrollTop = 0;
    // The preview itself, not «إرسال»: a held Enter must not send what
    // nobody has read, and the pane must scroll from the keyboard.
    views.preview.focus();
  } catch (err) {
    setStatus(message(err), { error: true });
  } finally {
    busy = false;
    buttons.next.removeAttribute('aria-busy');
    syncCompose();
  }
}

buttons.next.addEventListener('click', () => void toPreview());

// ─── Send and results ─────────────────────────────────────────────────────

function setBusy(on) {
  busy = on;
  buttons.send.setAttribute('aria-busy', String(on));
  buttons.retry.setAttribute('aria-busy', String(on));
  for (const name of ['back', 'copy', 'send', 'retry', 'cancel']) buttons[name].disabled = on;
  buttons.send.textContent = on ? 'جارٍ الإرسال…' : 'إرسال';
  setStatus(on ? 'جارٍ إرسال البلاغ…' : '');
}

function showProblem(tone, icon, title, text, note = []) {
  showView('result');
  el('result-success').hidden = true;
  const box = el('result-problem');
  box.hidden = false;
  box.dataset.tone = tone;
  el('result-problem-icon').replaceChildren(createIcon(icon));
  el('result-problem-title').textContent = title;
  el('result-problem-text').textContent = text;
  el('result-note').hidden = note.length === 0;
  el('result-note').replaceChildren(...note);
}

/** Moves focus to what just appeared, so it is read and the keyboard follows. */
function focusResult() {
  el(el('result-success').hidden ? 'result-problem-title' : 'result-title').focus();
}

const LIMIT_TAIL = ' البلاغ محفوظ في هذه النافذة حتى ذلك الحين.';

// The countdown lives in the sentence, not on the disabled button, whose grey
// would make the one live fact on screen the hardest to read.
function startRateLimitCountdown(seconds) {
  clearInterval(retryTimer);
  const until = Date.now() + seconds * 1000;
  const text = el('result-problem-text');
  const tick = () => {
    if (Date.now() >= until) {
      clearInterval(retryTimer);
      buttons.retry.disabled = false;
      text.textContent = 'يمكنك الإرسال الآن.';
      return;
    }
    buttons.retry.disabled = true;
    const left = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    text.textContent = `يمكنك الإرسال بعد ${minutesPhrase(left)}.${LIMIT_TAIL}`;
  };
  tick();
  retryTimer = setInterval(tick, 15000);
}

function renderOutcome(outcome) {
  if (outcome.status === 'sent') {
    showView('result');
    el('result-problem').hidden = true;
    el('result-note').hidden = true;
    el('result-success').hidden = false;
    el('report-number').textContent = `#${outcome.id}`;
    el('copy-number').dataset.id = String(outcome.id);
    showButtons(['done']);
    focusResult();
    return;
  }
  if (outcome.status === 'rejected') {
    const reason = REJECTIONS[outcome.error] ?? 'لم يقبل الخادم البلاغ.';
    const detail =
      outcome.error === 'invalid_field' && outcome.field ? `${reason}: \u2066${outcome.field}\u2069.` : reason;
    // Fixable by editing (too large, wrong type, a field): editing leads.
    const fixable = outcome.code === 413 || outcome.code === 415 || outcome.error === 'invalid_field';
    showProblem(
      'danger',
      ALERT,
      'لم يُقبل البلاغ',
      `${detail} إعادة الإرسال لن تغيّر النتيجة.`,
      withLatin('يمكنك نسخ البلاغ ولصقه في مسألة على ', 'github.com/iSltanX/Raff', ' — ما تكتبه هناك علني.')
    );
    showButtons(['cancel', 'copy', 'back'], { primary: fixable ? 'back' : 'copy' });
    buttons.back.textContent = 'رجوع للتعديل';
    buttons.cancel.textContent = 'إغلاق';
    focusResult();
    return;
  }
  if (outcome.status === 'rateLimited') {
    showProblem('warning', CLOCK, 'بلغتَ حد الإرسال مؤقتًا', '', [
      'الحد مشترك بين تطبيقات الصانع للحماية من الإغراق. إغلاق النافذة يتجاهل البلاغ؛ انسخه إن أردت الاحتفاظ به.',
    ]);
    showButtons(['cancel', 'copy', 'retry'], { primary: 'retry' });
    buttons.cancel.textContent = 'إغلاق';
    startRateLimitCountdown(outcome.retryAfterS);
    focusResult();
    return;
  }
  const why = { timeout: 'انتهت المهلة قبل أن يرد الخادم.', network: 'لا اتصال بالخادم.', server: 'تعذّر على الخادم استلامه الآن.' }[outcome.reason] ?? '';
  showProblem('danger', ALERT, 'تعذّر الإرسال', `${why} أعد المحاولة؛ إن كان البلاغ قد وصل فلن يتكرر.`);
  showButtons(['cancel', 'copy', 'retry'], { primary: 'retry' });
  buttons.cancel.textContent = 'إغلاق';
  focusResult();
}

async function send() {
  setBusy(true);
  try {
    renderOutcome(await api.reportSend());
  } catch (err) {
    showProblem('danger', ALERT, 'تعذّر الإرسال', message(err));
    showButtons(['cancel', 'copy', 'back'], { primary: 'back' });
    focusResult();
  } finally {
    setBusy(false);
    if (!buttons.retry.hidden && el('result-problem').dataset.tone === 'warning') {
      buttons.retry.disabled = true; // the countdown owns it
    }
  }
}

buttons.send.addEventListener('click', () => void send());
buttons.retry.addEventListener('click', () => void send());

buttons.copy.addEventListener('click', async () => {
  try {
    await api.reportCopy();
    setStatus('نُسخ البلاغ إلى حافظتك (الصورة بنوعها وحجمها فقط).');
  } catch (err) {
    setStatus(message(err), { error: true });
  }
});

el('copy-number').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  try {
    await api.reportCopyNumber(Number(button.dataset.id));
    button.textContent = 'نُسخ الرقم';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      button.textContent = 'نسخ الرقم';
    }, 2000);
  } catch (err) {
    setStatus(message(err), { error: true });
  }
});

buttons.back.addEventListener('click', () => {
  clearInterval(retryTimer);
  showView('compose');
  showButtons(['cancel', 'next']);
  buttons.back.textContent = 'رجوع';
  buttons.cancel.textContent = 'إلغاء';
  syncCompose();
  (kind ? checkedKind() : kinds[0]).focus();
});

buttons.cancel.addEventListener('click', closeWindow);
buttons.done.addEventListener('click', closeWindow);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !busy && nothingToLose()) closeWindow();
});

renderAttachment('empty');
showButtons(['cancel', 'next']);
syncCompose();
