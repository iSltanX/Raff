// Frontend logic tests — run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arabicDigits,
  normalizeArabic,
  filterItems,
  relativeTimeAr,
  metaLine,
  hotkeyDisplay,
  hotkeyFromEvent,
} from '../src/js/logic.js';

test('arabicDigits converts Western digits', () => {
  assert.equal(arabicDigits(3), '٣');
  assert.equal(arabicDigits('0.1.0'), '٠.١.٠');
  assert.equal(arabicDigits('قبل 12 د'), 'قبل ١٢ د');
});

test('normalizeArabic strips tashkeel and tatweel', () => {
  assert.equal(normalizeArabic('مُثَبَّت'), 'مثبت');
  assert.equal(normalizeArabic('رفّ'), 'رف');
  assert.equal(normalizeArabic('كـــتاب'), 'كتاب');
  assert.equal(normalizeArabic('HeLLo'), 'hello');
  // The tashkeel class must not swallow Arabic punctuation or rare letters.
  assert.equal(normalizeArabic('٥٠٪'), '50٪');
  assert.equal(normalizeArabic('٫٬٭ٮٯ'), '٫٬٭ٮٯ');
});

test('filterItems matches text and source app, diacritic-insensitive', () => {
  const items = [
    { text: 'أكتب خطابًا رسميًا', sourceApp: 'ChatGPT' },
    { text: 'SELECT * FROM users', sourceApp: 'TablePlus' },
    { text: 'رفّ مثبّت', sourceApp: 'Notes' },
  ];
  assert.equal(filterItems(items, '').length, 3);
  assert.equal(filterItems(items, 'select')[0].sourceApp, 'TablePlus');
  assert.equal(filterItems(items, 'chatgpt').length, 1);
  assert.equal(filterItems(items, 'مثبت').length, 1); // no shadda in query
  assert.equal(filterItems(items, 'غير موجود').length, 0);
});

test('relativeTimeAr matches identity samples', () => {
  const now = Date.now();
  const min = 60_000;
  assert.equal(relativeTimeAr(now - 10_000, now), 'الآن');
  assert.equal(relativeTimeAr(now - 3 * min, now), 'قبل ٣ د');
  assert.equal(relativeTimeAr(now - 30 * min, now), 'قبل ٣٠ د');
  assert.equal(relativeTimeAr(now - 70 * min, now), 'قبل ساعة');
  assert.equal(relativeTimeAr(now - 130 * min, now), 'قبل ساعتين');
  assert.equal(relativeTimeAr(now - 5 * 60 * min, now), 'قبل ٥ س');
  assert.equal(relativeTimeAr(now - 30 * 60 * min, now), 'أمس');
  assert.equal(relativeTimeAr(now - 2 * 24 * 60 * min, now), 'قبل يومين');
  assert.equal(relativeTimeAr(now - 4 * 24 * 60 * min, now), 'قبل ٤ أيام');
  assert.equal(relativeTimeAr(now - 8 * 24 * 60 * min, now), 'قبل أسبوع');
});

test('metaLine joins source and time like the reference', () => {
  const now = Date.now();
  const item = { sourceApp: 'ChatGPT', createdAt: now - 70 * 60_000 };
  assert.equal(metaLine(item, now), 'ChatGPT • قبل ساعة');
  assert.equal(metaLine({ sourceApp: '', createdAt: now }, now), 'الآن');
});

test('hotkeyDisplay renders macOS symbols in convention order', () => {
  assert.equal(hotkeyDisplay('shift+super+v'), '⇧⌘V');
  assert.equal(hotkeyDisplay('super+shift+v'), '⇧⌘V');
  assert.equal(hotkeyDisplay('ctrl+alt+space'), '⌃⌥space');
  assert.equal(hotkeyDisplay('cmd+F1'), '⌘F1');
});

test('hotkeyFromEvent builds accelerators and rejects invalid combos', () => {
  assert.equal(
    hotkeyFromEvent({ metaKey: true, shiftKey: true, code: 'KeyV' }),
    'shift+super+v'
  );
  assert.equal(hotkeyFromEvent({ altKey: true, code: 'Digit5' }), 'alt+5');
  assert.equal(hotkeyFromEvent({ metaKey: true, code: 'F6' }), 'super+F6');
  assert.equal(hotkeyFromEvent({ code: 'KeyV' }), null); // no modifier
  assert.equal(hotkeyFromEvent({ metaKey: true, code: 'MetaLeft' }), null); // modifier only
});
