/**
 * The warm-up loop — which routes it opens, and what it teaches the sender.
 *
 * WHY THIS FILE EXISTS. `warmAll` had no test of any kind, in either direction:
 * nothing asserted which addresses it warms, and nothing asserted that its
 * result goes anywhere. Both became load-bearing in v1.18.0.
 *
 * It is the instance's cheapest transport diagnostic. It runs at boot, before
 * a single message has been sent, and again every few minutes — so it is where
 * a dead local Tor daemon gets noticed, and because its verdict feeds the
 * sender's reachability tracker, the first chat message of the day is dialled
 * knowing whether Tor works instead of discovering the dead daemon on its own
 * time, in front of a user.
 *
 * Since an earlier release the fan-out goes only to probed-good peers, only over Tor (an
 * onion, or an https origin reached through an exit), so the warm-up visits
 * onions and nothing else: an I2P or Lokinet address is never a push route,
 * and warming one would hold a tunnel open for nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import { ChatFastDispatcher } from '$indexer/chatFastDispatcher';
import type { FastFederationDb } from '$indexer/chatFastFederation';
import { closePool, type WarmResult } from '$indexer/hiddenServicePool';

const ONION = `${'a'.repeat(56)}.onion`;
const ONION2 = `${'c'.repeat(56)}.onion`;
const I2P = `${'b'.repeat(52)}.b32.i2p`;

/** Every daemon CONFIGURED, none answering: nothing has ever listened on port
 *  1, so every warm-up fails the way a box with no Tor fails — at once,
 *  locally, before any peer is involved. */
const DEAD: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:1',
	i2pHttpProxy: '127.0.0.1:1',
	lokinet: true
};

type Row = {
	origin: string;
	reg_alt_networks: Record<string, string | null> | null;
	last_probe_status?: string;
};

/** Directory rows as the read returns them: probed good unless said otherwise
 *  (only probed-good peers are fan-out peers). */
function dbWith(rows: Row[]): FastFederationDb {
	const full = rows.map((r) => ({
		last_probe_status: 'good',
		last_probed_at: null,
		registered_at_time: null,
		last_probe_error: null,
		...r
	}));
	return {
		query: (async () => ({
			rows: full,
			rowCount: full.length
		})) as unknown as FastFederationDb['query']
	};
}

function makeDispatcher(
	rows: Row[],
	opts: {
		proxies?: HiddenServiceProxyConfig;
		warmOrigin?: (origin: string) => Promise<WarmResult>;
	} = {}
): ChatFastDispatcher {
	return new ChatFastDispatcher({
		db: dbWith(rows),
		selfOrigin: 'https://self.example',
		proxies: opts.proxies ?? DEAD,
		postIsolated: async () => ({ status: 200, body: '{}' }),
		...(opts.warmOrigin !== undefined ? { warmOrigin: opts.warmOrigin } : {})
	});
}

/** A warm-up seam that records what it was asked to visit. */
function recording(result: (origin: string) => WarmResult): {
	attempted: string[];
	warmOrigin: (origin: string) => Promise<WarmResult>;
} {
	const attempted: string[] = [];
	return {
		attempted,
		warmOrigin: async (origin) => {
			attempted.push(origin);
			return result(origin);
		}
	};
}

const LOCAL_FAULT: WarmResult = { ok: false, localFault: true };
const PEER_FAULT: WarmResult = { ok: false, localFault: false };
const OK: WarmResult = { ok: true, localFault: false };

afterEach(async () => {
	await closePool();
});

