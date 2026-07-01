#!/usr/bin/env tsx
/**
 * scripts/canary/verify.ts
 *
 * Verify a Morphit canary file for freshness and structural
 * sanity.  Used by:
 *
 *   1. CI on every PR that modifies the canary template — fails
 *      the build if the template is missing required placeholders.
 *
 *   2. Operators running `npx tsx scripts/canary/verify.ts <url>`
 *      against their own (or another operator's) canary as a quick
 *      "is it still being published, and is it fresh?" check.
 *
 *      The cryptographic check is the PGP signature: verify it
 *      out-of-band with `gpg --verify` against the operator's
 *      release public key (published at /pgp_keys.asc on the same
 *      instance).  This script confirms the PGP signature block is
 *      PRESENT and the freshness window is intact; it does not
 *      itself run gpg.
 *
 *   3. The frontend's degraded-canary banner pulls /canary.txt and
 *      applies similar freshness logic in JS.  This script is the
 *      authoritative reference for what "fresh" means.
 *
 * Exit codes:
 *   0  — structurally valid, PGP signature block present, and the
 *        freshness window is intact.
 *   1  — missing, malformed, no PGP signature block, or the
 *        freshness window has expired (treat as silent).
 *   2  — valid but with non-fatal warnings (e.g. a future-dated
 *        Generated: timestamp).
 */

import { readFileSync } from 'node:fs';

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
	'NEWS_HEADLINE'
];

const STALE_DAYS = 14;

interface Verification {
	readonly ok: boolean;
	readonly warnings: readonly string[];
	readonly errors: readonly string[];
	readonly generatedAt: string | null;
	readonly ageDays: number | null;
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

	// ── Extract Generated date and check the freshness window.
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

	// ── PGP signature is the canary's cryptographic anchor, so its
	// ABSENCE is a hard error (an unsigned canary proves nothing).
	// Signature VALIDITY is checked out-of-band with `gpg --verify`;
	// here we only confirm the block is present and closed.
	if (!text.includes('-----BEGIN PGP SIGNATURE-----')) {
		errors.push('no PGP signature block — canary is unsigned');
	}
	if (!text.includes('-----END PGP SIGNATURE-----')) {
		errors.push('PGP signature block is not closed');
	}

	return {
		ok: errors.length === 0,
		warnings,
		errors,
		generatedAt,
		ageDays
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
