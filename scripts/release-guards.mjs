// Checks a release build must pass before anything is packaged or published.
//
// - `checkFreshApp`: the app `tauri build` left behind is the one it just
//   built, not an older bundle a failed build left in place (audit 013 ج1).
//   `build-candidate.mjs` tolerates the build's last step failing locally
//   (the updater signature needs CI's key), so "an app exists" alone could
//   pass a stale one on.
// - `checkReleaseTag`: the release workflow runs from a tag `vX.Y.Z` that
//   names the version every manifest declares (audit 013 ج2). A run from a
//   branch would have tagged the release after the branch.
//
// As a command, for the workflow:
//   node scripts/release-guards.mjs tag <ref_type> <ref_name>

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

/** The version each manifest declares. */
export function declaredVersions(root = project) {
  const json = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  const cargo = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const pkg = cargo.slice(cargo.indexOf('[package]'));
  return {
    'package.json': json('package.json').version,
    'tauri.conf.json': json('src-tauri/tauri.conf.json').version,
    'Cargo.toml': pkg.match(/^version\s*=\s*"([^"]+)"/mu)?.[1],
  };
}

/** `null` when the run may release; otherwise why it may not. */
export function checkReleaseTag({ refType, refName, versions }) {
  const values = Object.values(versions);
  if (values.some((v) => !v) || new Set(values).size !== 1) {
    return `the manifests disagree on the version: ${JSON.stringify(versions)}`;
  }
  if (refType !== 'tag') {
    return `a release runs from a tag, not a ${refType || 'missing ref'} ("${refName}") — run the workflow from the tag v${values[0]}`;
  }
  if (refName !== `v${values[0]}`) {
    return `the tag ${refName} does not name the version ${values[0]} the manifests declare`;
  }
  return null;
}

/** The bundle's own version, as macOS reads it. */
export function bundleVersion(appPath) {
  const plist = path.join(appPath, 'Contents/Info.plist');
  return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], {
    encoding: 'utf8',
  }).trim();
}

/** `null` when `appPath` is the app this build made; otherwise why not. */
export function checkFreshApp({ appPath, startedAt, version }) {
  let executables;
  try {
    const dir = path.join(appPath, 'Contents/MacOS');
    executables = readdirSync(dir).map((name) => statSync(path.join(dir, name)).mtimeMs);
  } catch {
    return `${appPath} has no executable`;
  }
  // A second of slack for file systems that round modification times.
  if (executables.length === 0 || Math.max(...executables) < startedAt - 1000) {
    return `${appPath} predates this build: tauri build failed before bundling, and an older app was left in place`;
  }
  let found;
  try {
    found = bundleVersion(appPath);
  } catch {
    return `${appPath} has no readable version`;
  }
  if (found !== version) {
    return `${appPath} is version ${found}, not ${version}`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [what, refType, refName] = process.argv.slice(2);
  if (what !== 'tag') {
    console.error('usage: node scripts/release-guards.mjs tag <ref_type> <ref_name>');
    process.exit(2);
  }
  const problem = checkReleaseTag({ refType, refName, versions: declaredVersions() });
  if (problem) {
    console.error(`release-guards: ${problem}`);
    process.exit(1);
  }
  console.log(`release-guards: ${refName} matches every manifest`);
}
