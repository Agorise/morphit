/**
 * Smoke — verify-download.mjs pure logic (cp556).
 *
 * The chain fetch is network I/O (can't run offline), but the parts a
 * downloader's trust actually rests on — the SHA-256 computation, the
 * anchor extraction, and the match/mismatch decision — are pure and
 * MUST be right. A false "match" would tell a user a tampered download
 * is safe; a false "mismatch" would scare them off a genuine one.
 *
 * Registered: `.:verify-download-smoke`.
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// The verifier exports its pure helpers; import them directly.
import { sha256File, extractDistribution, compareRelease } from './verify-download.mjs';

let scenarios = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	scenarios++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failures++;
		console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

console.log('\n── verify-download pure-logic smoke ──────────────────────\n');

// ─── sha256File — pin against the WELL-KNOWN empty-input digest ──────
const dir = mkdtempSync(join(tmpdir(), 'morphit-verify-'));
const emptyFile = join(dir, 'empty.bin');
writeFileSync(emptyFile, '');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
check(
	'sha256File matches the canonical empty-input SHA-256',
	sha256File(emptyFile) === EMPTY_SHA256,
	sha256File(emptyFile)
);

const helloFile = join(dir, 'hello.bin');
writeFileSync(helloFile, 'morphit\n');
const HELLO_SHA256 = sha256File(helloFile);
check('sha256File returns 64-lowercase-hex', /^[0-9a-f]{64}$/.test(HELLO_SHA256), HELLO_SHA256);

// ─── extractDistribution ────────────────────────────────────────────
const GOOD_SHA = 'a'.repeat(64);
const GOOD_FPR = 'DEADBEEF'.repeat(5);
const fullPayload = {
	version: '1.8.15',
	hash_manifest: {},
	distribution: {
		source_sha256: GOOD_SHA,
		gpg_fingerprint: GOOD_FPR,
		ipfs_cid: 'Qm' + 'a'.repeat(44),
		mirrors: ['https://codeberg.org/agorise/morphit']
	}
};

check('extractDistribution returns the block for a valid payload', extractDistribution(fullPayload)?.source_sha256 === GOOD_SHA);
check('extractDistribution → null when payload has no distribution', extractDistribution({ version: '1.8.15' }) === null);
check('extractDistribution → null for a non-object payload', extractDistribution('nope' as unknown) === null);
check('extractDistribution → null when distribution is an array', extractDistribution({ distribution: [] } as unknown) === null);
check(
	'extractDistribution → null when source_sha256 is malformed',
	extractDistribution({ distribution: { source_sha256: 'short', gpg_fingerprint: GOOD_FPR } } as unknown) === null
);
check(
	'extractDistribution → null when source_sha256 is UPPERCASE (not sha256sum form)',
	extractDistribution({ distribution: { source_sha256: 'A'.repeat(64), gpg_fingerprint: GOOD_FPR } } as unknown) === null
);

// ─── compareRelease ─────────────────────────────────────────────────
const match = compareRelease(GOOD_SHA, fullPayload, null);
check('compareRelease → match when the hash equals the anchor', match.status === 'match');
check('  …and it surfaces the fingerprint for git verify-tag (tarball unsigned by default)', match.dist?.gpg_fingerprint === GOOD_FPR);

const mismatch = compareRelease('b'.repeat(64), fullPayload, null);
check('compareRelease → mismatch when the hash differs', mismatch.status === 'mismatch');
check('  …and it reports both expected and got', mismatch.expected === GOOD_SHA && mismatch.got === 'b'.repeat(64));

const noAnchor = compareRelease(GOOD_SHA, { version: '1.8.15', hash_manifest: {} }, null);
check('compareRelease → no_anchor when the op has no distribution block', noAnchor.status === 'no_anchor');

const versionMismatch = compareRelease(GOOD_SHA, fullPayload, '1.8.14');
check("compareRelease → version_mismatch when the chain's latest anchor is a different release", versionMismatch.status === 'version_mismatch');

const versionMatch = compareRelease(GOOD_SHA, fullPayload, '1.8.15');
check('compareRelease → match when the requested version equals the anchor', versionMatch.status === 'match');

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`\u2713 all ${scenarios} verify-download scenarios passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failures}/${scenarios} verify-download scenarios failed`);
	process.exit(1);
}
