#!/usr/bin/env tsx
/**
 * relay-client contract-symmetry-smoke — keep @morphit/relay-client's
 * `RelayErrorCode` union in sync with what the relay code actually
 * emits on the wire.
 *
 * Part 122 cp7 — created after the cp6 deep-deep found seven
 * contract gaps in the initial relay-client extraction:
 *
 *   F16 — ghost code `invite_required` was in the union but the
 *         relay never emits it
 *   F17 — `chunked_unsupported` emitted by security middleware
 *         was missing
 *   F18 — `malformed_request` emitted by three sites was missing
 *   F19 — `origin_required` + `origin_not_allowed` emitted by
 *         origin-enforcement middleware were missing
 *   F20 — `internal` emitted by main.ts onError catch-all was
 *         missing
 *
 * All seven were hand-extraction omissions; this smoke would have
 * caught every one mechanically.
 *
 * Two-way symmetry rule:
 *
 *   (A) Every `code: '<literal>'` string in apps/relay/src/ MUST
 *       appear in `RelayErrorCode`'s union.  Missing codes mean
 *       the contract under-promises (worse failure mode: types
 *       pass while consumers fall through to a default).
 *
 *   (B) Every `RelayErrorCode` union member MUST appear somewhere
 *       in apps/relay/src/ as a `code: '<literal>'` emission.
 *       Ghost members mean the contract over-promises (consumers
 *       prepare for codes that never arrive — wasted i18n keys,
 *       dead error-handling branches).
 *
 * Both directions are equally serious for the schema-as-contract
 * pattern — the whole point of having a shared package is that
 * the contract reflects reality.
 *
 * The smoke deliberately scans `apps/relay/src/` (production code
 * only) and excludes test files (`*.test.ts`), since test scenarios
 * may construct synthetic codes for negative-path coverage.
 *
 * Usage:
 *   tsx packages/relay-client/scripts/contract-symmetry-smoke.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const RELAY_SRC = join(REPO_ROOT, 'apps', 'relay', 'src');
const RELAY_CLIENT_INDEX = join(REPO_ROOT, 'packages', 'relay-client', 'src', 'index.ts');

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

/** Walk apps/relay/src/ for *.ts files (excluding tests). */
function walkRelayTsFiles(): string[] {
	if (!existsSync(RELAY_SRC)) return [];
	const out: string[] = [];
	const stack: string[] = [RELAY_SRC];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(full);
			} else if (ent.isFile() && ent.name.endsWith('.ts')) {
				if (ent.name.endsWith('.test.ts')) continue;
				out.push(full);
			}
		}
	}
	return out;
}

/** Extract every `code: '<literal>'` string the relay can emit. */
function collectRelayEmittedCodes(): Set<string> {
	const codes = new Set<string>();
	for (const path of walkRelayTsFiles()) {
		const src = readFileSync(path, 'utf-8');
		// Match `code: '<literal>'` in JSON-body construction sites
		// AND in discriminated-union return-type definitions
		// (e.g. `| { ok: false; code: 'altcha_malformed' }`).
		// Both shapes mean "this code is part of the wire contract."
		for (const m of src.matchAll(/code:\s*'([a-z_][a-z0-9_]*)'/g)) {
			codes.add(m[1]!);
		}
	}
	return codes;
}

