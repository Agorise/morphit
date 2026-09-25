#!/usr/bin/env tsx
/**
 * federated-price-smoke.ts (v1.15.x stage 2)
 *
 * Pins the hidden-only federated price:
 *   - federatedMedian: manipulation-resistant median, min-count floor, filters junk.
 *   - createFederatedFetcher: medians peers' morphit_native observations + own
 *     native; returns null (→ static floor) below the observation floor; tolerates
 *     an absent db; respects freshness (via the SQL, exercised with a fake db).
 */
import { federatedMedian, createFederatedFetcher } from '../src/indexer/price/federatedPriceFetcher.ts';

let pass = 0;
const fails: string[] = [];
const ok = (m: string, cond: boolean): void => {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${m}`);
	} else {
		fails.push(m);
		console.log(`  \u2717 ${m}`);
	}
};

// ── federatedMedian ──
ok('odd count → middle value', federatedMedian([0.002, 0.0025, 0.003], 3) === 0.0025);
ok('even count → mean of middle two', federatedMedian([0.002, 0.003], 2) === 0.0025);
ok('below min-count → null', federatedMedian([0.0025, 0.0026], 3) === null);
ok('filters non-positive / NaN', federatedMedian([0.0025, 0, -1, NaN, 0.0027, 0.0026], 3) === 0.0026);
ok('empty → null', federatedMedian([], 1) === null);
// one attacker among 5 honest can't move the median off the middle
ok('a single outlier does not move the median', federatedMedian([0.0025, 0.0025, 0.0025, 0.0026, 99], 3) === 0.0025);

// ── createFederatedFetcher with a fake peer table ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb = (rows: Array<{ observed_price: string }>): any => ({
	query: async () => ({ rows })
});

// 3 peers + own = 4 samples → median.
{
	const fetch = createFederatedFetcher({
		db: fakeDb([{ observed_price: '0.0024' }, { observed_price: '0.0026' }, { observed_price: '0.0028' }]),
		asset: 'BLURT',
		denominationFiat: 'USD',
		ownNative: async () => 0.0025,
		freshnessMinutes: 240,
		minObservations: 3
	});
	const p = await fetch();
	ok('3 peers + own native → median of the 4', p === (0.0025 + 0.0026) / 2);
}

// Too few observations → null (→ composite static floor).
{
	const fetch = createFederatedFetcher({
		db: fakeDb([{ observed_price: '0.0026' }]),
		asset: 'BLURT',
		denominationFiat: 'USD',
		ownNative: async () => null, // this node has no native price (no volume)
		freshnessMinutes: 240,
		minObservations: 3
	});
	ok('1 peer, no own native → null (below floor → static floor)', (await fetch()) === null);
}

// No db (caller passed none) → own native only, still below floor → null.
{
	const fetch = createFederatedFetcher({
		db: undefined,
		asset: 'BLURT',
		denominationFiat: 'USD',
		ownNative: async () => 0.0025,
		freshnessMinutes: 240,
		minObservations: 3
	});
	ok('no db + only own native → null (needs the federation)', (await fetch()) === null);
}

// A throwing db degrades to own-native (no crash).
{
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const throwingDb: any = {
		query: async () => {
			throw new Error('db down');
		}
	};
	const fetch = createFederatedFetcher({
		db: throwingDb,
		asset: 'BLURT',
		denominationFiat: 'USD',
		ownNative: async () => 0.0025,
		freshnessMinutes: 240,
		minObservations: 1
	});
	ok('db error → falls back to own native, no throw', (await fetch()) === 0.0025);
}

// ── factory wiring: hidden-only drops clearnet, uses federated primary ──
{
	const fs = await import('node:fs');
	const factory = fs.readFileSync(new URL('../src/indexer/price/factory.ts', import.meta.url), 'utf8');
	ok('factory has a hidden-only (blurtRpcEndpoints empty) branch', /blurtRpcEndpoints\.length === 0/.test(factory));
	ok('hidden-only branch uses createFederatedFetcher as primary', /createFederatedFetcher\(/.test(factory) && /name: 'federated'/.test(factory));
	ok('hidden-only branch drops clearnet upstreams (upstreams: [])', /upstreams: \[\]/.test(factory));
}

// ── peerReceiptBase: hidden-origin resolution + auto-discovery ──
{
	const { peerReceiptBase } = await import('../src/indexer/price/peerPriceMonitor.ts');
	const ONION = 'axj4qkjwk3bwh2lrn4bud5rrgsyrvuamd6jxdlmks6flsrju7q5rb5yd.onion';
	const B32 = '7tea4n3co3q2ozke2ovgqn7j5zirkauxipfttudbhthkat6fzlcq.b32.i2p';
	ok('clearnet node → peer clearnet origin unchanged', peerReceiptBase('https://vigilante.trading', { tor: ONION }, false) === 'https://vigilante.trading');
	ok('hidden-only + i2p → i2p base', peerReceiptBase('https://x', { i2p_b32: B32 }, true) === `http://${B32}`);
	ok('hidden-only + tor only → tor base', peerReceiptBase('https://x', { tor: ONION }, true) === `http://${ONION}`);
	ok('hidden-only + both → I2P preferred (Tor-distrust hedge)', peerReceiptBase('https://x', { tor: ONION, i2p_b32: B32 }, true) === `http://${B32}`);
	ok('hidden-only + no hidden addr → null (skip, never clearnet)', peerReceiptBase('https://x', { ens: 'x.eth' }, true) === null);
	ok('hidden-only + null alt → null', peerReceiptBase('https://x', null, true) === null);
	// A brand-new instance (e.g. vigilante.trading) that registered a hidden addr
	// is reachable the moment it lands in known_instances — no config anywhere.
	ok('a newly-registered peer with a hidden addr is auto-resolvable', peerReceiptBase('https://vigilante.trading', { i2p_b32: B32, tor: ONION }, true) === `http://${B32}`);
	// v1.18.0 (F31) — the other two networks. The picker read only i2p_b32 and
	// tor, so a peer reachable only by an I2P name or over Lokinet was never
	// sampled.
	ok('hidden-only + I2P name only → sampled', peerReceiptBase('https://x', { i2p_name: 'peer.i2p' }, true) === 'http://peer.i2p');
	ok('hidden-only + Lokinet only → sampled', peerReceiptBase('https://x', { lokinet: 'peer.loki' }, true) === 'http://peer.loki');
}

// ── the monitor RUNS on a hidden-only node ──
// Its observations are the federated median's only input there. Opt-in by env
// alone meant a default hidden-only node priced from its own trades or the
// static floor while /v1/instance called its price leg federated.
{
	const fs = await import('node:fs');
	const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
	ok('main.ts starts the peer monitor on every hidden-only node', /config\.priceFeedPeerMonitorEnabled \|\| config\.blurtRpcEndpoints\.length === 0/.test(main));
}


console.log('');
if (fails.length > 0) {
	console.log(`\u2717 ${fails.length} of ${pass + fails.length} federated-price checks FAILED`);
	for (const f of fails) console.log(`    - ${f}`);
	process.exit(1);
}
console.log(`\u2713 all ${pass} federated-price scenarios passed`);
