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
  assert.match(css, /\.toast\s*\{[^}]*background:\s*var\(--color-bg-elevated\);/s);
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

  /* Delete's Figma master (COMPONENT_SET "Feedback / Toast" 74:476) binds a
     TEXT-role variable, color/text/primary, as its BACKGROUND fill — an
     opaque near-black pill in Light, the exact "large dark capsule" defect
     reported against production. Locking both halves of the fix: the
     container never becomes a filled destructive block (kind is carried by
     a thin stroke, checked below, and the icon, checked above)... */
  assert.doesNotMatch(
    css,
    /\.toast\[data-kind='delete'\]\s*\{[^}]*background/s,
    'Delete must never repaint the toast surface — kind lives in the stroke and icon only'
  );
  /* ...and the wrapper band around it is gone, so nothing except the pill
     itself can carry that kind of weight. */
  assert.doesNotMatch(
    css,
    /\.panel-feedback\s*\{[^}]*(?:background|border-top)/s,
    'the feedback wrapper must carry no surface of its own — Figma floats the pill on the bare canvas ("Toast Slot / Reserved Above Toolbar"), not on a coloured band'
  );

  /* Kind is legible from a hairline, matching Figma's own per-variant stroke
     bindings (Success/Error → status colours, Pin/Unpin → a neutral border)
     — restrained colour, never restated as a fill. */
  assert.match(css, /\.toast\s*\{[^}]*border:\s*1px solid var\(--color-status-success\);/s);
  assert.match(
    css,
    /\.toast\[data-kind='pin'\],\s*\n\.toast\[data-kind='unpin'\]\s*\{[^}]*border-color:\s*var\(--color-border-default\);/s
  );
  assert.match(
    css,
    /\.toast\[data-kind='delete'\],\s*\n\.toast\[data-kind='error'\]\s*\{[^}]*border-color:\s*var\(--color-status-error\);/s
  );

  /* The floating pill needs its own definition now that its wrapper paints
     nothing — Figma's own DROP_SHADOW (radius 6, 8% black, offset 0/6) is
     exactly --elev-2. */
  assert.match(css, /\.toast\s*\{[^}]*box-shadow:\s*var\(--elev-2\);/s);

  /* Undo is a coloured word, not a button nested inside the pill — no
     border, transparent at rest, and hidden with opacity/hidden rather than
     just going borderless-but-still-boxed. */
  assert.match(css, /\.toast-undo\s*\{[^}]*border:\s*0;/s);
  assert.doesNotMatch(css, /\.toast-undo\s*\{[^}]*border:\s*1px solid/s);
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

  /* v4.1 moved reveal from each button onto the cluster, so the two controls
     and the fade behind them can never appear out of step with each other.
     The behaviour being protected is unchanged: hidden at rest, revealed by
     hover, selection, or keyboard focus — and hidden with OPACITY, never
     display/visibility, so the buttons stay in the tab order and
     `:focus-within` has something to fire on. */
  assert.match(css, /\.row-actions\s*\{[^}]*opacity:\s*0;[^}]*\}/s);
  assert.doesNotMatch(css, /\.row-actions\s*\{[^}]*(?:display:\s*none|visibility:\s*hidden)/s);
  assert.doesNotMatch(css, /\.delete-btn\s*\{\s*opacity:\s*0;/s, 'reveal is owned by the cluster');
  for (const selector of [
    '.row:hover .row-actions',
    '.row.selected .row-actions',
    '.row:focus-within .row-actions',
  ]) {
    assert.ok(css.includes(selector), `${selector} reveals the action cluster`);
  }
  assert.match(
    css,
    /\.row:hover \.row-actions,[\s\S]*?\.row:focus-within \.row-actions\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    'a revealed cluster must also become clickable'
  );

  /* Resting emphasis is deliberately subordinate — tertiary ink, no fill —
     and the hover well is the shared subtle fill, not a surface token that
     would fight whatever state the row is currently painted in. */
  assert.match(
    css,
    /\.row-action:hover::before,[\s\S]*?background:\s*var\(--color-fill-subtle\);/s
  );
  assert.match(css, /\.row-action\s*\{[^}]*color:\s*var\(--color-text-tertiary\);/s);
  assert.match(
    css,
    /\.delete-btn:hover,\s*\n\.delete-btn:focus-visible\s*\{[^}]*color:\s*var\(--color-status-error\);/s,
    'destructive weight is earned on approach, by pointer or by keyboard'
  );
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
