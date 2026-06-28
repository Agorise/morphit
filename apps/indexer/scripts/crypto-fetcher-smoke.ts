/**
 * crypto-fetcher-smoke (cp372)
 *
 * Parse + error-handling tests for the additional no-key crypto→USD
 * fetchers added for the multi-source average: CoinPaprika and
 * Kraken.  Each must extract the right price on a good response and
 * return null (never throw) on rate-limit, HTTP error, malformed
 * body, missing fields, non-positive values, or a thrown fetch.
 *
 * Run: npx tsx --tsconfig ../../tsconfig.smoke.json scripts/crypto-fetcher-smoke.ts
 */

import { createCoinpaprikaFetcher } from '../src/indexer/price/coinpaprikaFetcher';
import { createKrakenFetcher } from '../src/indexer/price/krakenFetcher';

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

/** Minimal Response stub: no content-length (skips the cap
 *  pre-check), no body stream (forces the res.text() fallback path
 *  in readPriceBodyCapped). */
function mockRes(status: number, jsonObj: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (_n: string) => null },
		body: undefined,
		text: async () => JSON.stringify(jsonObj)
	} as unknown as Response;
}
const fetchReturning = (res: Response): typeof globalThis.fetch =>
	(async () => res) as unknown as typeof globalThis.fetch;
const fetchThrowing = (): typeof globalThis.fetch =>
	(async () => {
		throw new Error('network boom');
	}) as unknown as typeof globalThis.fetch;

async function main(): Promise<void> {
	console.log('\n\u2500\u2500\u2500 crypto-fetcher smoke (cp372) \u2500\u2500\u2500');

	// ── CoinPaprika ─────────────────────────────────────────────
	const cpBase = { baseUrl: 'https://api.coinpaprika.com/v1', coinId: 'btc-bitcoin', vsCurrency: 'USD', timeoutMs: 1000 };
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchReturning(mockRes(200, { quotes: { USD: { price: 65000.5 } } })) });
		check('coinpaprika: parses quotes.USD.price', (await f()) === 65000.5);
	}
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchReturning(mockRes(200, { quotes: {} })) });
		check('coinpaprika: missing USD quote → null', (await f()) === null);
	}
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchReturning(mockRes(200, { nope: true })) });
		check('coinpaprika: missing quotes object → null', (await f()) === null);
	}
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchReturning(mockRes(200, { quotes: { USD: { price: 0 } } })) });
		check('coinpaprika: non-positive price → null', (await f()) === null);
	}
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchReturning(mockRes(200, { quotes: { USD: { price: 'abc' } } })) });
		check('coinpaprika: non-numeric price → null', (await f()) === null);
	}
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchReturning(mockRes(429, {})) });
		check('coinpaprika: 429 rate-limit → null', (await f()) === null);
	}
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchReturning(mockRes(500, {})) });
		check('coinpaprika: 500 → null', (await f()) === null);
	}
	{
		const f = createCoinpaprikaFetcher({ ...cpBase, fetchImpl: fetchThrowing() });
		check('coinpaprika: fetch throws → null (never propagates)', (await f()) === null);
	}

	// ── Kraken ──────────────────────────────────────────────────
	const krBase = { baseUrl: 'https://api.kraken.com/0/public', pair: 'XBTUSD', timeoutMs: 1000 };
	{
		const f = createKrakenFetcher({ ...krBase, fetchImpl: fetchReturning(mockRes(200, { error: [], result: { XXBTZUSD: { c: ['65000.1', '0.01'] } } })) });
		check('kraken: parses result[firstKey].c[0]', (await f()) === 65000.1);
	}
	{
		const f = createKrakenFetcher({ ...krBase, fetchImpl: fetchReturning(mockRes(200, { error: ['EQuery:Unknown asset pair'], result: {} })) });
		check('kraken: non-empty error array → null', (await f()) === null);
	}
	{
		const f = createKrakenFetcher({ ...krBase, fetchImpl: fetchReturning(mockRes(200, { error: [], result: {} })) });
		check('kraken: empty result → null', (await f()) === null);
	}
	{
		const f = createKrakenFetcher({ ...krBase, fetchImpl: fetchReturning(mockRes(200, { error: [], result: { XXBTZUSD: { c: [] } } })) });
		check('kraken: empty c array → null', (await f()) === null);
	}
	{
		const f = createKrakenFetcher({ ...krBase, fetchImpl: fetchReturning(mockRes(200, { error: [], result: { XXBTZUSD: { c: ['0'] } } })) });
		check('kraken: non-positive last price → null', (await f()) === null);
	}
	{
		const f = createKrakenFetcher({ ...krBase, fetchImpl: fetchReturning(mockRes(429, {})) });
		check('kraken: 429 rate-limit → null', (await f()) === null);
	}
	{
		const f = createKrakenFetcher({ ...krBase, fetchImpl: fetchThrowing() });
		check('kraken: fetch throws → null (never propagates)', (await f()) === null);
	}

	console.log('\u2500'.repeat(56));
	if (failed === 0) {
		console.log(`\u2713 all ${passed} crypto-fetcher scenarios passed`);
	} else {
		console.log(`${passed} passed, ${failed} failed (${passed + failed} total)`);
		console.log('crypto-fetcher-smoke FAILED');
		process.exit(1);
	}
}

void main();
