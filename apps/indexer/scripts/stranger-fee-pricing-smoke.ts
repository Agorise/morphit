/**
 * Stranger-fee pricing helper — tsx smoke runner.
 *
 * Exercises getStrangerFeeQuote() in isolation against a
 * Queryable mock. Verifies the count → multiplier sequence
 * (1, 2, 4, 8, 16, 32, 64, 128, 128, 128, ...) and the
 * resulting BLURT price.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/stranger-fee-pricing-smoke.ts
 */

import {
	getStrangerFeeQuote,
	STRANGER_FEE_BASE_BLURT,
	STRANGER_FEE_MAX_DOUBLINGS,
	STRANGER_FEE_MAX_MULTIPLIER,
	STRANGER_FEE_WINDOW_MINUTES,
	type Queryable
} from '../src/indexer/strangerFeePricing.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

/** Minimal Queryable mock that returns a single canned count. */
function mockClientWithCount(count: number): Queryable {
	return {
		query: async <R extends Record<string, unknown>>(
			text: string,
			params: readonly unknown[]
		): Promise<{ rows: R[]; rowCount: number | null }> => {
			if (!text.includes('paid_at >')) {
				throw new Error(`unexpected query: ${text.slice(0, 80)} — expected count query`);
			}
			if (params.length !== 2) {
				throw new Error(`expected 2 params (sender, interval), got ${params.length}`);
			}
			const interval = params[1];
			if (typeof interval !== 'string' || !interval.includes('minutes')) {
				throw new Error(`expected interval string with 'minutes', got ${String(interval)}`);
			}
			return {
				rows: [{ count: String(count) }] as unknown as R[],
				rowCount: 1
			};
		}
	};
}

/** Mock that asserts the 3-param (deterministic) branch is taken. */
function mockClientWithCountDeterministic(count: number, expectedNow: Date): Queryable {
	return {
		query: async <R extends Record<string, unknown>>(
			text: string,
			params: readonly unknown[]
		): Promise<{ rows: R[]; rowCount: number | null }> => {
			if (!text.includes('paid_at >')) {
				throw new Error(`unexpected query: ${text.slice(0, 80)} — expected count query`);
			}
			if (params.length !== 3) {
				throw new Error(`expected 3 params (sender, interval, now), got ${params.length}`);
			}
			// The query must NOT use NOW() — replay safety requires
			// the timestamp come from the caller's blockTime.
			if (text.includes('NOW()')) {
				throw new Error(`replay-safe path must not include NOW() — got: ${text}`);
			}
			if (!text.includes('$3::timestamptz')) {
				throw new Error(`replay-safe path must use $3::timestamptz — got: ${text}`);
			}
			const passedNow = params[2];
			if (!(passedNow instanceof Date) || passedNow.getTime() !== expectedNow.getTime()) {
				throw new Error(`expected $3 to be the passed-in now Date, got ${String(passedNow)}`);
			}
			return {
				rows: [{ count: String(count) }] as unknown as R[],
				rowCount: 1
			};
		}
	};
}

console.log('\n── Stranger-fee pricing helper ──────────────────────');

// ─── Multiplier sequence ─────────────────────────────────────

const cases: ReadonlyArray<{
	count: number;
	expectedMultiplier: number;
	expectedPriceBlurt: number;
	expectedCapped: boolean;
}> = [
	{ count: 0, expectedMultiplier: 1, expectedPriceBlurt: 5, expectedCapped: false },
	{ count: 1, expectedMultiplier: 2, expectedPriceBlurt: 10, expectedCapped: false },
	{ count: 2, expectedMultiplier: 4, expectedPriceBlurt: 20, expectedCapped: false },
	{ count: 3, expectedMultiplier: 8, expectedPriceBlurt: 40, expectedCapped: false },
	{ count: 4, expectedMultiplier: 16, expectedPriceBlurt: 80, expectedCapped: false },
	{ count: 5, expectedMultiplier: 32, expectedPriceBlurt: 160, expectedCapped: false },
	{ count: 6, expectedMultiplier: 64, expectedPriceBlurt: 320, expectedCapped: false },
	{ count: 7, expectedMultiplier: 128, expectedPriceBlurt: 640, expectedCapped: true },
	{ count: 8, expectedMultiplier: 128, expectedPriceBlurt: 640, expectedCapped: true },
	{ count: 100, expectedMultiplier: 128, expectedPriceBlurt: 640, expectedCapped: true }
];

