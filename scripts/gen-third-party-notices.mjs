// Writes THIRD-PARTY-NOTICES.md: the copyright and licence text of every Rust
// crate compiled into the binary and of the four font families bundled in the
// window assets, which their licences require to travel with them.
//
//   npm run notices
//
// The shipped crates are the ones reachable from the app through normal (not
// dev, not build-time) dependencies on aarch64-apple-darwin. Their licence files
// are read from the crates' own sources, so nothing here is typed by hand; the
// font copyright lines are read from each font's name table. Identical texts are
// printed once, with the crates that share them. The file records a digest of
// Cargo.lock (without the app's own version line), and a test fails when the
// lock changes and this has not been run again.
//
// Needs the crates' sources in ~/.cargo (any build puts them there); it never
// uses the network.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

/** SHA-256 of Cargo.lock, ignoring the app's own version line: bumping 7.0.0
 *  to 7.0.1 does not change what ships from other people. */
export function lockDigest(lockText) {
  const neutral = lockText.replace(/(name = "raff"\nversion = )"[^"]*"/u, '$1"-"');
  return createHash('sha256').update(neutral).digest('hex');
}

const FONT_FAMILIES = [
  { name: 'Almarai', files: ['Almarai-Bold.ttf', 'Almarai-Regular.ttf'], source: 'https://github.com/googlefonts/almarai' },
  { name: 'Cairo', files: ['Cairo-Bold.ttf', 'Cairo-Medium.ttf', 'Cairo-Regular.ttf', 'Cairo-SemiBold.ttf'], source: 'https://github.com/Gue3bara/Cairo' },
  { name: 'Inter', files: ['Inter-Medium.ttf', 'Inter-Regular.ttf', 'Inter-SemiBold.ttf'], source: 'https://github.com/rsms/inter' },
  { name: 'JetBrains Mono', files: ['JetBrainsMono-Medium.ttf', 'JetBrainsMono-Regular.ttf'], source: 'https://github.com/JetBrains/JetBrainsMono' },
];

/** A name-table string of a TrueType font (1 = family, 0 = copyright, 13 = licence). */
function fontName(file, nameId) {
  const bytes = readFileSync(file);
  const tables = bytes.readUInt16BE(4);
  for (let i = 0; i < tables; i += 1) {
    const at = 12 + i * 16;
    if (bytes.toString('latin1', at, at + 4) !== 'name') continue;
    const table = bytes.readUInt32BE(at + 8);
    const count = bytes.readUInt16BE(table + 2);
    const strings = table + bytes.readUInt16BE(table + 4);
    let found = null;
    for (let r = 0; r < count; r += 1) {
      const rec = table + 6 + r * 12;
      if (bytes.readUInt16BE(rec + 6) !== nameId) continue;
      const [platform, length, offset] = [bytes.readUInt16BE(rec), bytes.readUInt16BE(rec + 8), bytes.readUInt16BE(rec + 10)];
      const raw = bytes.subarray(strings + offset, strings + offset + length);
      const text = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
      if (platform === 3 || found === null) found = text.trim();
      if (platform === 3) break;
    }
    return found;
  }
  return null;
}

function shippedCrates() {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--offline', '--filter-platform', 'aarch64-apple-darwin', '--manifest-path', path.join(project, 'src-tauri/Cargo.toml')], { encoding: 'utf8', maxBuffer: 1 << 29 })
  );
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
  }
  seen.delete(meta.resolve.root);
  return [...seen].map((id) => packages.get(id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const LICENCE_FILE = /^(LICEN[CS]E|COPYING|UNLICENSE|NOTICE|COPYRIGHT)([-_. ].*)?$/iu;

function licenceTexts(pkg) {
  const dir = path.dirname(pkg.manifest_path);
  const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f) && statSync(path.join(dir, f)).isFile() && statSync(path.join(dir, f)).size < 300_000);
  return files.sort().map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/gu, '\n').trim() }));
}

