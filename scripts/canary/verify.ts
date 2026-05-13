#!/usr/bin/env tsx
/**
 * scripts/canary/verify.ts
 *
 * Verify a Morphit canary file for freshness, structural sanity,
 * and (Part 89) posting-key signature integrity.  Used by:
 *
 *   1. CI on every PR that modifies the canary template — fails
 *      the build if the template is missing required placeholders.
 *
 *   2. Operators running `npx tsx scripts/canary/verify.ts <url>`
 *      against another operator's canary as a quick "are they
 *      still publishing AND is the on-chain attestation valid?"
 *      check.  This script verifies the BLURT posting-key
 *      attestation locally (no network beyond the optional
 *      fetch) by parsing the embedded `public_key:` line and
 *      recovering the same key from the signature; matching
 *      that public key against the operator's
 *      `morphit_operator_register_v1` chain record is the
 *      operator's responsibility.
 *
 *      PGP signature verification still requires the operator's
 *      release pubkey in the local keyring; this script reports
 *      the signature presence/absence but doesn't itself run
 *      gpg --verify.
 *
 *   3. The frontend's degraded-canary banner pulls /canary.txt
 *      and applies similar logic in JS.  This script is the
 *      authoritative reference for what "fresh" means.
 *
 * Exit codes:
 *   0  — canary is structurally valid, posting-key attestation
 *        verifies, and the freshness window is intact.
 *   1  — canary is missing, malformed, the posting-key
 *        attestation fails to verify, or the freshness window
 *        has expired.
 *   2  — canary is structurally valid AND the posting-key
 *        attestation verifies, but the PGP signature block is
 *        missing.  Treated as a warning, not a hard fail,
 *        because the posting-key attestation is the stronger
 *        check (it's tied to on-chain identity).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Signature } from '@beblurt/dblurt';

const REQUIRED_PLACEHOLDERS_OR_FILLED = [
	'OPERATOR_NAME',
	'INSTANCE_ORIGIN',
	'GENERATED_AT_ISO',
	'VALID_THROUGH_ISO',
	'OPERATOR_ACCOUNT',
	'BLURT_HEAD_HEIGHT',
	'BLURT_HEAD_HASH',
	'BTC_HEAD_HEIGHT',
	'BTC_HEAD_HASH',
	'NEWS_HEADLINE',
	// Part 89 — posting-key attestation block.
	'OPERATOR_POSTING_ACCOUNT',
	'OPERATOR_POSTING_PUBKEY',
	'POSTING_SIG_SHA256',
	'POSTING_SIG_BASE64'
];

const STALE_DAYS = 14;

interface Verification {
	readonly ok: boolean;
	readonly warnings: readonly string[];
	readonly errors: readonly string[];
	readonly generatedAt: string | null;
	readonly ageDays: number | null;
	/** Posting-key attestation result, when one was present. */
	readonly postingKey: PostingKeyResult | null;
}

interface PostingKeyResult {
	/** The `account:` line value from inside the attestation block. */
	readonly account: string;
	/** The `public_key:` line value (BLT5...). */
	readonly declaredPublicKey: string;
	/** The public key recovered from the signature.  Must match
	 *  `declaredPublicKey` for the attestation to verify. */
	readonly recoveredPublicKey: string;
	/** Did the recovered key match the declared key? */
	readonly verified: boolean;
}

/**
 * Slice the canary into the bytes that the posting-key signer
 * actually signed.  Mirrors the slice in `scripts/canary/generate.sh`:
 *
 *   `sed -n '1,/-----BEGIN MORPHIT POSTING-KEY ATTESTATION-----/p'`
 *   followed by `sed '$d'`
 *
 * which is "everything from line 1 up to and INCLUDING the line
 * matching the BEGIN marker, then drop the last line (the BEGIN
 * marker itself)."  Returns the bytes the signer hashed; the
 * verifier hashes the same bytes and recovers the public key.
 */
function extractSignedPayload(text: string): Buffer | null {
	const marker = '-----BEGIN MORPHIT POSTING-KEY ATTESTATION-----';
	const idx = text.indexOf(marker);
	if (idx === -1) return null;
	// Everything BEFORE the marker line.  generate.sh's
	// sed-then-`$d` keeps the trailing newline before the marker
	// (since sed lines are newline-terminated and the `$d` drops
	// the marker line itself, the previous newline survives).
	const before = text.slice(0, idx);
	return Buffer.from(before, 'utf8');
}

