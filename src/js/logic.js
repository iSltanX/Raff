// Pure frontend logic — no Tauri imports, unit-tested with `npm test`.

const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/** Converts Western digits in a string/number to Arabic-Indic digits. */
export function arabicDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]);
}

const ARABIC_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

/** A release's `YYYY-MM-DD` as a reader says it (audit 022 ج3): «٢٠ أكتوبر
 * ٢٠٢٦» in Arabic, the interface language's own long date otherwise. A
 * calendar day, so it is never shifted by a time zone. `null` for anything
 * that is not such a date. */
export function releaseDate(iso, lang = 'ar') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(iso ?? ''));
  if (!m) return null;
  const [year, month, day] = m.slice(1).map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  const arabic = `${arabicDigits(day)} ${ARABIC_MONTHS[month - 1]} ${arabicDigits(year)}`;
  if (/^ar(-|$)/iu.test(String(lang ?? ''))) return arabic;
  try {
    return new Intl.DateTimeFormat(lang, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(at);
  } catch {
    // An empty or malformed `lang` makes Intl throw; the date still shows,
    // in the interface's own language.
    return arabic;
  }
}

/**
 * A count with its noun, as Arabic counts: one and two have their own forms,
 * three to ten take the plural, eleven and up the singular accusative.
 * `forms` = [one, two, three-to-ten, eleven-and-up], e.g.
 * ['مرة', 'مرتين', 'مرات', 'مرة'] → «مرة»، «مرتين»، «٣ مرات»، «١١ مرة».
 */
export function arabicCount(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  const mod = n % 100;
  return `${arabicDigits(n)} ${mod >= 3 && mod <= 10 ? few : many}`;
}

/** Strips Arabic diacritics (tashkeel) and tatweel, folds Arabic-Indic digits
 *  to Western, and folds the two spellings people actually disagree about —
 *  forgiving search in both directions.
 *
 *  This is the search normalizer and nothing else: stored and displayed text
 *  keeps every letter the user copied.
 *
 *  The fold is deliberately two rules and stays two. Taa marbuta against haa
 *  is the obvious next candidate and is left out on purpose: it buys a
 *  handful of spelling slips and pays for them in false matches on every
 *  feminine noun. */
export function normalizeArabic(s) {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ٰٟ]/g, '') // tashkeel
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا') // alef forms
    .replace(/ى/g, 'ي') // dotless ya
    .toLowerCase();
}

/**
 * Instant filter over preview text and source app name.
 *
 * `alsoMatchIds` carries the rows Rust matched in the part of the text this
 * side never receives — the preview is cut at 1000 characters. It is a union,
 * not a replacement: the local pass stays synchronous so typing never waits
 * on IPC, and the deeper answer widens the result when it arrives.
 */
export function filterItems(items, query, alsoMatchIds = null) {
  const q = normalizeArabic(query.trim());
  if (!q) return items;
  return items.filter(
    (item) =>
      alsoMatchIds?.has(item.id) ||
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

/**
 * Why an accelerator cannot be رفّ's global shortcut, or null when it can.
 *
 * A global shortcut is taken from every app while رفّ runs. With no modifier
 * but ⇧ it would take a capital letter from all typing; ⌘ with C, V, X, A, Z,
 * Q or W, the edit and window commands every app relies on. The backend
 * refuses the same ones (`hotkey_refusal` in commands.rs).
 */
const SHARED_HOTKEYS = new Set(['c', 'v', 'x', 'a', 'z', 'q', 'w'].map((key) => `super+${key}`));

export function hotkeyRefusal(accel) {
  const mods = String(accel).split('+').slice(0, -1);
  if (!mods.some((mod) => mod !== 'shift')) return 'needs-modifier';
  if (SHARED_HOTKEYS.has(accel)) return 'shared';
  return null;
}
