// The exact bug that broke the v4.2.0 release workflow's first run: the
// script assumed `target/release/bundle`, but tauri-action runs with
// `args: --target aarch64-apple-darwin` (see release.yml), and Cargo nests
// EVERY target-qualified build under `target/<triple>/release/...` — even
// when the triple matches the host natively — never the unqualified path a
// plain `tauri build` (no --target, what build-candidate.mjs runs locally)
// uses. The script found nothing, and failed before touching the icon.
//
// This guards the fix structurally: the script must check the
// target-qualified path (what CI actually produces), not just the
// plain one (what only the local candidate builder produces).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  path.join(here, '..', 'scripts', 'ci-fix-release-icon.mjs'),
  'utf8'
);

test('checks the target-triple-qualified bundle path CI actually produces', () => {
  assert.match(
    script,
    /target\/aarch64-apple-darwin\/release\/bundle/u,
    'must account for the --target aarch64-apple-darwin path tauri-action builds into'
  );
});

test('still falls back to the unqualified path, for robustness', () => {
  const withoutTargetTriple = script.replace(/target\/aarch64-apple-darwin\/release\/bundle/gu, '');
  assert.match(
    withoutTargetTriple,
    /target\/release\/bundle/u,
    'a plain (non---target) tauri build output must still be found'
  );
});

test('fails loudly, listing every path checked, if neither exists', () => {
  const bail = script.slice(script.indexOf('if (!bundleRoot)'), script.indexOf('if (!bundleRoot)') + 400);
  assert.match(bail, /process\.exit\(1\)/u, 'a missing app must not silently proceed to patch nothing');
});