for (const c of cases) {
	await scenario(
		`count=${c.count} → multiplier=${c.expectedMultiplier}, price=${c.expectedPriceBlurt} BLURT, capped=${c.expectedCapped}`,
		async () => {
			const mock = mockClientWithCount(c.count);
			const quote = await getStrangerFeeQuote(mock, 'alice');
			assertEqual(quote.multiplier, c.expectedMultiplier, 'multiplier');
			assertEqual(quote.recentCount, c.count, 'recentCount');
			assertEqual(quote.capped, c.expectedCapped, 'capped');
			// Use a tolerance for FP — Math.pow can introduce
			// rounding for large exponents, though 2^N for small N
			// is exact in IEEE-754.
			const diff = Math.abs(quote.priceBlurt - c.expectedPriceBlurt);
			if (diff > 1e-9) {
				throw new Error(`priceBlurt: expected ${c.expectedPriceBlurt}, got ${quote.priceBlurt}`);
			}
		}
	);
}

// ─── Empty-row defensive case ────────────────────────────────

await scenario('handles empty result rows as count=0', async () => {
	// Postgres COUNT(*) always returns one row with count='0',
	// but if a future schema migration breaks that we shouldn't
	// crash. Treat the empty/undefined row as count=0.
	const mock: Queryable = {
		query: async () => ({ rows: [], rowCount: 0 })
	};
	const quote = await getStrangerFeeQuote(mock, 'alice');
	assertEqual(quote.multiplier, 1, 'multiplier');
	assertEqual(quote.recentCount, 0, 'recentCount');
	assertEqual(quote.capped, false, 'capped');
});

// ─── Constants sanity ────────────────────────────────────────

await scenario('exported constants match documented values', () => {
	assertEqual(STRANGER_FEE_BASE_BLURT, 5, 'base BLURT');
	assertEqual(STRANGER_FEE_MAX_DOUBLINGS, 8, 'max doublings');
	assertEqual(STRANGER_FEE_MAX_MULTIPLIER, 128, 'max multiplier');
	assertEqual(STRANGER_FEE_WINDOW_MINUTES, 5, 'window minutes');
});

// ─── Replay-safe (deterministic now) path ────────────────────
// P4-10 (HIGH) audit fix: when replaying chain history, the
// query must use the caller's blockTime, not NOW(). Otherwise
// historical fees fall outside the 5-minute window during
// replay and the same op gets a different verdict than it did
// in real time.

const REPLAY_NOW = new Date('2026-04-30T15:00:00Z');

await scenario('passing now Date triggers deterministic query path', async () => {
	const mock = mockClientWithCountDeterministic(3, REPLAY_NOW);
	const quote = await getStrangerFeeQuote(mock, 'alice', REPLAY_NOW);
	assertEqual(quote.recentCount, 3, 'recentCount');
	assertEqual(quote.multiplier, 8, 'multiplier');
});

await scenario('omitting now uses NOW() (real-time) path', async () => {
	// mockClientWithCount asserts 2 params + that the query uses
	// NOW(). If the omit-now path accidentally uses the new branch,
	// this will fail.
	const mock: Queryable = {
		query: async <R extends Record<string, unknown>>(
			text: string,
			params: readonly unknown[]
		): Promise<{ rows: R[]; rowCount: number | null }> => {
			if (params.length !== 2) {
				throw new Error(`omit-now path should use 2 params, got ${params.length}`);
			}
			if (!text.includes('NOW()')) {
				throw new Error(`omit-now path should use NOW(), got: ${text}`);
			}
			return {
				rows: [{ count: '0' }] as unknown as R[],
				rowCount: 1
			};
		}
	};
	const quote = await getStrangerFeeQuote(mock, 'alice');
	assertEqual(quote.recentCount, 0, 'recentCount');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
