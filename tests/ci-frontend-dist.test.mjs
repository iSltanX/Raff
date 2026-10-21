// `cargo test` compiles `generate_context!`, which embeds `frontendDist`
// (`../dist`) at compile time and refuses to build when it is missing. Since
// the package test builds into its own temp folder (`--out`, audit 025),
// `npm test` no longer leaves a `dist/` behind, so every workflow that runs
// `cargo test` has to build the frontend itself — after `npm ci`, before the
// Rust step. A local checkout hides the gap with a `dist/` from an earlier
// build; a clean clone, CI and the release runner do not (F-CI, 2026-10-21).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');

/** The `run:` commands of a workflow, in the order its steps run. */
function runSteps(workflow) {
  return [...workflow.matchAll(/^\s*run:\s*(.+)$/gmu)].map((m) => m[1].trim());
}

for (const file of ['ci.yml', 'release.yml']) {
  test(`${file} builds dist/ after npm ci and before cargo test`, () => {
    const steps = runSteps(read('.github', 'workflows', file));
    const install = steps.indexOf('npm ci');
    const build = steps.indexOf('npm run build:frontend');
    const cargo = steps.findIndex((s) => s.startsWith('cargo test'));
    assert.ok(install >= 0, `${file}: npm ci step`);
    assert.ok(cargo >= 0, `${file}: cargo test step`);
    assert.ok(build >= 0, `${file}: no npm run build:frontend step, so cargo test fails on a clean runner`);
    assert.ok(install < build && build < cargo, `${file}: order is ${steps.join(' → ')}`);
  });
}

test('tauri.conf.json embeds dist/, the folder the workflows build', () => {
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  assert.equal(conf.build.frontendDist, '../dist');
  assert.equal(conf.build.beforeBuildCommand, 'npm run build:frontend');
});

test('tauri dev rebuilds dist/ first and waits for it, instead of showing a stale one', () => {
  // No devUrl: dev serves frontendDist as it is, so without this it shows
  // whatever dist/ an earlier build left (audit 2026-10-21 ج٥).
  const { build } = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  assert.equal(build.devUrl, undefined);
  assert.deepEqual(build.beforeDevCommand, { script: 'npm run build:frontend', wait: true });
});

test('the README command table builds the frontend before the Rust tests', () => {
  const readme = read('README.md');
  const build = readme.indexOf('`npm run build:frontend`');
  const cargo = readme.indexOf('`cargo test --manifest-path src-tauri/Cargo.toml`');
  assert.ok(build >= 0, 'README lists npm run build:frontend');
  assert.ok(build < cargo, 'and lists it before cargo test, which needs dist/');
});

test('the release, like CI, stops on a known Rust advisory before it builds', () => {
  // A tag can be pushed long after the last CI run; advisories land in between
  // (nine did between 2026-10-09 and 10-20, F-DEP).
  for (const file of ['ci.yml', 'release.yml']) {
    const steps = runSteps(read('.github', 'workflows', file));
    const audit = steps.indexOf('cargo audit');
    assert.ok(audit >= 0, `${file} runs cargo audit`);
    assert.ok(audit < steps.findIndex((s) => s.startsWith('cargo test')), `${file}: before the Rust tests`);
  }
});
