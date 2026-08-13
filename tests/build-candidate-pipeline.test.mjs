// The release pipeline must patch the app icon BEFORE the DMG and updater
// archive are generated — never build them first and patch a copy after.
//
// This was a real defect: `tauri build` produced a DMG and a `.tar.gz` from
// the pre-patch (black) icon, then apply-app-icon.mjs patched only the
// standalone `.app`, so anyone installing from the DMG got the wrong icon
// even though the tested `.app` looked correct. scripts/build-candidate.mjs
// exists specifically to make that divergence structurally impossible: it
// discards tauri's own DMG/tar.gz and regenerates both from the
// already-patched app. This guards the ORDER, since that is exactly what
// regressed — not any one line of implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  path.join(here, '..', 'scripts', 'build-candidate.mjs'),
  'utf8'
);

function stepIndex(pattern) {
  const m = script.match(pattern);
  assert.ok(m, `expected to find ${pattern} in build-candidate.mjs`);
  return m.index;
}

test('icon patching happens before DMG creation, and before the updater archive', () => {
  const appBuilt = stepIndex(/run\(['"]npm['"],\s*\[['"]run['"],\s*['"]tauri['"],\s*['"]build['"]\]/);
  // The actual invocation, not the docstring above that names the same file.
  const iconPatched = stepIndex(/run\(['"]node['"],\s*\[path\.join\(here,\s*['"]apply-app-icon\.mjs['"]/);
  const dmgCreated = stepIndex(/hdiutil['"],\s*\[\s*\n?\s*['"]create['"]/);
  const tarCreated = stepIndex(/tar['"],\s*\[['"]-czf['"]/);

  assert.ok(appBuilt < iconPatched, 'tauri build must run before the icon is patched (nothing to patch yet)');
  assert.ok(iconPatched < dmgCreated, 'the icon must be patched before the DMG is created from it');
  assert.ok(iconPatched < tarCreated, 'the icon must be patched before the updater archive is created from it');
});

test('the DMG and the updater archive are built from the SAME app directory that was patched', () => {
  // Both must reference `appPath` (the one variable the icon patch step also
  // targets), not a second/independent path — that variable identity is what
  // makes "same bytes" true rather than "happens to currently agree".
  const dmgStep = script.slice(script.indexOf('Regenerate the DMG'), script.indexOf('Regenerate the updater'));
  assert.match(dmgStep, /cp['"],\s*\[['"]-R['"],\s*appPath/u, 'the DMG staging copy must come from appPath');

  const tarStep = script.slice(script.indexOf('Regenerate the updater'));
  assert.match(tarStep, /bundleMacos.*['"]Raff\.app['"]/su, 'the tar must be built from the same bundleMacos/Raff.app the icon patch targeted');
});

test('a local build failure (missing updater signing key) does not abort before the icon patch', () => {
  // The known, expected local-only failure (no TAURI_SIGNING_PRIVATE_KEY) must
  // be swallowed so the script reaches the icon patch and DMG/tar
  // regeneration — those are exactly the steps this pipeline exists to run.
  const tauriBuildCall = script.indexOf("run('npm', ['run', 'tauri', 'build']");
  const catchBlock = script.slice(tauriBuildCall, tauriBuildCall + 400);
  assert.match(catchBlock, /catch/u, 'the tauri build step must be wrapped so a local signing failure is not fatal');
});
