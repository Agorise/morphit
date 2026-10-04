/**
 * BTC and XMR prices (and the USD→fiat table) come from the
 * Haveno and Bisq pricenodes' `getAllMarketPrices`, over Tor, by consensus.
 *
 * Driven through the production entry points (config loader with its DEFAULT
 * pricenode list, the multi-asset price factory, the FX factory) against a
 * stand-in Tor SOCKS port that serves the five onion names the maintainer
 * tested live on 2026-10-02. The bodies are shaped exactly like the two real
 * serializers:
 *   Bisq   (bisq-network/bisq-pricenode, ExchangeRate.java):
 *          data[] = {currencyCode, price, timestampSec, provider}; a fiat
 *          entry is fiat per BTC, an altcoin entry is BTC per coin.
 *   Haveno (haveno-dex/haveno-pricenode, ExchangeRate.java):
 *          data[] = {baseCurrencyCode, counterCurrencyCode, price, timestampMs,
 *          timestampSec, provider}; XMR/<fiat> is fiat per XMR, BTC/XMR is XMR
 *          per BTC.
 * (Both "timestamp" fields carry milliseconds.)
 *
 * Every DNS question is trapped: a clearnet price API is never asked while the
 * onion consensus holds, and never at all on a zero-clearnet node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as http from 'node:http';

import { loadConfig, type Config } from '$config';
import { createMultiAssetPriceSources } from '$indexer/price/factory';
import { createFxRateSource } from '$indexer/fx/factory';
import { pricenodesFor } from '$indexer/price/pricenodes';
import type { BlurtPriceSource } from '$indexer/price/source';
import {
	installHiddenServiceDispatcher,
	indexerRouterPolicy,
	type HiddenDispatcherHandle
} from '$indexer/hiddenServiceDispatcher';
import { startFakeTor, sendJson, trapDns, type FakeTor } from '../../testutils/fakeTor';

const HAVENO = [
	'elaxlgigphpicy5q7pi5wkz2ko2vgjbq4576vic7febmx4xcxvk6deqd.onion',
	'lrrgpezvdrbpoqvkavzobmj7dr2otxc5x6wgktrw337bk6mxsvfp5yid.onion',
	'agorise7ae5g7lkqp7r7qddsyzskft7cqhgguwkadbqamtsrap5onead.onion'
];
const BISQ = [
	'ro7nv73awqs3ga2qtqeqawrjpbxwarsazznszvr6whv7tes5ehffopid.onion',
	'runbtcpn7gmbj5rgqeyfyvepqokrijem6rbw7o5wgqbguimuoxrmcdyd.onion'
];

/** Units of fiat per USD the fixtures are built from. */
const FX: Record<string, number> = {
	USD: 1,
	EUR: 0.92,
	GBP: 0.79,
	JPY: 150,
	CAD: 1.36,
	AUD: 1.52,
	CHF: 0.88,
	CNY: 7.2,
	BRL: 5,
	MXN: 18,
	INR: 83,
	SEK: 10.5
};

/** A Haveno pricenode body: every fiat quoted per XMR, BTC as XMR per BTC. */
function havenoBody(usdPerXmr: number, xmrPerBtc: number): unknown {
	const ts = Date.now();
	const rate = (base: string, counter: string, price: number, provider = 'Haveno-Aggregate') => ({
		baseCurrencyCode: base,
		counterCurrencyCode: counter,
		price,
		timestampMs: ts,
		timestampSec: ts,
		provider
	});
	return {
		binanceTs: ts,
		binanceCount: 40,
		krakenTs: ts,
		krakenCount: 22,
		data: [
			rate('BTC', 'XMR', xmrPerBtc),
			rate('ETH', 'XMR', 11.5),
			...Object.entries(FX).map(([f, k]) => rate('XMR', f, usdPerXmr * k))
		]
	};
}

/** A Bisq pricenode body: every fiat per BTC, XMR as BTC per XMR. */
function bisqBody(usdPerBtc: number, btcPerXmr: number): unknown {
	const ts = Date.now();
	const rate = (code: string, price: number, provider = 'Bisq-Aggregate') => ({
		currencyCode: code,
		price,
		timestampSec: ts,
		provider
	});
	return {
		btcmarketsTs: ts,
		btcmarketsCount: 1,
		krakenTs: ts,
		krakenCount: 30,
		data: [
			...Object.entries(FX).map(([f, k]) => rate(f, usdPerBtc * k)),
			rate('ETH', 0.0383),
			rate('XMR', btcPerXmr)
		],
		bitcoinFeesTs: Math.floor(ts / 1000),
		bitcoinFeeInfo: { btcTxFee: 12, btcMinTxFee: 2 }
	};
}

