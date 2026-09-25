/**
 * The probe must never blame a peer for OUR OWN dead Tor/i2pd/lokinet.
 *
 * THE BUG THIS PINS. `federationProbe` documented the rule plainly — "never
 * penalise a healthy peer for our Tor being offline" — and implemented it as
 * `err instanceof ProxyUnavailableError` at a `fetch()` boundary. fetch does
 * not propagate a connector's error; it raises `TypeError: fetch failed` with
 * the real reason on `cause`. So the branch was unreachable, and an instance
 * whose Tor daemon stopped would walk its directory writing `unreachable`
 * across every onion-published peer in the federation — peers that were up the
 * whole time, downgraded by a fault that was entirely local and entirely
 * invisible. On I2P and Lokinet the rule had never been implemented at all,
 * because neither transport raised the marker class in the first place.
 *
 * Two levels, because the bug could live at either:
 *   - probeOne must RETHROW a local-transport fault rather than converting it
 *     into an `unreachable` verdict.
 *   - the scheduler must CATCH that and list the peer instead.
 *
 * The errors below are produced by dialling a closed local port, not written
 * by hand: a hand-written error is built from the same belief as the code that
 * misreads it, so it would have agreed with the bug.
 */

import { describe, it, expect } from 'vitest';
import type { Database } from '$db/pool';
import type pg from 'pg';
import { FederationProbeScheduler, probeOne, publishedHiddenHosts } from '$indexer/federationProbe';
import { fetchJsonViaHiddenService } from '$indexer/hiddenServiceFetch';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';

const ONION_HOST = `${'a'.repeat(56)}.onion`;
const ONION_ORIGIN = `http://${ONION_HOST}`;
const I2P_ORIGIN = `http://${'b'.repeat(52)}.b32.i2p`;
const LOKI_ORIGIN = 'http://peer-with-no-tun.loki';

/** Nothing has ever listened on port 1. A connect there is refused at once. */
const DEAD_PROXIES: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:1',
	i2pHttpProxy: '127.0.0.1:1'
};

/** A real error from a real refused proxy, for the origin given. */
async function realLocalFault(origin: string): Promise<unknown> {
	try {
		await fetchJsonViaHiddenService(`${origin}/v1/instance`, DEAD_PROXIES, 2_000);
	} catch (err) {
		return err;
	}
	throw new Error('expected the hidden-service fetch to fail, and it did not');
}

interface CapturedQuery {
	readonly text: string;
	readonly params: readonly unknown[];
}

function makeMockDb(peerOrigin: string): { db: Database; queries: CapturedQuery[] } {
	const queries: CapturedQuery[] = [];
	const query = (async (text: string, params: readonly unknown[] = []) => {
		queries.push({ text, params });
		const t = text.trim().toUpperCase();
		if (t.startsWith('DELETE')) return { rows: [], rowCount: 0 };
		if (t.startsWith('SELECT')) {
			return {
				rows: [
					{
						origin: peerOrigin,
						operator_account: 'peerop',
						registered_at_time: new Date('2026-04-17T00:00:00Z'),
						last_probed_at: null,
						last_probe_status: 'never',
						consecutive_failures: 0,
						reg_alt_networks: null,
						last_action_block_num: null
					}
				],
				rowCount: 1
			};
		}
		return { rows: [], rowCount: 1 };
	}) as unknown as Database['query'];
	const db: Database = {
		query,
		async withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
			return fn({} as pg.PoolClient);
		},
		async close() {}
	};
	return { db, queries };
}

const INSTANCE_ROW = {
	origin: ONION_ORIGIN,
	operator_account: 'peerop',
	registered_at_time: new Date('2026-04-17T00:00:00Z'),
	last_probed_at: null,
	last_probe_status: 'never',
	consecutive_failures: 0
};

describe('probeOne — a local transport fault is rethrown, not recorded as the peer failing', () => {
	it('rethrows when /v1/instance fails because our Tor is down', async () => {
		const err = await realLocalFault(ONION_ORIGIN);
		await expect(
			probeOne(INSTANCE_ROW as never, null, () => Promise.reject(err), null)
		).rejects.toBeTruthy();
	});

	it('rethrows when our i2pd is down', async () => {
		const err = await realLocalFault(I2P_ORIGIN);
		await expect(
			probeOne(INSTANCE_ROW as never, null, () => Promise.reject(err), null)
		).rejects.toBeTruthy();
	});

	it('rethrows when lokinet is not running', async () => {
		const err = await realLocalFault(LOKI_ORIGIN);
		await expect(
			probeOne(INSTANCE_ROW as never, null, () => Promise.reject(err), null)
		).rejects.toBeTruthy();
	});

	/**
	 * The other half of the contract, and the reason rethrowing is safe: an
	 * ordinary peer failure must still resolve to `unreachable`. Without this,
	 * a change that made probeOne rethrow EVERYTHING would pass the three tests
	 * above while destroying the probe's actual job.
	 */
	it('still records a genuine peer failure as unreachable', async () => {
		const outcome = await probeOne(
			INSTANCE_ROW as never,
			null,
			() => Promise.reject(new Error('connection reset by peer')),
			null
		);
		expect(outcome.status).toBe('unreachable');
	});

	/** A SOCKS reply code means Tor worked and the onion did not answer. That is
	 *  the peer's, and it must not be laundered into "our transport is down". */
	it('records a SOCKS host-unreachable reply as the peer failing', async () => {
		const err = new TypeError('fetch failed', {
			cause: new Error('onion unreachable via Tor: host unreachable')
		});
		const outcome = await probeOne(INSTANCE_ROW as never, null, () => Promise.reject(err), null);
		expect(outcome.status).toBe('unreachable');
	});
});

