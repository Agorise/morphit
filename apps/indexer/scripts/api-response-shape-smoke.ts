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
	// Canonical Model A: base tracks LISTING_FEE_USD.blurt ÷ price =
	// 62.5 BLURT at the $0.002 reference, so the echo is the canonical
	// ~$0.125 — NOT feeBaseBlurt × price.
	assertEqual(body.base_fee_fiat, 0.125, 'base_fee_fiat');
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

await scenario('listing-fee body: canonical display ignores feeBaseBlurt for the live amount', () => {
	// Pre-cp372 the displayed fee was feeBaseBlurt-driven (80 × $0.002
	// = $0.16).  Under canonical Model A the DISPLAY tracks the
	// canonical target (~$0.125) regardless of the operator's
	// feeBaseBlurt — that value is now the enforcement floor, not the
	// quote.  (No-price fallback still reports feeBaseBlurt; see below.)
	const cfg = fakeConfig({ feeBaseBlurt: 80, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.002, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	assertEqual(body.base_fee_fiat, 0.125, 'base_fee_fiat is canonical, not 80×price');
	assertEqual(body.base_fee_blurt, 62.5, 'base_fee_blurt is canonical 62.5, not 80');
});

// ── Model A (cp372): displayed base tracks the operator's USD fee ──
const approxEq = (actual: unknown, expected: number, label: string, eps = 1e-9): void => {
	if (typeof actual !== 'number' || Math.abs(actual - expected) > eps) {
		throw new Error(`${label}: expected ≈${expected}, got ${JSON.stringify(actual)}`);
	}
};

await scenario('listing-fee body (Model A): USD base is canonical 62.5 at the reference price', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.002, stale: false }); // == reference
	const body = buildListingFeeBody(cfg, ps);
	approxEq(body.base_fee_blurt, 62.5, 'base_fee_blurt canonical at reference (not feeBaseBlurt)');
	assertEqual(body.base_fee_blurt_live, true, 'base_fee_blurt_live');
});

await scenario('listing-fee body (Model A): BLURT appreciated → fewer BLURT, USD value held', () => {
	// Price doubled to $0.004: canonical amount halves to 31.25 BLURT,
	// USD value stays the canonical target ($0.125).
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.004, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	approxEq(body.base_fee_blurt, 31.25, 'base_fee_blurt halves on 2× price');
	approxEq(body.base_fee_fiat, 0.125, 'base_fee_fiat held at canonical target');
	assertEqual(body.base_fee_blurt_live, true, 'base_fee_blurt_live');
});

await scenario('listing-fee body (Model A): BLURT depreciated → more BLURT, USD value held', () => {
	// Price halved to $0.001: canonical amount doubles to 125 BLURT.
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.001, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	approxEq(body.base_fee_blurt, 125, 'base_fee_blurt doubles on ½ price');
	approxEq(body.base_fee_fiat, 0.125, 'base_fee_fiat held at canonical target');
});

await scenario('listing-fee body (Model A): canonical display is independent of feeBaseBlurt', () => {
	// Two operators with different floors (60 vs 80) quote the SAME
	// canonical amount — the floor never leaks into the quote.
	const ps = makePriceSource({ price: 0.004, stale: false });
	const a = buildListingFeeBody(fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true }), ps);
	const b = buildListingFeeBody(fakeConfig({ feeBaseBlurt: 80, priceFeedEnabled: true }), ps);
	approxEq(a.base_fee_blurt, 31.25, 'operator A canonical');
	approxEq(b.base_fee_blurt, 31.25, 'operator B canonical (same, ignores 80)');
});

await scenario('listing-fee body (Model A): base_fee_blurt_live false when no price', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60 });
	const body = buildListingFeeBody(cfg, null);
	assertEqual(body.base_fee_blurt, 60, 'base_fee_blurt is pinned fallback');
	assertEqual(body.base_fee_blurt_live, false, 'base_fee_blurt_live false');
});

await scenario('listing-fee body (Model A): base_fee_blurt_live false when price stale', () => {
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true });
	const ps = makePriceSource({ price: 0.002, stale: true });
	const body = buildListingFeeBody(cfg, ps);
	assertEqual(body.base_fee_blurt, 60, 'base_fee_blurt is pinned fallback when stale');
	assertEqual(body.base_fee_blurt_live, false, 'base_fee_blurt_live false');
});

