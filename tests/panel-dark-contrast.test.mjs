// The dark panel is glass. Over a bright desktop it composites to about
// #505050, and that is the background its row text has to stay legible on
// (audit P4: `.row-time` measured 3.08:1, link titles 3.58:1). The ratio is
// computed from the tokens themselves, so changing either side re-checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');
const tokens = read('src/tokens.css');
const panel = read('src/panel.css');

const DARK = ":root[data-appearance='dark']";

function darkToken(name) {
  const block = tokens.slice(tokens.indexOf(`${DARK} {`));
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`, 'u'));
  assert.ok(match, `${name} is defined for the dark appearance`);
  return match[1].trim();
}

function rgba(value) {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)).concat(1);
  }
  const [r, g, b, a = 1] = value.match(/[\d.]+/gu).map(Number);
  return [r, g, b, a];
}

const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
const channel = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The colour a dark-appearance rule for `selector` in panel.css resolves to. */
function darkColor(selector) {
  const rule = panel.match(new RegExp(`${DARK.replace(/[[\]]/gu, '\\$&')} ${selector.replace(/\./gu, '\\.')}\\s*\\{([^}]*)\\}`, 'u'));
  assert.ok(rule, `panel.css gives ${selector} its own dark colour`);
  const token = rule[1].match(/color:\s*var\((--[\w-]+)\)/u);
  assert.ok(token, `${selector} takes its dark colour from a token`);
  return rgba(darkToken(token[1]));
}

const WHITE = [255, 255, 255];
const worstBackground = over(rgba(darkToken('--bg-glass')), WHITE);

test('the worst dark background is the glass over a white desktop (#505050)', () => {
  assert.deepEqual(worstBackground.map(Math.round), [80, 80, 80]);
});

for (const selector of ['.row-time', '.preview-title.is-link']) {
  test(`dark ${selector} clears 4.5:1 on that background`, () => {
    const ratio = contrast(over(darkColor(selector), worstBackground), worstBackground);
    assert.ok(ratio >= 4.5, `${selector}: ${ratio.toFixed(2)}:1`);
  });
}
