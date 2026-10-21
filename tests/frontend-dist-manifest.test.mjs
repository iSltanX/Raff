import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const projectDist = path.join(project, 'dist');

// The suite builds into a directory of its own: `dist/` is what `tauri build`
// packages, and a test run must not delete or rewrite it (audit 025).
function buildInto(t) {
  const dist = mkdtempSync(path.join(tmpdir(), 'raff-dist-'));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  execFileSync(process.execPath, ['scripts/build-frontend.mjs', `--out=${dist}`], {
    cwd: project,
    stdio: 'pipe',
  });
  return dist;
}

/** What `dist/` is right now: absent, or its manifest's identity and bytes. */
function projectDistSnapshot() {
  const manifest = path.join(projectDist, 'asset-manifest.json');
  if (!existsSync(manifest)) return { exists: existsSync(projectDist) };
  const { ino, mtimeMs } = statSync(manifest);
  return { exists: true, ino, mtimeMs, bytes: readFileSync(manifest, 'utf8') };
}

function filesUnder(dir, relative = '') {
  return readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(dir, child) : [child];
  });
}

test('frontend distribution contains exactly the production allowlist', (t) => {
  const dist = buildInto(t);

  const manifest = JSON.parse(readFileSync(path.join(dist, 'asset-manifest.json'), 'utf8'));
  const actual = filesUnder(dist)
    .filter((file) => file !== 'asset-manifest.json')
    .sort();

  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(actual, manifest.files);
  assert.ok(actual.includes('index.html'));
  assert.ok(actual.includes('assets/icons/image.svg'));
  assert.ok(actual.includes('fonts/Cairo-Regular.ttf'));

  for (const file of actual) {
    assert.doesNotMatch(file, /(?:^|\/)\.DS_Store$/u);
    assert.doesNotMatch(file, /(?:^|\/)mock\.js$/u);
    assert.doesNotMatch(
      file,
      /(?:-figma(?:@\d+x)?\.(?:png|svg)$|empty-shelf-product|showcase|design-review)/iu
    );
  }
});

test('a test build leaves the project dist/ exactly as it was', (t) => {
  const before = projectDistSnapshot();
  buildInto(t);
  assert.deepEqual(projectDistSnapshot(), before);
});

test('the build refuses an output directory that already holds files', (t) => {
  // It writes into the directory and never empties it: a mistyped path must
  // not become a deletion.
  const occupied = mkdtempSync(path.join(tmpdir(), 'raff-dist-occupied-'));
  t.after(() => rmSync(occupied, { recursive: true, force: true }));
  writeFileSync(path.join(occupied, 'keep.txt'), 'mine');

  assert.throws(() =>
    execFileSync(process.execPath, ['scripts/build-frontend.mjs', `--out=${occupied}`], {
      cwd: project,
      stdio: 'pipe',
    })
  );
  assert.deepEqual(readdirSync(occupied), ['keep.txt']);
  assert.equal(readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'mine');
});

test('an argument the build does not understand stops it before dist/ is touched', () => {
  const before = projectDistSnapshot();
  for (const args of [['--out', tmpdir()], ['--out'], ['--outdir=x']]) {
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/build-frontend.mjs', ...args], { cwd: project, stdio: 'pipe' }),
      undefined,
      args.join(' ')
    );
  }
  assert.deepEqual(projectDistSnapshot(), before);
});

test('Tauri packages the generated frontend instead of the design source tree', () => {
  const config = JSON.parse(readFileSync(path.join(project, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.build.beforeBuildCommand, 'npm run build:frontend');
  assert.equal(config.build.frontendDist, '../dist');

  const store = readFileSync(path.join(project, 'src/js/store.js'), 'utf8');
  assert.doesNotMatch(store, /^import\s+\{\s*mockInvoke\s*\}/mu);
  assert.match(store, /await import\('\.\/mock\.js'\)/u);
});

test('every asset the pages reference ships in the bundle', async () => {
  // A mask or image missing from the allowlist renders as a blank square in
  // the packaged app while the browser preview (which serves src/) looks fine.
  const { readFileSync, readdirSync } = await import('node:fs');
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const build = readFileSync(path.join(source, '../scripts/build-frontend.mjs'), 'utf8');
  const shipped = new Set([...build.matchAll(/^\s+'([^']+)',$/gmu)].map((m) => m[1]));
  const files = [
    ...readdirSync(source).filter((f) => /\.(css|html)$/u.test(f)),
    ...readdirSync(path.join(source, 'js')).filter((f) => f !== 'mock.js').map((f) => `js/${f}`),
  ];
  for (const file of files) {
    const text = readFileSync(path.join(source, file), 'utf8');
    for (const [, ref] of text.matchAll(/(?:url\(['"]?|src="|asset\(')((?:\.\.\/)?assets\/[A-Za-z0-9/_.-]+?)(?:\.svg|\.png)?['")]/gu)) {
      const normalized = ref.replace(/^\.\.\//u, '');
      const candidates = /\.(svg|png)$/u.test(normalized) ? [normalized] : [`${normalized}.svg`, `${normalized}.png`];
      assert.ok(candidates.some((c) => shipped.has(c)), `${file} → ${normalized} is not in the production allowlist`);
    }
  }
});
