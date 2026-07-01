#!/usr/bin/env tsx
/**
 * economics-canonical-smoke.
 *
 * Locks the CANONICAL economics — the single source of truth in
 * `@morphit/asset-registry` (inlined in `index.ts`) that the frontend
 * quote and the indexer validation both import. People's money rides
 * on these numbers, so this smoke pins:
 *
 *   1. The USD targets ($1 first order; 25¢ BTC/XMR; 12.5¢ BLURT)
 *      and that they're frozen.
 *   2. The 50% BLURT-discount invariant (BLURT fee == half BTC/XMR).
 *   3. The price→amount derivation helpers (and that they return
 *      null on an unusable price so callers fall back safely).
 *   4. The static FEE_FALLBACK amounts implied by the reference
 *      prices.
 *   5. isFeeCapableAsset matches the frozen fee_method assets.
 *   6. The canonical fee-capable set, the registry's per-asset
 *      canPayListingFee flags, the LISTING_FEE_USD keys, and the
 *      assumed smallest-unit decimals all AGREE (no drift between
 *      the two sources of truth).
 *
 * If any of these change, that's an economics change — it must be
 * deliberate, and every doc/FAQ/locale that states a cost has to
 * move with it. This smoke is the tripwire.
 */

import {
	FIRST_ORDER_MIN_USD,
	LISTING_FEE_USD,
	FEE_REFERENCE_PRICE_USD,
	FEE_PRICE_TOLERANCE,
	FEE_FALLBACK,
	listingFeeBlurtBase,
	listingFeeSatoshis,
	listingFeePiconero,
	isFeeCapableAsset,
	ASSETS
} from '@morphit/asset-registry';

