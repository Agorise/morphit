/**
 * Smoke — treasury auto-re-pin decision logic.
 *
 * Exercises the pure decideRepin() brain: drift detection in both
 * directions, the re-pin threshold, the canonical fresh-amount
 * computation, and — most importantly for a money path — the
 * failsafes: feed-down skips, sanity-ceiling rejection, and the
 * no-current-pin bootstrap case.
 *
 * Run: ../../node_modules/.bin/tsx --tsconfig ../../tsconfig.smoke.json scripts/treasury-repin-smoke.ts
 */

import {
	decideRepin,
	agreedPrice,
	REPIN_BTC_SATOSHIS_MAX,
	buildRepinnedTreasury,
	parseReleaseTreasury,
	DEFAULT_REPIN_DRIFT_THRESHOLD,
	type PinnedAmounts,
	type RepinPrices
} from '../src/lib/treasuryRepin.ts';
import {
	LISTING_FEE_USD,
	FEE_FALLBACK,
	listingFeeSatoshis,
	listingFeePiconero,
	listingFeeBlurtBase,
	FEE_PRICE_TOLERANCE
} from '@morphit/asset-registry';

let passed = 0;
let failed = 0;

function scenario(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

// Reference prices at which the canonical fallbacks are exactly on
// target ($0.25 / $0.25 / $0.125).
const REF: RepinPrices = { btcUsd: 60_000, xmrUsd: 320, blurtUsd: 0.002 };
// Pinned amounts that are exactly on-target at the reference prices.
const ON_TARGET: PinnedAmounts = {
	btcSatoshis: FEE_FALLBACK.satoshis, // 417
	xmrPiconero: FEE_FALLBACK.piconero, // 781250000n
	blurtBase: FEE_FALLBACK.blurtBase // 62.5
};

scenario('threshold sits inside the verifier tolerance band (no mid-drift rejection)', () => {
	assert(DEFAULT_REPIN_DRIFT_THRESHOLD < FEE_PRICE_TOLERANCE, 'threshold must be < tolerance');
});

scenario('on-target pins at reference prices → no re-pin', () => {
	const d = decideRepin(ON_TARGET, REF);
	assert(d.shouldRepin === false, 'should not re-pin when on target');
	assert(d.btc.due === false && d.xmr.due === false && d.blurt.due === false, 'no asset due');
});

scenario('small drift within threshold → no re-pin', () => {
	// +5% BTC price: pinned USD value drifts ~5% (< 10% threshold).
	const d = decideRepin(ON_TARGET, { ...REF, btcUsd: 63_000 });
	assert(d.btc.drift !== null && d.btc.drift > 0.04 && d.btc.drift < 0.06, 'btc drift ≈5%');
	assert(d.btc.due === false, 'btc not due at 5%');
	assert(d.shouldRepin === false, 'no re-pin overall');
});

scenario('BTC appreciated past threshold → re-pin due, fresh amount canonical', () => {
	// +20% BTC: pinned 417 sats now worth ~$0.30 → drift ~20% > 10%.
	const btcUsd = 72_000;
	const d = decideRepin(ON_TARGET, { ...REF, btcUsd });
	assert(d.btc.due === true, 'btc due at 20% drift');
	assert(d.shouldRepin === true, 'should re-pin');
	assert(d.btc.computed === listingFeeSatoshis(btcUsd), 'fresh sats are canonical');
	// Fresh amount is fewer sats than the stale pin (BTC went up).
	assert((d.btc.computed as number) < FEE_FALLBACK.satoshis, 'fewer sats after appreciation');
});

scenario('XMR depreciated past threshold → re-pin due (drift works downward too)', () => {
	// −20% XMR: pinned piconero now worth ~$0.20 → drift ~20%.
	const xmrUsd = 256;
	const d = decideRepin(ON_TARGET, { ...REF, xmrUsd });
	assert(d.xmr.due === true, 'xmr due at 20% drift');
	assert(d.xmr.computed === listingFeePiconero(xmrUsd), 'fresh piconero canonical');
	assert((d.xmr.computed as bigint) > FEE_FALLBACK.piconero, 'more piconero after depreciation');
});

scenario('BLURT appreciated past threshold → re-pin due', () => {
	const blurtUsd = 0.0025; // +25%
	const d = decideRepin(ON_TARGET, { ...REF, blurtUsd });
	assert(d.blurt.due === true, 'blurt due');
	assert(d.blurt.computed === listingFeeBlurtBase(blurtUsd), 'fresh base canonical');
});

// ── FAILSAFES ──────────────────────────────────────────────────

scenario('FAILSAFE: BTC feed down (null price) → never re-pin BTC', () => {
	const d = decideRepin(ON_TARGET, { ...REF, btcUsd: null });
	assert(d.btc.due === false, 'btc not due with no price');
	assert(d.btc.computed === null, 'no computed amount');
	assert(/unavailable/.test(d.btc.note), 'note explains skip');
});

scenario('FAILSAFE: zero / negative price → skipped, not re-pinned', () => {
	const d0 = decideRepin(ON_TARGET, { ...REF, xmrUsd: 0 });
	assert(d0.xmr.due === false && d0.xmr.computed === null, 'zero price skipped');
	const dNeg = decideRepin(ON_TARGET, { ...REF, blurtUsd: -1 });
	assert(dNeg.blurt.due === false && dNeg.blurt.computed === null, 'negative price skipped');
});

scenario('FAILSAFE: all feeds down → shouldRepin false', () => {
	const d = decideRepin(ON_TARGET, { btcUsd: null, xmrUsd: null, blurtUsd: null });
	assert(d.shouldRepin === false, 'nothing to do with no prices');
});

scenario('FAILSAFE: absurdly low BTC price → computed amount over ceiling → skipped', () => {
	const d = decideRepin(ON_TARGET, { ...REF, btcUsd: 0.0001 });
	assert(d.btc.due === false, 'absurd amount not proposed');
	assert(d.btc.computed === null, 'computed suppressed');
	assert(/ceiling/.test(d.btc.note), 'note explains ceiling rejection');
});

scenario('FAILSAFE: a $0.01 BTC price proposes nothing', () => {
	const d = decideRepin(ON_TARGET, { ...REF, btcUsd: 0.01 });
	assert(d.btc.due === false, 'a $0.01 BTC price proposed a re-pin');
	assert(d.btc.computed === null, 'computed suppressed');
	const boot = decideRepin(
		{ btcSatoshis: null, xmrPiconero: null, blurtBase: null },
		{ ...REF, btcUsd: 0.01 }
	);
	assert(boot.btc.due === false, 'a first pin from a $0.01 price was proposed');
});

scenario('FAILSAFE: realistic ceiling — no fee above 1e6 sats is ever proposed', () => {
	const boot = decideRepin(
		{ btcSatoshis: null, xmrPiconero: null, blurtBase: null },
		{ ...REF, btcUsd: 10 }
	);
	assert(
		boot.btc.due === false && boot.btc.computed === null,
		`2.5e6 sats proposed (ceiling ${REPIN_BTC_SATOSHIS_MAX})`
	);
});

scenario('FAILSAFE: one re-pin moves a pin by at most ×2 either way', () => {
	const pinned = ON_TARGET.btcSatoshis!;
	const tenfold = decideRepin(ON_TARGET, {
		...REF,
		btcUsd: LISTING_FEE_USD.btc / (pinned / 1e8) / 10
	});
	assert(tenfold.btc.due === false, 'a ×10 move was proposed in one re-pin');
	assert(/×2/.test(tenfold.btc.note), 'note explains the bound');
	const halfway = decideRepin(ON_TARGET, {
		...REF,
		btcUsd: LISTING_FEE_USD.btc / (pinned / 1e8) / 1.5
	});
	assert(halfway.btc.due === true, 'a ×1.5 move should still re-pin');
});

scenario('FAILSAFE: a price needs two independent sources that agree', () => {
	assert(agreedPrice([60000]) === null, 'one source was enough');
	assert(agreedPrice([60000, null, undefined]) === null, 'one usable source was enough');
	assert(agreedPrice([60000, 30000]) === null, 'two disagreeing sources gave a price');
	assert(agreedPrice([60000, 61000]) === 60500, 'two agreeing sources → their median');
	assert(agreedPrice([0.01, 60000, 60600]) === 60300, 'an outlier among three is outvoted');
});

scenario('FAILSAFE: a bad price on one asset does not block re-pin of a healthy one', () => {
	// BTC feed down, but XMR drifted 20% → XMR still re-pins.
	const d = decideRepin(ON_TARGET, { btcUsd: null, xmrUsd: 256, blurtUsd: 0.002 });
	assert(d.btc.due === false, 'btc skipped (no price)');
	assert(d.xmr.due === true, 'xmr still due');
	assert(d.shouldRepin === true, 'healthy asset re-pins independently');
});

scenario('BOOTSTRAP: no current pin → due, proposes canonical (first pin)', () => {
	const empty: PinnedAmounts = { btcSatoshis: null, xmrPiconero: null, blurtBase: null };
	const d = decideRepin(empty, REF);
	assert(d.btc.due && d.xmr.due && d.blurt.due, 'all due for first pin');
	assert(d.btc.computed === listingFeeSatoshis(REF.btcUsd!), 'canonical btc');
	assert(d.blurt.computed === listingFeeBlurtBase(REF.blurtUsd!), 'canonical blurt');
	assert(d.btc.drift === null, 'no drift without a prior pin');
});

scenario('custom threshold is honored', () => {
	// 8% drift: due under a 5% threshold, not under 10%.
	const eightPct = 64_800; // +8% BTC
	assert(decideRepin(ON_TARGET, { ...REF, btcUsd: eightPct }, 0.05).btc.due === true, 'due @5%');
	assert(
		decideRepin(ON_TARGET, { ...REF, btcUsd: eightPct }, 0.1).btc.due === false,
		'not due @10%'
	);
});

scenario('re-pinning resets drift to ~0 (computed amount is on-target)', () => {
	const btcUsd = 72_000;
	const d = decideRepin(ON_TARGET, { ...REF, btcUsd });
	const freshSats = d.btc.computed as number;
	// The fresh amount, valued at the same price, is back on target.
	const freshUsdValue = (freshSats / 1e8) * btcUsd;
	assert(Math.abs(freshUsdValue - LISTING_FEE_USD.btc) < 0.005, 'fresh amount on target');
});

// ── buildRepinnedTreasury (the new pin a re-pin would broadcast) ──

const ADDRS = {
	btcAddress: 'bc1qexampleexampleexampleexampleexampleex',
	xmrAddress: '4' + 'A'.repeat(94)
};

scenario('buildRepinnedTreasury: all due → fresh canonical amounts, addresses preserved', () => {
	const prices = { ...REF, btcUsd: 72_000, xmrUsd: 256, blurtUsd: 0.0025 };
	const d = decideRepin(ON_TARGET, prices);
	const t = buildRepinnedTreasury(d, ADDRS, ON_TARGET);
	assert(t.btc?.address === ADDRS.btcAddress, 'btc address preserved');
	assert(t.btc?.satoshis === listingFeeSatoshis(72_000), 'btc fresh canonical');
	assert(t.xmr?.piconero === listingFeePiconero(256)!.toString(), 'xmr fresh canonical');
	assert(t.blurt?.base === listingFeeBlurtBase(0.0025), 'blurt fresh canonical');
});

scenario('buildRepinnedTreasury: feed-down asset keeps its CURRENT amount (never zeroed)', () => {
	// BTC feed down → BTC must keep its current pin, not drop.
	const prices = { btcUsd: null, xmrUsd: 256, blurtUsd: 0.002 };
	const d = decideRepin(ON_TARGET, prices);
	const t = buildRepinnedTreasury(d, ADDRS, ON_TARGET);
	assert(t.btc?.satoshis === FEE_FALLBACK.satoshis, 'btc held at current pin');
	assert(t.xmr?.piconero === listingFeePiconero(256)!.toString(), 'xmr re-pinned fresh');
});

scenario('buildRepinnedTreasury: no BTC/XMR address → those null, blurt still present', () => {
	const prices = { ...REF, blurtUsd: 0.0025 };
	const d = decideRepin(ON_TARGET, prices);
	const t = buildRepinnedTreasury(d, { btcAddress: null, xmrAddress: null }, ON_TARGET);
	assert(t.btc === null && t.xmr === null, 'no address → null');
	assert(t.blurt?.base === listingFeeBlurtBase(0.0025), 'blurt pinned without address');
});

scenario('buildRepinnedTreasury: no blurt base anywhere → blurt omitted (legacy shape)', () => {
	const noBlurt: PinnedAmounts = { ...ON_TARGET, blurtBase: null };
	const d = decideRepin(noBlurt, { ...REF, blurtUsd: null }); // blurt feed down + no current
	const t = buildRepinnedTreasury(d, ADDRS, noBlurt);
	assert(!('blurt' in t) || t.blurt === undefined || t.blurt === null, 'blurt omitted');
});

// ── parseReleaseTreasury (the read side of the actuator) ──

scenario('parseReleaseTreasury: full block → addresses + pinned amounts', () => {
	const p = parseReleaseTreasury({
		btc: { address: ADDRS.btcAddress, satoshis: 417 },
		xmr: { address: ADDRS.xmrAddress, piconero: '781250000' },
		blurt: { base: 62.5 }
	});
	assert(p.addresses.btcAddress === ADDRS.btcAddress, 'btc addr');
	assert(p.pinned.btcSatoshis === 417, 'btc sats');
	assert(p.pinned.xmrPiconero === 781250000n, 'xmr piconero as bigint');
	assert(p.pinned.blurtBase === 62.5, 'blurt base');
});

scenario('parseReleaseTreasury: legacy block (no blurt) → blurtBase null', () => {
	const p = parseReleaseTreasury({
		btc: { address: ADDRS.btcAddress, satoshis: 417 },
		xmr: null
	});
	assert(p.pinned.blurtBase === null, 'no blurt pin');
	assert(p.pinned.xmrPiconero === null && p.addresses.xmrAddress === null, 'xmr absent');
});

scenario('parseReleaseTreasury: garbage / null → all null (no throw)', () => {
	for (const junk of [null, undefined, 42, 'x', [], { btc: 'nope', xmr: 5, blurt: [] }]) {
		const p = parseReleaseTreasury(junk);
		assert(
			p.pinned.btcSatoshis === null && p.pinned.blurtBase === null,
			`junk ${JSON.stringify(junk)} → null`
		);
	}
});

scenario(
	'parse → decide → build round-trips an on-target legacy pin into a BLURT-bearing one',
	() => {
		// A legacy chain-pin (BTC/XMR only) + a BLURT feed → first BLURT
		// pin gets proposed and built, addresses preserved.
		const parsed = parseReleaseTreasury({
			btc: { address: ADDRS.btcAddress, satoshis: 417 },
			xmr: { address: ADDRS.xmrAddress, piconero: '781250000' }
		});
		const d = decideRepin(parsed.pinned, REF);
		assert(d.blurt.due === true, 'blurt first-pin due (no current base)');
		const t = buildRepinnedTreasury(d, parsed.addresses, parsed.pinned);
		assert(t.blurt?.base === listingFeeBlurtBase(REF.blurtUsd!), 'blurt now pinned canonical');
		assert(t.btc?.address === ADDRS.btcAddress, 'btc address preserved through round-trip');
	}
);

// ── the re-pin tools' price fetch (treasury-repin-prices.ts) ──────
// A fake network: CoinGecko answers $0.01 for BTC, the other sources are
// down → no BTC price at all; then CoinPaprika and Kraken agree on XMR
// while CoinGecko is off → that agreed price.
{
	const { fetchAgreedPrices } = await import('./treasury-repin-prices.ts');
	const fake = (answers: Record<string, unknown>) =>
		(async (url: string) => {
			const hit = Object.entries(answers).find(([k]) => String(url).includes(k));
			if (!hit) return new Response('down', { status: 503 });
			return new Response(JSON.stringify(hit[1]), { status: 200 });
		}) as typeof fetch;
	const one = await fetchAgreedPrices(fake({ 'api.coingecko.com': { bitcoin: { usd: 0.01 } } }));
	scenario('FAILSAFE: one source answering $0.01 BTC gives no BTC price', () => {
		assert(one.prices.btcUsd === null, `btcUsd = ${one.prices.btcUsd}`);
	});
	const two = await fetchAgreedPrices(
		fake({
			'xmr-monero': { quotes: { USD: { price: 320 } } },
			'api.kraken.com': { error: [], result: { XXMRZUSD: { c: ['322.0', '1'] } } }
		})
	);
	scenario('FAILSAFE: two sources that agree give the agreed price', () => {
		assert(two.prices.xmrUsd === 321, `xmrUsd = ${two.prices.xmrUsd}`);
		assert(two.prices.btcUsd === null && two.prices.blurtUsd === null, 'no agreement elsewhere');
	});
}

if (failed > 0) {
	console.log(`\n✗ ${failed}/${passed + failed} treasury-repin scenarios failed`);
	process.exit(1);
}
console.log(`\n✓ all ${passed} treasury-repin scenarios passed`);
