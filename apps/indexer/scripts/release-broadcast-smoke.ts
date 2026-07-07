/**
 * release-broadcast-smoke (cp317)
 *
 * Guards the release-op broadcast tooling: the pure op-builder +
 * view-key guard, and the CLI's safety invariants (dry-run asks for
 * no key, the key is read masked and never persisted, laptop-only
 * banner present).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildReleaseCustomJsonOp,
	assertNoSecretHex,
	RELEASE_OP_ID,
	RELEASE_SIGNER_DEFAULT,
	BLURT_CUSTOM_JSON_MAX_BYTES
} from '../src/blurt/releaseBroadcastOp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let failures = 0;
let scenarios = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	scenarios++;
};
const bad = (m: string, d: string) => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failures++;
	scenarios++;
};
const throws = (label: string, fn: () => unknown, needle: string) => {
	try {
		fn();
		bad(`${label} should throw`, 'did not throw');
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes(needle)) ok(`${label} → throws (${needle})`);
		else bad(`${label} threw wrong error`, msg);
	}
};

const BTC = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const XMR = '84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const VALID = JSON.stringify({
	version: '1.0.0',
	hash_manifest: { 'app.js': 'sha256-' + 'A'.repeat(43) + '=' },
	endpoints: { blurt_rpc: ['https://rpc.beblurt.com'] },
	treasury: { btc: { address: BTC, satoshis: 416 }, xmr: { address: XMR, piconero: '781250000' } }
});

// ── 1. valid payload → correct op shape ───────────────────────────
const op = buildReleaseCustomJsonOp(VALID);
if (
	op.id === RELEASE_OP_ID &&
	op.required_auths.length === 0 &&
	op.required_posting_auths.length === 1 &&
	op.required_posting_auths[0] === RELEASE_SIGNER_DEFAULT &&
	op.json === VALID.trim()
)
	ok('valid payload → op {id:morphit_release_v1, posting_auths:[morphit], json=input}');
else bad('valid payload produced wrong op', JSON.stringify(op));

// ── 2. custom signer respected ────────────────────────────────────
if (buildReleaseCustomJsonOp(VALID, 'example-op').required_posting_auths[0] === 'example-op')
	ok('custom --signer is honored');
else bad('custom signer not honored', '');

// ── 3. invalid payload (bad version) → validation error ───────────
throws(
	'invalid payload (version not semver)',
	() => buildReleaseCustomJsonOp(JSON.stringify({ ...JSON.parse(VALID), version: 'nope' })),
	'failed validation'
);

// ── 4. non-JSON → JSON error ──────────────────────────────────────
throws('non-JSON payload', () => buildReleaseCustomJsonOp('{ not json'), 'not valid JSON');

// ── 5. 64-hex (view key) → refused ────────────────────────────────
throws(
	'assertNoSecretHex on a 64-hex string',
	() => assertNoSecretHex('prefix ' + 'a'.repeat(64) + ' suffix'),
	'secret key'
);

// ── 5b. cp430 — a hash_manifest over the indexer's 4096-byte per-field
//        JSONB cap is now rejected up front by validateReleasePayload
//        (schema cap lowered from 64 KB to match the handler). This is
//        the EXACT failure that reached the chain on 1.0.0 and got
//        filed valid=false → /v1/release not_found. ──
const bigManifest: Record<string, string> = {};
for (let i = 0; i < 120; i++) {
	bigManifest[`/_app/immutable/nodes/${i}.CFakeHash00000${i}.js`] = 'sha256-' + 'A'.repeat(43) + '=';
}
const manifestBytes = new TextEncoder().encode(JSON.stringify(bigManifest)).length;
if (manifestBytes > 4096) ok(`oversized manifest fixture is ${manifestBytes} bytes — over the 4096 per-field cap`);
else bad('oversized manifest fixture is not over 4096', String(manifestBytes));
throws(
	'manifest over the 4096 per-field cap → rejected before broadcast',
	() => buildReleaseCustomJsonOp(JSON.stringify({ ...JSON.parse(VALID), hash_manifest: bigManifest })),
	'hash_manifest_too_large'
);
// a normal (small) payload stays under the whole-op chain limit and builds
const okSized = buildReleaseCustomJsonOp(VALID);
if (new TextEncoder().encode(okSized.json).length < BLURT_CUSTOM_JSON_MAX_BYTES)
	ok('a normal (small) payload stays under the 8192-byte chain limit and builds');
else bad('normal payload unexpectedly over the limit', '');

// ── 6. real payload (SRI base64) passes the hex guard ─────────────
try {
	assertNoSecretHex(VALID);
	ok('real payload (SRI base64) passes the secret-hex guard (no false positive)');
} catch (e) {
	bad('real payload wrongly flagged as secret hex', e instanceof Error ? e.message : String(e));
}

// ── 7. invalid signer name → refused ──────────────────────────────
throws('invalid signer name', () => buildReleaseCustomJsonOp(VALID, 'BadName!!'), 'invalid signer');

// ── 8-11. CLI safety static guards ────────────────────────────────
const cli = readFileSync(join(REPO, 'apps/indexer/scripts/release-broadcast.ts'), 'utf-8');
if (cli.includes("from '../src/blurt/releaseBroadcastOp.ts'"))
	ok('CLI builds the op via the pure, tested module');
else bad('CLI no longer uses the pure op-builder module', 'validation/guard could drift');

// dry-run must exit BEFORE the key prompt (askHidden).
const dryIdx = cli.indexOf('if (dryRun)');
const askIdx = cli.indexOf('askHidden(');
if (dryIdx !== -1 && askIdx !== -1 && dryIdx < askIdx)
	ok('--dry-run exits before any key is requested');
else bad('--dry-run no longer precedes the key prompt', 'dry-run could leak into the key path');

if (cli.includes('_writeToOutput') && /askHidden/.test(cli))
	ok('posting key is read via a masked prompt (echo suppressed)');
else bad('posting key prompt is no longer masked', 'WIF could echo to the screen');

if (!/writeFileSync\([^)]*wif/i.test(cli) && !/console\.log\([^)]*wif/i.test(cli) && !/process\.env\.[A-Z_]*WIF/.test(cli))
	ok('posting key is never written to disk, logged, or read from an env var');
else bad('posting key may be persisted/logged/env-sourced', 'key-handling regression');

if (cli.includes('LAPTOP ONLY')) ok('CLI carries the LAPTOP-ONLY warning banner');
else bad('LAPTOP-ONLY banner removed', 'operator might run it on the server with the posting key');

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
