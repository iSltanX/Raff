#!/usr/bin/env node
// The in-app update, end to end and isolated: the real updater plugin, driven
// by رفّ's guarded install, replaces a copy of an earlier رفّ with a new
// build (updater.rs, `e2e_the_real_plugin_upgrades_an_earlier_release`).
//
//   node scripts/e2e-upgrade.mjs --old <earlier Raff.app.tar.gz> --app <new Raff.app>
//
// Everything happens in one folder under src-tauri/target/e2e-upgrade: the
// earlier copy is unpacked there, the plugin stages there (TMPDIR), and the
// new build's archive is packed there the way a release packs it. Nothing is
// launched, /Applications and the installed رفّ are not touched, and the
// archive is signed with a throwaway key made for this run — the release key
// is never read. The folder stays, as the record of the run.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeUpdateArchive } from './update-archive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

function arg(name) {
  const at = process.argv.indexOf(name);
  const value = at > 0 ? process.argv[at + 1] : undefined;
  if (!value) {
    console.error(`usage: node scripts/e2e-upgrade.mjs --old <earlier Raff.app.tar.gz> --app <new Raff.app>`);
    process.exit(2);
  }
  return path.resolve(value);
}

const old = arg('--old');
const app = arg('--app');
for (const file of [old, app]) {
  if (!existsSync(file)) {
    console.error(`e2e-upgrade: ${file} is not there`);
    process.exit(2);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const work = path.join(project, 'src-tauri/target/e2e-upgrade', stamp);
const tmp = path.join(work, 'tmp');
mkdirSync(tmp, { recursive: true });

// No signing key from the environment reaches a step of this run.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('TAURI_SIGNING_'))
);
const run = (cmd, args, extra = {}) => {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: project, env, ...extra });
};

// The new build, packed as a release packs it.
const fresh = path.join(work, 'new.app.tar.gz');
makeUpdateArchive({ cwd: path.dirname(app), appName: path.basename(app), out: fresh });
// A package cut short: it verifies (it is signed as it is) and fails to unpack.
const bad = path.join(work, 'bad.app.tar.gz');
const bytes = readFileSync(fresh);
writeFileSync(bad, bytes.subarray(0, Math.floor(bytes.length / 2)));
copyFileSync(old, path.join(work, 'old.app.tar.gz'));

const key = path.join(work, 'throwaway.key');
run('npx', ['tauri', 'signer', 'generate', '--ci', '-p', '', '-w', key]);
for (const file of [fresh, bad]) {
  run('npx', ['tauri', 'signer', 'sign', '-f', key, '-p', '', file]);
}

run(
  'cargo',
  [
    'test',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    'e2e_the_real_plugin_upgrades_an_earlier_release',
    '--',
    '--ignored',
    '--nocapture',
  ],
  {
    env: {
      ...env,
      TMPDIR: `${tmp}/`,
      RAFF_E2E_DIR: work,
      RAFF_E2E_OLD: path.join(work, 'old.app.tar.gz'),
      RAFF_E2E_NEW: fresh,
      RAFF_E2E_BAD: bad,
      RAFF_E2E_PUBKEY: readFileSync(`${key}.pub`, 'utf8').trim(),
    },
  }
);
console.log(`e2e-upgrade: passed; the run is in ${path.relative(project, work)}`);
