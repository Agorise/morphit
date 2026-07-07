/**
 * Morphit indexer — shared fee-amount calculator.
 *
 * Pure helpers for converting a USD target into the
 * corresponding BTC satoshis and XMR piconero amounts.
 * Used by both `recommend-fee-amounts.ts` (the operator
 * CLI helper) and the ops-cli setup wizard's listing-fee
 * editor step.
 *
 * Why this file exists.  Part 110 added a wizard step
 * that lets operators set the listing-fee USD target
 * (default $0.25) and have the wizard recompute the
 * BTC sat and XMR piconero amounts from live Coingecko
 * prices, with a manual-entry fallback when the API is
 * unreachable.  The math + the price fetch are the same
 * as `recommend-fee-amounts.ts` already had — pulling
 * them into a shared helper keeps the two consumers in
 * lockstep instead of letting them drift independently.
 *
 * The shared helper has NO side effects (no
 * `console.log`, no `process.exit`, no env reads).  The
 * CLI vs wizard differ only in how they present the
 * results to the operator.
 */

export interface BtcXmrUsdPrices {
	readonly btcUsd: number;
	readonly xmrUsd: number;
}

export interface FeeAmountsResult {
	readonly btcSatoshis: number;
	readonly xmrPiconero: number;
}

/**
 * Compute fee amounts in BTC sats and XMR piconero
 * targeting a given USD value.
 *
 * The default USD target this is called with traces to the
 * canonical `LISTING_FEE_USD` in `@morphit/asset-registry`
 * the canonical economics in @morphit/asset-registry (the single source of
 * truth); this helper takes
 * `targetUsd` as a parameter so the CLI/wizard can offer an
 * operator override. The formula matches the canonical
 * `listingFeeSatoshis` / `listingFeePiconero` helpers, so a
 * CLI-recomputed amount equals what the live derivation would
 * produce at the same price.
 *
 * Pure function — does not throw on any finite positive
 * input.  The caller is responsible for validating
 * `targetUsd > 0` and `prices.{btcUsd,xmrUsd} > 0`
 * before calling.
 */
export function computeFeeAmounts(
	targetUsd: number,
	prices: BtcXmrUsdPrices
): FeeAmountsResult {
	return {
		btcSatoshis: Math.round((targetUsd / prices.btcUsd) * 1e8),
		xmrPiconero: Math.round((targetUsd / prices.xmrUsd) * 1e12)
	};
}

/**
 * Live Coingecko BTC/USD + XMR/USD prices.  10s timeout.
 *
 * Throws `Error` with a clear message on:
 *   - network failure (DNS, connection, abort)
 *   - non-2xx HTTP response
 *   - malformed JSON shape
 *   - missing / non-finite / non-positive price fields
 *
 * The thrown messages are operator-facing — they will
 * appear in the wizard or CLI output.  No PII leaks.
 *
 * Allows dependency injection of a `fetch`-shaped
 * function for tests.
 */
export async function fetchBtcXmrPricesFromCoingecko(
	fetchImpl: typeof fetch = fetch
): Promise<BtcXmrUsdPrices> {
	const url =
		'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,monero&vs_currencies=usd';

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 10_000);

	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: ac.signal
		});
	} catch (err) {
		clearTimeout(timer);
		throw new Error(
			`coingecko unreachable: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	clearTimeout(timer);

	if (!res.ok) {
		throw new Error(`coingecko returned HTTP ${res.status}`);
	}

	// Part 112 hardening — tightened parse path.  Previously
	// did `Number(body.bitcoin?.usd)` directly; the downstream
	// `Number.isFinite` gate caught garbage but accepted a
	// surprising mix of input types via JavaScript's coercion
	// rules (e.g. `Number(null) === 0`, `Number([42]) === 42`,
	// `Number(true) === 1`).  Now: explicit type guards reject
	// anything that isn't already a number or a numeric-shaped
	// string.  Coingecko documents number responses, but has
	// occasionally returned strings; that's the only coercion
	// branch we accept.
	const body = (await res.json()) as {
		readonly bitcoin?: { readonly usd?: unknown };
		readonly monero?: { readonly usd?: unknown };
	};

	const btcUsd = parsePrice(body.bitcoin?.usd, 'BTC/USD');
	const xmrUsd = parsePrice(body.monero?.usd, 'XMR/USD');

	return { btcUsd, xmrUsd };
}

/** Strict parse: accept number or numeric-shaped string only.
 *  Reject null, undefined, boolean, array, object, NaN,
 *  Infinity, negative, zero, and strings with non-numeric
 *  characters.  Throws Error with a descriptive operator-facing
 *  message on rejection. */
function parsePrice(raw: unknown, label: string): number {
	let n: number;
	if (typeof raw === 'number') {
		n = raw;
	} else if (typeof raw === 'string') {
		// Reject strings that aren't strict decimal numbers.
		// Number('60000abc') gives NaN — caught by isFinite —
		// but Number(' 60000 ') gives 60000 (whitespace
		// tolerance) and Number('') gives 0.  Both are wrong
		// for our purposes; explicit regex avoids them.
		if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) {
			throw new Error(
				`coingecko ${label} not a numeric string: ${JSON.stringify(raw)}`
			);
		}
		n = Number(raw);
	} else {
		throw new Error(
			`coingecko ${label} not a number or numeric string: ${typeof raw}`
		);
	}
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`coingecko ${label} missing or invalid: ${JSON.stringify(raw)}`);
	}
	return n;
}
