// The updater unpacks Raff.app.tar.gz entry by entry, dropping the first path
// component of each (tauri-plugin-updater, install_inner). An entry that is not
// under Raff.app/ — in particular the AppleDouble file `._Raff.app` that macOS's
// own `tar` writes for files carrying extended attributes — ends up unpacked
// onto the extraction folder itself and the whole install fails with «تعذّر
// تنزيل التحديث أو تثبيته». v7.0.0 shipped exactly that (macOS tags every file
// this Mac builds with com.apple.provenance), so the archive is made by one
// helper that keeps metadata out, and checked here the way the updater reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { archiveEntries, makeUpdateArchive, assertUpdaterReadable } from '../scripts/update-archive.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const onMac = process.platform === 'darwin';

/** A bundle directory whose files carry an extended attribute, like this Mac's builds. */
function bundleWithXattrs() {
  const dir = mkdtempSync(path.join(tmpdir(), 'raff-archive-'));
  mkdirSync(path.join(dir, 'Raff.app/Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(dir, 'Raff.app/Contents/_CodeSignature'), { recursive: true });
  for (const f of ['Raff.app/Contents/Info.plist', 'Raff.app/Contents/MacOS/raff', 'Raff.app/Contents/_CodeSignature/CodeResources']) {
    writeFileSync(path.join(dir, f), 'x');
    execFileSync('xattr', ['-w', 'com.apple.provenance', 'x', path.join(dir, f)]);
  }
  return dir;
}

test('plain tar on a bundle with extended attributes does write AppleDouble entries (the failure this guards)', { skip: !onMac }, () => {
  const dir = bundleWithXattrs();
  try {
    const out = path.join(dir, 'plain.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', dir, 'Raff.app']);
    assert.ok(archiveEntries(out).some((n) => path.basename(n).startsWith('._')), 'the setup reproduces the bug');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the update archive has only Raff.app entries, no metadata files', { skip: !onMac }, () => {
  const dir = bundleWithXattrs();
  try {
    const out = path.join(dir, 'Raff.app.tar.gz');
    makeUpdateArchive({ cwd: dir, appName: 'Raff.app', out });
    const names = archiveEntries(out);
    assert.ok(names.includes('Raff.app/Contents/Info.plist') && names.includes('Raff.app/Contents/MacOS/raff'), 'the bundle is in it');
    assert.deepEqual(names.filter((n) => path.basename(n).startsWith('._')), [], 'no AppleDouble entry');
    assert.ok(names.every((n) => n === 'Raff.app' || n.startsWith('Raff.app/')), 'every entry is under Raff.app/');
    assertUpdaterReadable(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertUpdaterReadable refuses an archive the updater cannot unpack', { skip: !onMac }, () => {
  const dir = bundleWithXattrs();
  try {
    const out = path.join(dir, 'plain.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', dir, 'Raff.app']);
    assert.throws(() => assertUpdaterReadable(out), /\._/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both release paths build the archive with the helper, never with a bare tar', () => {
  for (const file of ['scripts/build-candidate.mjs', 'scripts/ci-fix-release-icon.mjs']) {
    const script = readFileSync(path.join(root, file), 'utf8');
    assert.match(script, /import \{[^}]*makeUpdateArchive[^}]*\} from '\.\/update-archive\.mjs';/u, `${file} imports the helper`);
    assert.doesNotMatch(script, /run\('tar',\s*\['-czf'/u, `${file} no longer calls tar -czf directly`);
  }
});
