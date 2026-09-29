/**
 * v1.20.0 fix wave, G5 — one out-of-range entry must not discard a provider's
 * whole FX table.
 *
 * currency-api ships ~150 fiat AND crypto codes; `btc` per USD is ~1e-5, below
 * FX_RATE_PLAUSIBLE_MIN (1e-4). The composite fed the raw table to the
 * all-or-nothing plausibility check, so that source never contributed and a
 * node relying on it served no live rate for currencies like IRR — which the
 * $1 first-buy floor then treated as already-USD ("1 IRR" = $1).
 */
import { describe, expect, it } from 'vitest';

import { CompositeCachedFxSource } from '$indexer/fx/compositeFxSource';
import { tableFromFlat } from '$indexer/fx/fetchUtil';

const FIAT: Record<string, number> = {
	eur: 0.92,
	gbp: 0.79,
	mxn: 18.5,
	jpy: 150,
	irr: 42000,
	cad: 1.36,
	aud: 1.52,
	chf: 0.88,
	cny: 7.2,
	inr: 83,
	brl: 5,
	zar: 18.5,
	rub: 92,
	krw: 1330
};

async function withTable(extra: Record<string, number>) {
	const table = tableFromFlat({ ...FIAT, ...extra });
	const src = new CompositeCachedFxSource({
		upstreams: [{ name: 'currency_api', fetch: async () => table }],
		refreshIntervalMs: 3_600_000
	});
	await src.refreshOnce();
	return src;
}

describe('CompositeCachedFxSource — per-currency filtering (G5)', () => {
	it('a table carrying a crypto code below the plausible floor still contributes its fiat rates', async () => {
		const src = await withTable({ btc: 0.0000105, eth: 0.0003 });
		expect(src.sourceStatus()[0]?.ok).toBe(true);
		expect(src.rate('IRR')).toBe(42000);
		// The implausible entry itself is never served.
		expect(src.rate('BTC')).toBeNull();
	});

	it('an absurdly large entry is dropped, not the table', async () => {
		const src = await withTable({ vef: 2.5e11 });
		expect(src.sourceStatus()[0]?.ok).toBe(true);
		expect(src.rate('VEF')).toBeNull();
		expect(src.rate('MXN')).toBe(18.5);
	});

	it('a table whose EUR anchor is wrong is still rejected whole', async () => {
		const src = await withTable({ eur: 92 });
		expect(src.sourceStatus()[0]?.ok).toBe(false);
	});
});
