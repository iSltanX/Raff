// The panel is opaque: flat, not frosted (Najdi redesign, 2026-10-21). Its
// rows are read on --bg-glass itself and, once selected, on --bg-selected — in
// both appearances. The ratios are computed from the tokens, so changing
// either side re-checks them. (Audit P4 measured the old dark glass over a
// white desktop: `.row-time` 3.08:1, link titles 3.58:1.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');
const tokens = read('src/tokens.css');
const panel = read('src/panel.css');

const LIGHT = ':root';
const DARK = ":root[data-appearance='dark']";

function token(scope, name) {
  const start = tokens.indexOf(`${scope} {`);
  const block = tokens.slice(start, tokens.indexOf('\n}', start));
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`, 'u'));
  return match?.[1].trim() ?? (scope === DARK ? token(LIGHT, name) : undefined);
}

const hex = (value) => {
  assert.match(value, /^#[0-9a-f]{6}$/u, `${value} is an opaque colour`);
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
};
const channel = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The token a colour rule for `selector` resolves to in that appearance. */
function colorToken(scope, selector) {
  const escaped = selector.replace(/[.[\]]/gu, '\\$&');
  if (scope === DARK) {
    const own = panel.match(new RegExp(`${DARK.replace(/[[\]]/gu, '\\$&')} ${escaped}\\s*\\{([^}]*)\\}`, 'u'));
    const name = own?.[1].match(/color:\s*var\((--[\w-]+)\)/u)?.[1];
    if (name) return name;
  }
  const rules = [...panel.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'gu'))];
  const name = rules.map((r) => r[1].match(/(?:^|\s)color:\s*var\((--[\w-]+)\)/u)?.[1]).find(Boolean);
  assert.ok(name, `${selector} takes its colour from a token`);
  return name;
}

test('the panel surface is opaque in both appearances', () => {
  for (const scope of [LIGHT, DARK]) hex(token(scope, '--bg-glass'));
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const window = config.app.windows.find((w) => w.label === 'panel');
  assert.equal(window.windowEffects, undefined, 'no native frosted material under the panel');
});

for (const selector of ['.row-time', '.preview-title.is-link']) {
  test(`${selector} clears 4.5:1 on the panel and on a selected row`, () => {
    for (const scope of [LIGHT, DARK]) {
      const ink = hex(token(scope, colorToken(scope, selector)));
      for (const surface of ['--bg-glass', '--bg-selected']) {
        const ratio = contrast(ink, hex(token(scope, surface)));
        assert.ok(ratio >= 4.5, `${scope} ${selector} on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
  });
}

// Audit 021 ج1 measured secondary text at ~3.1:1 on the identity before
// «نجدي». On this one every --ink-3 text reads at 5.0:1 or more in both
// appearances (evidence/2026-10-22-m6b), so it stays --ink-3; this keeps a
// later token change from taking it under AA on any surface it is read on.
test('secondary text (--ink-3) stays at AA on every panel surface, in both appearances', () => {
  for (const scope of [LIGHT, DARK]) {
    const ink = hex(token(scope, '--ink-3'));
    for (const surface of ['--bg-glass', '--bg-selected', '--bg-window', '--bg-raised']) {
      const ratio = contrast(ink, hex(token(scope, surface)));
      assert.ok(ratio >= 4.5, `${scope} --ink-3 on ${surface}: ${ratio.toFixed(2)}:1`);
    }
  }
});