await scenario('listing-fee body (Model A): non-USD denomination keeps pinned base (no USD scaling)', () => {
	// EUR operator: live USD figure isn't available in this route, so
	// the base stays the operator's pinned feeBaseBlurt (graceful).
	const cfg = fakeConfig({ feeBaseBlurt: 60, priceFeedEnabled: true, priceFeedDenominationFiat: 'EUR' });
	const ps = makePriceSource({ price: 0.0018, stale: false });
	const body = buildListingFeeBody(cfg, ps);
	assertEqual(body.base_fee_blurt, 60, 'base_fee_blurt unscaled for non-USD');
	assertEqual(body.base_fee_blurt_live, false, 'base_fee_blurt_live false for non-USD');
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

// ── Model A (cp372): live BTC/XMR fee amounts (USD-denominated) ──

await scenario('listing-fee body (Model A): BTC live amount equals pinned at the reference price', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true }); // btcFeeSatoshis defaults to 417
	const btc = makePriceSource({ price: 60_000, stale: false });
	const body = buildListingFeeBody(cfg, null, btc, null);
	assertEqual(body.btc_fee_satoshis, 417, 'btc_fee_satoshis at reference');
	approxEq(body.btc_fee_fiat, 0.2502, 'btc_fee_fiat ≈ $0.25', 1e-6);
	assertEqual(body.btc_fee_live, true, 'btc_fee_live');
	assertEqual(body.btc_price_fiat, 60_000, 'btc_price_fiat');
});

await scenario('listing-fee body (Model A): BTC depreciated → more satoshis, USD value held', () => {
	// BTC halved to $30k: canonical $0.25 ÷ $30k = 833 sats (rounded).
	const cfg = fakeConfig({ priceFeedEnabled: true });
	const btc = makePriceSource({ price: 30_000, stale: false });
	const body = buildListingFeeBody(cfg, null, btc, null);
	assertEqual(body.btc_fee_satoshis, 833, 'btc_fee_satoshis ≈ canonical $0.25 worth at $30k');
	approxEq(body.btc_fee_fiat, 0.25, 'btc_fee_fiat held at canonical target', 1e-3);
});

await scenario('listing-fee body (Model A): XMR live amount equals pinned at the reference price', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true }); // xmrFeePiconero defaults to 781250000
	const xmr = makePriceSource({ price: 320, stale: false });
	const body = buildListingFeeBody(cfg, null, null, xmr);
	assertEqual(body.xmr_fee_piconero, '781250000', 'xmr_fee_piconero at reference');
	approxEq(body.xmr_fee_fiat, 0.25, 'xmr_fee_fiat ≈ $0.25', 1e-6);
	assertEqual(body.xmr_fee_live, true, 'xmr_fee_live');
	assertEqual(body.xmr_price_fiat, 320, 'xmr_price_fiat');
});

await scenario('listing-fee body (Model A): XMR depreciated → more piconero, USD value held', () => {
	// XMR halved to $160: the quoted piconero doubles.
	const cfg = fakeConfig({ priceFeedEnabled: true });
	const xmr = makePriceSource({ price: 160, stale: false });
	const body = buildListingFeeBody(cfg, null, null, xmr);
	assertEqual(body.xmr_fee_piconero, '1562500000', 'xmr_fee_piconero doubles on ½ price');
	approxEq(body.xmr_fee_fiat, 0.25, 'xmr_fee_fiat held at target', 1e-6);
});

await scenario('listing-fee body (Model A): no BTC/XMR fields when sources absent', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true });
	const body = buildListingFeeBody(cfg, null, null, null);
	assertAbsent(body, 'btc_fee_satoshis');
	assertAbsent(body, 'xmr_fee_piconero');
});

await scenario('listing-fee body (Model A): no BTC fields when BTC price stale', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true });
	const btc = makePriceSource({ price: 60_000, stale: true });
	const body = buildListingFeeBody(cfg, null, btc, null);
	assertAbsent(body, 'btc_fee_satoshis');
});

await scenario('listing-fee body (Model A): no BTC fields when btcFeeSatoshis is 0 (asset not accepted)', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true, btcFeeSatoshis: 0 });
	const btc = makePriceSource({ price: 60_000, stale: false });
	const body = buildListingFeeBody(cfg, null, btc, null);
	assertAbsent(body, 'btc_fee_satoshis');
});

await scenario('listing-fee body (Model A): non-USD denomination omits BTC/XMR live amounts', () => {
	// No FX in this route → a non-USD operator can't express the USD
	// target here; the UI falls back to the chain-pinned /v1/release
	// amount instead.
	const cfg = fakeConfig({ priceFeedEnabled: true, priceFeedDenominationFiat: 'EUR' });
	const btc = makePriceSource({ price: 55_000, stale: false });
	const xmr = makePriceSource({ price: 290, stale: false });
	const body = buildListingFeeBody(cfg, null, btc, xmr);
	assertAbsent(body, 'btc_fee_satoshis');
	assertAbsent(body, 'xmr_fee_piconero');
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