describe('scheduler — a peer is LISTED, not downgraded, when our own proxy is dead', () => {
	it.each([
		['tor', ONION_ORIGIN],
		['i2p', I2P_ORIGIN],
		['lokinet', LOKI_ORIGIN]
	])('lists a %s peer rather than marking it unreachable', async (_network, origin) => {
		const { db, queries } = makeMockDb(origin);
		const scheduler = new FederationProbeScheduler(db, {
			intervalMs: 15_000,
			selfOrigin: 'https://morphit.io',
			localLagBlocks: () => 0,
			hiddenServiceProxies: DEAD_PROXIES
		});

		await scheduler.scanOnce();

		const updates = queries.filter((q) => q.text.trim().toUpperCase().startsWith('UPDATE'));
		expect(updates.length, 'the peer row must be written').toBeGreaterThan(0);
		// The listing path: status 'good', reason recorded as not-network-probed.
		// (The reason is a bound parameter since the listing learned a second
		// reason — a clearnet peer a hidden-only node does not contact — so it is
		// asserted where it now travels, not in the SQL text.)
		expect(
			updates.some((u) => u.params.includes('hidden_service_not_network_probed')),
			'the peer must be LISTED with the not-network-probed reason'
		).toBe(true);
		// And emphatically NOT the blame path.
		expect(
			updates.some((u) => u.params.includes('unreachable')),
			'a local proxy outage must never write `unreachable` against a peer'
		).toBe(false);
	});
});

/**
 * A clearnet-censored peer is reached over WHICHEVER hidden network it
 * published — not only over Tor.
 *
 * The directory's censorship fallback (v1.15.3 "Fix A") retried a failed
 * clearnet probe over the peer's `.onion` and nothing else. So an instance
 * behind a national firewall that had published only an I2P destination — which
 * is exactly what an operator does where Tor itself is blocked, and the reason
 * Morphit carries three transports rather than one — was recorded `unreachable`
 * and fell out of the federation directory. Unreachable is precisely what it
 * was not; it was reachable by the only road it had left.
 *
 * Same narrowness the chat fast path carried (ADR-0052 decision 8): treating
 * "hidden service" as a synonym for Tor.
 */
describe('publishedHiddenHosts — which addresses the censorship fallback tries', () => {
	const ONION_HOST = `${'a'.repeat(56)}.onion`;
	const I2P_B32 = `${'b'.repeat(52)}.b32.i2p`;

	it('offers all four dialable networks, in preference order', () => {
		expect(
			publishedHiddenHosts({
				tor: ONION_HOST,
				i2p_b32: I2P_B32,
				i2p_name: 'peer.i2p',
				lokinet: 'peer.loki'
			})
		).toEqual([ONION_HOST, I2P_B32, 'peer.i2p', 'peer.loki']);
	});

	it('THE REGRESSION: an I2P-only peer is no longer skipped', () => {
		expect(publishedHiddenHosts({ i2p_b32: I2P_B32 })).toEqual([I2P_B32]);
	});

	it('a Lokinet-only peer is no longer skipped either', () => {
		expect(publishedHiddenHosts({ lokinet: 'peer.loki' })).toEqual(['peer.loki']);
	});

	it('never offers an ENS name — it is a name, not a transport', () => {
		expect(publishedHiddenHosts({ ens: 'peer.eth' } as never)).toEqual([]);
	});

	it('drops a value that is not an address of its network', () => {
		expect(publishedHiddenHosts({ tor: 'not-an-onion.example.com', i2p_b32: I2P_B32 })).toEqual([
			I2P_B32
		]);
	});

	it('handles a peer that published nothing', () => {
		expect(publishedHiddenHosts(null)).toEqual([]);
		expect(publishedHiddenHosts({})).toEqual([]);
	});

	it('does not offer the same host twice', () => {
		expect(publishedHiddenHosts({ i2p_b32: I2P_B32, i2p_name: I2P_B32 })).toEqual([I2P_B32]);
	});

	it('normalises case, as the registration does', () => {
		expect(publishedHiddenHosts({ tor: ONION_HOST.toUpperCase() })).toEqual([ONION_HOST]);
	});
});
