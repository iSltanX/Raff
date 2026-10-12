// يولّد متجهات مشتركة لاختبار تطابق normalizeArabic (JS) مع normalize_for_search (Rust).
// التشغيل: node audit/scripts/gen-normalize-vectors.mjs > audit/fixtures/normalize-vectors.json
//
// expected      = ناتج JS الفعلي (normalizeArabic)
// perCharModel  = نموذج JS لسلوك Rust: الطيّ حرفًا حرفًا (حلقة normalize_for_search)
//                 ثم خفض النص كاملًا كما يفعل str::to_lowercase
// divergence    = RAFF-AUD-007 حيث يختلف خفض النص كاملًا عن خفض كل حرف وحده
//                 (السيغما النهائية) — أي حيث اختلف الطرفان قبل الإصلاح، فتبقى
//                 هذه المتجهات تحت اختبارَي الانحدار في الجهتين.
import { normalizeArabic } from '../../src/js/logic.js';

function fold(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0660 && cp <= 0x0669) out += String(cp - 0x0660);
    else if ((cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || cp === 0x0640) continue;
    else if (cp === 0x0623 || cp === 0x0625 || cp === 0x0622) out += '\u0627';
    else if (cp === 0x0649) out += '\u064A';
    else out += ch;
  }
  return out;
}

const perCharModel = (s) => fold(s).toLowerCase();

/** سلوك Rust قبل إصلاح RAFF-AUD-007: كل حرف يُخفض وحده دون سياقه. */
function lowercaseEachChar(s) {
  let out = '';
  for (const ch of fold(s)) out += ch.toLowerCase();
  return out;
}

function xorshift(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

const handpicked = [
  ['', 'فارغ'],
  ['مَرْحَبًا', 'تشكيل'],
  ['مـــرحبا', 'تطويل'],
  ['أحمد إبراهيم آمال', 'أشكال الألف'],
  ['مصطفى على', 'الألف المقصورة'],
  ['٠١٢٣٤٥٦٧٨٩', 'أرقام عربية-هندية'],
  ['۰۱۲۳', 'أرقام فارسية (لا تُطوى في الجانبين)'],
  ['رحمٰن', 'ألف خنجرية U+0670'],
  ['\u0656\u065F', 'أطراف نطاق التشكيل'],
  ['\u066A\u066B\u066C', 'رموز بعد الأرقام (يجب أن تبقى)'],
  ['HELLO World', 'لاتيني'],
  ['İstanbul', 'İ التركية'],
  ['ẞ', 'eszett كبيرة'],
  ['ΟΔΟΣ', 'سيغما نهائية'],
  ['ΣΑΣ', 'سيغما نهائية مكررة'],
  ['Σ', 'سيغما منفردة'],
  ['ΑΣ Β', 'سيغما قبل مسافة'],
  ['\u202Eabc', 'RLO'],
  ['\uFEFFنص', 'BOM'],
  ['😀 إيموجي', 'خارج BMP'],
  ['a\u0301', 'علامة تركيبية لاتينية'],
];

const vectors = handpicked.map(([input, note]) => ({ input, note }));

const pool = [
  ...'ابتثجحخدذرزسشصضطظعغفقكلمنهوي',
  'أ', 'إ', 'آ', 'ى', 'ة', 'ء', 'ـ', ...'\u064B\u064C\u064D\u064E\u064F\u0650\u0651\u0652\u0670',
  ...'٠١٢٣٤٥٦٧٨٩', ...'0123456789', ...'ABCxyz', ' ', 'Σ', 'Ω', 'İ', '\u0301',
];
const next = xorshift(0x5eed);
for (let i = 0; i < 200; i++) {
  const len = next() % 24;
  let s = '';
  for (let j = 0; j < len; j++) s += pool[next() % pool.length];
  vectors.push({ input: s, note: `مولَّد #${i} (seed 0x5eed)` });
}

const out = vectors.map((v) => {
  const expected = normalizeArabic(v.input);
  return {
    ...v,
    expected,
    perCharModel: perCharModel(v.input),
    divergence: expected === lowercaseEachChar(v.input) ? null : 'RAFF-AUD-007',
  };
});

const trimVectors = [
  ' أ ', '\tx\n', '\u00A0x\u00A0', '\u3000x', '\uFEFFx', 'x\uFEFF', '\u200Bx', '\u2028x',
  // U+0085: White_Space في Rust وليس مسافة في JS، فلا يُقصّ في الجهتين.
  '\u0085x',
  // بقية قائمة ECMAScript، كل محرف على الطرفين: VT وFF وCR، وكل Zs، وU+2029.
  ...['\u000B', '\u000C', '\r', '\u1680', '\u202F', '\u205F', '\u2029']
    .concat(Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)))
    .map((ch) => `${ch}x${ch}`),
  // U+180E: كان Zs قديمًا، وليس مسافة في JS اليوم ولا في Rust.
  '\u180Ex',
].map((input) => ({
  input,
  jsTrim: input.trim(),
}));

process.stdout.write(
  JSON.stringify(
    { generator: 'audit/scripts/gen-normalize-vectors.mjs', seed: '0x5eed', vectors: out, trimVectors },
    null,
    1
  ) + '\n'
);
