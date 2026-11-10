#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/price-primary-fallback-smoke.ts
 *
 * Pins the BLURT/USD precedence, by running the real factory against
 * stubbed price hosts (no network):
 *
 *   - Blurt's own `api.blurt.blog/price_info` feed and Cexius's BLURT/USDT
 *     are the PRIMARY source (v1.24.0): asked together, both answers
 *     averaged ('primary_avg'), either one alone when the other is down;
 *   - the CEX-aggregator average is asked only when BOTH are down
 *     (then morphit_native, then the static floor).
 *
 * The composite's tier logic itself is covered by the vitest suite
 * (test/indexer/price/compositeSource.test.ts, cexiusBlend.test.ts).
 */

import { createPriceSource } from '../src/indexer/price/factory';
import { fakeConfig } from '../test/testutils/context';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

const AGGREGATOR_HOSTS = ['api.coingecko.com', 'api.coinpaprika.com', 'min-api.cryptocompare.com'];

/** Stub the price hosts: Blurt's feed and Cexius answer the given prices (or
 *  nothing when null); every aggregator answers 0.0009. Returns the hosts asked. */
function stub(blurt: number | null, cexius: number | null): Set<string> {
	const asked = new Set<string>();
	globalThis.fetch = (async (input: string | URL) => {
		const u = new URL(String(input));
		asked.add(u.host);
		if (u.host === 'api.blurt.blog' && blurt !== null)
			return new Response(JSON.stringify({ price_usd: blurt }), { status: 200 });
		if (u.host === 'cexius.com' && cexius !== null)
			return new Response(
				JSON.stringify({ ticker: { market: 'BLURT-USDT', quote_unit: 'USDT', last: String(cexius) } }),
				{ status: 200 }
			);
		if (u.host === 'api.coingecko.com')
			return new Response(JSON.stringify({ blurt: { usd: 0.0009 } }), { status: 200 });
		if (u.host === 'api.coinpaprika.com')
			return new Response(JSON.stringify({ quotes: { USD: { price: 0.0009 } } }), { status: 200 });
		throw new Error('connect ETIMEDOUT');
	}) as typeof fetch;
	return asked;
}

async function run(blurt: number | null, cexius: number | null) {
	const asked = stub(blurt, cexius);
	const s = createPriceSource(
		fakeConfig({
			blurtPriceFeedUrl: 'https://api.blurt.blog/price_info',
			cexiusBaseUrl: 'https://cexius.com/api/v2'
		})
	);
	await (s as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
	return { d: s.currentDetailed(), asked };
}

console.log('\n── price primary/fallback smoke ─────────────────────\n');

{
	const { d, asked } = await run(0.000714, 0.000808);
	check(
		'both answer: their average is committed as primary_avg',
		d.source === 'primary_avg' && Math.abs(d.price - 0.000761) < 1e-12,
		`${d.source} ${d.price}`
	);
	check('both answer: no aggregator is asked', !AGGREGATOR_HOSTS.some((h) => asked.has(h)), [...asked].join(' '));
}
{
	const { d, asked } = await run(0.000714, null);
	check('Cexius down: Blurt’s feed alone', d.source === 'blurt_price_feed' && d.price === 0.000714, `${d.source} ${d.price}`);
	check('Cexius down: no aggregator is asked', !AGGREGATOR_HOSTS.some((h) => asked.has(h)));
}
{
	const { d } = await run(null, 0.000808);
	check('Blurt’s feed down: Cexius alone', d.source === 'cexius' && d.price === 0.000808, `${d.source} ${d.price}`);
}
{
	const { d, asked } = await run(null, null);
	check('both down: the aggregator average', d.source === 'external_avg', d.source);
	check('both down: the aggregators were asked', asked.has('api.coingecko.com'));
}

console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
	console.error('price-primary-fallback smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} price-primary-fallback scenarios passed`);
