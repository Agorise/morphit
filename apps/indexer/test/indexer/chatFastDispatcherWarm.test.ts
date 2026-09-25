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
 * over a route that already works instead of discovering the dead daemon on its
 * own time, in front of a user.
 *
 * It also decides a real cost. Every warmed hidden origin holds a pooled
 * connection and, under it, a live circuit or tunnel pair. Warming every
 * address of every peer would multiply that by however many networks the
 * federation publishes, to protect a failover most peers will never need — so
 * the policy is deliberately narrower, and narrow policies are the ones that
 * get widened by accident.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import { ChatFastDispatcher } from '$indexer/chatFastDispatcher';
import type { FastFederationDb } from '$indexer/chatFastFederation';
import { closePool } from '$indexer/hiddenServicePool';

const ONION = `${'a'.repeat(56)}.onion`;
const ONION2 = `${'c'.repeat(56)}.onion`;
const I2P = `${'b'.repeat(52)}.b32.i2p`;

/** Nothing has ever listened on port 1, so every hidden warm-up fails the way a
 *  box with no Tor/i2pd fails: at once, locally, before any peer is involved. */
/** Every daemon CONFIGURED, none answering. Lokinet included: since the final
 *  v1.18.0 review it is opt-in (S3), and these cases are about what happens
 *  when a network this node runs is not answering. */
const DEAD: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:1',
	i2pHttpProxy: '127.0.0.1:1',
	lokinet: true
};

type Row = { origin: string; reg_alt_networks: Record<string, string | null> | null };

function dbWith(rows: Row[]): FastFederationDb {
	return {
		query: (async () => ({ rows, rowCount: rows.length })) as unknown as FastFederationDb['query']
	};
}

function makeDispatcher(rows: Row[], proxies: HiddenServiceProxyConfig = DEAD): ChatFastDispatcher {
	return new ChatFastDispatcher({
		db: dbWith(rows),
		selfOrigin: 'https://self.example',
		proxies,
		postClearnet: async () => ({ status: 200, body: '{}' })
	});
}

afterEach(async () => {
	await closePool();
});

