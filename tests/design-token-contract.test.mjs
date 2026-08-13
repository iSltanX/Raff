import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (relativePath) => readFileSync(path.join(project, relativePath), 'utf8');

function cssRuleBody(source, selectorPattern, description) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const match = selectorPattern.exec(withoutComments);
  assert.ok(match, `${description} token block must exist`);
  const openBrace = withoutComments.indexOf('{', match.index);
  let depth = 1;
  for (let index = openBrace + 1; index < withoutComments.length; index += 1) {
    if (withoutComments[index] === '{') depth += 1;
    if (withoutComments[index] === '}') depth -= 1;
    if (depth === 0) return withoutComments.slice(openBrace + 1, index);
  }
  assert.fail(`${description} token block must close`);
}

function customProperties(body) {
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/gu)].map((match) => [
      match[1],
      match[2].trim().toLowerCase(),
    ])
  );
}

function resolve(name, properties, resolving = new Set()) {
  assert.ok(properties.has(name), `${name} must be declared`);
  assert.ok(!resolving.has(name), `${name} must not form an alias cycle`);
  const next = new Set(resolving).add(name);
  return properties
    .get(name)
    .replace(/var\(\s*(--[\w-]+)(?:\s*,[^)]*)?\s*\)/gu, (_, reference) =>
      resolve(reference, properties, next)
    );
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    assert.match(hex, /^#[\da-f]{6}$/u);
    const channels = hex
      .slice(1)
      .match(/.{2}/gu)
      .map((part) => Number.parseInt(part, 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      );
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const primitives = {
  '--terracotta-50': '#fdf5f0',
  '--terracotta-75': '#fbede5',
  '--terracotta-100': '#f9e6da',
  '--terracotta-200': '#f0c9b0',
  '--terracotta-300': '#e4a882',
  '--terracotta-400': '#d4855a',
  '--terracotta-500': '#c4704b',
  '--terracotta-600': '#a85a3a',
  '--terracotta-700': '#8a452d',
  '--terracotta-800': '#6c3522',
  '--terracotta-900': '#4e2619',
  '--terracotta-950': '#2e160e',
  '--terracotta-app-icon-end': '#a35634',
  '--terracotta-app-icon-dark-bg-start': '#2a2018',
  '--terracotta-app-icon-dark-bg-end': '#1b140f',
  '--terracotta-app-icon-mark-dark': '#f5ede5',
  '--stone-0': '#ffffff',
  '--stone-25': '#fcfbf9',
  '--stone-40': '#fbfaf7',
  '--stone-50': '#faf8f6',
  '--stone-60': '#f7f5f1',
  '--stone-70': '#f6f5f2',
  '--stone-80': '#f5f0ea',
  '--stone-90': '#f1ede7',
  '--stone-100': '#f2efeb',
  '--stone-150': '#eae5df',
  '--stone-175': '#ebe6df',
  '--stone-200': '#e0dad2',
  '--stone-225': '#ded8d0',
  '--stone-300': '#cec5ba',
  '--stone-400': '#b0a596',
  '--stone-500': '#8f8275',
  '--stone-550': '#766d65',
  '--stone-600': '#6b6054',
  '--stone-700': '#4d443a',
  '--stone-725': '#4a382b',
  '--stone-800': '#342d26',
  '--stone-850': '#2a2420',
  '--stone-900': '#1e1a17',
  '--stone-950': '#110f0d',
  '--graphite-50': '#f4f2ef',
  '--graphite-300': '#b9b4ae',
  '--graphite-400': '#98928b',
  '--graphite-600': '#3a3b3f',
  '--graphite-650': '#303136',
  '--graphite-700': '#292a2e',
  '--graphite-750': '#27282c',
  '--graphite-800': '#222326',
  '--graphite-825': '#202125',
  '--graphite-850': '#202124',
  '--graphite-875': '#1d1e21',
  '--graphite-900': '#17181a',
  '--warm-dark-selected': '#30251f',
  '--indigo-50': '#f0f1f8',
  '--indigo-100': '#dddff0',
  '--indigo-200': '#b8bce1',
  '--indigo-300': '#8e94ce',
  '--indigo-400': '#6a72bb',
  '--indigo-500': '#4e56a0',
  '--indigo-600': '#3e4580',
  '--indigo-700': '#303562',
  '--indigo-800': '#232746',
  '--indigo-900': '#171a2f',
  '--indigo-950': '#0d0f1c',
  '--green-400': '#5cb37a',
  '--green-500': '#3d9960',
  '--green-600': '#2e7a4b',
  '--red-400': '#d46b6b',
  '--red-500': '#c04e4e',
  '--red-600': '#a33c3c',
  '--amber-400': '#d9a641',
  '--amber-500': '#c4902c',
  '--amber-600': '#a57724',
  '--overlay-selected-light': 'rgba(196, 112, 75, 0.2)',
  '--overlay-selected-dark': 'rgba(212, 133, 90, 0.42)',
  '--overlay-ink-subtle': 'rgba(30, 26, 23, 0.055)',
  '--overlay-white-subtle': 'rgba(255, 255, 255, 0.06)',
  '--system-stoplight-close': '#ff5f56',
  '--system-stoplight-minimize': '#ffbd2e',
  '--system-stoplight-zoom': '#27c93f',
  '--system-control-tint': '#0868e8',
  '--system-destructive': '#ff383c',
  '--space-2xs': '2px',
  '--space-xs': '4px',
  '--space-sm': '6px',
  '--space-md': '8px',
  '--space-lg': '13px',
  '--space-xl': '21px',
  '--space-2xl': '34px',
  '--space-3xl': '55px',
  '--space-4xl': '89px',
  '--radius-none': '0px',
  '--radius-sm': '4px',
  '--radius-md': '8px',
  '--radius-lg': '12px',
  '--radius-xl': '16px',
  '--radius-2xl': '20px',
  '--radius-full': '9999px',
  '--text-micro': '9px',
  '--text-caption': '11px',
  '--text-body': '13px',
  '--text-subhead': '15px',
  '--text-title-3': '17px',
  '--text-title-2': '21px',
  '--text-title-1': '28px',
  '--text-display-2': '34px',
  '--text-display-1': '55px',
  '--size-12': '12px',
  '--size-20': '20px',
  '--size-30': '30px',
  '--size-32': '32px',
  '--size-56': '56px',
  '--size-68': '68px',
};

const semanticAliases = {
  '--color-bg-primary': ['--stone-0', '--graphite-850'],
  '--color-bg-secondary': ['--stone-60', '--graphite-900'],
  '--color-bg-tertiary': ['--stone-40', '--graphite-875'],
  '--color-bg-elevated': ['--stone-25', '--graphite-800'],
  '--color-bg-hover': ['--stone-80', '--graphite-750'],
  '--color-bg-selected': ['--terracotta-75', '--warm-dark-selected'],
  '--color-bg-brand': ['--terracotta-500', '--terracotta-400'],
  '--color-bg-accent': ['--indigo-500', '--indigo-200'],
  '--color-text-primary': ['--stone-900', '--graphite-50'],
  '--color-text-secondary': ['--stone-600', '--graphite-300'],
  '--color-text-tertiary': ['--stone-550', '--graphite-400'],
  '--color-text-inverse': ['--stone-0', '--stone-900'],
  '--color-text-brand': ['--terracotta-700', '--terracotta-300'],
  '--color-text-accent': ['--indigo-600', '--indigo-200'],
  '--color-text-link': ['--indigo-600', '--indigo-200'],
  '--color-border-default': ['--stone-225', '--graphite-600'],
  '--color-border-subtle': ['--stone-175', '--graphite-650'],
  '--color-border-strong': ['--stone-500', '--stone-600'],
  '--color-border-brand': ['--terracotta-500', '--terracotta-400'],
  '--color-border-focus': ['--indigo-500', '--indigo-200'],
  '--color-icon-primary': ['--stone-900', '--graphite-50'],
  '--color-icon-secondary': ['--stone-600', '--graphite-300'],
  '--color-icon-brand': ['--terracotta-500', '--terracotta-400'],
  '--color-status-success': ['--green-600', '--green-400'],
  '--color-status-error': ['--red-600', '--red-400'],
  '--color-status-warning': ['--amber-600', '--amber-400'],
  '--color-interactive-primary': ['--terracotta-500', '--terracotta-400'],
  '--color-interactive-primary-hover': ['--terracotta-600', '--terracotta-500'],
  '--color-interactive-secondary': ['--stone-90', '--graphite-700'],
  '--color-interactive-secondary-hover': ['--stone-175', '--graphite-600'],
  '--color-bg-row': ['--stone-40', '--graphite-875'],
  '--color-bg-field': ['--stone-0', '--graphite-825'],
  '--color-bg-control': ['--stone-90', '--graphite-700'],
  '--color-text-on-accent': ['--stone-900', '--stone-900'],
  '--color-text-on-system-tint': ['--stone-0', '--stone-0'],
  '--color-text-credit': ['--stone-725', '--graphite-300'],
  '--color-border-divider': ['--stone-175', '--graphite-650'],
  '--color-border-selected': ['--terracotta-500', '--terracotta-400'],
  '--color-border-selected-soft': ['--overlay-selected-light', '--overlay-selected-dark'],
  '--color-fill-subtle': ['--overlay-ink-subtle', '--overlay-white-subtle'],
  '--color-source-icon-well': ['--stone-70', '--graphite-700'],
  '--color-pinned': ['--terracotta-500', '--terracotta-500'],
  '--color-app-icon-start': ['--terracotta-500', '--terracotta-app-icon-dark-bg-start'],
  '--color-app-icon-end': ['--terracotta-app-icon-end', '--terracotta-app-icon-dark-bg-end'],
  '--color-app-icon-mark': ['--stone-0', '--terracotta-app-icon-mark-dark'],
  '--color-focus-ring': ['--indigo-500', '--indigo-200'],
  '--color-system-stoplight-close': ['--system-stoplight-close', '--system-stoplight-close'],
  '--color-system-stoplight-minimize': [
    '--system-stoplight-minimize',
    '--system-stoplight-minimize',
  ],
  '--color-system-stoplight-zoom': ['--system-stoplight-zoom', '--system-stoplight-zoom'],
  '--color-system-control-tint': ['--system-control-tint', '--system-control-tint'],
  '--color-system-destructive': ['--system-destructive', '--system-destructive'],
  '--metric-row-inline': ['--size-12', '--size-12'],
  '--metric-row-block': ['--space-sm', '--space-sm'],
  '--metric-row-min-height': ['--size-56', '--size-56'],
  '--metric-row-action': ['--size-32', '--size-32'],
  '--metric-row-actions-gap': ['--space-xs', '--space-xs'],
  '--metric-row-actions-inline': ['--size-68', '--size-68'],
  '--metric-source-slot-inline': ['--size-30', '--size-30'],
  '--metric-source-glyph': ['--size-20', '--size-20'],
};

/* Optical macOS geometry with no Figma variable counterpart, documented as such
   in tokens.css. Listed explicitly so that introducing another one is a
   deliberate act rather than a silent escape from the contract. */
const productionOnly = new Set([
  '--metric-panel-inline',
  '--metric-list-scrollbar',
  '--metric-control-height',
  '--metric-control-height-sm',
  '--metric-icon-chip',
  '--radius-control',
]);

/* Token families that mirror Figma one-for-one. Typefaces, leading, tracking
   and motion are authored in code only and are checked by their own tests. */
const mirroredFamily =
  /^--(color|space|radius|text|size|metric|terracotta|stone|graphite|indigo|green|red|amber|overlay|system|warm)-/u;

test('CSS mirrors every approved Figma primitive and semantic alias', () => {
  assert.equal(Object.keys(primitives).length, 113, 'fixture must cover all Figma primitives');
  assert.equal(
    Object.keys(semanticAliases).length,
    59,
    'fixture must cover every Figma Semantic variable'
  );

  const css = read('src/tokens.css');
  const light = customProperties(cssRuleBody(css, /:root\s*\{/u, 'Light'));
  const dark = customProperties(
    cssRuleBody(css, /:root\s*\[data-appearance=['"]dark['"]\]\s*\{/u, 'Dark')
  );

  for (const [name, value] of Object.entries(primitives)) {
    assert.equal(light.get(name), value, `${name} must equal its Figma primitive`);
  }

  for (const [name, [lightAlias, darkAlias]] of Object.entries(semanticAliases)) {
    assert.equal(light.get(name), `var(${lightAlias})`, `${name} Light alias`);
    /* metric/* resolves to the same primitive in both Figma modes, so it is
       declared once and never overridden in the dark block. */
    if (!name.startsWith('--metric-')) {
      assert.equal(dark.get(name), `var(${darkAlias})`, `${name} Dark alias`);
    }
  }

  /* Reverse coverage. Matching the fixture against the CSS only proves that
     what we listed is correct — it cannot see a token the fixture forgot. That
     blind spot is how the size/* and metric/* families reached production with
     14 variables unguarded. Assert the other direction too. */
  const accounted = new Set([
    ...Object.keys(primitives),
    ...Object.keys(semanticAliases),
    ...productionOnly,
  ]);
  const unaccounted = [...light.keys()].filter(
    (name) => mirroredFamily.test(name) && !accounted.has(name)
  );
  assert.deepEqual(
    unaccounted,
    [],
    'every mirrored token must be in the fixture or the production-only allowlist'
  );
});

test('semantic contextual pairs meet their intended contrast thresholds', () => {
  const css = read('src/tokens.css');
  const light = customProperties(cssRuleBody(css, /:root\s*\{/u, 'Light'));
  const darkOverrides = customProperties(
    cssRuleBody(css, /:root\s*\[data-appearance=['"]dark['"]\]\s*\{/u, 'Dark')
  );
  const scopes = [
    ['Light', light],
    ['Dark', new Map([...light, ...darkOverrides])],
  ];

  for (const [appearance, scope] of scopes) {
    const checks = [
      ['brand text on selection', '--color-text-brand', '--color-bg-selected', 4.5],
      ['dark ink on brand accent', '--color-text-on-accent', '--color-bg-brand', 4.5],
      ['white text on system tint', '--color-text-on-system-tint', '--color-system-control-tint', 4.5],
      ['tertiary text on canvas', '--color-text-tertiary', '--color-bg-secondary', 4.5],
      ['success text on canvas', '--color-status-success', '--color-bg-secondary', 4.5],
      ['error text on canvas', '--color-status-error', '--color-bg-secondary', 4.5],
      ['warning graphic on canvas', '--color-status-warning', '--color-bg-secondary', 3],
      ['focus ring on canvas', '--color-focus-ring', '--color-bg-secondary', 3],
    ];
    for (const [label, foreground, background, minimum] of checks) {
      const ratio = contrastRatio(resolve(foreground, scope), resolve(background, scope));
      assert.ok(ratio >= minimum, `${appearance} ${label}: ${ratio.toFixed(2)} < ${minimum}`);
    }
  }

  assert.ok(
    contrastRatio(resolve('--color-text-on-accent', light), resolve('--color-system-destructive', light)) >=
      4.5,
    'destructive filled controls must use dark ink, not low-contrast white'
  );
});

test('production typography assigns Cairo and Almarai by text role and script', () => {
  const tokens = read('src/tokens.css');
  const panel = read('src/panel.css');
  const settingsCss = read('src/settings.css');
  const settingsHtml = read('src/settings.html');
  const settingsJs = read('src/js/settings.js');
  const frontendBuilder = read('scripts/build-frontend.mjs');

  assert.match(tokens, /--font-ar:\s*'Cairo'/u);
  assert.match(tokens, /--font-latin:\s*'Almarai'/u);
  assert.match(tokens, /--font-mixed:\s*'Raff Mixed'/u);
  assert.doesNotMatch(panel, /\.time\s*\{/su);
  assert.match(panel, /\.preview-title\.is-code\s*\{[^}]*font-family:\s*var\(--font-latin\)/su);
  assert.match(panel, /\.preview-title\.is-mixed\s*\{[^}]*font-family:\s*var\(--font-mixed\)/su);
  assert.match(settingsCss, /\.about-version\s*\{[^}]*font-family:\s*var\(--font-mixed\)/su);
  assert.doesNotMatch(settingsHtml, /class="about-version\s+latin"/u);
  assert.match(settingsJs, /`الإصدار \$\{arabicDigits\(version\)\} · \\u2066Version \$\{version\}\\u2069`/u);

  assert.doesNotMatch(tokens, /Cairo-Black|font-weight:\s*900/u);
  assert.doesNotMatch(frontendBuilder, /Cairo-Black/u);
});
