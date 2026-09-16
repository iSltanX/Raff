// The رفّ identity contract: palette, type, icons, window geometry and the
// invariants the panel depends on. Values here are the design decisions, so a
// regression has to be deliberate to get past them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, '..');
const read = (file) => readFileSync(path.join(project, file), 'utf8');

const CSS = ['tokens.css', 'controls.css', 'panel.css', 'settings.css', 'about.css', 'update.css', 'firstrun.css'];
const HTML = ['index.html', 'settings.html', 'about.html', 'update.html', 'firstrun.html'];

function block(css, selector) {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'u'));
  return match?.[1] ?? '';
}

function token(css, scope, name) {
  return block(css, scope).match(new RegExp(`${name}:\\s*([^;]+);`, 'u'))?.[1].trim();
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the Mizan palette is the only palette, in both appearances', () => {
  const tokens = read('src/tokens.css');
  assert.equal(token(tokens, ':root', '--ink'), '#1c1917');
  assert.equal(token(tokens, ':root', '--bg-canvas'), '#f0ede8');
  assert.equal(token(tokens, ':root', '--bg-window'), '#f8f6f3');
  assert.equal(token(tokens, ':root', '--brand-sage'), '#7c8c78');
  assert.equal(token(tokens, ':root', '--line-strong'), '#d6d0c8');
  assert.equal(token(tokens, ":root[data-appearance='dark']", '--ink'), '#f0ede8');

  for (const file of [...CSS, ...HTML]) {
    const text = read(`src/${file}`).toLowerCase();
    assert.doesNotMatch(text, /#c4704b|#d4855a|#a85a3a|terracotta/u, `${file} carries no previous-identity colour`);
  }
  for (const file of CSS.slice(1)) {
    assert.doesNotMatch(read(`src/${file}`), /--(?:color|metric|figma)-/u, `${file} uses the current token names`);
  }
});