describe('which routes the warm-up opens', () => {
	it('warms the onion of a peer', async () => {
		const d = makeDispatcher([
			{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(1);
	});

	it('warms nothing for a peer that is clearnet all the way down', async () => {
		const d = makeDispatcher([{ origin: 'https://peer.example', reg_alt_networks: null }]);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(0);
	});

	/**
	 * I2P and Lokinet cannot put two pushes on unlinkable paths, so they
	 * are not fan-out routes — and a zero-clearnet peer's I2P name, which the
	 * warm-up used to visit as the peer's "only other road", is no road at all.
	 */
	it('warms only the onion of a peer that also publishes I2P and Lokinet', async () => {
		const rec = recording(() => OK);
		const d = makeDispatcher(
			[
				{
					origin: `http://${ONION}`,
					reg_alt_networks: { tor: ONION, i2p_b32: I2P, lokinet: 'peer.loki' }
				}
			],
			{ warmOrigin: rec.warmOrigin }
		);
		await d.warmAll();
		expect(rec.attempted).toEqual([`http://${ONION}`]);
	});

	/**
	 * A zero-clearnet peer has no exit road to fall back to, so every onion it
	 * publishes is warmed; a peer with an https origin has one, and only its
	 * preferred onion is.
	 */
	it('warms every onion of a zero-clearnet peer, and one of a peer with an https origin', async () => {
		const hiddenOnly = recording(() => OK);
		const d1 = makeDispatcher([{ origin: `http://${ONION2}`, reg_alt_networks: { tor: ONION } }], {
			warmOrigin: hiddenOnly.warmOrigin
		});
		await d1.warmAll();
		expect(hiddenOnly.attempted.sort()).toEqual([`http://${ONION}`, `http://${ONION2}`].sort());

		const withExit = recording(() => OK);
		const d2 = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{ warmOrigin: withExit.warmOrigin }
		);
		await d2.warmAll();
		expect(withExit.attempted).toEqual([`http://${ONION}`]);
	});

	it('does not warm the same origin twice when two peers publish it', async () => {
		const d = makeDispatcher([
			{ origin: 'https://one.example', reg_alt_networks: { tor: ONION } },
			{ origin: 'https://two.example', reg_alt_networks: { tor: ONION } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(1);
	});

	it('warms nothing when the operator has no Tor: there is no fan-out route at all', async () => {
		const d = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{
				proxies: { torSocks: '', i2pHttpProxy: '127.0.0.1:1', lokinet: true }
			}
		);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(0);
	});

	it('warms nothing for a peer the probe has not verified', async () => {
		const d = makeDispatcher([
			{
				origin: 'https://peer.example',
				reg_alt_networks: { tor: ONION },
				last_probe_status: 'never'
			}
		]);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(0);
	});
});

describe('what the warm-up teaches the sender', () => {
	it('marks Tor down when every route over it failed locally (the real warm-up, dead daemon)', async () => {
		const d = makeDispatcher([
			{ origin: 'https://one.example', reg_alt_networks: { tor: ONION } },
			{ origin: 'https://two.example', reg_alt_networks: { tor: ONION2 } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmOk).toBe(0);
		expect(d.diagnostics().networksDown).toEqual(['tor']);
	});

	it('never marks I2P or Lokinet down: it does not visit them', async () => {
		const d = makeDispatcher([
			{
				origin: `http://${ONION}`,
				reg_alt_networks: { tor: ONION, i2p_b32: I2P, lokinet: 'p.loki' }
			}
		]);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['tor']);
	});

	it('does not mark anything down for a clearnet-only peer', async () => {
		const d = makeDispatcher([{ origin: 'https://peer.example', reg_alt_networks: null }]);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual([]);
	});

	/**
	 * THE MIXED CASE, and the one that separates "all failed locally" from "any
	 * failed locally" — a distinction a real transport cannot demonstrate,
	 * because a proxy that is down fails every route at once and a proxy that is
	 * up fails none of them locally. Read as "any", one peer's bad route would
	 * take Tor away from every other peer.
	 */
	it('does NOT mark Tor down when one route over it still works', async () => {
		const d = makeDispatcher(
			[
				{ origin: 'https://alive.example', reg_alt_networks: { tor: ONION } },
				{ origin: 'https://stale.example', reg_alt_networks: { tor: ONION2 } }
			],
			{ warmOrigin: async (o) => (o.includes(ONION) ? OK : LOCAL_FAULT) }
		);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(2);
		expect(d.status().lastWarmOk).toBe(1);
		expect(d.diagnostics().networksDown).toEqual([]);
	});

	it('DOES mark it down once the last working route over it goes', async () => {
		const d = makeDispatcher(
			[
				{ origin: 'https://one.example', reg_alt_networks: { tor: ONION } },
				{ origin: 'https://two.example', reg_alt_networks: { tor: ONION2 } }
			],
			{ warmOrigin: async () => LOCAL_FAULT }
		);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['tor']);
		// ...and once convicted it is reported in ONE place.
		expect(d.diagnostics().networksSuspected.tor).toBeUndefined();
	});

	/** Tor's failure names our own proxy, so one is conclusive even when only
	 *  one onion was tried. */
	it('DOES mark Tor down when only ONE onion route was tried', async () => {
		const d = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{
				warmOrigin: async () => LOCAL_FAULT
			}
		);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['tor']);
	});

	/**
	 * ...unless the fault itself says it cannot be pinned on our end. The
	 * confidence the error carried decides, not the network's default: an
	 * ambiguous fault from one peer is held as suspicion and reported, not
	 * convicted.
	 */
	it('holds an ambiguous fault from one peer as suspicion, and reports it', async () => {
		const d = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{
				warmOrigin: async () => ({ ok: false, localFault: true, confidence: 'ambiguous' })
			}
		);
		await d.warmAll();
		const diag = d.diagnostics();
		expect(diag.networksDown).toEqual([]);
		expect(diag.networksSuspected.tor, 'the instance must not keep what it knows to itself').toBe(
			1
		);
	});

	/** A network that comes back forgets what was held against it. */
	it('drops the held fault once Tor is proven to work', async () => {
		let daemonDown = true;
		const d = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{
				warmOrigin: async () =>
					daemonDown ? { ok: false, localFault: true, confidence: 'ambiguous' } : OK
			}
		);
		await d.warmAll();
		expect(d.diagnostics().networksSuspected.tor).toBe(1);
		daemonDown = false;
		await d.warmAll();
		expect(d.diagnostics().networksSuspected.tor).toBeUndefined();
	});

	/**
	 * Two routes, neither working, and they disagree about whose fault it is:
	 * something on Tor got far enough to fail for the peer's reasons, so our
	 * daemon cannot be blamed and the local fault is not recorded at all.
	 */
	it('records nothing when routes over Tor disagree about whose fault it is', async () => {
		const d = makeDispatcher(
			[
				{ origin: 'https://ours.example', reg_alt_networks: { tor: ONION } },
				{ origin: 'https://theirs.example', reg_alt_networks: { tor: ONION2 } }
			],
			{ warmOrigin: async (o) => (o.includes(ONION) ? LOCAL_FAULT : PEER_FAULT) }
		);
		await d.warmAll();
		const diag = d.diagnostics();
		expect(diag.networksDown, 'a muddied verdict is not a conviction').toEqual([]);
		expect(diag.networksSuspected).toEqual({});
	});

	it('leaves Tor up when its only route failed for the peer’s reasons', async () => {
		const d = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{
				warmOrigin: async () => PEER_FAULT
			}
		);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual([]);
	});

	/**
	 * RECOVERY, NOTICED BY THE LOOP RATHER THAN BY A USER: without this the mark
	 * expires on its own after the cooldown, and a zero-clearnet peer spends that
	 * minute not receiving anything.
	 */
	it('clears the mark as soon as a warm-up over Tor succeeds again', async () => {
		let daemonUp = false;
		const d = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{
				warmOrigin: async () => (daemonUp ? OK : LOCAL_FAULT)
			}
		);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['tor']);
		daemonUp = true;
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual([]);
	});

	it('reports the counts an operator reads in /v1/health', async () => {
		const d = makeDispatcher([
			{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }
		]);
		await d.warmAll();
		const s = d.status();
		expect(s.lastWarmTotal).toBe(1);
		expect(s.lastWarmOk).toBe(0);
		expect(s.networksDown).toBe(1);
		expect(d.diagnostics().networksDown).toEqual(['tor']);
	});
});

/**
 * The fan-out bound, reported rather than merely applied.
 *
 * Every chat message goes to every peer, so the peer count is bounded. Past
 * that bound an instance can be healthy, reachable, and still on chain timing —
 * and nothing about its users' experience says why.
 */
describe('the peer directory reports what the bound left out', () => {
	function dispatcherWith(n: number): ChatFastDispatcher {
		const rows = Array.from({ length: n }, (_, i) => ({
			origin: `https://peer${i}.example`,
			reg_alt_networks: null
		}));
		return makeDispatcher(rows, {
			proxies: { torSocks: '127.0.0.1:1', i2pHttpProxy: '' },
			warmOrigin: async () => OK
		});
	}

	it('reports zero dropped for a federation inside the bound', async () => {
		const d = dispatcherWith(6);
		await d.peersNow();
		expect(d.status().peers).toBe(6);
		expect(d.status().peersTruncated).toBe(0);
	});

	it('reports the count when the directory outgrows the bound', async () => {
		const d = dispatcherWith(46);
		await d.peersNow();
		expect(d.status().peers).toBe(40);
		expect(d.status().peersTruncated).toBe(6);
	});
});