/** Parse the `RelayErrorCode` union member literals from index.ts. */
function parseRelayErrorCodeUnion(): Set<string> {
	let src = readFileSync(RELAY_CLIENT_INDEX, 'utf-8');
	// Strip JSDoc block comments BEFORE the [^;]+ regex looks for
	// the union terminator — block comments routinely contain `;`
	// (e.g. "Chunked transfer-encoding rejected; client must send
	// Content-Length.") which would otherwise truncate the union
	// at the first comment-internal semicolon.  Bug caught during
	// cp7 smoke development.
	src = src.replace(/\/\*[\s\S]*?\*\//g, '');
	// Strip line comments too for the same reason.
	src = src.replace(/^[ \t]*\/\/.*$/gm, '');
	const blockMatch = /export type RelayErrorCode =([^;]+);/m.exec(src);
	if (!blockMatch) {
		throw new Error(
			'Could not locate `export type RelayErrorCode = ...;` block in relay-client/src/index.ts'
		);
	}
	const block = blockMatch[1]!;
	const codes = new Set<string>();
	for (const m of block.matchAll(/\|\s*'([a-z_][a-z0-9_]*)'/g)) {
		codes.add(m[1]!);
	}
	return codes;
}

// ─── Internal-only codes that the relay defines as code: '...' in
//     module-internal Result types but never emits on the wire.
//     These are LEGITIMATELY not in RelayErrorCode and excluded from
//     the symmetry check.
const INTERNAL_ONLY_CODES = new Set<string>([
	// apps/relay/src/crypto/keyEnvelope.ts — Result type for
	// keystore decryption.  These never reach an HTTP response.
	'decryption_failed',
	'malformed',
	'weak_params',
	// apps/relay/src/crypto/promptPassphrase.ts — Result type for
	// startup-only TTY-prompt errors.  No HTTP path exposes these.
	'no_tty',
	'cancelled',
	'timeout',
	'empty'
]);

// ─── Run ──
const emittedCodes = collectRelayEmittedCodes();
const unionCodes = parseRelayErrorCodeUnion();

// Filter out internal-only codes from the emitted set for the
// symmetry check.
const wireEmittedCodes = new Set<string>();
for (const c of emittedCodes) {
	if (!INTERNAL_ONLY_CODES.has(c)) {
		wireEmittedCodes.add(c);
	}
}

// (A) Every wire-emitted code must be in the union.
const missingFromUnion = [...wireEmittedCodes].filter((c) => !unionCodes.has(c));
results.push({
	name: 'every relay-emitted code is in RelayErrorCode union (direction A)',
	ok: missingFromUnion.length === 0,
	detail:
		missingFromUnion.length === 0
			? undefined
			: `Codes emitted by apps/relay/src/ but absent from RelayErrorCode: ` +
			  `[${missingFromUnion.sort().join(', ')}].  ` +
			  `Add them to the union in packages/relay-client/src/index.ts. ` +
			  `If a code is internal-only (never reaches an HTTP response), add it to ` +
			  `INTERNAL_ONLY_CODES in this smoke instead.`
});

// (B) Every union member must be emitted somewhere in the relay.
const ghostMembers = [...unionCodes].filter((c) => !emittedCodes.has(c));
results.push({
	name: 'every RelayErrorCode union member is emitted by the relay (direction B)',
	ok: ghostMembers.length === 0,
	detail:
		ghostMembers.length === 0
			? undefined
			: `Union members declared in RelayErrorCode but never emitted by ` +
			  `apps/relay/src/: [${ghostMembers.sort().join(', ')}].  ` +
			  `Either remove these ghost members from the union (the contract is ` +
			  `over-promising), or grep more carefully — they may be emitted via an ` +
			  `indirection this smoke doesn't follow.`
});

// (C) Sanity: at least some codes were found on both sides.
results.push({
	name: 'sanity: at least 10 codes emitted by relay (catches a parse failure)',
	ok: emittedCodes.size >= 10,
	detail:
		emittedCodes.size >= 10
			? undefined
			: `Found only ${emittedCodes.size} code: '<literal>' references in apps/relay/src/. ` +
			  `Expected dozens.  Did the relay source-tree layout change?`
});
results.push({
	name: 'sanity: at least 10 codes in RelayErrorCode union (catches a parse failure)',
	ok: unionCodes.size >= 10,
	detail:
		unionCodes.size >= 10
			? undefined
			: `Parsed only ${unionCodes.size} members from RelayErrorCode union. ` +
			  `Expected dozens.  Is the type block formatted unexpectedly?`
});

// ─── Report ──
console.log(
	`relay-client contract-symmetry smoke: ${results.length} scenarios ` +
		`(${emittedCodes.size} relay-emitted codes — ${INTERNAL_ONLY_CODES.size} ` +
		`internal-only = ${wireEmittedCodes.size} wire-emitted; ` +
		`${unionCodes.size} RelayErrorCode union members)\n`
);
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) {
			for (const line of r.detail.split('\n')) {
				console.log(`      ${line}`);
			}
		}
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} contract-symmetry checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${results.length - failed} passed`);
	process.exit(1);
}
