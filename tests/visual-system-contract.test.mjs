// Static production contracts for Raff's real-world v4 visual-quality pass.
// These checks deliberately avoid jsdom/a layout engine: they keep native
// window geometry, semantic theme roles, and the design-review fixture in sync
// while allowing component CSS to evolve without screenshot-test brittleness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { mockInvoke } from '../src/js/mock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');

function read(relativePath) {
  return readFileSync(path.join(project, relativePath), 'utf8');
}

function rustNumber(source, name) {
  const match = source.match(
    new RegExp(`\\bconst\\s+${name}\\s*:\\s*f64\\s*=\\s*(\\d+(?:\\.\\d+)?)`)
  );
  assert.ok(match, `Rust must declare ${name} as an f64 constant`);
  return Number(match[1]);
}

function rustWindowSize(source, page) {
  const pageMarker = `"${page}"`;
  const pageIndex = source.indexOf(pageMarker);
  assert.notEqual(pageIndex, -1, `Rust must open ${page}`);

  // The dimensions are the first numeric tuple after the page argument. The
  // bounded slice prevents a missing tuple from accidentally matching a later
  // window builder.
  const nearbyCall = source.slice(pageIndex + pageMarker.length, pageIndex + 900);
  const size = nearbyCall.match(/\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/);
  assert.ok(size, `Rust must give ${page} an explicit numeric window size`);
  return { width: Number(size[1]), height: Number(size[2]) };
}

function cssRuleBody(source, selectorPattern, description) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = selectorPattern.exec(withoutComments);
  assert.ok(match, `${description} token block must exist`);

  const openBrace = withoutComments.indexOf('{', match.index);
  let depth = 1;
  for (let index = openBrace + 1; index < withoutComments.length; index += 1) {
    if (withoutComments[index] === '{') depth += 1;
    if (withoutComments[index] === '}') depth -= 1;
    if (depth === 0) return withoutComments.slice(openBrace + 1, index);
  }
  assert.fail(`${description} token block must have a closing brace`);
}

function cssCustomProperties(ruleBody) {
  const properties = new Map();
  for (const match of ruleBody.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    properties.set(match[1], match[2].trim());
  }
  return properties;
}

