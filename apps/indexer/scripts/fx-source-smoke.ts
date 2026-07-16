#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/fx-source-smoke.ts
 *
 * Structural + behavioural smoke for the USD→fiat FX subsystem
 * (indexer/fx/*).  Pins the money-adjacent contract so any silent
 * drift trips CI:
 *
 *   - Plausibility gate (isPlausibleFxTable): currency count, EUR
 *     anchor, per-rate range, base check.
 *   - tableFromFlat: uppercasing + junk filtering.
 *   - CompositeCachedFxSource: upstream rotation (first plausible
 *     wins), null/throw/implausible failover, static-table fallback,
 *     per-currency static fallback, USD identity, conversion math,
 *     unknown-currency → null, NaN guards, staleness.
 *   - Each provider fetcher: shape parsing, base/result guards,
 *     429/!ok/throw → null (never throws).
 *   - Static table sanity.
 *
 * No real network: the composite is driven with injected FxFetch
 * upstreams + clock; fetchers use a mock fetchImpl returning real
 * Response objects.
 */

import {
	isPlausibleFxTable,
	type FxRateTable
} from '../src/indexer/fx/source';
import { tableFromFlat } from '../src/indexer/fx/fetchUtil';
import { CompositeCachedFxSource } from '../src/indexer/fx/compositeFxSource';
import { STATIC_FX_TABLE, staticTableHas } from '../src/indexer/fx/staticTable';
import { createFrankfurterFetcher } from '../src/indexer/fx/frankfurterFetcher';
import { createErApiFetcher } from '../src/indexer/fx/erApiFetcher';
import { createCurrencyApiFetcher } from '../src/indexer/fx/currencyApiFetcher';

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name} — ${detail}`);
	failed++;
}
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) pass(name);
	else fail(name, detail);
}
function approx(a: number | null, b: number, eps = 1e-6): boolean {
	return a !== null && Math.abs(a - b) < eps;
}

const goodRates = (): Record<string, number> => ({
	EUR: 0.92,
	GBP: 0.79,
	JPY: 150,
	AUD: 1.52,
	CAD: 1.36,
	CHF: 0.88,
	CNY: 7.2,
	INR: 83,
	MXN: 17,
	BRL: 5.0,
	ZAR: 18.5
});
const goodTable = (): FxRateTable => ({ base: 'USD', rates: goodRates() });

// Fixed-clock + no-op timer composite for deterministic tests.
function makeComposite(
	upstreams: ReadonlyArray<{ name: string; fetch: () => Promise<FxRateTable | null> }>,
	clock: { t: number }
): CompositeCachedFxSource {
	return new CompositeCachedFxSource({
		upstreams,
		refreshIntervalMs: 1000,
		staleThresholdMs: 3000,
		now: () => clock.t,
		// cp474 — the stub deliberately ignores the handler (the smoke drives the
		// clock by hand), so it can't structurally match setInterval's overloads;
		// route through `unknown` rather than claim an overlap that isn't there.
		setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
		clearInterval: (() => {}) as typeof globalThis.clearInterval
	});
}

// Mock fetchImpl returning a real Response with the given JSON body.
function mockFetch(body: unknown, init?: { status?: number; ok?: boolean }): typeof globalThis.fetch {
	return (async () => {
		const status = init?.status ?? 200;
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof globalThis.fetch;
}
const throwingFetch: typeof globalThis.fetch = (async () => {
	throw new Error('network down');
}) as unknown as typeof globalThis.fetch;

async function main(): Promise<void> {
	// ─── isPlausibleFxTable ─────────────────────────────────────
	check('plausible: a normal USD table passes', isPlausibleFxTable(goodTable()));
	check(
		'plausible: <10 currencies rejected',
		!isPlausibleFxTable({ base: 'USD', rates: { EUR: 0.92, GBP: 0.79 } })
	);
	check(
		'plausible: EUR out of anchor range rejected',
		!isPlausibleFxTable({ base: 'USD', rates: { ...goodRates(), EUR: 5.0 } })
	);
	check(
		'plausible: missing EUR anchor rejected',
		!isPlausibleFxTable({
			base: 'USD',
			rates: (() => {
				const r = goodRates();
				delete (r as Record<string, number>).EUR;
				return r;
			})()
		})
	);
	check(
		'plausible: a rate out of range (1e8) rejected',
		!isPlausibleFxTable({ base: 'USD', rates: { ...goodRates(), HYP: 1e8 } })
	);
	check(
		'plausible: non-USD base rejected',
		!isPlausibleFxTable({ base: 'EUR' as 'USD', rates: goodRates() })
	);
	check('plausible: null rejected', !isPlausibleFxTable(null));
	check(
		'plausible: zero/negative rate rejected',
		!isPlausibleFxTable({ base: 'USD', rates: { ...goodRates(), BAD: -1 } })
	);

	// ─── tableFromFlat ──────────────────────────────────────────
	{
		const t = tableFromFlat({ EUR: 0.92, GBP: 0.79 });
		check('tableFromFlat: builds USD-base table', t !== null && t.base === 'USD' && t.rates.EUR === 0.92);
	}
	{
		const t = tableFromFlat({ eur: 0.92, gbp: 0.79 });
		check('tableFromFlat: uppercases lowercase codes', t !== null && t.rates.EUR === 0.92 && t.rates.GBP === 0.79);
	}
	{
		const t = tableFromFlat({ EUR: 0.92, BAD: 'x', NEG: -1, ZERO: 0 });
		check(
			'tableFromFlat: filters non-numeric / non-positive',
			t !== null && t.rates.EUR === 0.92 && !('BAD' in t.rates) && !('NEG' in t.rates) && !('ZERO' in t.rates)
		);
	}
	check('tableFromFlat: empty object → null', tableFromFlat({}) === null);
	check('tableFromFlat: non-object → null', tableFromFlat(42) === null);

	// ─── Composite: rotation + commit ───────────────────────────
	{
		const clock = { t: 1000 };
		const src = makeComposite(
			[
				{ name: 'first', fetch: async () => goodTable() },
				{ name: 'second', fetch: async () => goodTable() }
			],
			clock
		);
		await src.refreshOnce();
		check(
			'composite: all plausible sources contribute (averaged)',
			src.currentDetailed().source === 'first+second' &&
				src.currentDetailed().contributing_sources.length === 2
		);
		check('composite: rate(EUR) matches committed', approx(src.rate('EUR'), 0.92));
		check('composite: rate(USD) is always 1', src.rate('USD') === 1);
		check('composite: live_currency_count > 0 after commit', src.currentDetailed().live_currency_count > 0);
		check('composite: USD identity present in committed table', src.currentDetailed().rates.USD === 1);
		check('composite: usdToFiat(1, AUD) ≈ 1.52', approx(src.usdToFiat(1, 'AUD'), 1.52));
		check('composite: usdToFiat(10, EUR) ≈ 9.2', approx(src.usdToFiat(10, 'EUR'), 9.2, 1e-9));
		check('composite: fiatToUsd(1.52, AUD) ≈ 1', approx(src.fiatToUsd(1.52, 'AUD'), 1, 1e-9));
		check('composite: fiatToUsd(0.92, EUR) ≈ 1', approx(src.fiatToUsd(0.92, 'EUR'), 1, 1e-9));
		check('composite: case-insensitive fiat (aud)', approx(src.rate('aud'), 1.52));
		check('composite: unknown fiat → rate null', src.rate('ZZZ') === null);
		check('composite: unknown fiat → usdToFiat null', src.usdToFiat(1, 'ZZZ') === null);
		check('composite: unknown fiat → fiatToUsd null', src.fiatToUsd(1, 'ZZZ') === null);
		check('composite: NaN usd → usdToFiat null', src.usdToFiat(NaN, 'EUR') === null);
		check('composite: NaN amount → fiatToUsd null', src.fiatToUsd(NaN, 'EUR') === null);
	}

	// ─── Composite: failover (null / throw / implausible) ───────
	{
		const clock = { t: 1000 };
		const src = makeComposite(
			[
				{ name: 'nuller', fetch: async () => null },
				{ name: 'thrower', fetch: throwingFetch as unknown as () => Promise<FxRateTable | null> },
				{ name: 'implausible', fetch: async () => ({ base: 'USD' as const, rates: { EUR: 0.92 } }) },
				{ name: 'good', fetch: async () => goodTable() }
			],
			clock
		);
		await src.refreshOnce();
		check('composite: skips null/throw/implausible, lands on good', src.currentDetailed().source === 'good');
		check('composite: failover still serves correct rate', approx(src.rate('GBP'), 0.79));
	}

	// ─── Composite: total outage → static table ─────────────────
	{
		const clock = { t: 1000 };
		const src = makeComposite(
			[
				{ name: 'a', fetch: async () => null },
				{ name: 'b', fetch: async () => null }
			],
			clock
		);
		await src.refreshOnce();
		check('composite: all-fail no-cache → source is static_table', src.currentDetailed().source === 'static_table');
		check('composite: all-fail → live_currency_count 0', src.currentDetailed().live_currency_count === 0);
		check('composite: static fallback still gives EUR', approx(src.rate('EUR'), STATIC_FX_TABLE.rates.EUR));
		check('composite: static fallback gives USD=1', src.rate('USD') === 1);
		check('composite: genuinely-unknown currency still null', src.rate('ZZZ') === null);
	}

	// ─── Composite: per-currency static fallback when live lacks it ─
	{
		const clock = { t: 1000 };
		// Live table omits THB but static has it.
		const src = makeComposite([{ name: 'live', fetch: async () => goodTable() }], clock);
		await src.refreshOnce();
		check('composite: live present → uses live EUR', approx(src.rate('EUR'), 0.92));
		check(
			'composite: currency absent from live falls back to static (THB)',
			approx(src.rate('THB'), STATIC_FX_TABLE.rates.THB)
		);
	}

	// ─── Composite: staleness ───────────────────────────────────
	{
		const clock = { t: 1000 };
		const src = makeComposite([{ name: 'x', fetch: async () => goodTable() }], clock);
		await src.refreshOnce();
		check('composite: fresh right after refresh', src.currentDetailed().stale === false);
		clock.t = 1000 + 3001; // advance past staleThresholdMs (3000)
		check('composite: stale after threshold elapses', src.currentDetailed().stale === true);
		check('composite: stale value still served (rate unchanged)', approx(src.rate('EUR'), 0.92));
	}

	// ─── Composite: AVERAGING math + outlier rejection ──────────
	const tableWithEur = (eur: number): FxRateTable => ({
		base: 'USD',
		rates: { ...goodRates(), EUR: eur }
	});
	{
		const clock = { t: 1000 };
		// Two sources agree within tolerance on EUR (0.915, 0.925) → mean 0.920.
		const src = makeComposite(
			[
				{ name: 'a', fetch: async () => tableWithEur(0.915) },
				{ name: 'b', fetch: async () => tableWithEur(0.925) }
			],
			clock
		);
		await src.refreshOnce();
		check('averaging: two close readings averaged (0.915,0.925 → 0.920)', approx(src.rate('EUR'), 0.92, 1e-9));
		check('averaging: no outlier flagged when both agree within tolerance', src.currentDetailed().outlier_rejected === false);
	}
	{
		const clock = { t: 1000 };
		// Two sources >2% apart (0.90, 0.94): both diverge from their
		// midpoint, so both are flagged and the median (0.92) is used —
		// a visible disagreement rather than a silently-skewed value.
		const src = makeComposite(
			[
				{ name: 'a', fetch: async () => tableWithEur(0.9) },
				{ name: 'b', fetch: async () => tableWithEur(0.94) }
			],
			clock
		);
		await src.refreshOnce();
		check('averaging: two far-apart readings flagged, median used (→0.92)', approx(src.rate('EUR'), 0.92, 1e-9) && src.currentDetailed().outlier_rejected === true);
	}
	{
		const clock = { t: 1000 };
		// Three sources, one wild outlier (0.92, 0.93, 1.50).  Median
		// 0.93; 1.50 is >2% off → dropped; mean(0.92,0.93)=0.925.
		const src = makeComposite(
			[
				{ name: 'a', fetch: async () => tableWithEur(0.92) },
				{ name: 'b', fetch: async () => tableWithEur(0.93) },
				{ name: 'c', fetch: async () => tableWithEur(1.5) }
			],
			clock
		);
		await src.refreshOnce();
		check('averaging: outlier (1.50) rejected, inliers averaged (→0.925)', approx(src.rate('EUR'), 0.925, 1e-9));
		check('averaging: outlier_rejected flag set when a source diverges', src.currentDetailed().outlier_rejected === true);
		check('averaging: all 3 sources still listed as contributing', src.currentDetailed().contributing_sources.length === 3);
	}
	{
		const clock = { t: 1000 };
		// One source down (null), the other two averaged.
		const src = makeComposite(
			[
				{ name: 'down', fetch: async () => null },
				{ name: 'b', fetch: async () => tableWithEur(0.91) },
				{ name: 'c', fetch: async () => tableWithEur(0.93) }
			],
			clock
		);
		await src.refreshOnce();
		check('averaging: down source excluded, rest averaged (→0.92)', approx(src.rate('EUR'), 0.92, 1e-9));
		check(
			'averaging: contributing_sources excludes the down one',
			src.currentDetailed().contributing_sources.length === 2 &&
				!src.currentDetailed().contributing_sources.includes('down')
		);
	}

	// ─── Composite: per-source health (for morphit-ops view) ────
	{
		const clock = { t: 5000 };
		const src = makeComposite(
			[
				{ name: 'up', fetch: async () => goodTable() },
				{ name: 'broken', fetch: async () => null }
			],
			clock
		);
		await src.refreshOnce();
		const statuses = src.sourceStatus();
		const up = statuses.find((s) => s.name === 'up');
		const broken = statuses.find((s) => s.name === 'broken');
		check('source-status: up source ok=true with lastOkAt set', !!up && up.ok === true && up.lastOkAt !== null && up.currencyCount > 0);
		check('source-status: broken source ok=false, lastOkAt null', !!broken && broken.ok === false && broken.lastOkAt === null);
		check('source-status: broken source still recorded lastTriedAt', !!broken && broken.lastTriedAt !== null);
	}

	// ─── Fetchers: Frankfurter ──────────────────────────────────
	{
		const f = createFrankfurterFetcher({
			baseUrl: 'https://x/v1',
			timeoutMs: 1000,
			fetchImpl: mockFetch({ amount: 1, base: 'USD', date: '2026-01-01', rates: goodRates() })
		});
		const t = await f();
		check('frankfurter: parses USD-base rates', t !== null && approx(t.rates.EUR, 0.92));
	}
	{
		const f = createFrankfurterFetcher({
			baseUrl: 'https://x/v1',
			timeoutMs: 1000,
			fetchImpl: mockFetch({ base: 'EUR', rates: goodRates() })
		});
		check('frankfurter: rejects non-USD base', (await f()) === null);
	}

	// ─── Fetchers: open.er-api ──────────────────────────────────
	{
		const f = createErApiFetcher({
			baseUrl: 'https://x/v6',
			timeoutMs: 1000,
			fetchImpl: mockFetch({ result: 'success', base_code: 'USD', rates: goodRates() })
		});
		const t = await f();
		check('er_api: parses success table', t !== null && approx(t.rates.GBP, 0.79));
	}
	{
		const f = createErApiFetcher({
			baseUrl: 'https://x/v6',
			timeoutMs: 1000,
			fetchImpl: mockFetch({ result: 'error', 'error-type': 'unsupported-code' })
		});
		check('er_api: rejects non-success result', (await f()) === null);
	}

	// ─── Fetchers: currency-api (lowercase, nested under usd) ───
	{
		const f = createCurrencyApiFetcher({
			baseUrl: 'https://cdn/v1',
			timeoutMs: 1000,
			fetchImpl: mockFetch({ date: '2026-01-01', usd: { eur: 0.92, gbp: 0.79, jpy: 150, aud: 1.52, cad: 1.36, chf: 0.88, cny: 7.2, inr: 83, mxn: 17, brl: 5.0, zar: 18.5 } })
		});
		const t = await f();
		check('currency_api: parses + uppercases nested usd map', t !== null && approx(t.rates.EUR, 0.92) && approx(t.rates.AUD, 1.52));
	}

	// ─── Fetchers: HTTP error paths → null (never throw) ────────
	{
		const f = createFrankfurterFetcher({ baseUrl: 'https://x/v1', timeoutMs: 1000, fetchImpl: mockFetch({}, { status: 429 }) });
		check('fetcher: HTTP 429 → null', (await f()) === null);
	}
	{
		const f = createErApiFetcher({ baseUrl: 'https://x/v6', timeoutMs: 1000, fetchImpl: mockFetch({}, { status: 500 }) });
		check('fetcher: HTTP 500 → null', (await f()) === null);
	}
	{
		const f = createCurrencyApiFetcher({ baseUrl: 'https://cdn/v1', timeoutMs: 1000, fetchImpl: throwingFetch });
		let threw = false;
		let res: FxRateTable | null = null;
		try {
			res = await f();
		} catch {
			threw = true;
		}
		check('fetcher: network throw → null, never throws', !threw && res === null);
	}

	// ─── Static table sanity ────────────────────────────────────
	check('static: USD = 1', STATIC_FX_TABLE.rates.USD === 1);
	check('static: has EUR + GBP', typeof STATIC_FX_TABLE.rates.EUR === 'number' && typeof STATIC_FX_TABLE.rates.GBP === 'number');
	check('static: ≥ 10 currencies', Object.keys(STATIC_FX_TABLE.rates).length >= 10);
	check('static: table itself is plausible', isPlausibleFxTable(STATIC_FX_TABLE));
	check('static: staticTableHas case-insensitive (aud)', staticTableHas('aud') === true);
	check('static: staticTableHas unknown false (ZZZ)', staticTableHas('ZZZ') === false);

	const total = passed + failed;
	console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
	if (failed > 0) {
		console.error('\nfx-source smoke FAILED');
		process.exit(1);
	}
	console.log(`✓ all ${total} fx-source scenarios passed`);
}

void main();
