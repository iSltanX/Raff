// Audit 026 ج6: every icon the build ships is one a page uses. Four were
// exported from icons.js, allowlisted, and shipped, and nothing imported
// them. The files stay in the repository for the design; the build carries
// only what is drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

test('every shipped icon is drawn somewhere', () => {
  const icons = read('src/js/icons.js');
  const constant = new Map(
    [...icons.matchAll(/export const (\w+) = asset\('([\w-]+)'\)/gu)].map((m) => [m[2], m[1]])
  );
  const inTables = icons.replace(/^export const \w+ = asset\('[\w-]+'\);$/gmu, '');
  const pages = readdirSync(path.join(here, '../src/js'))
    .filter((f) => f.endsWith('.js') && f !== 'icons.js')
    .map((f) => read(`src/js/${f}`))
    .join('\n');
  const markup = ['src/index.html', 'src/settings.html', 'src/firstrun.html', 'src/about.html', 'src/update.html', 'src/report.html']
    .map(read)
    .join('\n');
  const css = readdirSync(path.join(here, '../src')).filter((f) => f.endsWith('.css')).map((f) => read(`src/${f}`)).join('\n');

  const shipped = [...read('scripts/build-frontend.mjs').matchAll(/'assets\/icons\/([\w-]+)\.svg'/gu)].map((m) => m[1]);
  assert.ok(shipped.length > 20, `read ${shipped.length}`);
  for (const name of shipped) {
    const viaJs = constant.has(name) && new RegExp(`\\b${constant.get(name)}\\b`, 'u').test(pages);
    // Or inside one of icons.js's own tables (the content-type icons), which
    // the pages reach through the table's function.
    const inTable = inTables.includes(`asset('${name}')`);
    const direct = (markup + css).includes(`icons/${name}.svg`);
    assert.ok(viaJs || inTable || direct, `${name}.svg ships but nothing draws it`);
  }
});
