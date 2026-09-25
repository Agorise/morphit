/**
 * A hidden-only node contacts no clearnet host — and still gets its price.
 *
 * TWO DEFECTS, ONE CAUSE: `federationProbe.fetchJson`, the SSRF-hardened
 * clearnet fetch, carries its OWN transport. It resolves the host with the
 * system resolver and connects through an IP-pinned agent (the DNS-rebinding
 * defence). The fail-closed router a hidden-only node installs never sees such a
 * request.
 *
 *   F30 — THE LEAK. The federation probe used fetchJson on every clearnet-origin
 *   peer, hidden-only or not: a clearnet DNS query naming the peer, then a TCP
 *   connection to it from the node's own address, on every scan, under a "Zero
 *   use of clearnet internet" label.
 *
 *   F31 — THE PRICE THAT NEVER CAME. The peer price monitor sent a hidden-only
 *   node's samples through the same fetchJson, which refuses anything but
 *   https — so every `http://<onion|i2p>` fetch failed, silently, and the
 *   federated median a hidden-only node prices from never had a sample. And the
 *   address picker only knew `i2p_b32` and `tor`.
 *
 * The TCP counts below are real connections to a real listener, not a mocked
 * fetch: the defect was a transport that bypassed the thing a mock would sit in
 * front of.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import type pg from 'pg';
import type { Database } from '$db/pool';
import {
	fetchJson,
	FederationProbeScheduler,
	_setDnsResolverForTesting
} from '$indexer/federationProbe';
import {
	installHiddenServiceDispatcher,
	clearnetRefused,
	ClearnetRefusedError,
	type HiddenDispatcherHandle
} from '$indexer/hiddenServiceDispatcher';
import {
	peerReceiptBases,
	runPeerPriceSampleCycle,
	_resetPeerPriceMonitorState
} from '$indexer/price/peerPriceMonitor';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';

/** Nothing listens on port 1: a proxy there is "down". */
const DEAD_PROXIES: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:1',
	i2pHttpProxy: '127.0.0.1:1'
};

const ONION = `${'a'.repeat(56)}.onion`;
const B32 = `${'b'.repeat(52)}.b32.i2p`;
const I2P_NAME = 'peer.i2p';
const LOKI = 'peer.loki';

// ── a stand-in "peer on the open internet" ─────────────────────────────────
/** A TCP listener that counts every connection made to it. The DNS stub below
 *  points a public-looking name here, so a connection is exactly what a real
 *  node would have made to a real peer's address. */
let peer: net.Server;
let peerPort = 0;
let tcpConnections = 0;
let dnsLookups = 0;

beforeEach(async () => {
	tcpConnections = 0;
	dnsLookups = 0;
	peer = net.createServer((s) => {
		tcpConnections++;
		s.destroy();
	});
	await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
	peerPort = (peer.address() as net.AddressInfo).port;
	_setDnsResolverForTesting(async () => {
		dnsLookups++;
		return { address: '127.0.0.1', family: 4 };
	});
});

let handle: HiddenDispatcherHandle | null = null;
afterEach(async () => {
	await handle?.uninstall();
	handle = null;
	_setDnsResolverForTesting(null);
	await new Promise<void>((r) => peer.close(() => r()));
});

const hiddenOnly = (): void => {
	handle = installHiddenServiceDispatcher(DEAD_PROXIES, 'refuse');
};
const PUBLIC_PEER = (): string => `https://peer.example:${peerPort}`;

// ─────────────────────────────────────────────────────────────────────────────
describe('F30 — fetchJson never reaches clearnet on a hidden-only node', () => {
	/** The detector works: on an ordinary node the same call DOES connect.
	 *  Without this the zero below could mean the listener was never reachable. */
	it('control: on a clearnet node it resolves the name and connects', async () => {
		await fetchJson(`${PUBLIC_PEER()}/v1/instance`).catch(() => undefined);
		expect(dnsLookups).toBe(1);
		expect(tcpConnections).toBeGreaterThan(0);
	});

	it('on a hidden-only node: refused, with no DNS query and no connection', async () => {
		hiddenOnly();
		await expect(fetchJson(`${PUBLIC_PEER()}/v1/instance`)).rejects.toBeInstanceOf(
			ClearnetRefusedError
		);
		expect(dnsLookups, 'a DNS query naming the peer is itself a clearnet leak').toBe(0);
		expect(
			tcpConnections,
			'a hidden-only node connected to a clearnet peer from its own address'
		).toBe(0);
	});

	it('the policy is the install’s, and uninstalling restores it', async () => {
		expect(clearnetRefused()).toBe(false);
		hiddenOnly();
		expect(clearnetRefused()).toBe(true);
		await handle!.uninstall();
		handle = null;
		expect(clearnetRefused()).toBe(false);
	});

	it('an "allow" install (a node that keeps clearnet RPC) does not refuse', async () => {
		handle = installHiddenServiceDispatcher(DEAD_PROXIES, 'allow');
		expect(clearnetRefused()).toBe(false);
	});
});