const node =
	(body: () => unknown) =>
	(req: http.IncomingMessage, res: http.ServerResponse): void => {
		if ((req.url ?? '').split('?')[0] === '/getAllMarketPrices') sendJson(res, 200, body());
		else res.writeHead(404).end();
	};

/** The five nodes agreeing: implied BTC/USD and XMR/USD per node. */
const AGREEING = {
	h: [
		[300, 200],
		[301, 200],
		[299.5, 200.5]
	] as const,
	b: [
		[60100, 0.005],
		[59950, 0.00501]
	] as const
};
const btcOf = {
	h: (i: number): number => AGREEING.h[i]![0] * AGREEING.h[i]![1],
	b: (i: number): number => AGREEING.b[i]![0]
};
const xmrOf = {
	h: (i: number): number => AGREEING.h[i]![0],
	b: (i: number): number => AGREEING.b[i]![0] * AGREEING.b[i]![1]
};
const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function serveAll(tor: FakeTor): void {
	HAVENO.forEach((h, i) =>
		tor.route(
			h,
			node(() => havenoBody(AGREEING.h[i]![0], AGREEING.h[i]![1]))
		)
	);
	BISQ.forEach((h, i) =>
		tor.route(
			h,
			node(() => bisqBody(AGREEING.b[i]![0], AGREEING.b[i]![1]))
		)
	);
}

function config(tor: FakeTor, clearnetRpc: boolean): Config {
	const saved = { ...process.env };
	Object.assign(process.env, {
		MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused@localhost/unused',
		MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
		MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
		MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
		MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
		MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
			'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
		MORPHIT_INDEXER_RPC_ENDPOINTS: clearnetRpc ? 'https://rpc.example.org' : '',
		MORPHIT_INDEXER_TOR_SOCKS: tor.socks,
		MORPHIT_INDEXER_I2P_HTTP_PROXY: '',
		MORPHIT_INDEXER_PRICE_REFRESH_INTERVAL_MS: '300',
		MORPHIT_INDEXER_FX_REFRESH_INTERVAL_MS: '300'
	});
	try {
		return loadConfig();
	} finally {
		process.env = saved;
	}
}

/** True once `cond` holds (false if it never does within `ms`). */
async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
	try {
		await vi.waitFor(
			() => {
				if (!cond()) throw new Error('not yet');
			},
			{ timeout: ms, interval: 20 }
		);
		return true;
	} catch {
		return cond();
	}
}

/** Resolves once `n` more pricenode rounds for `cfg` have completed — every
 *  node asked has answered or failed, and the consensus is updated. */
function rounds(cfg: Config, n: number): Promise<void> {
	const pn = pricenodesFor(cfg)!;
	let seen = 0;
	return new Promise((resolve) => pn.onUpdate(() => ++seen === n && resolve()));
}

/** Re-read `s` from the latest round now, and wait for that to finish. */
const refreshed = (s: BlurtPriceSource | undefined): Promise<void> =>
	(s as unknown as { refreshOnce(): Promise<void> }).refreshOnce();

let tor: FakeTor;
let dns: Awaited<ReturnType<typeof trapDns>>;
let router: HiddenDispatcherHandle | null = null;
let running: { stop(): void }[] = [];

beforeEach(async () => {
	tor = await startFakeTor();
	dns = await trapDns();
	running = [];
});
afterEach(async () => {
	for (const s of running) s.stop();
	dns.restore();
	await router?.uninstall();
	router = null;
	await tor.close();
});

/** Build the price sources and start those of `assets` (all by default). */
function boot(cfg: Config, assets?: readonly string[]): Map<string, BlurtPriceSource> {
	router = installHiddenServiceDispatcher(
		{ torSocks: tor.socks, i2pHttpProxy: '', lokinet: false },
		indexerRouterPolicy(cfg)
	);
	const sources = createMultiAssetPriceSources(cfg);
	for (const [asset, s] of sources) {
		if (assets !== undefined && !assets.includes(asset)) continue;
		s.start();
		running.push(s);
	}
	return sources;
}

const fresh = (s: BlurtPriceSource | undefined): boolean =>
	s !== undefined && !s.currentDetailed().stale;

