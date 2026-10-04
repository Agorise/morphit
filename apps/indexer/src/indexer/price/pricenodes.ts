/**
 * Morphit indexer — BTC / XMR prices and the USD→fiat table from the Haveno and
 * Bisq pricenodes, over Tor, by consensus.
 *
 * Each pricenode serves `GET /getAllMarketPrices`: its own average of many
 * exchanges, for every fiat. Two serializers exist (checked against their
 * source, 2026-10-02):
 *   Bisq   (bisq-network/bisq-pricenode, spot/ExchangeRate.java):
 *          `{ …, "data": [{currencyCode, price, timestampSec, provider}, …] }`
 *          — a FIAT entry is fiat per BTC; an altcoin entry (XMR …) is BTC
 *          per coin.
 *   Haveno (haveno-dex/haveno-pricenode, spot/ExchangeRate.java):
 *          `{ …, "data": [{baseCurrencyCode, counterCurrencyCode, price,
 *          timestampMs, timestampSec, provider}, …] }` — `XMR/<fiat>` is fiat
 *          per XMR; `BTC/XMR` is XMR per BTC.
 * Both "timestamp" fields carry milliseconds (a value that reads as seconds is
 * taken as seconds). From either shape this module derives, per node, BTC and
 * XMR in every fiat it quotes, and each fiat per USD.
 *
 * Every refresh asks every node at once (in the background; a request never
 * waits on it), through indexer/sourceFetch.ts: a fresh Tor circuit per
 * request, no redirects, the answer capped at PRICENODE_MAX_BODY_BYTES and
 * shape-checked. A node that fails twice in a row is skipped for a few rounds
 * (it is asked again sooner if too few others are left). Of the answers of ONE
 * round, a value is taken only by consensus (consensusOf):
 *   - the largest group of answers within `tolerance` of each other must hold
 *     at least `minAgree` (2) of them AND more than half of all answers;
 *   - its median is the value; the answers outside it are outliers, dropped.
 * Otherwise there is no value: never one node's word, never an average with a
 * liar in it. When a round makes no value, consumers keep their last one,
 * marked stale (price/compositeSource.ts) — or none.
 */
import { logger } from '$log';
import type { Config } from '$config';
import type { PriceFetch } from '$indexer/price/source';
import type { FxFetch, FxRateTable } from '$indexer/fx/source';
import { STATIC_FX_TABLE } from '$indexer/fx/staticTable';
import {
	makeSourceFetch,
	sourceClearnetAllowed,
	SOURCE_HIDDEN_REQUEST_TIMEOUT_MS
} from '$indexer/sourceFetch';
import { hiddenServiceProxyConfigFromEnv } from '@morphit/hidden-transport';

const log = logger('pricenodes');

/** Largest getAllMarketPrices answer read (the real ones are ~11–17 KB). */
export const PRICENODE_MAX_BODY_BYTES = 512 * 1024;
/** Most rate entries one answer may carry. */
export const PRICENODE_MAX_ENTRIES = 5_000;
/** A rate older than this is not used. */
export const PRICENODE_MAX_RATE_AGE_MS = 6 * 60 * 60 * 1000;
/** Clock skew tolerated for a rate stamped in the future. */
const FUTURE_SKEW_MS = 10 * 60 * 1000;
/** Agreement band for the USD→fiat table (independent FX quotes agree well). */
export const PRICENODE_FX_TOLERANCE = 0.02;

/** ISO 4217 codes this runtime knows, plus the static FX table's: the fiats. */
const FIAT: ReadonlySet<string> = new Set([
	...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []),
	...Object.keys(STATIC_FX_TABLE.rates),
	'USD'
]);

