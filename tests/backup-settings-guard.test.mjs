// An imported backup changes preferences only (IMP-05, ت٦٤). The M10
// experiments are this Mac's privacy choices, like capture and retention: a
// file from another Mac never turns them on or off here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsFromBackup } from '../src/js/logic.js';

test('settingsFromBackup leaves the experiments and every privacy setting as they are', () => {
  const current = {
    hotkey: 'shift+super+v',
    appearance: 'light',
    excludedApps: [],
    skipSecrets: false,
    ocrEnabled: false,
    respectConcealed: true,
    captureEnabled: true,
    historyLimit: 500,
    retentionDays: 30,
  };
  const file = {
    ...current,
    skipSecrets: true,
    ocrEnabled: true,
    respectConcealed: false,
    captureEnabled: false,
    historyLimit: 200,
    retentionDays: 7,
  };
  const { patch, hotkey } = settingsFromBackup(current, file);
  assert.deepEqual(patch, {});
  assert.equal(hotkey, null);
});
