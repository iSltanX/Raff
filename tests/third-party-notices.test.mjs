// What ships in the app has to carry its licences. The Rust crates compiled into
// the binary (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, and a few MPL-2.0) and
// the four font families bundled in the window assets (SIL OFL 1.1) each require
// their copyright and licence text to travel with the binary. THIRD-PARTY-
// NOTICES.md is generated from the dependency graph (scripts/gen-third-party-
// notices.mjs), copied into Raff.app/Contents/Resources by tauri.conf.json, and
// must be regenerated whenever the shipped dependencies change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { lockDigest } from '../scripts/gen-third-party-notices.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
// Booleans, not `assert.match(longText, …)`: a failure carrying a whole notices
// file as `actual` stalls node 20's TAP reporter for minutes.
const has = (text, pattern, what) => assert.ok(pattern.test(text), what);

test('the bundle carries the notices file in its resources', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const resources = conf.bundle.resources ?? {};
  const entries = Array.isArray(resources) ? resources.map((r) => [r, r]) : Object.entries(resources);
  const notices = entries.find(([from]) => from.endsWith('THIRD-PARTY-NOTICES.md'));
  assert.ok(notices, 'bundle.resources names THIRD-PARTY-NOTICES.md');
  assert.equal(notices[1], 'THIRD-PARTY-NOTICES.md', 'it lands at the top of Contents/Resources');
  assert.ok(existsSync(path.join(root, 'src-tauri', notices[0])), 'the path resolves from src-tauri/');
});

test('the notices were generated from this dependency lock', () => {
  const text = read('THIRD-PARTY-NOTICES.md');
  const stamp = text.match(/Cargo\.lock digest: ([0-9a-f]{64})/u)?.[1];
  assert.ok(stamp, 'the file records the digest of the lock it was generated from');
  assert.equal(stamp, lockDigest(read('src-tauri/Cargo.lock')), 'stale: run `npm run notices`');
});

test('every shipped font family and the OFL text are in it', () => {
  const text = read('THIRD-PARTY-NOTICES.md');
  for (const family of ['Almarai', 'Cairo', 'Inter', 'JetBrains Mono']) {
    has(text, new RegExp(`### ${family}\\b`, 'u'), `${family} has a section`);
  }
  has(text, /SIL OPEN FONT LICENSE Version 1\.1/u, 'the OFL text');
  has(text, /Copyright 2016 The Inter Project Authors/u, 'a font copyright line, read from the font file');
});

test('the Rust crates are listed with their licence texts, MPL ones with their source', () => {
  const text = read('THIRD-PARTY-NOTICES.md');
  const crates = [...text.matchAll(/^- \*\*([^*]+)\*\* ([^\s]+) — /gmu)];
  assert.ok(crates.length >= 300, `at least 300 shipped crates listed (found ${crates.length})`);
  for (const name of ['tauri', 'serde', 'tokio', 'tauri-nspanel', 'cssparser']) {
    assert.ok(crates.some((c) => c[1] === name), `${name} is listed`);
  }
  has(text, /Permission is hereby granted, free of charge/u, 'an MIT text');
  has(text, /Apache License\s+Version 2\.0, January 2004/u, 'the Apache-2.0 text');
  has(text, /Mozilla Public License Version 2\.0/u, 'the MPL-2.0 text');
  has(text, /## MPL-2\.0 source/u, 'where the MPL-covered source is obtained');
});

test('the README points to the notices', () => {
  has(read('README.md'), /\(THIRD-PARTY-NOTICES\.md\)/u, 'README links to THIRD-PARTY-NOTICES.md');
});