describe('zero-clearnet node: BTC/XMR prices from the onion pricenodes', () => {
	it('five agreeing nodes (3 Haveno + 2 Bisq shapes) → the median, fresh, with no DNS question', async () => {
		serveAll(tor);
		const sources = boot(config(tor, false));
		const btc = sources.get('BTC');
		const xmr = sources.get('XMR');
		expect(await until(() => fresh(btc) && fresh(xmr))).toBe(true);
		expect(btc!.currentDetailed().price).toBeCloseTo(
			median([0, 1, 2].map(btcOf.h).concat([0, 1].map(btcOf.b))),
			6
		);
		expect(xmr!.currentDetailed().price).toBeCloseTo(
			median([0, 1, 2].map(xmrOf.h).concat([0, 1].map(xmrOf.b))),
			6
		);
		expect(dns.names).toEqual([]);
		expect(tor.streams.every((s) => s.host.endsWith('.onion'))).toBe(true);
		// One circuit per request.
		const users = tor.streams.map((s) => s.user);
		expect(new Set(users).size).toBe(users.length);
	});

	it('an outlier node is rejected: the price is the median of the agreeing ones', async () => {
		serveAll(tor);
		// The Cake node quotes XMR 40 % high (and so BTC too).
		tor.route(
			HAVENO[1]!,
			node(() => havenoBody(301 * 1.4, 200))
		);
		const sources = boot(config(tor, false));
		const btc = sources.get('BTC');
		expect(await until(() => fresh(btc))).toBe(true);
		expect(btc!.currentDetailed().price).toBeCloseTo(
			median([btcOf.h(0), btcOf.h(2), btcOf.b(0), btcOf.b(1)]),
			6
		);
	});

	it('quorum: one answering node is not enough; a second agreeing one makes the price', async () => {
		tor.route(
			HAVENO[0]!,
			node(() => havenoBody(300, 200))
		);
		const cfg = config(tor, false);
		const twoRounds = rounds(cfg, 2);
		const sources = boot(cfg);
		const btc = sources.get('BTC');
		// Two full rounds in which the lone node answered, each read by the source.
		await twoRounds;
		await refreshed(btc);
		expect(
			pricenodesFor(cfg)!
				.sourceStatus()
				.filter((n) => n.ok)
		).toHaveLength(1);
		expect(fresh(btc), 'a single pricenode decided the price').toBe(false);
		expect(btc!.currentDetailed().price).not.toBeCloseTo(60_000, 0);
		tor.route(
			BISQ[0]!,
			node(() => bisqBody(60_100, 0.005))
		);
		expect(await until(() => fresh(btc))).toBe(true);
		expect(btc!.currentDetailed().price).toBeCloseTo((60_000 + 60_100) / 2, 6);
	});

	it('two nodes that disagree make no price; once every node fails, the last price goes stale — never a new number', async () => {
		tor.route(
			HAVENO[0]!,
			node(() => havenoBody(300, 200))
		);
		tor.route(
			BISQ[0]!,
			node(() => bisqBody(90_000, 0.005))
		);
		const cfg = config(tor, false);
		const twoRounds = rounds(cfg, 2);
		const sources = boot(cfg);
		const btc = sources.get('BTC');
		// Two full rounds in which both nodes answered, each read by the source.
		await twoRounds;
		await refreshed(btc);
		expect(
			pricenodesFor(cfg)!
				.sourceStatus()
				.filter((n) => n.ok)
		).toHaveLength(2);
		expect(fresh(btc), 'two disagreeing nodes produced a price').toBe(false);

		serveAll(tor);
		expect(await until(() => fresh(btc))).toBe(true);
		const good = btc!.currentDetailed().price;
		for (const h of [...HAVENO, ...BISQ]) tor.unroute(h);
		expect(await until(() => !fresh(btc))).toBe(true);
		expect(btc!.currentDetailed().price).toBe(good);
	});

	it('malformed, oversized and redirecting answers do not count', async () => {
		serveAll(tor);
		tor.route(HAVENO[0]!, (_q, res) => {
			res.writeHead(302, { location: 'http://evil.example/' }).end();
		});
		tor.route(HAVENO[1]!, (_q, res) => sendJson(res, 200, { data: 'nope' }));
		tor.route(HAVENO[2]!, (_q, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				`{"data":[${'{"currencyCode":"USD","price":1,"timestampSec":1,"provider":"x"},'.repeat(40_000)}{}]}`
			);
		});
		const sources = boot(config(tor, false));
		const btc = sources.get('BTC');
		expect(await until(() => fresh(btc))).toBe(true);
		// Only the two Bisq nodes counted.
		expect(btc!.currentDetailed().price).toBeCloseTo((btcOf.b(0) + btcOf.b(1)) / 2, 6);
		expect(tor.streams.some((s) => s.host === 'evil.example')).toBe(false);
	});

	it('the USD→fiat table also comes from the pricenodes (no clearnet FX API)', async () => {
		serveAll(tor);
		const cfg = config(tor, false);
		router = installHiddenServiceDispatcher(
			{ torSocks: tor.socks, i2pHttpProxy: '', lokinet: false },
			indexerRouterPolicy(cfg)
		);
		const fx = createFxRateSource(cfg)!;
		fx.start();
		running.push(fx);
		expect(await until(() => fx.currentDetailed().live_currency_count > 0)).toBe(true);
		expect(fx.rate('EUR')).toBeCloseTo(0.92, 9);
		expect(fx.rate('JPY')).toBeCloseTo(150, 6);
		expect(dns.names).toEqual([]);
	});
});

