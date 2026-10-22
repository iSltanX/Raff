// «لصق بلا تشكيل» (IMP-06) is offered only where `without_tashkeel` in
// paste.rs would change the text; `hasTashkeel` has to draw the same line.
// Review 2026-10-22: a decomposed hamza or madda is part of its letter, and
// the Quranic signs that are symbols are not marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTashkeel } from '../src/js/logic.js';

test('hasTashkeel: marks yes; decomposed hamza, madda and Quranic symbols no', () => {
  assert.equal(hasTashkeel('مُحَمَّد'), true);
  assert.equal(hasTashkeel('الســلام'), true, 'tatweel');
  assert.equal(hasTashkeel('رحمٰن'), true, 'superscript alef');
  assert.equal(hasTashkeel('أم إن آمن ءٟ'), false, 'NFD أ إ آ');
  assert.equal(hasTashkeel('۝١ ۞ ۩ ۥۦ'), false, 'symbols and small letters');
  for (const mark of ['ۖ', 'ۜ', '۟', 'ۤ', 'ۧ', 'ۨ', '۪', 'ۭ', 'ٖ', 'ٞ']) {
    assert.equal(hasTashkeel(`ا${mark}`), true, mark.codePointAt(0).toString(16));
  }
});
