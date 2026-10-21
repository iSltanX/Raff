// Audit 026 ج1: the app icon's asset catalogue was compiled for macOS 26.0
// while the app declares 12.0 as its minimum, under a comment claiming the
// two matched. Compiled either way the catalogue holds the same renditions
// (evidence/2026-10-22-m7); what differs is the system it says it is for.
// It is now built for the app's own minimum, read from the one place that
// declares it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

test('the icon catalogue is built for the minimum the app declares', () => {
  const script = read('scripts/apply-app-icon.mjs');
  const declaration = script.slice(script.indexOf('const DEPLOYMENT_TARGET'));
  const value = declaration.slice(0, declaration.indexOf(';'));
  assert.doesNotMatch(value, /['"]\d+(\.\d+)*['"]/u, 'no version written in by hand');
  assert.match(value, /tauri\.conf\.json/u);
  assert.match(value, /\.bundle\.macOS\.minimumSystemVersion/u);
  assert.match(script, /'--minimum-deployment-target', DEPLOYMENT_TARGET/u);
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(conf.bundle.macOS.minimumSystemVersion, '12.0');
});