function verifyPostingKey(text: string, errors: string[]): PostingKeyResult | null {
	const blockMatch = text.match(
		/-----BEGIN MORPHIT POSTING-KEY ATTESTATION-----\s*([\s\S]*?)\s*-----END MORPHIT POSTING-KEY ATTESTATION-----/
	);
	if (blockMatch === null) {
		errors.push('posting-key attestation block is missing');
		return null;
	}
	const body = blockMatch[1]!;

	const accountMatch = body.match(/^account:\s*(\S+)/m);
	const pubMatch = body.match(/^public_key:\s*(\S+)/m);
	const sigMatch = body.match(/^signature:\s*(\S+)/m);

	if (accountMatch === null || pubMatch === null || sigMatch === null) {
		errors.push(
			'posting-key attestation block is malformed — must contain ' +
				'`account:`, `public_key:`, and `signature:` lines'
		);
		return null;
	}

	const account = accountMatch[1]!;
	const declaredPublicKey = pubMatch[1]!;
	const sigB64 = sigMatch[1]!;

	const sigBuf = Buffer.from(sigB64, 'base64');
	if (sigBuf.length !== 65) {
		errors.push(
			`posting-key signature has wrong wire length: ${sigBuf.length} bytes ` +
				'(expected 65 = recovery byte || 64-byte ECDSA data)'
		);
		return null;
	}

	let sig: Signature;
	try {
		sig = Signature.fromBuffer(sigBuf);
	} catch (e) {
		errors.push(
			`posting-key signature failed to parse: ${e instanceof Error ? e.message : String(e)}`
		);
		return null;
	}

	const payload = extractSignedPayload(text);
	if (payload === null) {
		errors.push('could not extract signed payload (BEGIN marker not found)');
		return null;
	}

	const digest = createHash('sha256').update(payload).digest();
	let recoveredPublicKey: string;
	try {
		recoveredPublicKey = sig.recover(digest, 'BLT').toString();
	} catch (e) {
		errors.push(
			`posting-key signature recover() failed: ${e instanceof Error ? e.message : String(e)}`
		);
		return null;
	}

	const verified = recoveredPublicKey === declaredPublicKey;
	if (!verified) {
		errors.push(
			`posting-key attestation does NOT verify — recovered ${recoveredPublicKey} ` +
				`but declared ${declaredPublicKey}.  Either the canary content was ` +
				`tampered with after signing, or the signature was forged with a ` +
				`different key than declared.`
		);
	}

	return { account, declaredPublicKey, recoveredPublicKey, verified };
}

function verify(text: string): Verification {
	const errors: string[] = [];
	const warnings: string[] = [];

	// ── Structural: must start with the canary header.
	if (!text.startsWith('-----BEGIN MORPHIT CANARY-----')) {
		errors.push('missing header line "-----BEGIN MORPHIT CANARY-----"');
	}

	// ── Structural: every required field has been substituted.
	// In a valid canary, none of the {{...}} placeholders remain.
	for (const ph of REQUIRED_PLACEHOLDERS_OR_FILLED) {
		const placeholder = `{{${ph}}}`;
		if (text.includes(placeholder)) {
			errors.push(`unfilled placeholder ${placeholder}`);
		}
	}

	// ── Extract Generated date.
	let generatedAt: string | null = null;
	let ageDays: number | null = null;
	const m = text.match(/^Generated:\s*(\S+)/m);
	if (m) {
		generatedAt = m[1]!;
		const t = Date.parse(generatedAt);
		if (Number.isNaN(t)) {
			errors.push(`Generated: timestamp is not parseable: ${generatedAt}`);
		} else {
			ageDays = (Date.now() - t) / (24 * 3600 * 1000);
			if (ageDays < 0) {
				warnings.push(`Generated: timestamp is in the future (${ageDays.toFixed(1)} days)`);
			}
			if (ageDays > STALE_DAYS) {
				errors.push(
					`canary is stale: generated ${ageDays.toFixed(1)} days ago ` +
						`(limit: ${STALE_DAYS} days).  Treat as silent.`
				);
			}
		}
	} else {
		errors.push('no Generated: line found');
	}

	// ── Posting-key attestation (Part 89).  Stronger than PGP
	// because it's tied to on-chain identity.  An adversary who
	// has compromised the operator's web server but NOT their
	// Blurt posting key cannot forge this.
	const postingKey = verifyPostingKey(text, errors);

	// ── PGP signature presence (warning, not error — the
	// posting-key attestation is the load-bearing signature now,
	// PGP is the convenience-grade familiar verification path).
	if (!text.includes('-----BEGIN PGP SIGNATURE-----')) {
		warnings.push('no PGP signature block — canary is unsigned with PGP');
	}
	if (!text.includes('-----END PGP SIGNATURE-----')) {
		warnings.push('PGP signature block is not closed');
	}

	return {
		ok: errors.length === 0,
		warnings,
		errors,
		generatedAt,
		ageDays,
		postingKey
	};
}

async function loadFromArg(arg: string): Promise<string> {
	if (arg.startsWith('http://') || arg.startsWith('https://')) {
		const res = await fetch(arg);
		if (!res.ok) {
			throw new Error(`fetch ${arg}: HTTP ${res.status}`);
		}
		return await res.text();
	}
	return readFileSync(arg, 'utf8');
}

async function main(): Promise<void> {
	const arg = process.argv[2];
	if (!arg) {
		console.error('usage: verify.ts <path-or-url>');
		process.exit(1);
	}
	let text: string;
	try {
		text = await loadFromArg(arg);
	} catch (err) {
		console.error(
			`canary-verify: load failed: ${err instanceof Error ? err.message : String(err)}`
		);
		process.exit(1);
	}

	const v = verify(text);

	console.log(`source: ${arg}`);
	if (v.generatedAt !== null) {
		console.log(`generated: ${v.generatedAt}`);
	}
	if (v.ageDays !== null) {
		console.log(`age: ${v.ageDays.toFixed(1)} days`);
	}
	if (v.postingKey !== null) {
		console.log(`posting-key account: ${v.postingKey.account}`);
		console.log(`posting-key declared: ${v.postingKey.declaredPublicKey}`);
		console.log(`posting-key recovered: ${v.postingKey.recoveredPublicKey}`);
		console.log(`posting-key verified: ${v.postingKey.verified ? 'YES' : 'NO'}`);
	}
	for (const w of v.warnings) console.log(`  warn: ${w}`);
	for (const e of v.errors) console.log(`  error: ${e}`);

	if (!v.ok) {
		console.log('canary-verify: FAIL');
		process.exit(1);
	}
	if (v.warnings.length > 0) {
		console.log('canary-verify: OK (with warnings)');
		process.exit(2);
	}
	console.log('canary-verify: OK');
}

main().catch((err) => {
	console.error('canary-verify: unhandled:', err);
	process.exit(1);
});
