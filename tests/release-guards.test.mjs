// Audit 013: two ways a release could carry the wrong thing.
// ج1 — `build-candidate.mjs` lets `tauri build` fail at its last step (the
// updater signature needs CI's key), then checked only that an app existed:
// a build that failed earlier left last week's app in place, and it shipped.
// ج2 — the release workflow could run from a branch and tag the release with
// the branch's name, or from a tag that names another version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkFreshApp, checkReleaseTag, declaredVersions } from '../scripts/release-guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

function fakeApp(version) {
  const root = mkdtempSync(path.join(tmpdir(), 'raff-guard-'));
  const app = path.join(root, 'Raff.app');
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents/MacOS/raff'), 'binary');
  writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
  );
  return { root, app };
}

test('ج1: only the app this build made passes', () => {
  const startedAt = Date.now();
  const fresh = fakeApp('6.0.2');
  try {
    assert.equal(checkFreshApp({ appPath: fresh.app, startedAt, version: '6.0.2' }), null);
    assert.match(checkFreshApp({ appPath: fresh.app, startedAt, version: '6.0.3' }), /is version 6\.0\.2/u);
    const old = (startedAt - 3_600_000) / 1000;
    utimesSync(path.join(fresh.app, 'Contents/MacOS/raff'), old, old);
    assert.match(checkFreshApp({ appPath: fresh.app, startedAt, version: '6.0.2' }), /predates this build/u);
    assert.match(checkFreshApp({ appPath: path.join(fresh.root, 'none.app'), startedAt, version: '6.0.2' }), /no executable/u);
  } finally {
    rmSync(fresh.root, { recursive: true, force: true });
  }
});

test('ج1: build-candidate takes the time before building and checks the app after', () => {
  const script = read('scripts/build-candidate.mjs');
  const started = script.indexOf('const startedAt = Date.now()');
  const built = script.search(/run\(['"]npm['"],\s*\[['"]run['"],\s*['"]tauri['"],\s*['"]build['"]\]/u);
  const checked = script.indexOf('checkFreshApp({');
  const patched = script.search(/run\(['"]node['"],\s*\[path\.join\(here,\s*['"]apply-app-icon\.mjs['"]/u);
  assert.ok(started > 0 && started < built && built < checked && checked < patched, `${started} ${built} ${checked} ${patched}`);
});

test('ج2: a release runs from the tag that names the declared version', () => {
  const versions = { 'package.json': '6.0.2', 'tauri.conf.json': '6.0.2', 'Cargo.toml': '6.0.2' };
  assert.equal(checkReleaseTag({ refType: 'tag', refName: 'v6.0.2', versions }), null);
  assert.match(checkReleaseTag({ refType: 'branch', refName: 'main', versions }), /from a tag/u);
  assert.match(checkReleaseTag({ refType: 'tag', refName: 'v6.0.1', versions }), /does not name/u);
  assert.match(
    checkReleaseTag({ refType: 'tag', refName: 'v6.0.2', versions: { ...versions, 'Cargo.toml': '6.0.1' } }),
    /disagree/u
  );
  const here = declaredVersions();
  assert.equal(new Set(Object.values(here)).size, 1, JSON.stringify(here));
});

test('ج2: the workflow checks the tag before it builds anything', () => {
  const workflow = read('.github/workflows/release.yml');
  const guard = workflow.indexOf('node scripts/release-guards.mjs tag "$REF_TYPE" "$REF_NAME"');
  // Through the environment, never spliced into the shell text.
  assert.doesNotMatch(workflow, /run:.*\$\{\{\s*github\.ref_name/u);
  assert.match(workflow, /REF_NAME: \$\{\{ github\.ref_name \}\}/u);
  const install = workflow.indexOf('run: npm ci');
  const build = workflow.indexOf('uses: tauri-apps/tauri-action');
  assert.ok(guard > 0 && guard < install && install < build, `${guard} ${install} ${build}`);
});