// ── a directory of one peer, as the probe scheduler reads it ─────────────────
interface Captured {
	readonly text: string;
	readonly params: readonly unknown[];
}
function probeDb(row: { origin: string; reg_alt_networks: unknown }): {
	db: Database;
	queries: Captured[];
} {
	const queries: Captured[] = [];
	const query = (async (text: string, params: readonly unknown[] = []) => {
		queries.push({ text, params });
		const t = text.trim().toUpperCase();
		if (t.startsWith('SELECT')) {
			return {
				rows: [
					{
						origin: row.origin,
						operator_account: 'peerop',
						registered_at_time: new Date('2026-04-17T00:00:00Z'),
						last_probed_at: null,
						last_probe_status: 'never',
						consecutive_failures: 0,
						cached_indexed_block: null,
						reg_alt_networks: row.reg_alt_networks,
						last_action_block_num: null
					}
				],
				rowCount: 1
			};
		}
		return { rows: [], rowCount: 1 };
	}) as unknown as Database['query'];
	return {
		db: {
			query,
			async withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
				return fn({} as pg.PoolClient);
			},
			async close() {}
		},
		queries
	};
}
const scheduler = (db: Database): FederationProbeScheduler =>
	new FederationProbeScheduler(db, {
		intervalMs: 15_000,
		selfOrigin: 'https://self.example',
		localLagBlocks: () => 0,
		hiddenServiceProxies: DEAD_PROXIES
	});
const updates = (qs: Captured[]): Captured[] =>
	qs.filter((q) => q.text.trim().toUpperCase().startsWith('UPDATE'));

