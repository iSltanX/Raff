import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const dist = path.join(project, 'dist');

function filesUnder(dir, relative = '') {
  return readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(dir, child) : [child];
  });
}

test('frontend distribution contains exactly the production allowlist', () => {
  execFileSync(process.execPath, ['scripts/build-frontend.mjs'], {
    cwd: project,
    stdio: 'pipe',
  });

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
