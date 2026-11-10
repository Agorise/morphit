/**
 * The other coins' USD prices (v1.23.2) — DISPLAY ONLY.
 *
 * morphit trades more coins than it charges fees in. BLURT, BTC and XMR have
 * their own guarded price sources (factory.ts). For the others, that is
 * every coin but BLURT, BTC, XMR and ECX (ETH, LTC, BCH, DASH, DOGE, ZEC,
 * ARRR, DCR, SOL, XRP, HIVE, STEEM, BTS, USDT, USDC and DAI), this module gives a USD price
 * for the "(≈11 BRL)" beside an amount and for filling in "how much ETH is
 * 11 BRL". Nothing is charged, enforced or signed from these numbers.
 *
 * Sources, all asked at once and combined with the median-anchored robust
 * mean (aggregate.ts), so one wrong answer is outvoted:
 *   - the onion pricenodes' consensus (pricenodes.ts) — the same rounds that
 *     price BTC and XMR, over Tor, no extra request; works on a hidden-only
 *     instance (not for HIVE, STEEM and BTS, which the pricenodes are not
 *     known to quote);
 *   - where this instance may reach clearnet: ONE CoinGecko request and ONE
 *     CryptoCompare request for all the coins together, per refresh.
 *
 * Never a bundled constant: a coin nobody answered for recently is absent,
 * and the page shows the amount without a fiat value. eCash (ECX) is left out
 * on purpose: its ticker is used by other coins too, so a provider's "ECX"
 * may not be this eCash.
 */

import { logger } from '$log';
import type { Config } from '$config';
import { aggregateRobust } from '$indexer/price/aggregate';
import { PRICENODE_COINS, pricenodesFor } from '$indexer/price/pricenodes';
import {
	priceUpstreamFetchInit,
	priceUpstreamHeaders,
	readPriceBodyCapped
} from '$indexer/price/priceFetchUtil';
import { sourceClearnetAllowed } from '$indexer/sourceFetch';

const log = logger('price-coin-quotes');

/** Each coin's CoinGecko id and CryptoCompare symbol. */
export const COIN_QUOTE_IDS: Readonly<
	Record<string, { readonly coingecko: string; readonly cryptocompare: string }>
> = {
	ETH: { coingecko: 'ethereum', cryptocompare: 'ETH' },
	LTC: { coingecko: 'litecoin', cryptocompare: 'LTC' },
	BCH: { coingecko: 'bitcoin-cash', cryptocompare: 'BCH' },
	DASH: { coingecko: 'dash', cryptocompare: 'DASH' },
	DOGE: { coingecko: 'dogecoin', cryptocompare: 'DOGE' },
	ZEC: { coingecko: 'zcash', cryptocompare: 'ZEC' },
	ARRR: { coingecko: 'pirate-chain', cryptocompare: 'ARRR' },
	DCR: { coingecko: 'decred', cryptocompare: 'DCR' },
	SOL: { coingecko: 'solana', cryptocompare: 'SOL' },
	XRP: { coingecko: 'ripple', cryptocompare: 'XRP' },
	// (v1.24.0) CoinGecko's API ids and CryptoCompare's symbols for Hive,
	// Steem and BitShares, checked on both sites' coin pages (2026-11-09).
	HIVE: { coingecko: 'hive', cryptocompare: 'HIVE' },
	STEEM: { coingecko: 'steem', cryptocompare: 'STEEM' },
	BTS: { coingecko: 'bitshares', cryptocompare: 'BTS' },
	USDT: { coingecko: 'tether', cryptocompare: 'USDT' },
	USDC: { coingecko: 'usd-coin', cryptocompare: 'USDC' },
	DAI: { coingecko: 'dai', cryptocompare: 'DAI' }
};

const STABLECOINS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'DAI']);

/** A price worth showing: a stablecoin near its dollar (a depeg to 0.5 still
 *  shows — that is the point of showing it), anything else positive and not
 *  absurd. */
