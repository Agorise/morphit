/**
 * /v1/listing-fee + /v1/stranger-fee-quote response-shape smokes.
 *
 * Exercises the pure response-body builders extracted from the
 * Hono routes:
 *   - buildListingFeeBody (apps/indexer/src/api/listingFeeBody.ts)
 *   - buildStrangerFeeQuoteBody (apps/indexer/src/api/strangerFeeQuoteBody.ts)
 *   - isAccountName (apps/indexer/src/api/shared.ts)
 *
 * Why pure-helper smokes instead of full Hono route smokes:
 * the sandbox doesn't have node_modules installed, so we can't
 * load `hono` at runtime.  The route handlers stay thin wrappers
 * around the pure helpers; this smoke covers the interesting
 * gating and response-shape logic.  The Hono routing itself
 * (URL matching, status codes for invalid input) is exercised
 * indirectly via the helpers + isAccountName.
 *
 * Closes the API-endpoint smoke gap from §F.11 close-out
 * residual #6.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/api-response-shape-smoke.ts
 */

import { buildListingFeeBody } from '../src/api/listingFeeBody.ts';
import { buildStrangerFeeQuoteBody } from '../src/api/strangerFeeQuoteBody.ts';
import { isAccountName } from '../src/api/shared.ts';
import { fakeConfig } from '../test/testutils/context.ts';
import type { BlurtPriceSource } from '../src/indexer/price/source.ts';
import type { Queryable } from '../src/indexer/strangerFeePricing.ts';

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

function assertContains(haystack: Record<string, unknown>, key: string): void {
	if (!(key in haystack)) {
		throw new Error(`expected key ${key} in response body, missing`);
	}
}

function assertAbsent(haystack: Record<string, unknown>, key: string): void {
	if (key in haystack) {
		throw new Error(`expected key ${key} ABSENT, but it's present`);
	}
}

function makePriceSource(opts: { price: number; stale: boolean }): BlurtPriceSource {
	return {
		current: () => opts.price,
		currentDetailed: () => ({
			price: opts.price,
			source: 'test',
			updated_at: new Date(0),
			stale: opts.stale
		}),
		start: () => undefined,
		stop: () => undefined
	};
}

function mockClientWithCount(count: number): Queryable {
	return {
		query: async <R extends Record<string, unknown>>(
			text: string,
			_params: readonly unknown[]
		): Promise<{ rows: R[]; rowCount: number | null }> => {
			if (!text.includes('paid_at >')) {
				throw new Error(`unexpected query: ${text.slice(0, 80)}`);
			}
			return {
				rows: [{ count: String(count) } as unknown as R],
				rowCount: 1
			};
		}
	};
}

// ─── /v1/listing-fee body ───────────────────────────────────────

await scenario('listing-fee body: returns base + feature-fee + ttl', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60, featureFeeBlurtPerHour: 50 });
	const body = buildListingFeeBody(cfg, null);
	assertEqual(body.base_fee_blurt, 60, 'base_fee_blurt');
	assertEqual(body.feature_fee_blurt_per_hour, 50, 'feature_fee_blurt_per_hour');
	assertEqual(body.quote_ttl_seconds, 300, 'quote_ttl_seconds');
});

await scenario('listing-fee body: omits fiat echo when priceSource is null', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60 });
	const body = buildListingFeeBody(cfg, null);
	assertAbsent(body, 'base_fee_fiat');
	assertAbsent(body, 'blurt_price_fiat');
	assertAbsent(body, 'denomination_fiat');
});

await scenario('listing-fee body: includes fiat echo when price is non-stale and positive', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.002, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	assertContains(body, 'base_fee_fiat');
	assertContains(body, 'blurt_price_fiat');
	assertContains(body, 'denomination_fiat');
	assertEqual(body.base_fee_fiat, 0.12, 'base_fee_fiat'); // 60 * 0.002
	assertEqual(body.blurt_price_fiat, 0.002, 'blurt_price_fiat');
	// cp128: default config denomination is 'USD'; operators in
	// non-USD markets configure differently.  The fakeConfig helper
	// defaults to 'USD' to match.
	assertEqual(body.denomination_fiat, 'USD', 'denomination_fiat');
});

await scenario('listing-fee body: omits fiat echo when price is stale', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.002, stale: true });
	const body = buildListingFeeBody(cfg, ps);
	assertAbsent(body, 'base_fee_fiat');
	assertAbsent(body, 'blurt_price_fiat');
	assertAbsent(body, 'denomination_fiat');
});

await scenario('listing-fee body: omits fiat echo when price is zero', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	assertAbsent(body, 'base_fee_fiat');
	assertAbsent(body, 'blurt_price_fiat');
	assertAbsent(body, 'denomination_fiat');
});

await scenario('listing-fee body: omits fiat echo when price is negative', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: -1, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	assertAbsent(body, 'base_fee_fiat');
	assertAbsent(body, 'blurt_price_fiat');
	assertAbsent(body, 'denomination_fiat');
});

await scenario('listing-fee body: tracks operator-tunable feeBaseBlurt', () => {
	// Operator runs feeBaseBlurt=80 — endpoint reports 80, the
	// frontend (post-Option-1) reads it for fee math.  This is
	// the federation-tunability invariant in API-body form.
	const cfg = fakeConfig({ feeBaseBlurt: 80 });
	const body = buildListingFeeBody(cfg, null);
	assertEqual(body.base_fee_blurt, 80, 'base_fee_blurt');
});