/** What one node's answer says: units of each fiat per 1 BTC and per 1 XMR. */
export interface PricenodeQuote {
	readonly btc: ReadonlyMap<string, number>;
	readonly xmr: ReadonlyMap<string, number>;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Parse one getAllMarketPrices answer (either shape). Null when the body is
 * not that document at all; an answer whose rates are all too old, malformed
 * or for other currencies parses to empty maps. PURE (given `now`).
 */
export function parseAllMarketPrices(body: unknown, now: number): PricenodeQuote | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data) || data.length > PRICENODE_MAX_ENTRIES) return null;
	const fresh = (e: Record<string, unknown>): boolean => {
		const raw = positive(e.timestampMs) ? e.timestampMs : e.timestampSec;
		if (!positive(raw)) return false;
		const ms = raw < 1e11 ? raw * 1000 : raw;
		return now - ms <= PRICENODE_MAX_RATE_AGE_MS && ms - now <= FUTURE_SKEW_MS;
	};
	const btcFiat = new Map<string, number>();
	const xmrFiat = new Map<string, number>();
	let btcPerXmr: number | null = null;
	let xmrPerBtc: number | null = null;
	for (const item of data) {
		if (typeof item !== 'object' || item === null) continue;
		const e = item as Record<string, unknown>;
		if (!positive(e.price) || !fresh(e)) continue;
		if (typeof e.currencyCode === 'string') {
			// Bisq: fiat per BTC, or BTC per altcoin.
			const code = e.currencyCode.toUpperCase();
			if (FIAT.has(code)) btcFiat.set(code, e.price);
			else if (code === 'XMR') btcPerXmr = e.price;
		} else if (
			typeof e.baseCurrencyCode === 'string' &&
			typeof e.counterCurrencyCode === 'string'
		) {
			// Haveno: XMR/<fiat> = fiat per XMR; BTC/XMR = XMR per BTC.
			const base = e.baseCurrencyCode.toUpperCase();
			const counter = e.counterCurrencyCode.toUpperCase();
			if (base === 'XMR' && FIAT.has(counter)) xmrFiat.set(counter, e.price);
			else if (base === 'BTC' && counter === 'XMR') xmrPerBtc = e.price;
		}
	}
	// Each shape quotes one coin directly and the other through the BTC/XMR rate.
	if (btcPerXmr !== null) {
		for (const [f, v] of btcFiat) if (!xmrFiat.has(f)) xmrFiat.set(f, v * btcPerXmr);
	}
	if (xmrPerBtc !== null) {
		for (const [f, v] of xmrFiat) if (!btcFiat.has(f)) btcFiat.set(f, v * xmrPerBtc);
	}
	return { btc: btcFiat, xmr: xmrFiat };
}

export interface Consensus {
	readonly value: number;
	/** Answers in the agreeing group. */
	readonly agreeing: number;
	/** Usable answers considered. */
	readonly considered: number;
}

/**
 * The consensus of `values` (see the header), or null. PURE.
 * `tolerance` is relative: 0.05 = within 5 % of each other's anchor.
 */
export function consensusOf(
	values: readonly number[],
	opts: { readonly minAgree: number; readonly tolerance: number }
): Consensus | null {
	const usable = values.filter(positive).sort((a, b) => a - b);
	if (usable.length === 0) return null;
	// The group around each answer; the largest wins (ties: none — ambiguous).
	let best: number[] = [];
	let tie = false;
	for (const anchor of usable) {
		const group = usable.filter((v) => Math.abs(v - anchor) <= anchor * opts.tolerance);
		if (group.length > best.length) {
			best = group;
			tie = false;
		} else if (group.length === best.length && group.some((v) => !best.includes(v))) {
			tie = true;
		}
	}
	if (tie || best.length < Math.max(1, opts.minAgree) || best.length * 2 <= usable.length) {
		return null;
	}
	const m = Math.floor(best.length / 2);
	const value = best.length % 2 === 1 ? best[m]! : (best[m - 1]! + best[m]!) / 2;
	return { value, agreeing: best.length, considered: usable.length };
}

interface NodeState {
	consecutiveFailures: number;
	skipRounds: number;
	lastOkAt: number | null;
	lastTriedAt: number | null;
}

export interface PricenodeConsensusOptions {
	readonly urls: readonly string[];
	readonly fetchImpl: typeof fetch;
	readonly refreshIntervalMs: number;
	readonly minAgree?: number;
	/** Agreement band for BTC / XMR prices. */
	readonly tolerance: number;
	readonly requestTimeoutMs?: number;
	readonly now?: () => number;
}

/** The latest round's answers from every pricenode, and their consensus. */
export class PricenodeConsensus {
	private readonly nodes = new Map<string, NodeState>();
	private round: { at: number; quotes: PricenodeQuote[] } | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private users = 0;
	private inFlight: Promise<void> | null = null;
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	private readonly minAgree: number;

	constructor(private readonly opts: PricenodeConsensusOptions) {
		this.now = opts.now ?? (() => Date.now());
		this.minAgree = Math.max(2, opts.minAgree ?? 2);
		for (const u of opts.urls) {
			this.nodes.set(u, {
				consecutiveFailures: 0,
				skipRounds: 0,
				lastOkAt: null,
				lastTriedAt: null
			});
		}
	}

	/** A consumer starts using the consensus (the refresh loop runs while
	 *  any does). Non-blocking. */
	acquire(): void {
		this.users++;
		if (this.timer !== null || this.opts.urls.length === 0) return;
		void this.refreshOnce();
		this.timer = setInterval(() => void this.refreshOnce(), this.opts.refreshIntervalMs);
		this.timer.unref?.();
	}

