// Audit 022 ج3: the update window showed the release date as ISO digits,
// «٢٠٢٦-١٠-٢٠», whose order an RTL line makes ambiguous. In Arabic it reads
// «٢٠ أكتوبر ٢٠٢٦» now; in another interface language, that language's own
// long date. The date is a calendar day, never shifted by a time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseDate } from '../src/js/logic.js';

test('Arabic: day, month name, year, in Arabic digits', () => {
  assert.equal(releaseDate('2026-10-20', 'ar'), '٢٠ أكتوبر ٢٠٢٦');
  assert.equal(releaseDate('2026-01-05', 'ar'), '٥ يناير ٢٠٢٦');
  assert.equal(releaseDate('2025-12-31', 'ar-SA'), '٣١ ديسمبر ٢٠٢٥', 'any Arabic, Gregorian');
});

test('another interface language: its own long date, the same day', () => {
  assert.equal(releaseDate('2026-10-20', 'en'), 'October 20, 2026');
  assert.match(releaseDate('2026-10-20', 'fr'), /^20 octobre 2026$/u);
});

test('a missing or malformed interface language still gives a date', () => {
  for (const lang of ['', null, 'en_US', 'i-klingon']) {
    assert.equal(releaseDate('2026-10-20', lang), '٢٠ أكتوبر ٢٠٢٦', String(lang));
  }
  assert.equal(releaseDate('2024-02-29', 'ar'), '٢٩ فبراير ٢٠٢٤', 'a leap day');
  assert.equal(releaseDate('2025-02-29', 'ar'), null, 'and none where there is none');
});

test('what is not a date is not shown as one', () => {
  for (const bad of ['', null, undefined, '2026-13-01', '2026-02-30', 'yesterday', '2026-10-20T00:00:00Z']) {
    assert.equal(releaseDate(bad, 'ar'), null, String(bad));
  }
});
