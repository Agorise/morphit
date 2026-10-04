/**
 * Live USD prices for the treasury re-pin tools, from independent sources.
 * A re-pin used to follow CoinGecko alone, so
 * one wrong answer from one site could re-pin every instance's fees.
 *
 * Each asset's price is the one at least two sources agree on
 * (treasuryRepin.agreedPrice); with fewer, that asset is not re-pinned.
 *   BTC   CoinGecko, CoinPaprika, Kraken
 *   XMR   CoinGecko, CoinPaprika, Kraken
 *   BLURT CoinGecko, CoinPaprika
 * Run on the maintainer's laptop or signing box, never on an instance.
 */
import { agreedPrice, type RepinPrices } from '../src/lib/treasuryRepin.ts';

type Fetch = typeof globalThis.fetch;
type Asset = 'btc' | 'xmr' | 'blurt';
export type Quotes = Record<Asset, Record<string, number | null>>;

async function getJson(fetchImpl: Fetch, url: string): Promise<unknown> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), 10_000);
	try {
		const res = await fetchImpl(url, {
			headers: { accept: 'application/json' },
			signal: ac.signal
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(t);
	}
}

const num = (v: unknown): number | null => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

async function coingecko(f: Fetch): Promise<Record<Asset, number | null>> {
	const b = (await getJson(
		f,
		'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,monero,blurt&vs_currencies=usd'
	)) as Record<string, { usd?: unknown }>;
	return { btc: num(b.bitcoin?.usd), xmr: num(b.monero?.usd), blurt: num(b.blurt?.usd) };
}

async function coinpaprika(f: Fetch): Promise<Record<Asset, number | null>> {
	const one = async (id: string): Promise<number | null> => {
		try {
			const b = (await getJson(f, `https://api.coinpaprika.com/v1/tickers/${id}?quotes=USD`)) as {
				quotes?: { USD?: { price?: unknown } };
			};
			return num(b.quotes?.USD?.price);
		} catch {
			return null;
		}
	};
	const [btc, xmr, blurt] = await Promise.all([
		one('btc-bitcoin'),
		one('xmr-monero'),
		one('blurt-blurt')
	]);
	return { btc, xmr, blurt };
}

async function kraken(f: Fetch): Promise<Record<Asset, number | null>> {
	const b = (await getJson(f, 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD,XMRUSD')) as {
		error?: unknown[];
		result?: Record<string, { c?: unknown[] }>;
	};
	if (Array.isArray(b.error) && b.error.length > 0) throw new Error(String(b.error[0]));
	const last = (keys: string[]): number | null => {
		for (const k of keys) {
			const v = b.result?.[k]?.c?.[0];
			if (num(v) !== null) return num(v);
		}
		return null;
	};
	return { btc: last(['XXBTZUSD', 'XBTUSD']), xmr: last(['XXMRZUSD', 'XMRUSD']), blurt: null };
}

/** Every source's quote, then the agreed price per asset. Never throws. */
export async function fetchAgreedPrices(
	fetchImpl: Fetch = globalThis.fetch
): Promise<{ prices: RepinPrices; quotes: Quotes }> {
	const sources: Array<[string, (f: Fetch) => Promise<Record<Asset, number | null>>]> = [
		['coingecko', coingecko],
		['coinpaprika', coinpaprika],
		['kraken', kraken]
	];
	const quotes: Quotes = { btc: {}, xmr: {}, blurt: {} };
	await Promise.all(
		sources.map(async ([name, get]) => {
			let r: Record<Asset, number | null>;
			try {
				r = await get(fetchImpl);
			} catch {
				r = { btc: null, xmr: null, blurt: null };
			}
			for (const a of ['btc', 'xmr', 'blurt'] as const)
				if (name !== 'kraken' || a !== 'blurt') quotes[a][name] = r[a];
		})
	);
	return {
		prices: {
			btcUsd: agreedPrice(Object.values(quotes.btc)),
			xmrUsd: agreedPrice(Object.values(quotes.xmr)),
			blurtUsd: agreedPrice(Object.values(quotes.blurt))
		},
		quotes
	};
}

/** One line per asset for the operator: each source's quote and the result. */
export function describeQuotes(q: Quotes, p: RepinPrices): string[] {
	const fmt = (r: Record<string, number | null>): string =>
		Object.entries(r)
			.map(([k, v]) => `${k}=${v ?? 'n/a'}`)
			.join(' ');
	return [
		`BTC   ${fmt(q.btc)} → ${p.btcUsd ?? 'no two sources agree — skipped'}`,
		`XMR   ${fmt(q.xmr)} → ${p.xmrUsd ?? 'no two sources agree — skipped'}`,
		`BLURT ${fmt(q.blurt)} → ${p.blurtUsd ?? 'no two sources agree — skipped'}`
	];
}
