// The public release pipeline must ship the same corrected icon the local
// candidate does — not tauri-action's raw, appearance-unaware icon.icns.
//
// This is the CI half of the fix build-candidate-pipeline.test.mjs guards
// locally: tauri-action has no post-build hook, so .github/workflows/release.yml
// must run scripts/ci-fix-release-icon.mjs AFTER the build-and-publish step,
// and the runner must be new enough to have Icon Composer's actool support at
// all (verified locally as Xcode 26.6; macos-14 predates it and — separately —
// is being sunset by GitHub regardless).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(
  path.join(here, '..', '.github', 'workflows', 'release.yml'),
  'utf8'
);

test('the release runner supports Icon Composer (not macos-14)', () => {
  assert.doesNotMatch(
    workflow,
    /runs-on:\s*macos-14\b/u,
    'macos-14 has no Xcode 26 — Icon Composer .icon compilation is unavailable there'
  );
  assert.match(workflow, /runs-on:\s*macos-26\b/u);
});

test('the icon-fix step runs after tauri-action, in the same job', () => {
  const buildStep = workflow.indexOf('tauri-apps/tauri-action@v0');
  const fixStep = workflow.indexOf('ci-fix-release-icon.mjs');
  assert.ok(buildStep >= 0, 'tauri-action step must exist');
  assert.ok(fixStep >= 0, 'the icon-fix step must exist');
  assert.ok(buildStep < fixStep, 'the icon can only be patched after tauri-action has built Raff.app');
});

test('the icon-fix step has the secrets it needs to sign the regenerated archive', () => {
  const fixStep = workflow.slice(workflow.indexOf('ci-fix-release-icon.mjs') - 400);
  assert.match(fixStep, /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY\s*\}\}/u);
  assert.match(fixStep, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/u, 'gh CLI needs auth to upload replacement assets');
});