function resolveCustomProperty(name, properties, resolving = new Set()) {
  assert.ok(properties.has(name), `${name} must be declared`);
  assert.ok(!resolving.has(name), `${name} must not form a custom-property cycle`);

  const nextResolving = new Set(resolving).add(name);
  return properties.get(name).replace(/var\(\s*(--[\w-]+)(?:\s*,[^)]*)?\s*\)/g, (_, reference) =>
    resolveCustomProperty(reference, properties, nextResolving)
  );
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    assert.match(hex, /^#[\da-f]{6}$/iu, `expected a resolved six-digit colour, received ${hex}`);
    const channels = hex
      .slice(1)
      .match(/.{2}/gu)
      .map((value) => Number.parseInt(value, 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('production window geometry matches the refined desktop composition', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const panelWindows = config.app?.windows?.filter((window) => window.label === 'panel') ?? [];
  assert.equal(panelWindows.length, 1, 'tauri.conf.json must define exactly one panel window');

  const [panel] = panelWindows;
  assert.deepEqual(
    { width: panel.width, height: panel.height },
    { width: 560, height: 640 },
    'the main panel must have enough physical presence for scannable clipboard rows'
  );

  const panelRust = read('src-tauri/src/panel.rs');
  assert.equal(rustNumber(panelRust, 'PANEL_WIDTH'), 560);
  assert.equal(rustNumber(panelRust, 'PANEL_HEIGHT'), 640);
  assert.equal(
    rustNumber(panelRust, 'PANEL_WIDTH'),
    panel.width,
    'Rust cursor-screen centering must use the configured panel width'
  );
  assert.equal(
    rustNumber(panelRust, 'PANEL_HEIGHT'),
    panel.height,
    'Rust placement fallback must use the configured panel height'
  );
  assert.equal(panel.resizable, false, 'the draggable panel remains fixed-size');
  assert.match(
    read('src/index.html'),
    /<header\b[^>]*class="panel-header"[^>]*id="panel-header"/u,
    'the panel exposes one explicit header drag surface'
  );
  const panelJs = read('src/js/panel.js');
  assert.match(panelJs, /panelHeaderEl\.addEventListener\('mousedown'/u);
  assert.match(panelJs, /event\.target\.closest\('button, input, select, textarea, a'\)/u);
  assert.match(panelJs, /\.startDragging\(\)/u);
  assert.match(panelRust, /panel_delegate!\(RaffPanelDelegate\s*\{[\s\S]*window_did_move/u);
  assert.match(panelRust, /"window_did_move"\s*=>\s*remember_position/u);
  const chromeCapability = JSON.parse(read('src-tauri/capabilities/chrome.json'));
  assert.ok(!chromeCapability.windows.includes('panel'), 'the panel must not inherit window-close');
  const panelCapability = JSON.parse(read('src-tauri/capabilities/panel-drag.json'));
  assert.deepEqual(panelCapability.windows, ['panel']);
  assert.deepEqual(
    panelCapability.permissions,
    ['core:window:allow-start-dragging'],
    'the panel may drag, but may neither close nor resize itself'
  );

  const commandsRust = read('src-tauri/src/commands.rs');
  assert.deepEqual(
    rustWindowSize(commandsRust, 'settings.html'),
    { width: 600, height: 520 },
    'Settings stays compact because its five independent pages never stack vertically'
  );
  assert.deepEqual(
    rustWindowSize(commandsRust, 'about.html'),
    { width: 360, height: 400 },
    'About retains Figma height and removes the former dead lower band'
  );
});

test('light and dark themes expose the semantic production surface roles', () => {
  const tokens = read('src/tokens.css');
  const light = cssCustomProperties(cssRuleBody(tokens, /:root\s*\{/, 'light'));
  const dark = cssCustomProperties(
    cssRuleBody(
      tokens,
      /:root\s*\[\s*data-appearance\s*=\s*(['"])dark\1\s*\]\s*\{/,
      'dark'
    )
  );
  const semanticSurfaceRoles = [
    '--color-bg-elevated',
    '--color-bg-row',
    '--color-bg-hover',
    '--color-bg-control',
  ];

  for (const role of semanticSurfaceRoles) {
    assert.ok(light.has(role), `${role} must be defined for Light appearance`);
    assert.ok(dark.has(role), `${role} must be intentionally defined for Dark appearance`);
  }
});

test('dark core surfaces do not regress to the legacy large brown palette', () => {
  const tokens = read('src/tokens.css');
  const light = cssCustomProperties(cssRuleBody(tokens, /:root\s*\{/, 'light'));
  const dark = cssCustomProperties(
    cssRuleBody(
      tokens,
      /:root\s*\[\s*data-appearance\s*=\s*(['"])dark\1\s*\]\s*\{/,
      'dark'
    )
  );
  // Dark declarations override the shared/light primitives when resolving an
  // alias such as `var(--color-bg-secondary)`.
  const darkScope = new Map([...light, ...dark]);
  const coreSurfaceRoles = [
    '--color-bg-primary',
    '--color-bg-secondary',
    '--color-bg-selected',
    '--color-bg-field',
    '--color-bg-elevated',
    '--color-bg-row',
    '--color-bg-hover',
    '--color-bg-control',
  ];
  const legacyBrown = /#(?:2a2420|1e1a17|342d26)\b/i;

  for (const role of coreSurfaceRoles) {
    const resolved = resolveCustomProperty(role, darkScope);
    assert.doesNotMatch(
      resolved,
      legacyBrown,
      `${role} must use the calmer neutral Dark palette, not an old brown surface`
    );
  }
});

test('small semantic text retains AA contrast in both appearances', () => {
  const tokens = read('src/tokens.css');
  const light = cssCustomProperties(cssRuleBody(tokens, /:root\s*\{/, 'light'));
  const dark = cssCustomProperties(
    cssRuleBody(
      tokens,
      /:root\s*\[\s*data-appearance\s*=\s*(['"])dark\1\s*\]\s*\{/,
      'dark'
    )
  );
  const scopes = [
    ['Light', light],
    ['Dark', new Map([...light, ...dark])],
  ];
  const textRoles = [
    '--color-text-primary',
    '--color-text-secondary',
    '--color-text-tertiary',
    '--color-text-brand',
  ];

  for (const [appearance, scope] of scopes) {
    const canvas = resolveCustomProperty('--color-bg-secondary', scope);
    for (const role of textRoles) {
      const text = resolveCustomProperty(role, scope);
      assert.ok(
        contrastRatio(text, canvas) >= 4.5,
        `${appearance} ${role} must remain legible at the 11–14px production sizes`
      );
    }
  }
});

test('design-review mock exercises realistic multilingual clipboard geometry', async () => {
  const state = await mockInvoke('get_state');
  const items = [...state.pinned, ...state.history];
  const hasArabic = (value) => /[\u0600-\u06ff]/u.test(value);
  const hasLatin = (value) => /[a-z]/iu.test(value);

  assert.ok(items.some((item) => hasArabic(item.text) && !hasLatin(item.text)), 'Arabic case');
  assert.ok(
    items.some(
      (item) => ['text', 'code'].includes(item.type) && !hasArabic(item.text) && hasLatin(item.text)
    ),
    'English text/code case'
  );
  assert.ok(
    items.some((item) => hasArabic(item.text) && hasLatin(item.text)),
    'mixed Arabic/English case'
  );
  assert.ok(
    items.some((item) => item.type === 'link' && /^https?:\/\//u.test(item.text) && item.text.length >= 80),
    'long URL case'
  );
  assert.ok(items.some((item) => item.type === 'image' && item.hasImage === true), 'image case');
  assert.ok(items.some((item) => item.isPinned === true), 'pinned case');
});

test('source app icons use the compact single-identifier well', () => {
  const panelCss = read('src/panel.css');
  const tokens = read('src/tokens.css');
  const light = cssCustomProperties(cssRuleBody(tokens, /:root\s*\{/, 'light'));

  assert.match(panelCss, /\.source-icon\s*\{[\s\S]*border-radius:\s*var\(--radius-control\)/u);
  assert.match(panelCss, /background:\s*var\(--color-source-icon-well\)/u);
  assert.match(panelCss, /color:\s*var\(--color-interactive-primary\)/u);
  assert.match(tokens, /--metric-icon-chip:\s*24px/u);
  assert.match(tokens, /--size-30:\s*30px/u);
  assert.match(tokens, /--size-20:\s*20px/u);
  assert.match(tokens, /--metric-source-slot-inline:\s*var\(--size-30\)/u);
  assert.match(tokens, /--metric-source-glyph:\s*var\(--size-20\)/u);
  assert.equal(
    resolveCustomProperty('--color-source-icon-well', light),
    '#f6f5f2',
    'the semantic role resolves through the approved Figma primitive alias'
  );
});