	release(): void {
		this.users = Math.max(0, this.users - 1);
		if (this.users === 0 && this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** True while the first round is still out (no answer of any kind yet). */
	awaitingFirstRound(): boolean {
		return this.round === null && this.inFlight !== null;
	}

	/** Called after every round. */
	onUpdate(cb: () => void): void {
		this.listeners.add(cb);
	}

	/** Ask every due node once, in parallel. Never throws. */
	refreshOnce(): Promise<void> {
		if (this.inFlight !== null) return this.inFlight;
		const run = async (): Promise<void> => {
			let due = [...this.nodes.entries()].filter(([, s]) => s.skipRounds === 0);
			// Too few left to make a quorum: ask the resting ones too.
			if (due.length <= this.minAgree) due = [...this.nodes.entries()];
			for (const [, s] of this.nodes) if (s.skipRounds > 0) s.skipRounds--;
			const answers = await Promise.all(due.map(([url, s]) => this.ask(url, s)));
			const quotes = answers.filter((q): q is PricenodeQuote => q !== null);
			this.round = { at: this.now(), quotes };
			if (quotes.length > 0) noteLive(this.now());
			log.info('pricenode_round', { asked: due.length, answered: quotes.length });
			for (const cb of this.listeners) {
				try {
					cb();
				} catch (err) {
					log.warn('pricenode_listener_threw', {}, err);
				}
			}
		};
		const p = run().catch((err) => log.warn('pricenode_round_failed', {}, err));
		this.inFlight = p.then(() => undefined);
		void this.inFlight.finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/** The latest round's answers, if the round is recent enough. */
	private currentQuotes(): PricenodeQuote[] {
		const r = this.round;
		if (
			r === null ||
			this.now() - r.at > this.opts.refreshIntervalMs * 2 + SOURCE_HIDDEN_REQUEST_TIMEOUT_MS
		) {
			return [];
		}
		return r.quotes;
	}

	/** Consensus price of 1 `asset` in `fiat`, or null. No I/O. */
	price(asset: 'BTC' | 'XMR', fiat: string): number | null {
		const f = fiat.toUpperCase();
		const vals = this.currentQuotes()
			.map((q) => (asset === 'BTC' ? q.btc : q.xmr).get(f))
			.filter(positive);
		return (
			consensusOf(vals, { minAgree: this.minAgree, tolerance: this.opts.tolerance })?.value ?? null
		);
	}

	/** Consensus USD→fiat table (units of fiat per USD), or null. No I/O. */
	fxTable(): FxRateTable | null {
		const per: Map<string, number[]> = new Map();
		for (const q of this.currentQuotes()) {
			const usd = q.btc.get('USD');
			if (!positive(usd)) continue;
			for (const [f, v] of q.btc) {
				const list = per.get(f) ?? [];
				list.push(v / usd);
				per.set(f, list);
			}
		}
		const rates: Record<string, number> = {};
		for (const [f, vals] of per) {
			const c = consensusOf(vals, { minAgree: this.minAgree, tolerance: PRICENODE_FX_TOLERANCE });
			if (c !== null) rates[f] = c.value;
		}
		if (Object.keys(rates).length === 0) return null;
		rates.USD = 1;
		return { base: 'USD', rates };
	}

	/** Per-node health for the operator's view. */
	sourceStatus(): { url: string; ok: boolean; lastOkAt: Date | null; lastTriedAt: Date | null }[] {
		return [...this.nodes.entries()].map(([url, s]) => ({
			url,
			ok: s.consecutiveFailures === 0 && s.lastOkAt !== null,
			lastOkAt: s.lastOkAt === null ? null : new Date(s.lastOkAt),
			lastTriedAt: s.lastTriedAt === null ? null : new Date(s.lastTriedAt)
		}));
	}

	private async ask(url: string, s: NodeState): Promise<PricenodeQuote | null> {
		s.lastTriedAt = this.now();
		const ac = new AbortController();
		const timer = setTimeout(
			() => ac.abort(),
			this.opts.requestTimeoutMs ?? SOURCE_HIDDEN_REQUEST_TIMEOUT_MS
		);
		let quote: PricenodeQuote | null = null;
		try {
			const res = await this.opts.fetchImpl(`${url}/getAllMarketPrices`, {
				method: 'GET',
				redirect: 'manual',
				signal: ac.signal,
				headers: { accept: 'application/json', 'user-agent': 'morphit-indexer/price-fetch' }
			});
			if (res.ok) {
				const text = await readCapped(res, ac);
				const q = parseAllMarketPrices(JSON.parse(text) as unknown, this.now());
				if (q !== null && (q.btc.size > 0 || q.xmr.size > 0)) quote = q;
			} else {
				await res.body?.cancel().catch(() => undefined);
			}
		} catch {
			quote = null;
		} finally {
			clearTimeout(timer);
		}
		if (quote === null) {
			s.consecutiveFailures++;
			// Rest a failing node: 1, 2, 4 … rounds, at most 6.
			if (s.consecutiveFailures >= 2) s.skipRounds = Math.min(6, 2 ** (s.consecutiveFailures - 2));
			log.warn('pricenode_no_answer', { node: originOf(url), failures: s.consecutiveFailures });
		} else {
			s.consecutiveFailures = 0;
			s.skipRounds = 0;
			s.lastOkAt = this.now();
		}
		return quote;
	}
}

async function readCapped(res: Response, ac: AbortController): Promise<string> {
	const cl = res.headers.get('content-length');
	if (cl !== null && Number(cl) > PRICENODE_MAX_BODY_BYTES) {
		ac.abort();
		throw new Error('pricenode answer too large');
	}
	const reader = res.body?.getReader();
	if (!reader) return '';
	const dec = new TextDecoder();
	let out = '';
	let total = 0;
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		total += r.value.byteLength;
		if (total > PRICENODE_MAX_BODY_BYTES) {
			ac.abort();
			await reader.cancel().catch(() => undefined);
			throw new Error('pricenode answer too large');
		}
		out += dec.decode(r.value, { stream: true });
	}
	return out + dec.decode();
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '(unparseable)';
	}
}

// ─── whether this process prices from the pricenodes right now ─────────────
let lastLiveAt = 0;
/** A round with any answer this recent counts as live. */
export const PRICENODE_LIVE_MAX_AGE_MS = 60 * 60_000;
function noteLive(at: number): void {
	lastLiveAt = at;
}
/** True when a pricenode round got an answer within PRICENODE_LIVE_MAX_AGE_MS
 *  (read by the clearnet gate's price leg). */
export function pricenodePriceIsLive(now: number = Date.now()): boolean {
	return lastLiveAt > 0 && now - lastLiveAt <= PRICENODE_LIVE_MAX_AGE_MS;
}
/** Tests only. */
export function _resetPricenodeLiveness(): void {
	lastLiveAt = 0;
}

// ─── one consensus per configuration ───────────────────────────────────────
const perConfig = new WeakMap<object, PricenodeConsensus | null>();

/**
 * The pricenode consensus for `config` — one per Config object, shared by the
 * price factory and the FX factory so each node is asked once per round. Null
 * when no pricenode is configured.
 */
export function pricenodesFor(config: Config): PricenodeConsensus | null {
	if (perConfig.has(config)) return perConfig.get(config)!;
	const urls = config.pricenodeUrls ?? [];
	const pn =
		urls.length === 0
			? null
			: new PricenodeConsensus({
					urls,
					fetchImpl: makeSourceFetch({
						proxies: config.hiddenProxies ?? hiddenServiceProxyConfigFromEnv(process.env),
						clearnetAllowed: sourceClearnetAllowed(config),
						maxBodyBytes: PRICENODE_MAX_BODY_BYTES
					}),
					refreshIntervalMs: config.priceRefreshIntervalMs,
					tolerance: config.priceOutlierTolerance
				});
	perConfig.set(config, pn);
	return pn;
}

/** A PriceFetch over the consensus: answers from the latest round, no I/O. */
export function pricenodePriceFetch(
	pn: PricenodeConsensus,
	asset: 'BTC' | 'XMR',
	fiat: string
): PriceFetch {
	return async () => pn.price(asset, fiat);
}

/** An FxFetch over the consensus: the latest round's table, no I/O. */
export function pricenodeFxFetch(pn: PricenodeConsensus): FxFetch {
	return async () => pn.fxTable();
}

/** Make `source`'s start()/stop() also start/stop the consensus loop, and
 *  refresh `source` as soon as a round lands. */
export function tiePricenodeLifecycle<
	T extends { start(): void; stop(): void; refreshOnce(): Promise<void> }
>(source: T, pn: PricenodeConsensus): T {
	const start = source.start.bind(source);
	const stop = source.stop.bind(source);
	let on = false;
	pn.onUpdate(() => {
		if (on) void source.refreshOnce();
	});
	source.start = (): void => {
		if (!on) {
			on = true;
			pn.acquire();
		}
		start();
	};
	source.stop = (): void => {
		if (on) {
			on = false;
			pn.release();
		}
		stop();
	};
	return source;
}
