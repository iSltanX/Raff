// Pure frontend logic — no Tauri imports, unit-tested with `npm test`.

const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/** Converts Western digits in a string/number to Arabic-Indic digits. */
export function arabicDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]);
}

/** Strips Arabic diacritics (tashkeel) and tatweel, folds Arabic-Indic digits
 *  to Western — forgiving search in both directions. */
export function normalizeArabic(s) {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ٰٟ]/g, '') // tashkeel
    .replace(/ـ/g, '') // tatweel
    .toLowerCase();
}

/** Instant filter over preview text and source app name. */
export function filterItems(items, query) {
  const q = normalizeArabic(query.trim());
  if (!q) return items;
  return items.filter(
    (item) =>
      normalizeArabic(item.text).includes(q) ||
      normalizeArabic(item.sourceApp || '').includes(q)
  );
}

/**
 * Relative time in Arabic matching the identity samples:
 * "الآن", "قبل ٣ د", "قبل ساعة", "قبل ساعتين", "قبل ٣ س", "أمس", "قبل يومين"…
 */
export function relativeTimeAr(thenMs, nowMs = Date.now()) {
  const diff = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `قبل ${arabicDigits(minutes)} د`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'قبل ساعة';
  if (hours === 2) return 'قبل ساعتين';
  if (hours < 24) return `قبل ${arabicDigits(hours)} س`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'أمس';
  if (days === 2) return 'قبل يومين';
  if (days < 7) return `قبل ${arabicDigits(days)} أيام`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return 'قبل أسبوع';
  if (weeks === 2) return 'قبل أسبوعين';
  if (days < 30) return `قبل ${arabicDigits(weeks)} أسابيع`;
  const d = new Date(thenMs);
  return arabicDigits(`${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`);
}

/** Meta line: "المصدر • الوقت" (e.g. "ChatGPT • قبل ساعة"). */
export function metaLine(item, nowMs = Date.now()) {
  const time = relativeTimeAr(item.createdAt, nowMs);
  return item.sourceApp ? `${item.sourceApp} • ${time}` : time;
}

const MOD_SYMBOLS = [
  [/^(cmd|command|super|meta)$/, '⌘'],
  [/^(ctrl|control)$/, '⌃'],
  [/^(alt|option)$/, '⌥'],
  [/^shift$/, '⇧'],
];
const MOD_ORDER = { '⌃': 0, '⌥': 1, '⇧': 2, '⌘': 3 };

/** "shift+super+v" → "⇧⌘V" (modifier order follows macOS convention). */
export function hotkeyDisplay(accel) {
  const parts = String(accel).split('+').map((p) => p.trim()).filter(Boolean);
  const mods = [];
  let key = '';
  for (const part of parts) {
    const symbol = MOD_SYMBOLS.find(([re]) => re.test(part.toLowerCase()))?.[1];
    if (symbol) mods.push(symbol);
    else key = part.length === 1 ? part.toUpperCase() : part;
  }
  mods.sort((a, b) => MOD_ORDER[a] - MOD_ORDER[b]);
  return mods.join('') + key;
}

/**
 * Builds an accelerator string from a KeyboardEvent, or null when the combo
 * is not a valid global shortcut (needs ≥1 modifier + a real key).
 */
export function hotkeyFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('super');
  if (mods.length === 0) return null;

  const code = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code === 'Space') key = 'space';
  if (!key) return null;

  return [...mods, key].join('+');
}