const ELECTION = ['MIT', 'BSD-3-Clause', 'Zlib', 'Apache-2.0', 'MPL-2.0'];

/** The first licence of ELECTION that a crate's SPDX string offers. */
function elected(spdx) {
  const offered = (spdx ?? '').split(/\s+(?:OR|AND)\s+|\//u).map((s) => s.trim().replace(/[()]/gu, ''));
  return ELECTION.find((l) => offered.includes(l)) ?? null;
}

function holder(pkg) {
  const author = (pkg.authors ?? [])[0]?.replace(/\s*<[^>]*>/u, '').trim();
  if (author) return author;
  const repo = (pkg.repository ?? '').split('/').filter(Boolean).pop();
  return `The ${repo ?? pkg.name} authors`;
}

/** Standard texts for crates whose source has none: the body of an MIT or
 *  BSD-3-Clause text already printed for other crates, under the manifest's holder. */
function suppliedTexts(withoutText, groups) {
  const texts = [...groups.keys()];
  const body = (needle, also) => {
    const found = texts.filter((x) => x.includes(needle) && (!also || x.includes(also)) && !/Apache|Mozilla/u.test(x)).sort((p, q) => p.length - q.length)[0];
    return found ? found.slice(found.indexOf(needle)).trim() : null;
  };
  const mit = body('Permission is hereby granted, free of charge');
  const bsd = body('Redistribution and use in source and binary forms', 'Neither the name of');
  const mplGroup = [...groups.entries()].find(([x]) => /Mozilla Public License Version 2\.0/u.test(x))?.[1].crates[0];
  const out = new Map();
  for (const pkg of withoutText) {
    const licence = elected(pkg.license);
    if (!licence) throw new Error(`${pkg.name}: no licence of the election list in "${pkg.license}"`);
    const who = holder(pkg);
    const key = `${licence}|${who}`;
    const entry = out.get(key) ?? { licence, holder: who, crates: [], text: null, pointer: null };
    if (licence === 'MIT' && mit) entry.text = `MIT License\n\nCopyright (c) ${who}\n\n${mit}`;
    else if (licence === 'BSD-3-Clause' && bsd) entry.text = `BSD 3-Clause License\n\nCopyright (c) ${who}\n\n${bsd}`;
    else if (licence === 'MPL-2.0') entry.pointer = mplGroup ? `the text printed for ${mplGroup.name}` : 'see the repository';
    else throw new Error(`${pkg.name}: no standard text to supply for ${licence}`);
    entry.crates.push(pkg);
    out.set(key, entry);
  }
  return [...out.values()].sort((p, q) => p.licence.localeCompare(q.licence) || p.holder.localeCompare(q.holder));
}

export function build() {
  const crates = shippedCrates();
  const groups = new Map(); // text → { texts: [{file}], crates: [] }
  const withoutText = [];
  const bySpdx = {};
  for (const pkg of crates) {
    const spdx = pkg.license ?? 'see repository';
    bySpdx[spdx] = (bySpdx[spdx] ?? 0) + 1;
    const texts = licenceTexts(pkg);
    if (!texts.length) { withoutText.push(pkg); continue; }
    for (const { file, text } of texts) {
      const entry = groups.get(text) ?? { files: new Set(), crates: [] };
      entry.files.add(file);
      if (!entry.crates.includes(pkg)) entry.crates.push(pkg);
      groups.set(text, entry);
    }
  }

  const lines = [];
  const add = (...l) => lines.push(...l);
  add(
    '# Third-party notices · إشعارات الطرف الثالث',
    '',
    'رفّ (Raff) is built from the open-source components below. Each is used under',
    'its own licence, reproduced here as those licences require. رفّ itself is',
    'covered by the notice in README.md.',
    '',
    'يضم رفّ مكوّنات مفتوحة المصدر مذكورة أدناه، لكلٍّ منها ترخيصه ونصه كما يشترط.',
    '',
    `Cargo.lock digest: ${lockDigest(readFileSync(path.join(project, 'src-tauri/Cargo.lock'), 'utf8'))}`,
    `Generated by scripts/gen-third-party-notices.mjs · ${crates.length} Rust crates, ${FONT_FAMILIES.length} font families.`,
    '',
    '## Fonts · الخطوط',
    '',
    'Bundled in the app\'s window assets and licensed under the SIL Open Font License 1.1',
    '(full text below). The copyright lines are read from the font files.',
    ''
  );
  for (const family of FONT_FAMILIES) {
    const copyright = new Set(family.files.map((f) => fontName(path.join(project, 'src/fonts', f), 0)).filter(Boolean));
    add(`### ${family.name}`, '', `Files: ${family.files.join(', ')} · Source: ${family.source}`, '');
    for (const c of copyright) add(`> ${c}`, '');
  }
  add('### SIL Open Font License 1.1', '', '~~~~', readFileSync(path.join(project, 'third-party/OFL-1.1.txt'), 'utf8').replace(/\r\n/gu, '\n').trim(), '~~~~', '');

  add('## Rust crates · مكتبات Rust', '', `Licence counts (SPDX): ${Object.entries(bySpdx).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join('; ')}.`, '');
  const mpl = crates.filter((p) => /MPL-2\.0/u.test(p.license ?? ''));
  add('### Crates', '');
  for (const p of crates) {
    add(`- **${p.name}** ${p.version} — ${p.license ?? 'see repository'}${p.repository ? ` — ${p.repository}` : ''}`);
  }
  add('');
  add('## MPL-2.0 source', '', 'These crates are covered by the Mozilla Public License 2.0. They are used unmodified,', 'and their source code is available from the locations below:', '');
  for (const p of mpl) add(`- ${p.name} ${p.version}: https://crates.io/crates/${p.name}/${p.version}${p.repository ? ` · ${p.repository}` : ''}`);
  add('');
  add('## Licence texts · نصوص التراخيص', '');
  const ordered = [...groups.entries()].sort((a, b) => b[1].crates.length - a[1].crates.length || a[1].crates[0].name.localeCompare(b[1].crates[0].name));
  for (const [text, { files, crates: users }] of ordered) {
    add(`### ${[...files].join(' / ')}`, '', `Applies to: ${users.map((p) => `${p.name} ${p.version}`).join(', ')}`, '', '~~~~', text, '~~~~', '');
  }
  const supplied = suppliedTexts(withoutText, groups);
  if (supplied.length) {
    add(
      '### Supplied texts · نصوص مُكمَّلة',
      '',
      'These crates declare their licence but their published source carries no licence file.',
      'The standard text of the licence each one declares is given instead (where a crate offers',
      'a choice, the first of MIT, BSD-3-Clause, Zlib, Apache-2.0, MPL-2.0 it lists), with the',
      'copyright holder named in the crate\'s own manifest. They are not copies of a file from the crate.',
      ''
    );
    for (const s of supplied) {
      add(`#### ${s.licence} · ${s.holder}`, '', `Applies to: ${s.crates.map((p) => `${p.name} ${p.version}`).join(', ')}`, '');
      if (s.text) add('~~~~', s.text, '~~~~', '');
      else add(`The full text is the Mozilla Public License 2.0 given above (${s.pointer}).`, '');
    }
  }
  return { text: `${lines.join('\n')}\n`, crates: crates.length, texts: groups.size, supplied: supplied.map((s) => `${s.licence}: ${s.crates.length}`), withoutText: withoutText.map((p) => `${p.name} ${p.version}`) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { text, crates, texts, supplied, withoutText } = build();
  writeFileSync(path.join(project, 'THIRD-PARTY-NOTICES.md'), text);
  console.log(`THIRD-PARTY-NOTICES.md: ${crates} crates, ${texts} distinct licence texts, ${(text.length / 1024).toFixed(0)} KB`);
  if (withoutText.length) console.log(`supplied from the declared licence (${withoutText.length} crates): ${supplied.join('; ')}`);
}
