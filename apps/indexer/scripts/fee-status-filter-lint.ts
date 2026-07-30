/**
 * Fee-status filter lint — tsx smoke runner.
 *
 * Static check that guards against a regression of the
 * Finding I display-layer bug where three public-visibility
 * endpoints had `fee_status = 'verified'` hardcoded instead
 * of the dual-status filter
 * `fee_status IN ('verified', 'verified_by_attestation')`.
 *
 * This is NOT a true runtime smoke — it's a grep. But
 * because the bug's signature is an exact string pattern
 * in the SQL, a grep catches it reliably at near-zero cost.
 *
 * The real-fix path would be to refactor endpoint SQL
 * building into pure helpers testable without the Hono
 * web-server dependency. Until then, this lint shields
 * against the specific regression class.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/fee-status-filter-lint.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Files that expose orders to non-owner viewers and must
 *  therefore allow both verification paths. The RSS routes
 *  live in rssOrderbookHandlers.ts (rssOrderbook.ts is now a
 *  thin Hono adapter with no SQL of its own — the lint
 *  follows the SQL). */
const PROTECTED_FILES = [
	'src/api/orderbook.ts',
	'src/api/rssOrderbookHandlers.ts',
	'src/api/featuredOrderbook.ts'
];

/** The exact anti-pattern: a hardcoded single-value filter
 *  that would silently exclude attestation-verified orders.
 *  Variants covered: single vs double quotes, optional
 *  whitespace around the equals. */
const REGRESSION_PATTERNS = [
	/fee_status\s*=\s*['"]verified['"](?!\s*,)/,
	/o\.fee_status\s*=\s*['"]verified['"](?!\s*,)/
];

/** The required filter shape — one of these MUST appear in
 *  each protected file. */
const REQUIRED_PATTERNS = [
	/fee_status\s+IN\s*\(/i,
	/fee_status\s+IN\s*\(\s*['"]verified['"]\s*,\s*['"]verified_by_attestation['"]/i
];

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── Fee-status filter lint (Finding I regression guard) ─');

for (const rel of PROTECTED_FILES) {
	const path = resolve(ROOT, rel);
	const content = readFileSync(path, 'utf8');

	scenario(`${rel} does not hardcode fee_status = 'verified'`, () => {
		for (const pattern of REGRESSION_PATTERNS) {
			const m = content.match(pattern);
			if (m) {
				throw new Error(
					`found regression pattern "${m[0]}" at index ${m.index}. ` +
						`This would silently exclude attestation-verified orders ` +
						`(Finding I). Use the dual-status IN clause instead.`
				);
			}
		}
	});

	scenario(`${rel} uses the dual-status IN clause`, () => {
		const hasRequired = REQUIRED_PATTERNS.some((p) => p.test(content));
		if (!hasRequired) {
			throw new Error(
				`no fee_status IN (...) clause found. Attestation-verified ` +
					`orders will not appear via this endpoint.`
			);
		}
	});
}

// Also spot-check the feature-bid handler — it gates on fee
// status before accepting bids, and a regression there would
// silently lose users' BLURT on legitimate attestation-verified
// orders.
scenario('featureBid handler accepts verified_by_attestation', () => {
	const path = resolve(ROOT, 'src/indexer/handlers/featureBid.ts');
	const content = readFileSync(path, 'utf8');
	if (!/verified_by_attestation/.test(content)) {
		throw new Error(
			`featureBid handler does not reference verified_by_attestation — ` +
				`would reject legitimate attestation-verified orders as ` +
				`referenced_order_fee_not_verified.`
		);
	}
});

// Type-union completeness check. The orders.ts endpoint has
// an internal OrderRow type that narrows fee_status; if
// anyone ever edits that union to drop pending_external or
// verified_by_attestation (e.g. auto-generated from a stale
// subset), future code destructuring OrderRow will silently
// mis-narrow. We grep for the two values near each other in
// that file. The shared type has its own narrowing — checked
// separately.
scenario('orders.ts OrderRow type includes pending_external + verified_by_attestation', () => {
	const path = resolve(ROOT, 'src/api/orders.ts');
	const content = readFileSync(path, 'utf8');
	// Require string-literal occurrences — a stale comment
	// mentioning a value in prose wouldn't satisfy this.
	if (!/['"]pending_external['"]/.test(content)) {
		throw new Error(
			`orders.ts OrderRow.fee_status no longer lists ` +
				`'pending_external'. Destructurers of OrderRow will ` +
				`mis-narrow against actual DB values.`
		);
	}
	if (!/['"]verified_by_attestation['"]/.test(content)) {
		throw new Error(
			`orders.ts OrderRow.fee_status no longer lists ` + `'verified_by_attestation'.`
		);
	}
});

scenario('shared types include pending_external + verified_by_attestation for fee_status', () => {
	const path = resolve(ROOT, '..', '..', 'packages', 'indexer-client', 'src', 'index.ts');
	const content = readFileSync(path, 'utf8');
	if (!/['"]pending_external['"]/.test(content)) {
		throw new Error(
			`shared types' fee_status union no longer lists ` +
				`'pending_external'. Frontends typechecking against this ` +
				`package will silently ignore real DB values.`
		);
	}
	if (!/['"]verified_by_attestation['"]/.test(content)) {
		throw new Error(
			`shared types' fee_status union no longer lists ` + `'verified_by_attestation'.`
		);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