function plausible(code: string, usd: number): boolean {
	if (!Number.isFinite(usd) || usd <= 0) return false;
	if (STABLECOINS.has(code)) return usd >= 0.5 && usd <= 1.5;
	return usd >= 1e-6 && usd <= 1e7;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** `{ "<coingecko id>": { "usd": n } }` → ticker → USD. PURE. */
export function parseCoingeckoBatch(body: unknown): Map<string, number> {
	const out = new Map<string, number>();
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return out;
	const obj = body as Record<string, unknown>;
	for (const [code, ids] of Object.entries(COIN_QUOTE_IDS)) {
		const inner = obj[ids.coingecko];
		if (typeof inner !== 'object' || inner === null) continue;
		const usd = (inner as Record<string, unknown>).usd;
		if (positive(usd)) out.set(code, usd);
	}
	return out;
}

/** `{ "<SYM>": { "USD": n } }` → ticker → USD (its 200-with-error body is
 *  nothing). PURE. */
export function parseCryptocompareBatch(body: unknown): Map<string, number> {
	const out = new Map<string, number>();
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return out;
	const obj = body as Record<string, unknown>;
	if (obj.Response === 'Error') return out;
	for (const [code, ids] of Object.entries(COIN_QUOTE_IDS)) {
		const inner = obj[ids.cryptocompare];
		if (typeof inner !== 'object' || inner === null) continue;
		const usd = (inner as Record<string, unknown>).USD;
		if (positive(usd)) out.set(code, usd);
	}
	return out;
}

export interface CoinQuoteSourceOptions {
	/** The onion pricenodes (null when this instance has none). */
	readonly pricenodes: {
		coinUsd(code: string): number | null;
		acquire?(): void;
		release?(): void;
	} | null;
	/** Asked before every clearnet request (false on a hidden-only instance). */
	readonly clearnetAllowed: () => boolean;
	readonly coingecko?: { readonly baseUrl: string; readonly apiKey?: string };
	readonly cryptocompare?: { readonly baseUrl: string; readonly apiKey?: string };
	readonly refreshIntervalMs: number;
	readonly outlierTolerance: number;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	readonly now?: () => number;
}

interface ProviderAnswer {
	readonly at: number;
	readonly prices: ReadonlyMap<string, number>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class CoinQuoteSource {
	private readonly answers = new Map<string, ProviderAnswer>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight: Promise<void> | null = null;
	private readonly now: () => number;

	constructor(private readonly opts: CoinQuoteSourceOptions) {
		this.now = opts.now ?? (() => Date.now());
	}

	start(): void {
		if (this.timer !== null) return;
		this.opts.pricenodes?.acquire?.();
		void this.refreshOnce();
		this.timer = setInterval(() => void this.refreshOnce(), this.opts.refreshIntervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
		this.opts.pricenodes?.release?.();
	}

	/** How long one provider's answer is served: two refreshes and a timeout. */
	private maxAgeMs(): number {
		return this.opts.refreshIntervalMs * 2 + (this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 25_000;
	}

	/** Ask the clearnet providers once (when allowed). Never throws. */
	refreshOnce(): Promise<void> {
		if (this.inFlight !== null) return this.inFlight;
		const run = async (): Promise<void> => {
			if (!this.opts.clearnetAllowed()) return;
			const asks: Promise<void>[] = [];
			const codes = Object.keys(COIN_QUOTE_IDS);
			const cg = this.opts.coingecko;
			if (cg) {
				const ids = codes.map((c) => COIN_QUOTE_IDS[c]!.coingecko).join(',');
				const url = `${cg.baseUrl.replace(/\/+$/, '')}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;
				const headers = priceUpstreamHeaders();
				if (cg.apiKey) headers['x-cg-pro-api-key'] = cg.apiKey;
				asks.push(this.ask('coingecko', url, headers, parseCoingeckoBatch));
			}
			const cc = this.opts.cryptocompare;
			if (cc) {
				const syms = codes.map((c) => COIN_QUOTE_IDS[c]!.cryptocompare).join(',');
				const url = `${cc.baseUrl.replace(/\/+$/, '')}/data/pricemulti?fsyms=${encodeURIComponent(syms)}&tsyms=USD`;
				const headers = priceUpstreamHeaders();
				if (cc.apiKey) headers.authorization = `Apikey ${cc.apiKey}`;
				asks.push(this.ask('cryptocompare', url, headers, parseCryptocompareBatch));
			}
			await Promise.all(asks);
		};
		const p = run().catch((err) => log.warn('coin_quotes_round_failed', {}, err));
		this.inFlight = p.then(() => undefined);
		void this.inFlight.finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async ask(
		name: string,
		url: string,
		headers: Record<string, string>,
		parse: (body: unknown) => Map<string, number>
	): Promise<void> {
		const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const res = await fetchImpl(url, { ...priceUpstreamFetchInit(ac.signal), headers });
			if (!res.ok) {
				log.warn('coin_quotes_http_not_ok', { provider: name, status: res.status });
				await res.body?.cancel().catch(() => undefined);
				return;
			}
			const prices = parse(JSON.parse(await readPriceBodyCapped(res, ac, url)) as unknown);
			if (prices.size > 0) this.answers.set(name, { at: this.now(), prices });
			else log.warn('coin_quotes_unexpected_shape', { provider: name });
		} catch (err) {
			log.warn('coin_quotes_fetch_error', { provider: name }, err);
		} finally {
			clearTimeout(timer);
		}
	}

	/** USD per coin for every coin with a fresh, plausible answer. No I/O. */
	currentUsd(): Record<string, number> {
		const now = this.now();
		const fresh = [...this.answers.values()].filter((a) => now - a.at <= this.maxAgeMs());
		const out: Record<string, number> = {};
		for (const code of Object.keys(COIN_QUOTE_IDS)) {
			const values: number[] = [];
			const fromNodes = this.opts.pricenodes?.coinUsd(code) ?? null;
			if (fromNodes !== null && plausible(code, fromNodes)) values.push(fromNodes);
			for (const a of fresh) {
				const v = a.prices.get(code);
				if (v !== undefined && plausible(code, v)) values.push(v);
			}
			const agg = aggregateRobust(values, this.opts.outlierTolerance);
			if (agg !== null && plausible(code, agg.value)) out[code] = agg.value;
		}
		return out;
	}
}

/** The instance's coin quote source, or null when its price feed is off. */
export function createCoinQuoteSource(config: Config): CoinQuoteSource | null {
	if (!config.priceFeedEnabled) return null;
	// The pricenode list and the coin list must stay in step.
	for (const c of PRICENODE_COINS) if (!(c in COIN_QUOTE_IDS)) log.warn('coin_without_ids', { c });
	return new CoinQuoteSource({
		pricenodes: pricenodesFor(config),
		clearnetAllowed: sourceClearnetAllowed(config),
		coingecko: { baseUrl: config.coingeckoBaseUrl, apiKey: config.coingeckoApiKey },
		cryptocompare: { baseUrl: config.cryptocompareBaseUrl, apiKey: config.cryptocompareApiKey },
		refreshIntervalMs: config.priceRefreshIntervalMs,
		outlierTolerance: config.priceOutlierTolerance
	});
}
