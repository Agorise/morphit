/**
 * Asking our own daemons whether they are alive — and what that lets us blame.
 *
 * Two open items closed together, because they were one missing signal:
 *
 *   - "a peer's reachability is guessed from config, never probed": the fast
 *     path learned a local daemon was down only by failing a message over it.
 *
 *   - "a Lokinet-only peer with a dead name keeps its fan-out slot": Lokinet has
 *     no proxy, so our router being down and a peer's `.loki` name being dead
 *     are the same `getaddrinfo ENOTFOUND`. The probe could not blame the peer
 *     without risking F2 (writing `unreachable` across healthy peers because OUR
 *     router stopped), so a dead Lokinet-only peer held a slot forever.
 *
 * The missing signal was a `.loki` name known to be good. `localhost.loki` is
 * one: lokinet answers it with this node's own address, and no peer supplied it.
 *
 * Errors here come from real lookups and real sockets, not written by hand —
 * the classifier was built from the shapes real failures have.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type pg from 'pg';
import type { Database } from '$db/pool';
import { checkLocalTransports, networksDownIn, tcpConnects } from '$indexer/localTransportLiveness';
import {
	isLocalTransportFault,
	asLocalTransportFault,
	localFaultConfidence,
	isProxyUnavailable,
	noteLokinetLiveness,
	lokinetLiveness,
	type HiddenServiceProxyConfig
} from '@morphit/hidden-transport';
import { fetchJsonViaHiddenService } from '$indexer/hiddenServiceFetch';
import { FederationProbeScheduler } from '$indexer/federationProbe';
import { ChatFastDispatcher } from '$indexer/chatFastDispatcher';

/** Every daemon, lokinet included — these cases are about lokinet's answer. */
const PROXIES: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:9050',
	i2pHttpProxy: '127.0.0.1:4444',
	lokinet: true
};
const DEAD_LOKI = 'http://peer-with-a-dead-name.loki';

afterEach(() => noteLokinetLiveness(null));

/** A real miss for a `.loki` name, from the real resolver path. */
async function realLokiMiss(): Promise<unknown> {
	try {
		await fetchJsonViaHiddenService(`${DEAD_LOKI}/v1/instance`, PROXIES, 5_000);
	} catch (err) {
		return (err as { cause?: unknown }).cause ?? err;
	}
	throw new Error('expected the .loki fetch to fail');
}

describe('the local checks', () => {
	/**
	 * v1.18.0 review (S3). Every installer-built node runs no lokinet, and on
	 * such a box `localhost.loki` is resolved by the ISP's resolver — once a
	 * minute, naming the software, from tor-only home servers included.
	 */
	it('does not ask the resolver anything on a node that does not run lokinet', async () => {
		const asked: string[] = [];
		const state = await checkLocalTransports(
			{ torSocks: '127.0.0.1:9050', i2pHttpProxy: '127.0.0.1:4444' },
			{
				lookup: async (h) => {
					asked.push(h);
				},
				connects: async () => true
			}
		);
		expect(asked, 'a DNS query left a node that does not run lokinet').toEqual([]);
		expect(state.loki).toBeNull();
		expect(networksDownIn(state), 'a network we do not run is not "down"').not.toContain('loki');
	});

	it('asks lokinet for its OWN name, not a peer’s', async () => {
		const asked: string[] = [];
		await checkLocalTransports(PROXIES, {
			lookup: async (h) => {
				asked.push(h);
			},
			connects: async () => true
		});
		// The name lokinet answers with this node's own address — a fact about
		// lokinet, so the literal is the assertion, not the constant.
		expect(asked).toEqual(['localhost.loki']);
	});

	it('records Lokinet’s answer process-wide, where the classifier reads it', async () => {
		await checkLocalTransports(PROXIES, {
			lookup: async () => undefined,
			connects: async () => true
		});
		expect(lokinetLiveness()).toBe(true);
		await checkLocalTransports(PROXIES, {
			lookup: async () => {
				throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
			},
			connects: async () => true
		});
		expect(lokinetLiveness()).toBe(false);
	});

	it('a wedged resolver reads as not alive, within the budget', async () => {
		const t0 = Date.now();
		const s = await checkLocalTransports(PROXIES, {
			lookup: () => new Promise(() => undefined),
			connects: async () => true
		});
		expect(s.loki).toBe(false);
		expect(Date.now() - t0).toBeLessThan(5_000);
	});

	it('a daemon the operator does not run is null, not down', async () => {
		const s = await checkLocalTransports(
			{ torSocks: '', i2pHttpProxy: '127.0.0.1:4444' },
			{ lookup: async () => undefined, connects: async () => false }
		);
		expect(s.tor).toBeNull();
		expect(networksDownIn(s)).toEqual(['i2p']);
	});

	it('a proxy that accepts connections is up; a refused port is down — real sockets', async () => {
		const srv = net.createServer((s) => s.destroy());
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		const port = (srv.address() as net.AddressInfo).port;
		expect(await tcpConnects('127.0.0.1', port, 2_000)).toBe(true);
		await new Promise<void>((r) => srv.close(() => r()));
		expect(await tcpConnects('127.0.0.1', port, 2_000)).toBe(false);
	});
});

