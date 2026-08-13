import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (relativePath) => readFileSync(path.join(project, relativePath), 'utf8');

test('About keeps the approved compact RTL identity header', () => {
  const html = read('src/about.html');
  const css = read('src/about.css');
  const js = read('src/js/about.js');
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const row = document.querySelector('.identity-row');
  assert.ok(row, 'the About identity is one compact vertical group');
  assert.deepEqual(
    [...row.children].map((child) => child.className),
    ['logo-graphic', 'app-version'],
    'Version stays directly beneath the canonical app icon'
  );

  const logo = row.querySelector('.logo-graphic');
  assert.equal(row.querySelector('.app-version').tagName, 'P');
  assert.equal(logo.getAttribute('src'), 'assets/app-icon.png');
  assert.equal(logo.getAttribute('width'), '80');
  assert.equal(logo.getAttribute('height'), '80');
  assert.equal(document.querySelector('.author').textContent, 'تطوير وتصميم سلطان');
  assert.equal(document.querySelector('.tagline'), null, 'the old long description is removed');

  assert.match(css, /\.identity-row\s*\{[\s\S]*?flex-direction:\s*column;/u);
  assert.match(css, /\.identity-row\s*\{[\s\S]*?gap:\s*var\(--space-md\);/u);
  assert.match(css, /\.app-version\s*\{[\s\S]*?font-family:\s*var\(--font-latin\);/u);
  assert.match(css, /\.app-version\s*\{[\s\S]*?font-size:\s*var\(--text-caption\);/u);
  assert.match(css, /\.author\s*\{[\s\S]*?font-family:\s*var\(--font-ar\);/u);
  assert.match(css, /\.author\s*\{[\s\S]*?color:\s*var\(--color-text-secondary\);/u);
  assert.match(css, /\.author\s*\{[\s\S]*?font-weight:\s*(?:400|500);/u);
  assert.match(js, /versionEl\.textContent\s*=\s*`Version \$\{version\}`;/u);
  assert.doesNotMatch(js, /\(الإصدار/u);
  assert.match(css, /\.actions-bottom\s*\{[\s\S]*?margin-top:\s*var\(--space-4xl\);/u);
  assert.match(
    css,
    /\.about\.has-status\s+\.actions-bottom\s*\{[\s\S]*?margin-top:\s*var\(--space-xl\);/u,
    'the transient status state compacts with an approved spacing token'
  );
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('About applies status compaction only while feedback is visible', async () => {
  const dom = new JSDOM(read('src/about.html'), { url: 'http://localhost/about.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  let resolveCheck;
  const pendingCheck = new Promise((resolve) => {
    resolveCheck = resolve;
  });
  dom.window.__TAURI__ = {
    core: {
      invoke(command) {
        if (command === 'get_state') return Promise.resolve({ version: '4.0.0' });
        if (command === 'check_for_update') return pendingCheck;
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
    window: {
      getCurrentWindow: () => ({ close: () => Promise.resolve() }),
    },
  };

  await import('../src/js/about.js?about-status-layout');
  await flush();

  const shell = dom.window.document.getElementById('about');
  const status = dom.window.document.getElementById('update-status');
  const button = dom.window.document.getElementById('update-btn');

  assert.equal(status.hidden, true, 'the resting design retains its original hidden-status rhythm');
  assert.equal(shell.classList.contains('has-status'), false);

  button.click();
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'جارٍ التحقق…');
  assert.equal(shell.classList.contains('has-status'), true);

  resolveCheck({ status: 'upToDate' });
  await flush();
  assert.equal(status.textContent, 'أنت على أحدث إصدار من رفّ.');
  assert.equal(shell.classList.contains('has-status'), true);
});