test('reading text keeps AA contrast on its surfaces in Light and Dark', () => {
  const tokens = read('src/tokens.css');
  for (const scope of [':root', ":root[data-appearance='dark']"]) {
    for (const surface of ['--bg-window', '--bg-canvas']) {
      for (const ink of ['--ink', '--ink-2', '--ink-3', '--accent-ink', '--danger']) {
        const ratio = contrast(token(tokens, scope, ink), token(tokens, scope, surface));
        assert.ok(ratio >= 4.5, `${scope} ${ink} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
    const onAccent = contrast(token(tokens, scope, '--on-accent'), token(tokens, scope, '--accent'));
    assert.ok(onAccent >= 4.5, `${scope} text on the accent fill is ${onAccent.toFixed(2)}:1`);
  }
});

test('type is Cairo and Almarai only', () => {
  const faces = [...read('src/tokens.css').matchAll(/font-family:\s*'([^']+)'/gu)].map((m) => m[1]);
  assert.deepEqual([...new Set(faces)].sort(), ['Almarai', 'Cairo']);
  const fonts = readdirSync(path.join(project, 'src/fonts')).filter((f) => f.endsWith('.ttf'));
  assert.ok(fonts.every((f) => /^(Cairo|Almarai)-/u.test(f)), fonts.join(', '));
});

test('every icon and brand asset the UI references exists', () => {
  const icons = read('src/js/icons.js');
  for (const [, name] of icons.matchAll(/asset\('([a-z-]+)'\)/gu)) {
    assert.ok(existsSync(path.join(project, `src/assets/icons/${name}.svg`)), `icon ${name}`);
  }
  for (const file of CSS) {
    for (const [, url] of read(`src/${file}`).matchAll(/url\('(assets\/[^']+)'\)/gu)) {
      assert.ok(existsSync(path.join(project, 'src', url)), `${file} → ${url}`);
    }
  }
  for (const file of HTML) {
    for (const [, src] of read(`src/${file}`).matchAll(/src="(assets\/[^"]+)"/gu)) {
      assert.ok(existsSync(path.join(project, 'src', src)), `${file} → ${src}`);
    }
  }
  assert.ok(!existsSync(path.join(project, 'src/assets/v4')), 'the previous identity assets are gone');
});

test('icons are drawn as masks and never injected as markup', () => {
  const icons = read('src/js/icons.js');
  assert.match(icons, /icon\.style\.setProperty\('--icon', `url\(\$\{source\}\)`\)/u);
  for (const file of readdirSync(path.join(project, 'src/js'))) {
    assert.doesNotMatch(read(`src/js/${file}`), /innerHTML\s*=/u, `${file} must not assign innerHTML`);
  }
  for (const file of readdirSync(path.join(project, 'src/assets/icons'))) {
    const svg = read(`src/assets/icons/${file}`);
    assert.match(svg, /viewBox="0 0 16 16"/u, file);
    assert.match(svg, /stroke-width="1\.5"/u, file);
  }
});

test('panel window geometry agrees across config, native code and CSS', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const panel = config.app.windows.find((w) => w.label === 'panel');
  assert.equal(panel.width, 460);
  assert.equal(panel.height, 540);
  assert.equal(panel.transparent, true);
  assert.deepEqual(panel.windowEffects, { effects: ['popover'], state: 'active', radius: 16 });

  const rust = read('src-tauri/src/panel.rs');
  assert.match(rust, /const PANEL_WIDTH: f64 = 460\.0;/u);
  assert.match(rust, /const PANEL_HEIGHT: f64 = 540\.0;/u);
  assert.match(read('src/tokens.css'), /--radius-panel:\s*16px;/u);
});

test('secondary windows use the native overlay title bar at their designed sizes', () => {
  const commands = read('src-tauri/src/commands.rs');
  assert.match(commands, /\.title_bar_style\(tauri::TitleBarStyle::Overlay\)/u);
  assert.match(commands, /\.hidden_title\(true\)/u);
  assert.doesNotMatch(commands, /decorations\(false\)/u);
  for (const size of ['(560.0, 440.0)', '(320.0, 360.0)', '(460.0, 520.0)', '(360.0, 280.0)']) {
    assert.ok(commands.includes(size), `window size ${size}`);
  }
});

test('panel chrome stays fixed while only results scroll', () => {
  const css = read('src/panel.css');
  assert.match(block(css, 'html,\nbody'), /overflow:\s*hidden;/u);
  assert.match(block(css, '.panel'), /height:\s*100vh;[\s\S]*overflow:\s*hidden;/u);
  assert.match(block(css, '.items-list'), /flex:\s*1;[\s\S]*overflow-y:\s*auto;/u);
});

test('row actions cost resting rows nothing and appear for mouse, selection and focus', () => {
  const css = read('src/panel.css');
  const actions = block(css, '.row-actions');
  assert.match(actions, /position:\s*absolute;/u);
  assert.match(actions, /opacity:\s*0;/u);
  assert.match(actions, /pointer-events:\s*none;/u);
  assert.match(
    css,
    /\.row:hover \.row-actions,\s*\.row\.selected \.row-actions,\s*\.row:focus-within \.row-actions\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/u
  );
});

test('quick-paste slots are revealed only while ⌘ is held', () => {
  const css = read('src/panel.css');
  assert.match(block(css, '.row-index'), /display:\s*none;/u);
  assert.match(css, /\.panel\.show-slots \.row-index\s*\{[^}]*display:\s*grid;/u);
  const js = read('src/js/panel.js');
  assert.match(js, /const QUICK_SLOTS = 9;/u);
  assert.match(js, /\/\^Digit\[1-9\]\$\/\.test\(e\.code\)/u);
});

test('history rows never resolve application artwork', () => {
  const panel = read('src/js/panel.js');
  assert.match(panel, /createIcon\(presentation\.asset, 'content-type-glyph'\)/u);
  assert.doesNotMatch(panel, /sourceAppIcon|appIcon\(|get_app_icon/u);
  for (const file of readdirSync(path.join(project, 'src-tauri/src'))) {
    assert.doesNotMatch(read(`src-tauri/src/${file}`), /iconForFile/u, file);
  }
});

test('the menu-bar glyph is an 18pt template drawn natively', () => {
  const tray = read('src-tauri/src/tray.rs');
  assert.match(tray, /include_bytes!\("\.\.\/icons\/tray\.png"\)/u);
  assert.match(tray, /image\.setTemplate\(true\)/u);
  assert.match(tray, /NSSize::new\(18\.0, 18\.0\)/u);
  const png = readFileSync(path.join(project, 'src-tauri/icons/tray.png'));
  assert.equal(png.readUInt32BE(16), 36);
  assert.equal(png.readUInt32BE(20), 36);
});

test('the app icon keeps transparent corners and one artwork for every appearance', () => {
  const png = readFileSync(path.join(project, 'src/assets/app-icon/raff-app-icon-1024.png'));
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png[25], 6, 'RGBA master');

  const icon = JSON.parse(read('src-tauri/icon-composer/AppIcon.icon/icon.json'));
  const layers = icon.groups.flatMap((group) => group.layers);
  assert.deepEqual(layers.map((l) => l['image-name']).sort(), ['recent.png', 'shelf.png']);
  for (const layer of layers) {
    assert.ok(existsSync(path.join(project, 'src-tauri/icon-composer/AppIcon.icon/Assets', layer['image-name'])));
  }
});
