import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/panel.css', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/js/panel.js', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');

// tokens.css aliases spacing/size metrics to shared primitives (--metric-*: var(--size-*))
// rather than repeating literals, so a metric's resolved pixel value has to be walked
// through its alias chain instead of matched as text against its own declaration.
function resolveTokenPx(name, source, resolving = new Set()) {
  assert.ok(!resolving.has(name), `${name} must not form an alias cycle`);
  const raw = source.match(new RegExp(`${name}:\\s*([^;]+);`, 'u'))?.[1]?.trim();
  assert.ok(raw, `${name} must be declared`);
  const alias = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/u);
  return alias ? resolveTokenPx(alias[1], source, new Set(resolving).add(name)) : raw;
}

test('feedback stack is tokenized, compact, directional, and never overlays content', () => {
  const feedbackAt = html.indexOf('class="panel-feedback"');
  const footerAt = html.indexOf('class="panel-footer"');
  assert.ok(feedbackAt > 0 && feedbackAt < footerAt, 'feedback is in flow directly above the footer');
  assert.match(css, /\.panel-feedback\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*center;/s);
  assert.match(css, /\.toast\s*\{[^}]*min-height:\s*42px;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s);
  assert.match(css, /\.toast\s*\{[^}]*background:\s*var\(--color-bg-primary\);/s);
  assert.match(css, /\.toast-icon\s*\{[^}]*color:\s*var\(--color-status-success\);/s);
  assert.match(css, /\.toast\[data-kind='delete'\][^{]*\.toast-icon[^}]*color:\s*var\(--color-status-error\);/s);
  assert.doesNotMatch(css.match(/\.toast\s*\{[\s\S]*?\n\}/)?.[0] ?? '', /#[0-9a-f]{3,8}\b/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.toast\s*\{[^}]*animation:\s*none;[^}]*transition:\s*none;/s);
  assert.doesNotMatch(css, /\.panel-feedback\s*\{[^}]*(?:position:\s*(?:fixed|absolute)|z-index)/s);
  assert.match(html, /id="feedback-announcer"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/);
  assert.match(html, /id="toast"[\s\S]*?role="group"/);
  assert.match(panel, /feedbackAnnouncerEl\.textContent = '';[\s\S]*?queueMicrotask/);
  assert.match(panel, /const PIN_TOAST_MS = 3000;/);
  assert.match(panel, /const DELETE_TOAST_MS = 5000;/);
});

test('row action visibility and sizing satisfy mouse, selection, and keyboard focus', () => {
  assert.match(
    css,
    /\.row-actions\s*\{[^}]*gap:\s*var\(--metric-row-actions-gap\);[^}]*width:\s*var\(--metric-row-actions-inline\);/s
  );
  assert.match(
    css,
    /\.row-action\s*\{[^}]*width:\s*var\(--metric-row-action\);[^}]*height:\s*var\(--metric-row-action\);/s
  );
  assert.match(css, /\.row-action \.figma-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/s);
  assert.equal(resolveTokenPx('--metric-row-action', tokens), '32px');
  assert.equal(resolveTokenPx('--metric-row-actions-gap', tokens), '4px');
  assert.equal(resolveTokenPx('--metric-row-actions-inline', tokens), '68px');
  assert.doesNotMatch(css, /\.row-actions\s*\{[^}]*(?:gap:\s*0|width:\s*88px)/s);
  assert.doesNotMatch(css, /\.row-action\s*\{[^}]*(?:width|height):\s*44px/s);
  assert.doesNotMatch(css, /\.row-action[^}]*transform:\s*translateX/s);
  assert.match(css, /\.delete-btn\s*\{\s*opacity:\s*0;/s);
  for (const selector of [
    '.row:hover .delete-btn',
    '.row.selected .delete-btn',
    '.row:focus-within .delete-btn',
    '.delete-btn:focus-visible',
  ]) {
    assert.ok(css.includes(selector), `${selector} reveals the delete action`);
  }
  assert.match(css, /\.row-action:hover::before,[\s\S]*?background:\s*var\(--color-bg-hover\);/s);
  assert.match(css, /\.delete-btn:focus-visible\s*\{[^}]*color:\s*var\(--color-status-error\);/s);
});

test('RTL is the live default while logical layout also mirrors under LTR', () => {
  assert.match(html, /<html\s+lang="ar"\s+dir="rtl">/);
  assert.match(css, /\.panel-feedback\s*\{[^}]*direction:\s*inherit;/s);
  assert.match(css, /padding-inline|padding:\s*var\(--space-xs\)\s+var\(--space-lg\)/);
  assert.match(css, /border-inline-start/);
});

test('feedback semantic roles resolve independently in Light and Dark modes', () => {
  const light = tokens.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const dark = tokens.match(/:root\[data-appearance='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const mode of [light, dark]) {
    assert.match(mode, /--color-bg-primary:\s*var\(--[^)]+\);/);
    assert.match(mode, /--color-border-default:\s*var\(--[^)]+\);/);
    assert.match(mode, /--color-text-primary:\s*var\(--[^)]+\);/);
    assert.match(mode, /--color-text-brand:\s*var\(--[^)]+\);/);
    assert.match(mode, /--color-status-success:\s*var\(--[^)]+\);/);
    assert.match(mode, /--color-status-error:\s*var\(--[^)]+\);/);
  }
  assert.match(css, /\.toast\s*\{[^}]*color:\s*var\(--color-text-primary\);/s);
  assert.match(css, /\.toast-undo\s*\{[^}]*color:\s*var\(--color-text-brand\);/s);
});
