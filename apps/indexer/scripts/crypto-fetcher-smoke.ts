/**
 * crypto-fetcher-smoke (cp372)
 *
 * Parse + error-handling tests for the crypto→USD fetchers in the
 * multi-source median: CoinPaprika, Kraken, CryptoCompare, Binance,
 * Coinbase, OKX, Bybit, CoinLore, CoinCap (key-gated), Messari
 * (key-gated).  Each must extract the right price on a good response and
 * return null (never throw) on rate-limit, HTTP error, malformed
 * body, missing fields, non-positive values, or a thrown fetch.
 *
 * Run: npx tsx --tsconfig ../../tsconfig.smoke.json scripts/crypto-fetcher-smoke.ts
 */

import { createCoinpaprikaFetcher } from '../src/indexer/price/coinpaprikaFetcher';
import { createKrakenFetcher } from '../src/indexer/price/krakenFetcher';
import { createCryptocompareFetcher } from '../src/indexer/price/cryptocompareFetcher';
import { createBinanceFetcher } from '../src/indexer/price/binanceFetcher';
import { createCoinbaseFetcher } from '../src/indexer/price/coinbaseFetcher';
import { createOkxFetcher } from '../src/indexer/price/okxFetcher';
import { createBybitFetcher } from '../src/indexer/price/bybitFetcher';
import { createCoincapFetcher } from '../src/indexer/price/coincapFetcher';
import { createCoinloreFetcher } from '../src/indexer/price/coinloreFetcher';
import { createMessariFetcher } from '../src/indexer/price/messariFetcher';

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

	// ── CryptoCompare (symbol-keyed; covers BLURT) ──────────────
	const ccBase = { baseUrl: 'https://min-api.cryptocompare.com', symbol: 'BTC', timeoutMs: 1000 };
	{
		const f = createCryptocompareFetcher({ ...ccBase, fetchImpl: fetchReturning(mockRes(200, { USD: 65000.5 })) });
		check('cryptocompare: parses USD', (await f()) === 65000.5);
	}
	{
		const f = createCryptocompareFetcher({ ...ccBase, fetchImpl: fetchReturning(mockRes(200, { Response: 'Error', Message: 'bad sym' })) });
		check('cryptocompare: Response:Error (200) → null', (await f()) === null);
	}
	{
		const f = createCryptocompareFetcher({ ...ccBase, fetchImpl: fetchReturning(mockRes(200, { USD: 0 })) });
		check('cryptocompare: non-positive → null', (await f()) === null);
	}
	{
		const f = createCryptocompareFetcher({ ...ccBase, fetchImpl: fetchReturning(mockRes(429, {})) });
		check('cryptocompare: 429 → null', (await f()) === null);
	}
	{
		const f = createCryptocompareFetcher({ ...ccBase, fetchImpl: fetchThrowing() });
		check('cryptocompare: throws → null', (await f()) === null);
	}

	// ── Binance ─────────────────────────────────────────────────
	const bnBase = { baseUrl: 'https://api.binance.com', symbol: 'BTCUSDT', timeoutMs: 1000 };
	{
		const f = createBinanceFetcher({ ...bnBase, fetchImpl: fetchReturning(mockRes(200, { symbol: 'BTCUSDT', price: '65000.10' })) });
		check('binance: parses price', (await f()) === 65000.1);
	}
	{
		const f = createBinanceFetcher({ ...bnBase, fetchImpl: fetchReturning(mockRes(400, { code: -1121, msg: 'Invalid symbol.' })) });
		check('binance: bad symbol (400) → null', (await f()) === null);
	}
	{
		const f = createBinanceFetcher({ ...bnBase, fetchImpl: fetchReturning(mockRes(418, {})) });
		check('binance: 418 ban → null', (await f()) === null);
	}
	{
		const f = createBinanceFetcher({ ...bnBase, fetchImpl: fetchThrowing() });
		check('binance: throws → null', (await f()) === null);
	}

	// ── Coinbase ────────────────────────────────────────────────
	const cbBase = { baseUrl: 'https://api.exchange.coinbase.com', product: 'BTC-USD', timeoutMs: 1000 };
	{
		const f = createCoinbaseFetcher({ ...cbBase, fetchImpl: fetchReturning(mockRes(200, { price: '65000.12', time: 't' })) });
		check('coinbase: parses price', (await f()) === 65000.12);
	}
	{
		const f = createCoinbaseFetcher({ ...cbBase, fetchImpl: fetchReturning(mockRes(404, { message: 'NotFound' })) });
		check('coinbase: 404 → null', (await f()) === null);
	}
	{
		const f = createCoinbaseFetcher({ ...cbBase, fetchImpl: fetchReturning(mockRes(200, { price: '-5' })) });
		check('coinbase: negative → null', (await f()) === null);
	}
	{
		const f = createCoinbaseFetcher({ ...cbBase, fetchImpl: fetchThrowing() });
		check('coinbase: throws → null', (await f()) === null);
	}

	// ── OKX ─────────────────────────────────────────────────────
	const okBase = { baseUrl: 'https://www.okx.com', instId: 'BTC-USDT', timeoutMs: 1000 };
	{
		const f = createOkxFetcher({ ...okBase, fetchImpl: fetchReturning(mockRes(200, { code: '0', data: [{ last: '65000.3' }] })) });
		check('okx: parses data[0].last', (await f()) === 65000.3);
	}
	{
		const f = createOkxFetcher({ ...okBase, fetchImpl: fetchReturning(mockRes(200, { code: '51001', msg: 'no inst', data: [] })) });
		check('okx: error code → null', (await f()) === null);
	}
	{
		const f = createOkxFetcher({ ...okBase, fetchImpl: fetchReturning(mockRes(200, { code: '0', data: [] })) });
		check('okx: empty data → null', (await f()) === null);
	}
	{
		const f = createOkxFetcher({ ...okBase, fetchImpl: fetchThrowing() });
		check('okx: throws → null', (await f()) === null);
	}

	// ── Bybit ───────────────────────────────────────────────────
	const byBase = { baseUrl: 'https://api.bybit.com', symbol: 'BTCUSDT', timeoutMs: 1000 };
	{
		const f = createBybitFetcher({ ...byBase, fetchImpl: fetchReturning(mockRes(200, { retCode: 0, result: { list: [{ lastPrice: '65000.4' }] } })) });
		check('bybit: parses result.list[0].lastPrice', (await f()) === 65000.4);
	}
	{
		const f = createBybitFetcher({ ...byBase, fetchImpl: fetchReturning(mockRes(200, { retCode: 10001, result: {} })) });
		check('bybit: retCode error → null', (await f()) === null);
	}
	{
		const f = createBybitFetcher({ ...byBase, fetchImpl: fetchReturning(mockRes(200, { retCode: 0, result: { list: [] } })) });
		check('bybit: empty list → null', (await f()) === null);
	}
	{
		const f = createBybitFetcher({ ...byBase, fetchImpl: fetchThrowing() });
		check('bybit: throws → null', (await f()) === null);
	}

	// ── CoinLore (numeric-id; array body) ───────────────────────
	const clBase = { baseUrl: 'https://api.coinlore.net', assetId: '90', timeoutMs: 1000 };
	{
		const f = createCoinloreFetcher({ ...clBase, fetchImpl: fetchReturning(mockRes(200, [{ id: '90', symbol: 'BTC', price_usd: '65000.6' }])) });
		check('coinlore: parses [0].price_usd', (await f()) === 65000.6);
	}
	{
		const f = createCoinloreFetcher({ ...clBase, fetchImpl: fetchReturning(mockRes(200, [])) });
		check('coinlore: empty array → null', (await f()) === null);
	}
	{
		const f = createCoinloreFetcher({ ...clBase, fetchImpl: fetchReturning(mockRes(200, { error: 'not found' })) });
		check('coinlore: non-array (error) → null', (await f()) === null);
	}
	{
		const f = createCoinloreFetcher({ ...clBase, fetchImpl: fetchThrowing() });
		check('coinlore: throws → null', (await f()) === null);
	}

	// ── CoinCap (key-gated; data.priceUsd) ──────────────────────
	const ccapBase = { baseUrl: 'https://rest.coincap.io/v3', assetId: 'bitcoin', apiKey: 'k', timeoutMs: 1000 };
	{
		const f = createCoincapFetcher({ ...ccapBase, fetchImpl: fetchReturning(mockRes(200, { data: { id: 'bitcoin', priceUsd: '65000.7' } })) });
		check('coincap: parses data.priceUsd', (await f()) === 65000.7);
	}
	{
		const f = createCoincapFetcher({ ...ccapBase, fetchImpl: fetchReturning(mockRes(401, {})) });
		check('coincap: 401 (bad/no key) → null', (await f()) === null);
	}
	{
		const f = createCoincapFetcher({ ...ccapBase, fetchImpl: fetchReturning(mockRes(200, { data: null })) });
		check('coincap: null data → null', (await f()) === null);
	}
	{
		const f = createCoincapFetcher({ ...ccapBase, fetchImpl: fetchThrowing() });
		check('coincap: throws → null', (await f()) === null);
	}

	// ── Messari (key-gated; data.market_data.price_usd) ─────────
	const msBase = { baseUrl: 'https://data.messari.io', slug: 'bitcoin', apiKey: 'k', timeoutMs: 1000 };
	{
		const f = createMessariFetcher({ ...msBase, fetchImpl: fetchReturning(mockRes(200, { data: { market_data: { price_usd: 65000.8 } } })) });
		check('messari: parses data.market_data.price_usd', (await f()) === 65000.8);
	}
	{
		const f = createMessariFetcher({ ...msBase, fetchImpl: fetchReturning(mockRes(404, {})) });
		check('messari: 404 → null', (await f()) === null);
	}
	{
		const f = createMessariFetcher({ ...msBase, fetchImpl: fetchReturning(mockRes(200, { data: { market_data: null } })) });
		check('messari: null market_data → null', (await f()) === null);
	}
	{
		const f = createMessariFetcher({ ...msBase, fetchImpl: fetchThrowing() });
		check('messari: throws → null', (await f()) === null);
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
