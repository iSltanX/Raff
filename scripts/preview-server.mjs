// The local preview of the pages (`mock.js` stands in for Rust when there is
// no `__TAURI__`): a static server on 127.0.0.1 that tells the browser not to
// keep anything.
//
// `python3 -m http.server` sends `Last-Modified` and no `Cache-Control`, which
// lets the browser serve a page it already has without asking — and `rsync -a`
// keeps the old modification times, so an index.html unchanged for days is
// the first thing it keeps. A cached index.html from before `#preview` with
// the current panel.js stops the module at panel.js:1735 (audit 2026-10-21,
// F-1735): a panel that never draws, for a fault the app does not have.
//
// Usage: node scripts/preview-server.mjs <folder> [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** A server for `folder`, not yet listening. Nothing outside it is served. */
export function previewServer(folder) {
  const root = path.resolve(folder);
  return createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store' };
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    let file;
    try {
      file = path.join(root, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    } catch {
      res.writeHead(400, headers).end();
      return;
    }
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403, headers).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, headers).end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [folder, port = '5179'] = process.argv.slice(2);
  if (!folder) {
    console.error('usage: node scripts/preview-server.mjs <folder> [port]');
    process.exit(2);
  }
  previewServer(folder).listen(Number(port), '127.0.0.1', () => {
    console.log(`preview: http://127.0.0.1:${port}/ (${path.resolve(folder)}, no-store)`);
  });
}
