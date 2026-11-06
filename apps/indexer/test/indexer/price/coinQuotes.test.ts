/**
 * The other coins' USD prices (v1.23.2, display only): the "(≈11 BRL)" beside
 * an amount of ETH, LTC, DOGE … and the amount filled in for them.
 *
 * Sources: the onion pricenodes' consensus (always, over Tor), and — only
 * where this instance may reach clearnet — one CoinGecko and one
 * CryptoCompare request for all the coins at once. Never a bundled constant:
 * a coin nobody answered for is simply absent.
 */
import { describe, expect, it } from 'vitest';

import {
	COIN_QUOTE_IDS,
	CoinQuoteSource,
	parseCoingeckoBatch,
	parseCryptocompareBatch
} from '$indexer/price/coinQuotes';
import { PRICENODE_COINS } from '$indexer/price/pricenodes';

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CG = {
	ethereum: { usd: 3000 },
	litecoin: { usd: 90 },
	tether: { usd: 1.0004 },
	dogecoin: { usd: 0 }, // not a price
	'pirate-chain': { eur: 0.2 } // wrong currency
};
const CC = {
	ETH: { USD: 3010 },
	LTC: { USD: 89 },
	USDT: { USD: 0.9996 },
	DOGE: { USD: 'x' }
};

function fakeFetch(handlers: { cg?: () => Response; cc?: () => Response }, seen: string[]) {
	return (async (url: string) => {
		seen.push(url);
		if (url.includes('/simple/price')) return handlers.cg ? handlers.cg() : json({}, 500);
		if (url.includes('/data/pricemulti')) return handlers.cc ? handlers.cc() : json({}, 500);
		return json({}, 404);
	}) as unknown as typeof fetch;
}

function source(over: Partial<ConstructorParameters<typeof CoinQuoteSource>[0]> = {}) {
	return new CoinQuoteSource({
		pricenodes: null,
		clearnetAllowed: () => true,
		coingecko: { baseUrl: 'https://cg.example/api/v3' },
		cryptocompare: { baseUrl: 'https://cc.example' },
		refreshIntervalMs: 300_000,
		outlierTolerance: 0.05,
		...over
	});
}

describe('coin quotes: the batch answers (pure)', () => {
	it('every listed coin has a CoinGecko id and a CryptoCompare symbol; ECX has neither', () => {
		expect(Object.keys(COIN_QUOTE_IDS).sort()).toEqual([...PRICENODE_COINS].sort());
		expect(COIN_QUOTE_IDS.ECX).toBeUndefined();
		expect(COIN_QUOTE_IDS.ARRR!.coingecko).toBe('pirate-chain');
		expect(COIN_QUOTE_IDS.XRP!.coingecko).toBe('ripple');
	});

	it('CoinGecko: { id: { usd } } back to tickers; a zero, a wrong currency or junk is left out', () => {
		const m = parseCoingeckoBatch(CG);
		expect(m.get('ETH')).toBe(3000);
		expect(m.get('LTC')).toBe(90);
		expect(m.get('USDT')).toBe(1.0004);
		expect(m.has('DOGE')).toBe(false);
		expect(m.has('ARRR')).toBe(false);
		expect(parseCoingeckoBatch(null).size).toBe(0);
		expect(parseCoingeckoBatch([1]).size).toBe(0);
	});

	it('CryptoCompare: { SYM: { USD } }; its 200-with-Response:"Error" is nothing', () => {
		const m = parseCryptocompareBatch(CC);
		expect(m.get('ETH')).toBe(3010);
		expect(m.has('DOGE')).toBe(false);
		expect(parseCryptocompareBatch({ Response: 'Error', Message: 'x', ETH: { USD: 5 } }).size).toBe(
			0
		);
		expect(parseCryptocompareBatch({ ECX: { USD: 5 } }).size).toBe(0);
	});
});

describe('CoinQuoteSource', () => {
	it('one request per provider for all coins; the robust mean of what answered', async () => {
		const seen: string[] = [];
		const s = source({ fetchImpl: fakeFetch({ cg: () => json(CG), cc: () => json(CC) }, seen) });
		expect(s.currentUsd()).toEqual({});
		await s.refreshOnce();
		expect(seen).toHaveLength(2);
		const cg = new URL(seen.find((u) => u.includes('/simple/price'))!);
		expect(cg.searchParams.get('vs_currencies')).toBe('usd');
		expect(cg.searchParams.get('ids')!.split(',')).toContain('pirate-chain');
		const cc = new URL(seen.find((u) => u.includes('/data/pricemulti'))!);
		expect(cc.searchParams.get('tsyms')).toBe('USD');
		expect(cc.searchParams.get('fsyms')!.split(',')).toContain('ARRR');
		const p = s.currentUsd();
		expect(p.ETH).toBeCloseTo(3005, 9);
		expect(p.LTC).toBeCloseTo(89.5, 9);
		expect(p.USDT).toBeCloseTo(1, 9);
		expect(p.DOGE).toBeUndefined();
		expect(p.ECX).toBeUndefined();
	});

	it('a hidden-only instance (no clearnet) asks no clearnet service; the pricenodes still answer', async () => {
		const seen: string[] = [];
		const s = source({
			clearnetAllowed: () => false,
			fetchImpl: fakeFetch({ cg: () => json(CG), cc: () => json(CC) }, seen),
			pricenodes: { coinUsd: (c: string) => (c === 'ETH' ? 2990 : null) }
		});
		await s.refreshOnce();
		expect(seen).toHaveLength(0);
		expect(s.currentUsd()).toEqual({ ETH: 2990 });
	});

	it('pricenodes and clearnet together; one far-off answer is outvoted', async () => {
		const s = source({
			fetchImpl: fakeFetch(
				{ cg: () => json({ ethereum: { usd: 3000 } }), cc: () => json({ ETH: { USD: 9000 } }) },
				[]
			),
			pricenodes: { coinUsd: (c: string) => (c === 'ETH' ? 3010 : null) }
		});
		await s.refreshOnce();
		expect(s.currentUsd().ETH).toBeCloseTo(3005, 9);
	});

	it('an implausible price is never shown (a stablecoin at 3 USD, a coin at 0)', async () => {
		const s = source({
			fetchImpl: fakeFetch({ cg: () => json({ tether: { usd: 3 }, 'usd-coin': { usd: 1 } }) }, [])
		});
		await s.refreshOnce();
		expect(s.currentUsd()).toEqual({ USDC: 1 });
	});

	it('an answer goes stale: past two refreshes (and a timeout) it is no longer served', async () => {
		let now = 1_000_000;
		let fail = false;
		const s = source({
			now: () => now,
			fetchImpl: fakeFetch({ cg: () => (fail ? json({ unexpected: true }) : json(CG)) }, [])
		});
		await s.refreshOnce();
		expect(s.currentUsd().ETH).toBe(3000);
		fail = true;
		now += 300_000;
		await s.refreshOnce();
		expect(s.currentUsd().ETH).toBe(3000); // the last answer, still fresh enough
		now += 300_000 + 31_000;
		expect(s.currentUsd().ETH).toBeUndefined();
	});

	it('a rate limit, a timeout or a throw leaves the source answering null, never throwing', async () => {
		const s = source({
			fetchImpl: (async () => {
				throw new Error('boom');
			}) as unknown as typeof fetch
		});
		await expect(s.refreshOnce()).resolves.toBeUndefined();
		expect(s.currentUsd()).toEqual({});
	});
});