await scenario('listing-fee body: fiat echo math respects operator-tunable feeBaseBlurt', () => {
	// 80 BLURT × $0.002 = $0.16.
	const cfg = fakeConfig({ feeBaseBlurt: 80, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.002, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	assertEqual(body.base_fee_fiat, 0.16, 'base_fee_fiat');
});

await scenario('listing-fee body (cp128): EUR-denominated operator returns EUR in denomination_fiat', () => {
	const cfg = fakeConfig({
		feeBaseBlurt: 60,
		priceFeedEnabled: true,
		priceFeedDenominationFiat: 'EUR'
	});
	const ps = makePriceSource({ price: 0.0018, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	assertEqual(body.denomination_fiat, 'EUR', 'denomination_fiat');
	assertEqual(body.blurt_price_fiat, 0.0018, 'blurt_price_fiat');
	assertEqual(body.base_fee_fiat, 0.108, 'base_fee_fiat'); // 60 * 0.0018
});

await scenario('listing-fee body (cp128): XAU-denominated operator returns XAU in denomination_fiat', () => {
	// Gold-denominated instance — pricing in fractional ounces.
	const cfg = fakeConfig({
		feeBaseBlurt: 60,
		priceFeedEnabled: true,
		priceFeedDenominationFiat: 'XAU'
	});
	const ps = makePriceSource({ price: 0.00000037, stale: false }); // ~$0.002 at $5500/oz
	const body = buildListingFeeBody(cfg, ps);
	assertEqual(body.denomination_fiat, 'XAU', 'denomination_fiat');
	assertEqual(body.blurt_price_fiat, 0.00000037, 'blurt_price_fiat');
});

// ─── /v1/stranger-fee-quote body ────────────────────────────────

await scenario('stranger-fee-quote body: base price for sender with no recent fees', async () => {
	const body = await buildStrangerFeeQuoteBody(mockClientWithCount(0), 'alice');
	assertEqual(body.account, 'alice', 'account');
	assertEqual(body.base_price_blurt, 5, 'base_price_blurt');
	assertEqual(body.price_blurt, 5, 'price_blurt');
	assertEqual(body.multiplier, 1, 'multiplier');
	assertEqual(body.recent_count, 0, 'recent_count');
	assertEqual(body.window_minutes, 5, 'window_minutes');
	assertEqual(body.capped, false, 'capped');
	assertEqual(body.max_multiplier, 128, 'max_multiplier');
});

await scenario('stranger-fee-quote body: 1 recent fee → 2× multiplier (10 BLURT)', async () => {
	const body = await buildStrangerFeeQuoteBody(mockClientWithCount(1), 'alice');
	assertEqual(body.multiplier, 2, 'multiplier');
	assertEqual(body.price_blurt, 10, 'price_blurt');
	assertEqual(body.recent_count, 1, 'recent_count');
	assertEqual(body.capped, false, 'capped');
});

await scenario(
	'stranger-fee-quote body: 7 recent fees → 128× multiplier (cap, 640 BLURT)',
	async () => {
		const body = await buildStrangerFeeQuoteBody(mockClientWithCount(7), 'alice');
		assertEqual(body.multiplier, 128, 'multiplier');
		assertEqual(body.price_blurt, 640, 'price_blurt');
		assertEqual(body.recent_count, 7, 'recent_count');
		assertEqual(body.capped, true, 'capped');
	}
);

await scenario(
	'stranger-fee-quote body: 50 recent fees still capped at 128× (no overflow)',
	async () => {
		// Defense against unbounded multiplier growth — the cap holds
		// even on absurd recent-counts.  Without it, a sender at count
		// 50 would face 2^50 × base = financial irrelevance.
		const body = await buildStrangerFeeQuoteBody(mockClientWithCount(50), 'alice');
		assertEqual(body.multiplier, 128, 'multiplier');
		assertEqual(body.price_blurt, 640, 'price_blurt');
		assertEqual(body.capped, true, 'capped');
	}
);

await scenario('stranger-fee-quote body: account name passed through verbatim', async () => {
	const body = await buildStrangerFeeQuoteBody(mockClientWithCount(0), 'bob-example-account');
	assertEqual(body.account, 'bob-example-account', 'account');
});

// ─── isAccountName (the route's pre-validation) ─────────────────

await scenario('isAccountName: accepts a normal account name', () => {
	if (!isAccountName('alice')) {
		throw new Error('alice should be accepted');
	}
	if (!isAccountName('alice-2026')) {
		throw new Error('alice-2026 should be accepted');
	}
	if (!isAccountName('bob123')) {
		throw new Error('bob123 should be accepted');
	}
});

await scenario('isAccountName: rejects empty string', () => {
	if (isAccountName('')) {
		throw new Error('empty string should be rejected');
	}
});

await scenario('isAccountName: rejects too-short names (<3 chars)', () => {
	if (isAccountName('ab')) {
		throw new Error('ab (2 chars) should be rejected');
	}
});

await scenario('isAccountName: rejects too-long names (>16 chars)', () => {
	if (isAccountName('abcdefghijklmnopq')) {
		throw new Error('17-char name should be rejected');
	}
});

await scenario('isAccountName: rejects uppercase', () => {
	if (isAccountName('Alice')) {
		throw new Error('uppercase should be rejected');
	}
});

await scenario('isAccountName: rejects underscores', () => {
	if (isAccountName('my_account')) {
		throw new Error('underscore should be rejected');
	}
});

await scenario('isAccountName: rejects names starting with a digit', () => {
	if (isAccountName('1alice')) {
		throw new Error('digit-leading should be rejected');
	}
});

await scenario('isAccountName: rejects non-string input', () => {
	if (isAccountName(null)) throw new Error('null should be rejected');
	if (isAccountName(undefined)) throw new Error('undefined should be rejected');
	if (isAccountName(123)) throw new Error('number should be rejected');
});

// ─── Final report ───────────────────────────────────────────────

console.log();
console.log('────────────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} scenarios passed`);
