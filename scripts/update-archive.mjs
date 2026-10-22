// Builds Raff.app.tar.gz, the archive the in-app updater downloads, and checks
// it the way the updater reads it.
//
// tauri-plugin-updater (macOS) unpacks the archive entry by entry into a fresh
// folder, dropping the first path component of each entry. Every entry must
// therefore live under `Raff.app/`: an entry that does not — above all the
// AppleDouble file `._Raff.app` that macOS's `tar` writes for any file that has
// extended attributes, which this Mac puts on everything it builds
// (com.apple.provenance) — is unpacked onto the extraction folder itself, and
// the whole install fails. v7.0.0 was first published that way. macOS's own
// `tar -t` cannot be used to check it: it folds those files into the entries
// they belong to and does not list them. So the names are read here from the
// tar headers.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Packs `appName` (a .app directory inside `cwd`) into `out`, without macOS
 *  metadata: COPYFILE_DISABLE stops AppleDouble files, --no-xattrs the
 *  attributes they would carry. */
export function makeUpdateArchive({ cwd, appName, out }) {
  if (existsSync(out)) rmSync(out, { force: true });
  console.log(`+ tar --no-xattrs -czf ${out} -C ${cwd} ${appName}  (COPYFILE_DISABLE=1)`);
  execFileSync('tar', ['--no-xattrs', '-czf', out, '-C', cwd, appName], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  assertUpdaterReadable(out, appName);
}

/** Every entry name of a .tar.gz, read from the tar headers (ustar prefix, PAX
 *  `path` records and GNU long names included). */
export function archiveEntries(file) {
  const tar = gunzipSync(readFileSync(file));
  const names = [];
  let pending = null;
  const text = (from, to) => tar.toString('utf8', from, to).replace(/\0.*$/su, '');
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(text(at + 124, at + 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === 'x') {
      const record = body.toString('utf8').match(/\d+ path=([^\n]+)\n/u);
      if (record) pending = record[1];
    } else if (type === 'L') {
      pending = body.toString('utf8').replace(/\0.*$/su, '');
    } else if (type !== 'g') {
      const prefix = text(at + 345, at + 500);
      const name = pending ?? (prefix ? `${prefix}/${text(at, at + 100)}` : text(at, at + 100));
      names.push(name.replace(/\/$/u, ''));
      pending = null;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

/** Throws unless the updater can unpack the archive: everything under `appName/`,
 *  and no `._` metadata entry anywhere. */
export function assertUpdaterReadable(file, appName = 'Raff.app') {
  const names = archiveEntries(file);
  const metadata = names.filter((n) => path.basename(n).startsWith('._'));
  if (metadata.length) throw new Error(`${file}: ${metadata.length} macOS metadata entries the updater cannot unpack, e.g. ${metadata[0]}`);
  const stray = names.filter((n) => n !== appName && !n.startsWith(`${appName}/`));
  if (stray.length) throw new Error(`${file}: entries outside ${appName}/, e.g. ${stray[0]}`);
  if (!names.some((n) => n === `${appName}/Contents/Info.plist`)) throw new Error(`${file}: no ${appName}/Contents/Info.plist`);
  return names.length;
}
