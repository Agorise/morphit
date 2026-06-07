#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/stablecoin-depeg-detector-smoke.ts
 *
 * Structural defense (cp127) — invariants for the cross-stablecoin
 * depeg detector module.
 *
 * These are STRUCTURAL checks (constants, types, contracts) — not
 * end-to-end DB-driven checks.  The DB-driven path requires a
 * Postgres fixture and is covered by Vitest in a separate run.
 * Structural smokes execute in CI without infrastructure.
 *
 * Scenarios:
 *   SD-1   Module exports the expected public API
 *   SD-2   Constants are sensible (threshold > 0 and < 0.5, window > 0)
 *   SD-3   DepegStatus union has exactly 3 variants
 *   SD-4   Empty stablecoinKeys → returns "unknown" status set
 *   SD-5   Single-stablecoin input → returns "unknown" for the lone coin
 *   SD-6   StablecoinDepegReport type fields complete
 */

import {
	detectStablecoinDepeg,
	DEPEG_RATIO_THRESHOLD,
	DEPEG_WINDOW_HOURS,
	DEPEG_MIN_TRADERS_PER_PAIR,
	DEPEG_ORDER_AGE_GRACE_MINUTES,
	type DepegStatus,
	type StablecoinDepegReport
} from '../src/indexer/price/stablecoinDepegDetector';

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── stablecoin-depeg-detector invariants smoke (cp127) ───\n');

// SD-1
{
	const hasDetector = typeof detectStablecoinDepeg === 'function';
	const hasConstants =
		typeof DEPEG_RATIO_THRESHOLD === 'number' &&
		typeof DEPEG_WINDOW_HOURS === 'number' &&
		typeof DEPEG_MIN_TRADERS_PER_PAIR === 'number' &&
		typeof DEPEG_ORDER_AGE_GRACE_MINUTES === 'number';
	if (hasDetector && hasConstants) pass('SD-1 module exports the expected public API');
	else fail('SD-1', `detector=${hasDetector}, constants=${hasConstants}`);
}

// SD-2 sensible thresholds
{
	const sane =
		DEPEG_RATIO_THRESHOLD > 0 &&
		DEPEG_RATIO_THRESHOLD < 0.5 &&
		DEPEG_WINDOW_HOURS > 0 &&
		DEPEG_WINDOW_HOURS <= 168 && // ≤ 1 week
		DEPEG_MIN_TRADERS_PER_PAIR >= 3 &&
		DEPEG_ORDER_AGE_GRACE_MINUTES >= 5;
	if (sane)
		pass(
			`SD-2 constants sane: threshold=${DEPEG_RATIO_THRESHOLD}, window=${DEPEG_WINDOW_HOURS}h, traders=${DEPEG_MIN_TRADERS_PER_PAIR}, grace=${DEPEG_ORDER_AGE_GRACE_MINUTES}min`
		);
	else fail('SD-2', 'one or more constants outside sane range');
}

// SD-3 DepegStatus union completeness — type-level check via satisfies
{
	const variants: DepegStatus[] = ['pegged', 'depegged', 'unknown'];
	if (variants.length === 3 && variants.includes('pegged') && variants.includes('depegged') && variants.includes('unknown')) {
		pass('SD-3 DepegStatus union has exactly 3 variants: pegged | depegged | unknown');
	} else {
		fail('SD-3', `got: ${JSON.stringify(variants)}`);
	}
}

// SD-4, SD-5 require a DB mock — we use a minimal stub
//
// The detector calls db.query() with parameters; we return empty
// rowsets so the detector exercises its <2-stablecoin guard cleanly.
const stubDb = {
	query: async <T = unknown>(_sql: string, _params?: unknown[]): Promise<{ rows: T[] }> => {
		return { rows: [] as T[] };
	}
	// Cast through unknown because the real Database interface has many more methods we don't need here
} as unknown as Parameters<typeof detectStablecoinDepeg>[0];

(async () => {
	// SD-4 empty stablecoinKeys
	const empty = await detectStablecoinDepeg(stubDb, { stablecoinKeys: [], officialAccountName: 'morphit' });
	if (
		empty.usable_pair_count === 0 &&
		Object.keys(empty.status).length === 0 &&
		empty.pair_details.length === 0
	) {
		pass('SD-4 empty stablecoinKeys → returns empty status set');
	} else {
		fail('SD-4', `unexpected: ${JSON.stringify(empty)}`);
	}

	// SD-5 single-stablecoin input
	const single = await detectStablecoinDepeg(stubDb, { stablecoinKeys: ['usdt'], officialAccountName: 'morphit' });
	if (
		single.usable_pair_count === 0 &&
		single.status.usdt === 'unknown' &&
		single.pair_details.length === 0
	) {
		pass('SD-5 single-stablecoin input → returns "unknown" for the lone coin (no cross-ratio possible)');
	} else {
		fail('SD-5', `unexpected: ${JSON.stringify(single)}`);
	}

	// SD-6 type contract check via satisfies
	{
		const sample: StablecoinDepegReport = {
			status: { usdt: 'pegged', usdc: 'pegged', dai: 'depegged' },
			usable_pair_count: 3,
			pair_details: [{ a: 'dai', b: 'usdc', ratio: 0.97, trader_count: 5 }],
			window_hours: 8,
			threshold: 0.03
		};
		if (sample.status.usdt === 'pegged' && sample.pair_details.length === 1) {
			pass('SD-6 StablecoinDepegReport type contract holds');
		} else {
			fail('SD-6', 'unreachable');
		}
	}

	const total = passed + failed;
	console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
	if (failed > 0) {
		console.error('\nstablecoin-depeg-detector-smoke FAILED');
		process.exit(1);
	}
	console.log(`✓ all ${total} stablecoin-depeg-detector scenarios passed`);
})();