describe('F30 — the probe on a hidden-only node', () => {
	it('control: a clearnet node DOES probe a clearnet peer directly', async () => {
		const { db } = probeDb({ origin: PUBLIC_PEER(), reg_alt_networks: null });
		await scheduler(db).scanOnce();
		expect(
			tcpConnections,
			'setup: the listener must be reachable for the zeros below to mean anything'
		).toBeGreaterThan(0);
	});

	it('does not contact a clearnet-only peer — and does not blame it', async () => {
		hiddenOnly();
		const { db, queries } = probeDb({ origin: PUBLIC_PEER(), reg_alt_networks: null });
		await scheduler(db).scanOnce();

		expect(dnsLookups).toBe(0);
		expect(tcpConnections, 'the probe reached a clearnet peer from a hidden-only node').toBe(0);
		const u = updates(queries);
		expect(u.length, 'the row must still be written').toBeGreaterThan(0);
		expect(
			u.some((q) => q.params.includes('unreachable')),
			'a request we chose not to make is not evidence the peer is down'
		).toBe(false);
		expect(u.some((q) => q.params.includes('clearnet_peer_not_probed_hidden_only'))).toBe(true);
	});

	it('goes to a clearnet peer’s published hidden address instead — never its origin', async () => {
		hiddenOnly();
		const { db, queries } = probeDb({ origin: PUBLIC_PEER(), reg_alt_networks: { tor: ONION } });
		await scheduler(db).scanOnce();

		expect(tcpConnections).toBe(0);
		// Our (dead) Tor was the only road: that is our fault, so the peer is
		// listed, not downgraded.
		const u = updates(queries);
		expect(u.some((q) => q.params.includes('unreachable'))).toBe(false);
		expect(u.some((q) => q.params.includes('hidden_service_not_network_probed'))).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F31 — which addresses a price sample tries', () => {
	it('hidden-only: every published hidden address, I2P first, then Tor, then Lokinet', () => {
		expect(
			peerReceiptBases(
				'https://x.example',
				{ tor: ONION, i2p_b32: B32, i2p_name: I2P_NAME, lokinet: LOKI },
				true
			)
		).toEqual([`http://${B32}`, `http://${I2P_NAME}`, `http://${ONION}`, `http://${LOKI}`]);
	});

	it.each([
		['an I2P name', { i2p_name: I2P_NAME }, `http://${I2P_NAME}`],
		['a Lokinet address', { lokinet: LOKI }, `http://${LOKI}`]
	])('a peer reachable only by %s is sampled (it was skipped)', (_w, alt, want) => {
		expect(peerReceiptBases('https://x.example', alt, true)).toEqual([want]);
	});

	it('clearnet node: the peer’s origin, alone and unchanged', () => {
		expect(peerReceiptBases('https://x.example', { tor: ONION }, false)).toEqual([
			'https://x.example'
		]);
	});

	it('hidden-only and nothing published: nothing — never the clearnet origin', () => {
		expect(peerReceiptBases('https://x.example', { ens: 'x.eth' }, true)).toEqual([]);
		expect(peerReceiptBases('https://x.example', null, true)).toEqual([]);
	});
});

// ── four peers, one per hidden network, as the monitor's query returns them ──
function priceDb(peers: { origin: string; reg_alt_networks: unknown }[]): {
	db: Database;
	inserted: unknown[][];
} {
	const inserted: unknown[][] = [];
	const query = (async (text: string, params: readonly unknown[] = []) => {
		const t = text.trim().toUpperCase();
		if (t.startsWith('INSERT')) {
			inserted.push([...params]);
			return { rows: [], rowCount: 1 };
		}
		if (text.includes('FROM known_instances')) return { rows: peers, rowCount: peers.length };
		if (text.includes('FROM price_peer_observations')) {
			return {
				rows: inserted.map((p) => ({ observed_price: String(p[3]) })),
				rowCount: inserted.length
			};
		}
		return { rows: [], rowCount: 0 };
	}) as unknown as Database['query'];
	return {
		db: {
			query,
			async withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
				return fn({} as pg.PoolClient);
			},
			async close() {}
		},
		inserted
	};
}
const FOUR_PEERS = [
	{ origin: 'https://tor-peer.example', reg_alt_networks: { tor: ONION } },
	{ origin: 'https://b32-peer.example', reg_alt_networks: { i2p_b32: B32 } },
	{ origin: 'https://named-peer.example', reg_alt_networks: { i2p_name: I2P_NAME } },
	{ origin: 'https://loki-peer.example', reg_alt_networks: { lokinet: LOKI } }
];
const receipt = (price: number) => ({
	asset: 'BLURT',
	denomination_fiat: 'USD',
	derived_price: price,
	source: 'morphit_native'
});
const priceSource = {
	currentDetailed: () => ({ price: 0.004, stale: false })
} as never;

describe('F31 — a hidden-only node actually collects peer prices', () => {
	beforeEach(() => _resetPeerPriceMonitorState());

	/**
	 * BEFORE / AFTER. The previous monitor, given these four peers, recorded
	 * none: two it never tried (I2P name, Lokinet), and two it tried through a
	 * fetch that refuses http://. Its federated median never had a sample.
	 */
	it('records one observation from each of four peers on four different networks', async () => {
		hiddenOnly();
		const { db, inserted } = priceDb(FOUR_PEERS);
		const asked: string[] = [];
		const result = await runPeerPriceSampleCycle({
			db,
			priceSource,
			asset: 'BLURT',
			denominationFiat: 'USD',
			hiddenOnly: true,
			hiddenFetch: async <T>(url: string): Promise<T> => {
				asked.push(new URL(url).host);
				return receipt(0.004) as T;
			}
		});
		expect(result.observationsRecorded, 'a hidden-only node sampled no peer at all').toBe(4);
		expect(inserted.map((p) => p[0]).sort()).toEqual(FOUR_PEERS.map((p) => p.origin).sort());
		expect(asked.sort()).toEqual([B32, I2P_NAME, LOKI, ONION].sort());
		expect(result.comparedAgainstMedian, 'and the median now has enough to compare').toBe(true);
		expect(tcpConnections, 'no clearnet contact on the way').toBe(0);
		expect(dnsLookups).toBe(0);
	});

	it('falls through to a peer’s next address when the first does not answer — still ONE sample', async () => {
		hiddenOnly();
		const { db, inserted } = priceDb([
			{ origin: 'https://both.example', reg_alt_networks: { tor: ONION, i2p_b32: B32 } }
		]);
		const asked: string[] = [];
		await runPeerPriceSampleCycle({
			db,
			priceSource,
			asset: 'BLURT',
			denominationFiat: 'USD',
			hiddenOnly: true,
			minObservations: 1,
			hiddenFetch: async <T>(url: string): Promise<T> => {
				const host = new URL(url).host;
				asked.push(host);
				if (host === B32) throw new Error('tunnel did not build');
				return receipt(0.004) as T;
			}
		});
		expect(asked, 'I2P first, then Tor').toEqual([B32, ONION]);
		expect(inserted.length, 'a peer on two networks must not weigh double').toBe(1);
	});

	it('hands the hidden transport the hidden budget, not the clearnet one', async () => {
		hiddenOnly();
		const { db } = priceDb([FOUR_PEERS[0]!]);
		const budgets: number[] = [];
		await runPeerPriceSampleCycle({
			db,
			priceSource,
			asset: 'BLURT',
			denominationFiat: 'USD',
			hiddenOnly: true,
			hiddenFetch: async <T>(_url: string, timeoutMs: number): Promise<T> => {
				budgets.push(timeoutMs);
				return receipt(0.004) as T;
			}
		});
		// A circuit takes 30-60 s to build. The budget used to be discarded.
		expect(budgets[0]).toBeGreaterThanOrEqual(60_000);
	});
});
