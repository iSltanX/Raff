// P4 — فحوص واجهة تقريبية (WebKit عبر Playwright ≠ WKWebView داخل Tauri).
// التشغيل: NODE_PATH=/tmp/raff-p4/node_modules node audit/scripts/p4-ui-approx.mjs
// Playwright و axe-core مثبّتان خارج المستودع (/tmp/raff-p4) دون تعديل أي ملف manifest.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(process.env.NODE_PATH ? path.join(process.env.NODE_PATH, 'x') : import.meta.url);
const { webkit } = require('playwright');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const root = path.resolve('src');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const pages = [
  ['index.html', 460, 540], ['settings.html', 560, 440], ['about.html', 320, 420],
  ['report.html', 460, 600], ['firstrun.html', 460, 520], ['update.html', 360, 280],
];
const browser = await webkit.launch();
const results = [];
for (const [file, width, height] of pages) {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    const page = await ctx.newPage();
    const consoleErrors = [];
    const external = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('request', r => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) external.push(r.url()); });
    await page.goto(`${base}/${file}`, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    await page.addScriptTag({ content: axeSource });
    const axe = await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ['violations'] });
      return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length,
        targets: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }));
    });
    const doc = await page.evaluate(() => {
      const de = document.documentElement;
      const overflow = [...document.querySelectorAll('body *')].filter(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) return false;
        return el.scrollWidth > el.clientWidth + 1 && cs.overflowX === 'visible' && el.clientWidth > 0;
      }).slice(0, 5).map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
      return { dir: de.getAttribute('dir'), lang: de.getAttribute('lang'),
        docOverflowX: de.scrollWidth > de.clientWidth, docOverflowY: de.scrollHeight > de.clientHeight, overflow };
    });
    // Tab order: up to 25 stops; record whether the focus is visible (outline or box-shadow).
    const tabRun = async (key) => {
    await page.evaluate(() => document.activeElement?.blur());
    const tabs = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(key);
      const f = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
        const label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 24) || el.getAttribute('placeholder') || '';
        return { tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), label, visible };
      });
      if (!f) { tabs.push(null); continue; }
      if (tabs.length && tabs[0] && tabs[0].tag === f.tag && tabs[0].label === f.label && i > 0) break;
      tabs.push(f);
    }
    return tabs;
    };
    const tabs = await tabRun('Tab');
    const altTabs = await tabRun('Alt+Tab');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const afterEsc = await page.evaluate(() => (document.activeElement?.tagName || '').toLowerCase());
    results.push({ file, scheme, width, height, axe, doc, tabs, altTabs, afterEsc, consoleErrors, external });
    await page.screenshot({ path: `audit/evidence/p4/${file.replace('.html', '')}-${scheme}.png` });
    await ctx.close();
  }
}
await browser.close();
server.close();
fs.writeFileSync('audit/evidence/p4/ui-approx.json', JSON.stringify(results, null, 2));
for (const r of results) {
  const noFocus = r.tabs.filter(t => t && !t.visible).length;
  console.log(`${r.file} [${r.scheme}] ${r.width}x${r.height} dir=${r.doc.dir} lang=${r.doc.lang} axe=${r.axe.map(v => `${v.id}(${v.impact}×${v.nodes})`).join(',') || '0'} tabStops=${r.tabs.filter(Boolean).length} noVisibleFocus=${noFocus} altTabStops=${r.altTabs.filter(Boolean).length} altNoVisibleFocus=${r.altTabs.filter(t => t && !t.visible).length} docOverflow=${r.doc.docOverflowX ? 'X' : ''}${r.doc.docOverflowY ? 'Y' : ''} overflowEls=${r.doc.overflow.join('|') || '-'} consoleErrors=${r.consoleErrors.length} external=${r.external.length}`);
}
