/**
 * price-feeds-health-smoke (cp372)
 *
 * Verifies buildPriceFeedsHealth (the /v1/health `price_feeds`
 * block + morphit-ops node-health source) correctly summarizes the
 * multi-source FX + crypto feed status: per-source up/down, seconds
 * since last success, staleness, contributing count, and the
 * provider-disagreement (outlier-rejected) flag.  Pure — no Hono.
 *
 * Run: npx tsx --tsconfig ../../tsconfig.smoke.json scripts/price-feeds-health-smoke.ts
 */

import { buildPriceFeedsHealth } from '../src/api/priceFeedsHealth.ts';
import type { FxRateSource } from '../src/indexer/fx/source.ts';
import type { BlurtPriceSource } from '../src/indexer/price/source.ts';

const T = 1_000_000_000_000; // fixed "now" in ms
const now = () => T;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

function fakeFx(opts: {
	source: string;
	stale: boolean;
	currencyCount: number;
	outlier: boolean;
	contributing: string[];
	sources: Array<{ name: string; ok: boolean; lastOkAgoS: number | null }>;
}): FxRateSource {
	return {
		rate: () => 1,
		usdToFiat: (u) => u,
		fiatToUsd: (a) => a,
		currentDetailed: () => ({
			rates: { USD: 1 },
			source: opts.source,
			updated_at: new Date(T),
			stale: opts.stale,
			live_currency_count: opts.currencyCount,
			contributing_sources: opts.contributing,
			outlier_rejected: opts.outlier
		}),
		sourceStatus: () =>
			opts.sources.map((s) => ({
				name: s.name,
				ok: s.ok,
				lastOkAt: s.lastOkAgoS === null ? null : new Date(T - s.lastOkAgoS * 1000),
				lastTriedAt: new Date(T),
				currencyCount: s.ok ? opts.currencyCount : 0
			})),
		start: () => {},
		stop: () => {}
	};
}

function fakeCrypto(opts: {
	source: string;
	stale: boolean;
	outlier: boolean;
	sources: Array<{ name: string; ok: boolean; lastOkAgoS: number | null }>;
}): BlurtPriceSource {
	return {
		current: () => 1,
		currentDetailed: () => ({ price: 1, source: opts.source, updated_at: new Date(T), stale: opts.stale }),
		start: () => {},
		stop: () => {},
		sourceStatus: () =>
			opts.sources.map((s) => ({
				name: s.name,
				ok: s.ok,
				lastOkAt: s.lastOkAgoS === null ? null : new Date(T - s.lastOkAgoS * 1000),
				lastTriedAt: new Date(T),
				lastValue: s.ok ? 1 : null
			})),
		outlierRejected: () => opts.outlier
	};
}

console.log('\n\u2500\u2500\u2500 price-feeds-health smoke (cp372) \u2500\u2500\u2500');

// ── FX present: 3 sources, one down, an outlier flagged ──
{
	const fx = fakeFx({
		source: 'frankfurter+er_api',
		stale: false,
		currencyCount: 44,
		outlier: true,
		contributing: ['frankfurter', 'er_api'],
		sources: [
			{ name: 'frankfurter', ok: true, lastOkAgoS: 12 },
			{ name: 'er_api', ok: true, lastOkAgoS: 12 },
			{ name: 'currency_api', ok: false, lastOkAgoS: 600 }
		]
	});
	const crypto = new Map<string, BlurtPriceSource>([
		['BLURT', fakeCrypto({ source: 'external_avg', stale: false, outlier: false, sources: [
			{ name: 'coingecko', ok: true, lastOkAgoS: 30 },
			{ name: 'coinpaprika', ok: true, lastOkAgoS: 30 }
		] })],
		['BTC', fakeCrypto({ source: 'external_avg', stale: false, outlier: true, sources: [
			{ name: 'coingecko', ok: true, lastOkAgoS: 30 },
			{ name: 'coinpaprika', ok: true, lastOkAgoS: 30 },
			{ name: 'kraken', ok: false, lastOkAgoS: null }
		] })],
		['XMR', fakeCrypto({ source: 'morphit_native', stale: true, outlier: false, sources: [
			{ name: 'coingecko', ok: false, lastOkAgoS: 9000 },
			{ name: 'coinpaprika', ok: false, lastOkAgoS: 9000 },
			{ name: 'kraken', ok: false, lastOkAgoS: 9000 }
		] })]
	]);
	const h = buildPriceFeedsHealth(fx, crypto, now);

	check('fx enabled', h.fx.enabled === true);
	if (h.fx.enabled) {
		check('fx source label preserved', h.fx.source === 'frankfurter+er_api');
		check('fx contributing === 2', h.fx.contributing === 2);
		check('fx outlier_rejected true', h.fx.outlier_rejected === true);
		check('fx not stale', h.fx.stale === false);
		check('fx 3 source rows', h.fx.sources.length === 3);
		const cur = h.fx.sources.find((s) => s.name === 'currency_api');
		check('fx down source ok=false, age 600s', !!cur && cur.ok === false && cur.last_ok_age_s === 600);
		const fr = h.fx.sources.find((s) => s.name === 'frankfurter');
		check('fx up source age 12s', !!fr && fr.last_ok_age_s === 12);
	}

	check('crypto has BLURT/BTC/XMR', !!h.crypto.BLURT && !!h.crypto.BTC && !!h.crypto.XMR);
	check('BTC outlier_rejected true', h.crypto.BTC!.outlier_rejected === true);
	check('BTC kraken down with null age', h.crypto.BTC!.sources.find((s) => s.name === 'kraken')?.last_ok_age_s === null);
	check('BLURT external_avg, no outlier', h.crypto.BLURT!.source === 'external_avg' && h.crypto.BLURT!.outlier_rejected === false);
	check('XMR fell back to native + stale', h.crypto.XMR!.source === 'morphit_native' && h.crypto.XMR!.stale === true);
}

// ── FX absent (feed disabled) ──
{
	const h = buildPriceFeedsHealth(null, new Map(), now);
	check('fx disabled when source null', h.fx.enabled === false);
	check('crypto empty when no sources', Object.keys(h.crypto).length === 0);
}

// ── Source without sourceStatus() (e.g. a non-composite impl) → empty rows, no crash ──
{
	const bare: BlurtPriceSource = {
		current: () => 1,
		currentDetailed: () => ({ price: 1, source: 'external_avg', updated_at: new Date(T), stale: false }),
		start: () => {},
		stop: () => {}
	};
	const h = buildPriceFeedsHealth(null, new Map([['BTC', bare]]), now);
	check('bare source → empty source rows, no outlier, no crash', h.crypto.BTC!.sources.length === 0 && h.crypto.BTC!.outlier_rejected === false);
}

console.log('\u2500'.repeat(56));
if (failed === 0) {
	console.log(`\u2713 all ${passed} price-feeds-health scenarios passed`);
} else {
	console.log(`${passed} passed, ${failed} failed (${passed + failed} total)`);
	console.log('price-feeds-health-smoke FAILED');
	process.exit(1);
}