describe('a node that may use clearnet still prefers the onion pricenodes', () => {
	it('while the onion consensus holds, no clearnet BTC/XMR price API is asked (no DNS question at all)', async () => {
		serveAll(tor);
		// BLURT has no onion price source (api.blurt.blog and the aggregators
		// stay its sources where clearnet is allowed), so only BTC and XMR run.
		const cfg = config(tor, true);
		const sources = boot(cfg, ['BTC', 'XMR']);
		const btc = sources.get('BTC');
		const xmr = sources.get('XMR');
		expect(await until(() => fresh(btc) && fresh(xmr))).toBe(true);
		// Two more full rounds, then both sources refresh again: still no
		// clearnet name asked.
		await rounds(cfg, 2);
		await Promise.all([refreshed(btc), refreshed(xmr)]);
		expect(fresh(btc) && fresh(xmr)).toBe(true);
		expect(dns.names.filter((n) => !n.endsWith('.onion'))).toEqual([]);
	});

	it('with every pricenode down it falls back to the clearnet sources (control: the trap sees them asked)', async () => {
		const cfg = config(tor, true);
		const firstRound = rounds(cfg, 1);
		const sources = boot(cfg, ['BTC', 'XMR']);
		// The first round finds every pricenode down …
		await firstRound;
		expect(
			pricenodesFor(cfg)!
				.sourceStatus()
				.some((n) => n.ok)
		).toBe(false);
		// … and the clearnet sources are then asked.
		expect(await until(() => dns.names.length > 0)).toBe(true);
		await refreshed(sources.get('BTC'));
		expect(sources.get('BTC')!.currentDetailed().stale).toBe(true);
	});
});

describe('parseAllMarketPrices / consensusOf (the pure parts)', () => {
	it('reads both serializers; an old or future-dated rate is not used; seconds are read as seconds', async () => {
		const { parseAllMarketPrices, consensusOf } = await import('$indexer/price/pricenodes');
		const now = Date.now();
		const bisq = parseAllMarketPrices(bisqBody(60_000, 0.005), now)!;
		expect(bisq.btc.get('USD')).toBe(60_000);
		expect(bisq.btc.get('EUR')).toBeCloseTo(60_000 * 0.92, 6);
		expect(bisq.xmr.get('USD')).toBeCloseTo(300, 9);
		expect(bisq.btc.has('ETH')).toBe(false);
		const haveno = parseAllMarketPrices(havenoBody(300, 200), now)!;
		expect(haveno.xmr.get('USD')).toBe(300);
		expect(haveno.btc.get('USD')).toBeCloseTo(60_000, 6);
		const old = {
			data: [
				{ currencyCode: 'USD', price: 60_000, timestampSec: now - 7 * 3_600_000, provider: 'x' }
			]
		};
		expect(parseAllMarketPrices(old, now)!.btc.size).toBe(0);
		const future = {
			data: [{ currencyCode: 'USD', price: 60_000, timestampSec: now + 3_600_000, provider: 'x' }]
		};
		expect(parseAllMarketPrices(future, now)!.btc.size).toBe(0);
		const secs = {
			data: [
				{ currencyCode: 'USD', price: 60_000, timestampSec: Math.floor(now / 1000), provider: 'x' }
			]
		};
		expect(parseAllMarketPrices(secs, now)!.btc.get('USD')).toBe(60_000);
		expect(parseAllMarketPrices([1, 2], now)).toBeNull();
		expect(parseAllMarketPrices({ data: 'x' }, now)).toBeNull();
		// Consensus: a strict majority of at least two, its median.
		expect(consensusOf([100, 101, 140], { minAgree: 2, tolerance: 0.05 })?.value).toBe(100.5);
		expect(consensusOf([100], { minAgree: 2, tolerance: 0.05 })).toBeNull();
		expect(consensusOf([100, 101, 200, 201], { minAgree: 2, tolerance: 0.05 })).toBeNull();
		expect(consensusOf([100, 200], { minAgree: 2, tolerance: 0.05 })).toBeNull();
	});
});
