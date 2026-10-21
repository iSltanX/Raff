// The local preview server tells the browser to keep nothing, so an edited
// page is always fetched again (audit 2026-10-21, F-1735), and serves nothing
// outside the folder it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { previewServer } from '../scripts/preview-server.mjs';

test('every answer says no-store, and only the folder is served', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'raff-preview-'));
  const folder = path.join(parent, 'ui');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>v1</title>');
  writeFileSync(path.join(parent, 'secret.txt'), 'outside');
  const server = previewServer(folder);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type'), /^text\/html/u);
    assert.match(await res.text(), /v1/u);

    // Edited in place, as rsync does: the next load sees it.
    writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>v2</title>');
    res = await fetch(`${base}/index.html`);
    assert.match(await res.text(), /v2/u);

    // `..` is resolved away by the URL itself; an encoded slash is not.
    for (const escape of ['/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e%2fsecret.txt']) {
      res = await fetch(`${base}${escape}`);
      assert.notEqual(res.status, 200, escape);
      assert.doesNotMatch(await res.text(), /outside/u, escape);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await fetch(`${base}/..%2Fsecret.txt`)).status, 403);
    res = await fetch(`${base}/missing.js`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a request it cannot parse is refused, not the end of the server', async () => {
  // `new URL('//', base)` throws; thrown in the handler, it took Node down.
  const { request } = await import('node:http');
  const server = previewServer(mkdtempSync(path.join(tmpdir(), 'raff-preview-')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '//' }, (res) => resolve(res.statusCode)).on('error', reject).end();
    });
    assert.equal(status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/missing`)).status, 404, 'still serving');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