let scenarios = 0;
let failures = 0;
function check(name: string, cond: boolean): void {
	scenarios++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}`);
		failures++;
	}
}

function main(): void {
	console.log('economics-canonical-smoke\n');

	// 1. USD targets + frozen
	check('FIRST_ORDER_MIN_USD === 1.0', FIRST_ORDER_MIN_USD === 1.0);
	check('LISTING_FEE_USD.blurt === 0.125', LISTING_FEE_USD.blurt === 0.125);
	check('LISTING_FEE_USD.btc === 0.25', LISTING_FEE_USD.btc === 0.25);
	check('LISTING_FEE_USD.xmr === 0.25', LISTING_FEE_USD.xmr === 0.25);
	check('LISTING_FEE_USD is frozen', Object.isFrozen(LISTING_FEE_USD));
	check('FEE_REFERENCE_PRICE_USD is frozen', Object.isFrozen(FEE_REFERENCE_PRICE_USD));
	check('FEE_FALLBACK is frozen', Object.isFrozen(FEE_FALLBACK));

	// 2. The 50% BLURT discount invariant — BLURT must be exactly half BTC/XMR.
	check('BLURT fee == 50% of BTC fee', LISTING_FEE_USD.blurt === LISTING_FEE_USD.btc / 2);
	check('BLURT fee == 50% of XMR fee', LISTING_FEE_USD.blurt === LISTING_FEE_USD.xmr / 2);
	check('BTC fee == XMR fee', LISTING_FEE_USD.btc === LISTING_FEE_USD.xmr);

	// 3. Tolerance band is a sane price-drift band (well above a rounding band, well below 1).
	check('FEE_PRICE_TOLERANCE === 0.15', FEE_PRICE_TOLERANCE === 0.15);
	check('FEE_PRICE_TOLERANCE in (0.01, 0.5)', FEE_PRICE_TOLERANCE > 0.01 && FEE_PRICE_TOLERANCE < 0.5);

	// 4. Derivation helpers — target ÷ live price.
	check('listingFeeBlurtBase(0.002) === 62.5', listingFeeBlurtBase(0.002) === 62.5);
	check('listingFeeBlurtBase doubles when price halves', listingFeeBlurtBase(0.001) === 125);
	check('listingFeeSatoshis(60000) === 417', listingFeeSatoshis(60000) === 417);
	check('listingFeeSatoshis(30000) === 833', listingFeeSatoshis(30000) === 833); // round(0.25/30000*1e8)=833
	check('listingFeePiconero(320) === 781250000n', listingFeePiconero(320) === 781250000n);
	check('listingFeePiconero returns bigint', typeof listingFeePiconero(320) === 'bigint');

	// Unusable price → null (so the caller falls back rather than dividing by zero).
	check('listingFeeBlurtBase(0) === null', listingFeeBlurtBase(0) === null);
	check('listingFeeBlurtBase(-1) === null', listingFeeBlurtBase(-1) === null);
	check('listingFeeBlurtBase(NaN) === null', listingFeeBlurtBase(Number.NaN) === null);
	check('listingFeeSatoshis(0) === null', listingFeeSatoshis(0) === null);
	check('listingFeePiconero(0) === null', listingFeePiconero(0) === null);
	check('listingFeeSatoshis(Infinity) === null', listingFeeSatoshis(Number.POSITIVE_INFINITY) === null);

	// Black-hat: a garbage price feed must never crash or produce an
	// absurd/zero fee. Tiny price → would-be ∞ (BigInt(∞) throws) → null.
	// Huge price → would-be 0 satoshi/piconero (free listing) → null.
	let piconeroThrew = false;
	try {
		listingFeePiconero(1e-310);
	} catch {
		piconeroThrew = true;
	}
	check('listingFeePiconero(tiny) does NOT throw', !piconeroThrew);
	check('listingFeePiconero(1e-310) === null', listingFeePiconero(1e-310) === null);
	check('listingFeeBlurtBase(1e-310) === null (no ∞)', listingFeeBlurtBase(1e-310) === null);
	check('listingFeeSatoshis(1e-310) === null (no ∞)', listingFeeSatoshis(1e-310) === null);
	check('listingFeeSatoshis(1e12) === null (no free listing)', listingFeeSatoshis(1e12) === null);
	check('listingFeePiconero(1e12) === null (no free listing)', listingFeePiconero(1e12) === null);

	// 5. FEE_FALLBACK == what the reference prices imply (the no-price safety net).
	check('FEE_FALLBACK.blurtBase === 62.5', FEE_FALLBACK.blurtBase === 62.5);
	check('FEE_FALLBACK.satoshis === 417', FEE_FALLBACK.satoshis === 417);
	check('FEE_FALLBACK.piconero === 781250000n', FEE_FALLBACK.piconero === 781250000n);
	check(
		'FEE_FALLBACK.blurtBase === listingFeeBlurtBase(reference)',
		FEE_FALLBACK.blurtBase === listingFeeBlurtBase(FEE_REFERENCE_PRICE_USD.blurt)
	);
	check(
		'FEE_FALLBACK.satoshis === listingFeeSatoshis(reference)',
		FEE_FALLBACK.satoshis === listingFeeSatoshis(FEE_REFERENCE_PRICE_USD.btc)
	);
	check(
		'FEE_FALLBACK.piconero === listingFeePiconero(reference)',
		FEE_FALLBACK.piconero === listingFeePiconero(FEE_REFERENCE_PRICE_USD.xmr)
	);

	// 6. Fee-capable assets match the frozen fee_method set (blurt|btc|xmr only).
	check("isFeeCapableAsset('BLURT')", isFeeCapableAsset('BLURT'));
	check("isFeeCapableAsset('BTC')", isFeeCapableAsset('BTC'));
	check("isFeeCapableAsset('XMR')", isFeeCapableAsset('XMR'));
	check("!isFeeCapableAsset('USDT')", !isFeeCapableAsset('USDT'));
	check("!isFeeCapableAsset('USDC')", !isFeeCapableAsset('USDC'));
	check("!isFeeCapableAsset('DOGE')", !isFeeCapableAsset('DOGE'));

	// 7. ENFORCE the "mirrors canPayListingFee" claim across the WHOLE
	//    registry — isFeeCapableAsset and the per-asset canPayListingFee
	//    flag are two expressions of one truth; if a new asset is ever
	//    added with one but not the other, this fails before the drift
	//    can ship. (index.ts hardcodes the set to stay tied to the
	//    FROZEN fee_method enum; this proves the registry agrees.)
	for (const a of ASSETS) {
		check(
			`isFeeCapableAsset('${a.ticker}') === canPayListingFee (${a.canPayListingFee})`,
			isFeeCapableAsset(a.ticker) === a.canPayListingFee
		);
	}
	// The fee-capable set is EXACTLY {BTC, XMR, BLURT} and LISTING_FEE_USD
	// has exactly those three keys (lowercased) — no missing/extra.
	const feeCapable = ASSETS.filter((a) => a.canPayListingFee)
		.map((a) => a.ticker)
		.sort();
	check(
		`fee-capable set is exactly BLURT/BTC/XMR (got ${feeCapable.join('/')})`,
		feeCapable.length === 3 &&
			feeCapable.includes('BLURT') &&
			feeCapable.includes('BTC') &&
			feeCapable.includes('XMR')
	);
	check(
		'LISTING_FEE_USD keys === the fee-capable tickers (lowercased)',
		Object.keys(LISTING_FEE_USD).sort().join(',') ===
			feeCapable.map((t) => t.toLowerCase()).sort().join(',')
	);
	// The decimals the canonical derivation assumes (8 sat / 12 pico /
	// 3 milliBLURT — baked into the FEE_FALLBACK + the helpers) must
	// match the registry's per-asset decimals, or a derived amount
	// would be off by orders of magnitude.
	const dec = (t: string): number | undefined => ASSETS.find((a) => a.ticker === t)?.decimals;
	check(`registry BTC decimals === 8 (got ${dec('BTC')})`, dec('BTC') === 8);
	check(`registry XMR decimals === 12 (got ${dec('XMR')})`, dec('XMR') === 12);
	check(`registry BLURT decimals === 3 (got ${dec('BLURT')})`, dec('BLURT') === 3);

	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
}

main();
