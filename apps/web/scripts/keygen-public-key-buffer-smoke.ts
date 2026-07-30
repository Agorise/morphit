#!/usr/bin/env tsx
/**
 * Smoke: `formatPublicKeyBLT` must hand dblurt a real Buffer, not a
 * bare Uint8Array.
 *
 * Regression guard for the cp283 import-blocking bug. The posting-key
 * login path (and account-name registration) calls
 * `formatPublicKeyBLT(publicKey)`, which wraps `@beblurt/dblurt`'s
 * `PublicKey(...).toString()`. dblurt bundles the browserify crypto
 * stack (cipher-base / hash-base + its own `buffer`), and computes the
 * BLT checksum via a RIPEMD160 `.update()` whose guard is
 * `Buffer.isBuffer(data) || typeof data === 'string'`. dblurt's
 * `Buffer.isBuffer` duck-types on the `_isBuffer` flag, which a plain
 * `Uint8Array` does NOT carry — so passing a Uint8Array throws
 * "Data must be a string or a buffer" IN THE BROWSER. (Node's native
 * crypto accepts typed arrays, so this bug is invisible to a Node
 * execution test — hence this is a SOURCE-level assertion.)
 *
 * The fix: convert with `Buffer.from(pk)` using an explicit
 * `import('buffer')` (the buffer@5.x npm package Vite bundles for the
 * browser, whose instances DO carry `_isBuffer`). We do NOT rely on a
 * global `Buffer`, because this app's Vite config injects none.
 *
 * Tamper: reverting `formatPublicKeyBLT` to
 * `new PublicKey(pk as unknown as Buffer)` → fails. Dropping the
 * `import('buffer')` and assuming a global Buffer → fails.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const KEYGEN = join(REPO_ROOT, 'apps/web/src/lib/crypto/keygen.ts');
const src = readFileSync(KEYGEN, 'utf8');

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
	if (ok) {
		console.log(`  ✓ ${label}`);
	} else {
		console.error(`  ✗ ${label}\n      ${detail}`);
		failures++;
	}
}

// Isolate the formatPublicKeyBLT function body so assertions can't be
// satisfied by an unrelated occurrence elsewhere in the file.
const fnStart = src.indexOf('export async function formatPublicKeyBLT');
const fnBody = fnStart === -1 ? '' : src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);

console.log('keygen formatPublicKeyBLT buffer smoke');
console.log('======================================');

check(
	'formatPublicKeyBLT exists',
	fnStart !== -1,
	'export async function formatPublicKeyBLT not found in keygen.ts'
);

check(
	'converts the public key to a real Buffer before dblurt',
	/new PublicKey\(\s*Buffer\.from\(pk\)/.test(fnBody),
	'expected `new PublicKey(Buffer.from(pk) ...)` — dblurt rejects a bare Uint8Array in the browser'
);

check(
	'does NOT pass a bare Uint8Array straight to PublicKey',
	!/new PublicKey\(\s*pk\s+as\s+unknown\s+as\s+Buffer\s*\)/.test(fnBody) &&
		!/new PublicKey\(\s*pk\s*\)/.test(fnBody),
	'`new PublicKey(pk ...)` reintroduces the "Data must be a string or a buffer" browser crash'
);

check(
	'sources Buffer explicitly (does not assume a global Buffer)',
	/import\(\s*['"]buffer['"]\s*\)/.test(fnBody),
	"expected an `import('buffer')` — this app's Vite config injects no global Buffer"
);

const TOTAL_SCENARIOS = 4;

if (failures > 0) {
	console.error(`\n✗ ${failures} assertion(s) failed`);
	process.exit(1);
}
console.log(`\n✓ all ${TOTAL_SCENARIOS} scenarios passed`);