describe('what Lokinet’s answer lets the classifier say about a `.loki` miss', () => {
	it('unknown (never asked): ours, but ambiguous — the old, cautious reading', async () => {
		const miss = await realLokiMiss();
		expect(isLocalTransportFault(miss, 'loki', PROXIES)).toBe(true);
		expect(localFaultConfidence(miss, 'loki')).toBe('ambiguous');
	});

	/** THE CHANGE. Our router answered its own name, so the resolver path works;
	 *  the peer's name failing is the peer's record. */
	it('our lokinet alive: a peer’s dead name is the PEER’s failure', async () => {
		const miss = await realLokiMiss();
		noteLokinetLiveness(true);
		expect(isLocalTransportFault(miss, 'loki', PROXIES)).toBe(false);
		expect(isProxyUnavailable(asLocalTransportFault(miss, 'loki', PROXIES))).toBe(false);
	});

	/** And the other direction: with our router down, one miss is enough — no
	 *  second address needed to convict our own end. */
	it('our lokinet down: the miss is ours, conclusively', async () => {
		const miss = await realLokiMiss();
		noteLokinetLiveness(false);
		const wrapped = asLocalTransportFault(miss, 'loki', PROXIES);
		expect(isProxyUnavailable(wrapped)).toBe(true);
		expect(localFaultConfidence(wrapped, 'loki')).toBe('conclusive');
	});

	it('an ordinary clearnet DNS failure is never ours, whatever lokinet says', async () => {
		noteLokinetLiveness(false);
		const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
			code: 'ENOTFOUND',
			syscall: 'getaddrinfo'
		});
		expect(isLocalTransportFault(err, null, PROXIES)).toBe(false);
	});
});

// ── the directory: a Lokinet-only peer whose name is dead ────────────────────
interface Captured {
	readonly text: string;
	readonly params: readonly unknown[];
}
function dbWithPeer(origin: string): { db: Database; queries: Captured[] } {
	const queries: Captured[] = [];
	const query = (async (text: string, params: readonly unknown[] = []) => {
		queries.push({ text, params });
		if (text.trim().toUpperCase().startsWith('SELECT')) {
			return {
				rows: [
					{
						origin,
						operator_account: 'peerop',
						registered_at_time: new Date('2026-04-17T00:00:00Z'),
						last_probed_at: null,
						last_probe_status: 'quiet',
						consecutive_failures: 5,
						cached_indexed_block: null,
						reg_alt_networks: null,
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
const scan = async (origin: string): Promise<Captured[]> => {
	const { db, queries } = dbWithPeer(origin);
	await new FederationProbeScheduler(db, {
		intervalMs: 15_000,
		selfOrigin: 'https://self.example',
		localLagBlocks: () => 0,
		hiddenServiceProxies: PROXIES
	}).scanOnce();
	return queries.filter((q) => q.text.trim().toUpperCase().startsWith('UPDATE'));
};

describe('the probe and a dead Lokinet-only peer', () => {
	/** THE FAN-OUT SLOT. With our router demonstrably alive, the peer's dead name
	 *  is recorded as the peer failing — so after the usual hysteresis it ranks
	 *  as unreachable and gives up the slot it has held indefinitely. */
	it('our lokinet alive → the peer is recorded as failing, not listed', async () => {
		noteLokinetLiveness(true);
		const u = await scan(DEAD_LOKI);
		expect(u.some((q) => q.params.includes('unreachable'))).toBe(true);
		expect(u.some((q) => q.params.includes('hidden_service_not_network_probed'))).toBe(false);
	});

	/** F2, unchanged: with OUR router down, nothing is learned about the peer. */
	it('our lokinet down → the peer is listed, never blamed', async () => {
		noteLokinetLiveness(false);
		const u = await scan(DEAD_LOKI);
		expect(u.some((q) => q.params.includes('unreachable'))).toBe(false);
		expect(u.some((q) => q.params.includes('hidden_service_not_network_probed'))).toBe(true);
	});
});

describe('the dispatcher asks at boot, before any message', () => {
	it('a network whose local end is down is off the fan-out before the first send', async () => {
		const d = new ChatFastDispatcher({
			db: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
			selfOrigin: 'https://self.example',
			proxies: PROXIES,
			postIsolated: async () => ({ status: 200, body: '' }),
			warmOrigin: async () => ({ ok: true }) as never,
			checkLocalTransports: async () => ({ tor: false, i2p: true, loki: false })
		});
		const state = await d.checkTransports();
		expect(state).toEqual({ tor: false, i2p: true, loki: false });
		const diag = d.diagnostics();
		expect(diag.networksDown).toEqual(['loki', 'tor']);
		expect(diag.localTransports).toEqual({ tor: false, i2p: true, loki: false });
		d.stop();
	});

	it('a live proxy clears nothing — accepting a connection is not proof it routes', async () => {
		const d = new ChatFastDispatcher({
			db: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
			selfOrigin: 'https://self.example',
			proxies: PROXIES,
			postIsolated: async () => ({ status: 200, body: '' }),
			checkLocalTransports: async () => ({ tor: true, i2p: true, loki: true })
		});
		await d.checkTransports();
		expect(d.diagnostics().networksDown).toEqual([]);
		d.stop();
	});
});