describe('which routes the warm-up opens', () => {
	it('warms the preferred hidden address of a peer', async () => {
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
	 * A peer with a clearnet origin has a cheap road to fall back to, and
	 * clearnet has no circuit to build. Warming its SECOND hidden address would
	 * hold another tunnel open to save milliseconds on a path that is already
	 * fast enough.
	 */
	it('warms one address for a peer that has a clearnet fallback, even with two hidden ones', async () => {
		const d = makeDispatcher([
			{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION, i2p_b32: I2P } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(1);
	});

	/**
	 * ...and the case with no cheap road. A zero-clearnet peer can only fall back
	 * to another hidden network, and cold that is a 30-60 second tunnel build —
	 * which does not so much miss the six-second target as ignore it. These are
	 * the peers the whole subsystem exists for, so their alternates are warmed.
	 */
	it('warms every address of a zero-clearnet peer, which has no cheap road', async () => {
		const d = makeDispatcher([
			{ origin: `http://${ONION}`, reg_alt_networks: { tor: ONION, i2p_b32: I2P } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(2);
	});

	it('does not warm the same origin twice when two peers publish it', async () => {
		const d = makeDispatcher([
			{ origin: 'https://one.example', reg_alt_networks: { tor: ONION } },
			{ origin: 'https://two.example', reg_alt_networks: { tor: ONION } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(1);
	});

	it('skips a network the operator has switched off', async () => {
		const d = makeDispatcher(
			[{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }],
			{
				torSocks: '',
				i2pHttpProxy: ''
			}
		);
		await d.warmAll();
		// The onion was never a candidate, so there is nothing hidden to warm.
		expect(d.status().lastWarmTotal).toBe(0);
	});
});

describe('what the warm-up teaches the sender', () => {
	it('marks a network down when every route over it failed locally', async () => {
		const d = makeDispatcher([
			{ origin: 'https://one.example', reg_alt_networks: { tor: ONION } },
			{ origin: 'https://two.example', reg_alt_networks: { tor: ONION2 } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmOk).toBe(0);
		expect(d.diagnostics().networksDown).toEqual(['tor']);
	});

	it('marks each failing network independently', async () => {
		const d = makeDispatcher([
			{ origin: `http://${ONION}`, reg_alt_networks: { tor: ONION, i2p_b32: I2P } }
		]);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['i2p', 'tor']);
	});

	/**
	 * The counterweight, and the reason marking down is safe: a network is only
	 * set aside when the failure was OURS. If one peer's tunnel will not build
	 * over a working daemon, that is the peer's problem, and taking the network
	 * away from every other peer on it would turn one bad peer into a
	 * federation-wide detour.
	 */
	it('does not mark a network down for a peer-side failure', async () => {
		// Nothing is listening on the loopback "proxy", but the peer here is
		// clearnet — there is no hidden network involved for a fault to be
		// attributed to, so nothing may be marked.
		const d = makeDispatcher([{ origin: 'https://peer.example', reg_alt_networks: null }]);
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual([]);
	});

	/**
	 * THE MIXED CASE, and the one that separates "all failed locally" from "any
	 * failed locally" — a distinction a real transport cannot demonstrate,
	 * because a proxy that is down fails every route on its network at once and
	 * a proxy that is up fails none of them locally.
	 *
	 * Lokinet is where it bites. There is no proxy: each `.loki` name resolves on
	 * its own, and one that does not resolve is classified as a local fault. Read
	 * as "any", a single peer with a stale Lokinet name would take the whole
	 * network away from every other peer on it — turning one dead peer into a
	 * federation-wide detour, which is the exact failure the per-network tracker
	 * was added to avoid rather than to cause.
	 */
	it('does NOT mark a network down when one route over it still works', async () => {
		const d = new ChatFastDispatcher({
			db: dbWith([
				{ origin: `http://alive.loki`, reg_alt_networks: { lokinet: 'alive.loki' } },
				{ origin: `http://stale.loki`, reg_alt_networks: { lokinet: 'stale.loki' } }
			]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async (origin: string) =>
				origin.includes('alive') ? { ok: true, localFault: false } : { ok: false, localFault: true }
		});
		await d.warmAll();
		expect(d.status().lastWarmTotal).toBe(2);
		expect(d.status().lastWarmOk).toBe(1);
		expect(d.diagnostics().networksDown).toEqual([]);
	});

	it('DOES mark it down once the last working route over it goes', async () => {
		const d = new ChatFastDispatcher({
			db: dbWith([
				{ origin: `http://one.loki`, reg_alt_networks: { lokinet: 'one.loki' } },
				{ origin: `http://two.loki`, reg_alt_networks: { lokinet: 'two.loki' } }
			]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () => ({ ok: false, localFault: true })
		});
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['loki']);
		// ...and once convicted it is reported in ONE place. A network listed as
		// both down and merely suspected would make the held-fault count read as
		// a second, contradictory opinion about the same network.
		expect(
			d.diagnostics().networksSuspected.loki,
			'a convicted network is no longer a suspected one'
		).toBeUndefined();
	});

	/**
	 * ...but ONE Lokinet route is not enough, and the warm path has to agree
	 * with the send path about that.
	 *
	 * A Lokinet local fault is a DNS miss carrying the PEER's name, so a stale
	 * `.loki` record is indistinguishable from our own router being stopped.
	 * With a single `.loki` peer in the directory, "every warm-up over this
	 * network failed locally" and "the one address we happen to know is out of
	 * date" are the same observation — and the first reading takes the network
	 * away from every `.loki` peer that joins in the next minute.
	 *
	 * This was the send path's bug, found first, and the warm path had its own
	 * copy of the decision. Both now go through `reportAddressFault`, because a
	 * rule that exists twice is a rule that can disagree with itself — which is
	 * exactly how this one was found.
	 */
	it('does NOT mark Lokinet down when only ONE .loki route was tried', async () => {
		const d = new ChatFastDispatcher({
			db: dbWith([{ origin: `http://only.loki`, reg_alt_networks: { lokinet: 'only.loki' } }]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () => ({ ok: false, localFault: true })
		});
		await d.warmAll();
		expect(
			d.diagnostics().networksDown,
			'one unresolvable name is evidence about that name, not about our router'
		).toEqual([]);
	});

	/**
	 * ...and it SAYS so, rather than leaving the operator with local faults and
	 * an empty `networksDown` to reconcile. The fixture-driven test in
	 * `health.test.ts` pins that the route passes the field through; this pins
	 * that the number in it comes from the real tracker and means what it says.
	 */
	it('reports the held fault instead of staying silent about it', async () => {
		const d = new ChatFastDispatcher({
			db: dbWith([{ origin: `http://only.loki`, reg_alt_networks: { lokinet: 'only.loki' } }]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () => ({ ok: false, localFault: true })
		});
		await d.warmAll();
		const diag = d.diagnostics();
		expect(diag.networksDown).toEqual([]);
		expect(
			diag.networksSuspected.loki,
			'the instance knows something here and must not keep it to itself'
		).toBe(1);
	});

	/**
	 * WHAT THE "every warm-up failed locally" GATE IS ACTUALLY FOR, which no
	 * test reached until the held-fault count existed to observe it.
	 *
	 * Two routes on one network, neither working, and they disagree about whose
	 * fault it is: one is a local fault, the other is the peer's. Our router
	 * cannot be confidently blamed — something on this network got far enough to
	 * fail for the peer's reasons — so the local fault is not recorded as
	 * evidence at all, and the network is neither convicted nor suspected.
	 *
	 * This is the only scenario in which the gate changes anything: when every
	 * route failed locally it agrees with the per-address reporting below it,
	 * and when one SUCCEEDED the success clears the network before the gate is
	 * consulted. Inverting the gate used to be caught by the peer-reasons test
	 * above; once per-address reporting was introduced that mutation became a
	 * no-op there, because an inverted gate over an EMPTY list of faulted
	 * addresses still reports nothing. The distinction survives only here.
	 */
	it('records nothing when routes on one network disagree about whose fault it is', async () => {
		const d = new ChatFastDispatcher({
			db: dbWith([
				{ origin: `http://ours.loki`, reg_alt_networks: { lokinet: 'ours.loki' } },
				{ origin: `http://theirs.loki`, reg_alt_networks: { lokinet: 'theirs.loki' } }
			]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async (origin: string) =>
				origin.includes('ours') ? { ok: false, localFault: true } : { ok: false, localFault: false }
		});
		await d.warmAll();
		const diag = d.diagnostics();
		expect(diag.networksDown, 'a muddied verdict is not a conviction').toEqual([]);
		expect(
			diag.networksSuspected,
			'nor is it evidence worth holding: another route on this network reached far ' +
				'enough to fail for the peer’s reasons'
		).toEqual({});
	});

	/** A network that comes back forgets what was held against it, and the
	 *  health block stops reporting it — otherwise the count becomes a permanent
	 *  smudge nobody can clear. */
	it('drops the held fault once the network is proven to work', async () => {
		let daemonDown = true;
		const d = new ChatFastDispatcher({
			db: dbWith([{ origin: `http://only.loki`, reg_alt_networks: { lokinet: 'only.loki' } }]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () => ({ ok: !daemonDown, localFault: daemonDown })
		});
		await d.warmAll();
		expect(d.diagnostics().networksSuspected.loki).toBe(1);
		daemonDown = false;
		await d.warmAll();
		expect(d.diagnostics().networksSuspected.loki).toBeUndefined();
	});

	/**
	 * THROUGH THE REAL `warmHiddenOrigin`, with no injected seam — which is the
	 * only place the warm-up's own CLASSIFICATION is exercised.
	 *
	 * Every other case in this block injects `warmOrigin` and therefore asserts
	 * what the dispatcher does with a verdict it was handed. This one asserts
	 * the verdict itself: a `.loki` name that does not resolve must be read as
	 * OUR transport, which is `isLocalTransportFault` and not
	 * `isProxyUnavailable` — Lokinet has no proxy and raises no marker class, so
	 * a consumer asking the wrong question is blind on that network and silently
	 * never marks it down.
	 *
	 * This test exists because the mutation that used to catch that
	 * (`fastchat-transport-harness` T20) stopped catching it. Not because the
	 * code regressed — because giving I2P a CONNECT connector means a dead I2P
	 * proxy now DOES raise the marker class, so the wrong question happens to
	 * get the right answer there. The property survived only on Lokinet, and
	 * nothing was testing it there.
	 */
	it('classifies an unresolvable .loki through the REAL warm-up, not a seam', async () => {
		const d = makeDispatcher([
			{ origin: 'http://one.loki', reg_alt_networks: { lokinet: 'one.loki' } },
			{ origin: 'http://two.loki', reg_alt_networks: { lokinet: 'two.loki' } }
		]);
		await d.warmAll();
		expect(d.status().lastWarmTotal, 'both .loki routes must have been attempted').toBe(2);
		expect(d.status().lastWarmOk).toBe(0);
		expect(
			d.diagnostics().networksDown,
			'a name that does not resolve is OUR transport, and two of them convict it'
		).toEqual(['loki']);
	});

	/**
	 * A network this node does not run is not warmed at all (v1.18.0 review,
	 * S3). With Lokinet off, a `.loki` warm-up could only be refused — so every
	 * three minutes it was attempted, refused, and reported as Lokinet being
	 * DOWN, in `/v1/health` and in the `peer_routes_warmed` log line, on nodes
	 * whose operator never had Lokinet to begin with. The sender already skips
	 * such addresses; the warm-up now uses the same rule, and warms the next
	 * address the sender would actually use.
	 */
	it('does not warm, or mark down, a network this node does not run', async () => {
		const attempted: string[] = [];
		const d = new ChatFastDispatcher({
			db: dbWith([
				{ origin: 'http://only.loki', reg_alt_networks: { lokinet: 'only.loki' } },
				{ origin: 'http://both.loki', reg_alt_networks: { lokinet: 'both.loki', tor: ONION } }
			]),
			selfOrigin: 'https://self.example',
			proxies: { torSocks: '127.0.0.1:1', i2pHttpProxy: '127.0.0.1:1' }, // no lokinet
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async (origin) => {
				attempted.push(origin);
				return { ok: false, localFault: true };
			}
		});
		await d.warmAll();
		expect(
			attempted.some((o) => o.includes('.loki')),
			'a .loki origin was warmed'
		).toBe(false);
		expect(attempted, 'the peer that also has an onion is warmed there').toEqual([
			`http://${ONION}`
		]);
		expect(d.diagnostics().networksDown).not.toContain('loki');
	});

	/** Tor is unchanged: its failure names our own proxy, so one is conclusive
	 *  even when only one onion was tried. */
	it('DOES mark Tor down when only ONE onion route was tried', async () => {
		const d = new ChatFastDispatcher({
			db: dbWith([{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () => ({ ok: false, localFault: true })
		});
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['tor']);
	});

	/** ...and a route that failed for the PEER's reasons is not our fault even
	 *  when it is the only one, so the network stays available to everyone else. */
	it('leaves a network up when its only route failed for the peer reasons', async () => {
		const d = new ChatFastDispatcher({
			db: dbWith([{ origin: `http://slow.loki`, reg_alt_networks: { lokinet: 'slow.loki' } }]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () => ({ ok: false, localFault: false })
		});
		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual([]);
	});

	/**
	 * RECOVERY, NOTICED BY THE LOOP RATHER THAN BY A USER.
	 *
	 * Without this the mark expires on its own after the cooldown, so the window
	 * between "the operator started Tor" and "the federation notices" is up to a
	 * minute of messages taking the long way round for no reason — and on a
	 * zero-clearnet peer with no long way round, a minute of not arriving at all.
	 * The warm-up already has the answer in its hand; this is it acting on it.
	 */
	it('clears a network mark as soon as a warm-up over it succeeds again', async () => {
		let daemonUp = false;
		const d = new ChatFastDispatcher({
			db: dbWith([{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } }]),
			selfOrigin: 'https://self.example',
			proxies: DEAD,
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () =>
				daemonUp ? { ok: true, localFault: false } : { ok: false, localFault: true }
		});

		await d.warmAll();
		expect(d.diagnostics().networksDown).toEqual(['tor']);

		// The operator starts their Tor daemon. Nothing else changes: no message
		// is sent, no cooldown expires.
		daemonUp = true;
		await d.warmAll();

		expect(
			d.diagnostics().networksDown,
			'the next warm pass is the earliest anything could know, so it must be what knows'
		).toEqual([]);
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
		// ...and the names are reachable beside them, which is the whole point.
		expect(d.diagnostics().networksDown).toEqual(['tor']);
	});
});

/**
 * The fan-out bound, reported rather than merely applied.
 *
 * Every chat message goes to every peer, so the peer count is bounded. Past
 * that bound an instance can be healthy, reachable, and still on chain timing —
 * and nothing about its users' experience says why. The bound is a DESIGN
 * decision; a silent one is indistinguishable from the bug.
 */
describe('the peer directory reports what the bound left out', () => {
	function dbWithPeers(n: number): FastFederationDb {
		const rows = Array.from({ length: n }, (_, i) => ({
			origin: `https://peer${i}.example`,
			reg_alt_networks: null,
			last_probe_status: 'good',
			last_probed_at: '2026-09-20T00:00:00Z',
			registered_at_time: '2026-01-01T00:00:00Z'
		}));
		return {
			query: (async () => ({
				rows,
				rowCount: rows.length
			})) as unknown as FastFederationDb['query']
		};
	}

	function dispatcherWith(n: number): ChatFastDispatcher {
		return new ChatFastDispatcher({
			db: dbWithPeers(n),
			selfOrigin: 'https://self.example',
			proxies: { torSocks: '', i2pHttpProxy: '' },
			postClearnet: async () => ({ status: 200, body: '{}' }),
			warmOrigin: async () => ({ ok: true, localFault: false })
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
		expect(
			d.status().peersTruncated,
			'an operator seeing a healthy peer stuck on chain timing has nothing else to read'
		).toBe(6);
	});
});
