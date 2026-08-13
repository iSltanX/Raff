// A real bug that shipped on v4.2.1's first upload: `latest.json`'s
// `signature` field was base64-encoded TWICE, which would fail every real
// installed Raff's minisign verification silently (caught only by
// downloading the live asset and decoding it by hand — decoding once landed
// on more base64 instead of minisign's own "untrusted comment: ..." text).
//
// Root cause: `tauri signer sign <file>` writes its `.sig` file ALREADY
// base64-encoded — the file's raw content on disk (trimmed) IS the final
// `signature` string, not something to encode again. The script had been
// reading it as a Buffer and calling `.toString('base64')` on top of that.
//
// This guards the fix at the source level, since reproducing the real bug
// needs the actual TAURI_SIGNING_PRIVATE_KEY (a CI-only secret, never
// available locally) to produce a real .sig file to decode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  path.join(here, '..', 'scripts', 'ci-fix-release-icon.mjs'),
  'utf8'
);

test('the .sig file content is used verbatim as the signature, never re-base64-encoded', () => {
  assert.doesNotMatch(
    script,
    /Buffer\.from\(readFileSync\(sigPath\)\)\.toString\(['"]base64['"]\)/u,
    'this exact pattern double-encodes an already-base64 .sig file — it shipped broken once'
  );
  assert.match(
    script,
    /readFileSync\(sigPath,\s*['"]utf8['"]\)\.trim\(\)/u,
    'the .sig file must be read as text and used directly, not re-encoded'
  );
});
