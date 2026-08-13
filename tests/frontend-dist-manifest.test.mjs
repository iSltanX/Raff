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
  assert.ok(actual.includes('assets/v4/icons/image.svg'));
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
