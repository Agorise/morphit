/**
 * Peer addressing — an instance is a PLACE, not an address.
 *
 * THE BUG THIS EXISTS FOR. `fastPeersFromDirectory` used to read a peer's row,
 * take `alt.tor ?? alt.i2p_b32`, and `continue` — discarding `row.origin`
 * outright. Nothing consulted whether THIS instance could reach the network it
 * had just committed to. So a clearnet-only box (no Tor daemon, which is the
 * default state of a fresh install) picked the `.onion` of every onion-
 * publishing peer in the federation, threw away the working clearnet origin
 * sitting in the very same row, and failed every single push — locally, in
 * milliseconds, with nothing logged that named the cause. Federated chat was
 * dead between those pairs and the symptom was "chat is sometimes slow",
 * because every message silently fell back to chain timing.
 *
 * It is the highest-consequence bug in the subsystem: it does not degrade the
 * feature, it removes it, and it removes it on the configuration most operators
 * actually run.
 *
 * `fastPeerFromRow` builds that every-address list for the reads made FROM a
 * peer (the login-pairing forward, the fee cross-check). Chat fan-out is
 * narrower since an earlier release: probe-verified peers only, every push over its own Tor
 * circuit, so `fanOutPeerFromRow` keeps a peer's onion and its https origin
 * (reached through an exit) and nothing else.
 *
 * WHAT IS ASSERTED HERE is behaviour, not shape: given a directory and a set of
 * local daemons, which address does a message actually go out over, and what
 * happens when that address turns out not to work.
 */

import { describe, it, expect } from 'vitest';
import { ProxyUnavailableError } from '@morphit/hidden-transport';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import {
	fastPeerFromRow,
	fanOutPeerFromRow,
	fastPeersFromDirectory,
	addressesOf,
	peerKey,
	peerRank,
	rankDirectoryPeers,
	fastPeerDirectory,
	PeerSender,
	NetworkReachability,
	NETWORK_DOWN_MS,
	type FastPeer,
	type FastFederationDb
} from '$indexer/chatFastFederation';

const ONION = `${'a'.repeat(56)}.onion`;
const ONION2 = `${'c'.repeat(56)}.onion`;
const I2P_B32 = `${'b'.repeat(52)}.b32.i2p`;
const I2P_NAME = 'peer.i2p';
const LOKI = 'peer.loki';

/** A box with every daemon running (or at least configured) — lokinet too. */
const BOTH: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:9050',
	i2pHttpProxy: '127.0.0.1:4444',
	lokinet: true
};
/** A clearnet-only box whose operator switched both off. */
const NEITHER: HiddenServiceProxyConfig = { torSocks: '', i2pHttpProxy: '' };
/** I2P only — the shape a Tor-blocked network forces. */
const I2P_ONLY: HiddenServiceProxyConfig = { torSocks: '', i2pHttpProxy: '127.0.0.1:4444' };

function row(origin: string, alt: Record<string, string | null> | null = null) {
	return { origin, reg_alt_networks: alt };
}

function originsOf(peer: FastPeer): string[] {
	return addressesOf(peer).map((a) => a.origin);
}

describe('a peer keeps every address it published', () => {
	it('THE REGRESSION: a clearnet-only instance still has the peer clearnet origin', () => {
		const peer = fastPeerFromRow(row('https://peer.example', { tor: ONION }), NEITHER);
		// The onion is not offered at all — this box has said it has no Tor.
		expect(originsOf(peer)).toEqual(['https://peer.example']);
		expect(peer.hidden).toBe(false);
	});

	it('THE REGRESSION, the other way: the clearnet origin is never discarded', () => {
		// Even WITH Tor configured — so the onion is rightly preferred — the
		// clearnet origin survives as a fallback rather than being dropped.
		const peer = fastPeerFromRow(row('https://peer.example', { tor: ONION }), BOTH);
		expect(originsOf(peer)).toEqual([`http://${ONION}`, 'https://peer.example']);
	});

	it('offers all four dialable networks, hidden first, in preference order', () => {
		const peer = fastPeerFromRow(
			row('https://peer.example', {
				tor: ONION,
				i2p_b32: I2P_B32,
				i2p_name: I2P_NAME,
				lokinet: LOKI,
				ens: 'peer.eth'
			}),
			BOTH
		);
		expect(originsOf(peer)).toEqual([
			`http://${ONION}`,
			`http://${I2P_B32}`,
			`http://${I2P_NAME}`,
			`http://${LOKI}`,
			'https://peer.example'
		]);
	});

	/**
	 * v1.18.0 review (S3). Lokinet has no proxy: a `.loki` name is resolved by
	 * the system resolver, and on a box without lokinet that resolver is the
	 * ISP's. Offering the address meant every warm-up and message sent the
	 * peer's name there in the clear — from tor-only home servers included.
	 */
	it('offers no .loki address on a node that does not run lokinet', () => {
		const peer = fastPeerFromRow(row('https://peer.example', { tor: ONION, lokinet: LOKI }), {
			torSocks: '127.0.0.1:9050',
			i2pHttpProxy: '127.0.0.1:4444'
		});
		expect(originsOf(peer)).toEqual([`http://${ONION}`, 'https://peer.example']);
	});

	it('never offers an ENS name — it is a name, not a transport', () => {
		const peer = fastPeerFromRow(row('https://peer.example', { ens: 'peer.eth' }), BOTH);
		expect(originsOf(peer)).toEqual(['https://peer.example']);
	});

	it('drops a network the operator explicitly switched off, keeping the others', () => {
		const peer = fastPeerFromRow(
			row('https://peer.example', { tor: ONION, i2p_b32: I2P_B32 }),
			I2P_ONLY
		);
		expect(originsOf(peer)).toEqual([`http://${I2P_B32}`, 'https://peer.example']);
	});

	it('ignores an alt value that is not a valid address of its network', () => {
		const peer = fastPeerFromRow(
			row('https://peer.example', { tor: 'not-an-onion.example.com', i2p_b32: I2P_B32 }),
			BOTH
		);
		expect(originsOf(peer)).toEqual([`http://${I2P_B32}`, 'https://peer.example']);
	});

	it('does not list the same address twice when a peer registers its onion as its origin', () => {
		// A zero-clearnet instance: its registered origin IS its onion.
		const peer = fastPeerFromRow(row(`http://${ONION}`, { tor: ONION }), BOTH);
		expect(originsOf(peer)).toEqual([`http://${ONION}`]);
		expect(peer.hidden).toBe(true);
	});

	it('keeps a zero-clearnet peer reachable when it publishes a second network', () => {
		const peer = fastPeerFromRow(row(`http://${ONION}`, { tor: ONION, i2p_b32: I2P_B32 }), BOTH);
		expect(originsOf(peer)).toEqual([`http://${ONION}`, `http://${I2P_B32}`]);
	});

	/**
	 * A peer with nothing this instance can reach is still LISTED, with its
	 * registered origin. Dropping it would make the peer list quietly shorter
	 * with nothing to explain the gap, and the address may well start working —
	 * the operator's Tor comes back, the cooldown expires. An address that
	 * fails is diagnosable; a peer that was never in the list is not.
	 */
	it('still lists a hidden-only peer whose network this instance has switched off', () => {
		const peer = fastPeerFromRow(row(`http://${ONION}`, { tor: ONION }), NEITHER);
		expect(originsOf(peer)).toEqual([`http://${ONION}`]);
	});

	it('handles a null alt_networks (peer never registered one)', () => {
		const peer = fastPeerFromRow(row('https://peer.example', null), BOTH);
		expect(originsOf(peer)).toEqual(['https://peer.example']);
	});

	it('accepts an alt value that already carries a scheme', () => {
		const peer = fastPeerFromRow(row('https://peer.example', { tor: `http://${ONION}` }), BOTH);
		expect(originsOf(peer)).toEqual([`http://${ONION}`, 'https://peer.example']);
	});
});

describe('the queue key is the peer, not the address', () => {
	it('stays the registered origin whichever address is preferred', () => {
		const viaOnion = fastPeerFromRow(row('https://peer.example', { tor: ONION }), BOTH);
		const viaClearnet = fastPeerFromRow(row('https://peer.example', { tor: ONION }), NEITHER);
		expect(peerKey(viaOnion)).toBe(peerKey(viaClearnet));
	});

	it('normalises case and a trailing slash, as the self-exclusion clause does', () => {
		expect(peerKey(fastPeerFromRow(row('https://Peer.Example/'), BOTH))).toBe(
			'https://peer.example'
		);
	});

	it('defaults to the origin for a hand-built peer', () => {
		expect(peerKey({ origin: 'https://x.example', hidden: false })).toBe('https://x.example');
	});
});

describe('NetworkReachability', () => {
	it('clearnet is never down — there is no local daemon for it to be missing', () => {
		const r = new NetworkReachability();
		r.markDown(null);
		expect(r.isDown(null)).toBe(false);
		expect(r.downNetworks()).toEqual([]);
	});

	it('marks a network down for the cooldown and no longer', () => {
		const r = new NetworkReachability();
		const t0 = 1_000_000;
		r.markDown('tor', t0);
		expect(r.isDown('tor', t0)).toBe(true);
		expect(r.isDown('tor', t0 + NETWORK_DOWN_MS - 1)).toBe(true);
		expect(r.isDown('tor', t0 + NETWORK_DOWN_MS)).toBe(false);
	});

	it('keeps networks independent', () => {
		const r = new NetworkReachability();
		r.markDown('tor', 0);
		expect(r.isDown('i2p', 0)).toBe(false);
		expect(r.isDown('loki', 0)).toBe(false);
		expect(r.downNetworks(0)).toEqual(['tor']);
	});

	it('a success clears the mark immediately rather than serving out the cooldown', () => {
		const r = new NetworkReachability();
		r.markDown('i2p', 0);
		r.markUp('i2p');
		expect(r.isDown('i2p', 1)).toBe(false);
	});

	/**
	 * `reportAddressFault` weighs ONE address's failure. The two properties
	 * below are what keep the corroboration rule from becoming a slow accrual
	 * that eventually fires on its own.
	 */
	it('a proven success forgets the addresses held against a network', () => {
		const r = new NetworkReachability();
		// One bad name on a network that is otherwise fine.
		expect(r.reportAddressFault('loki', 'http://stale.loki', 0)).toBe(false);
		// ...and then the network demonstrably WORKS. Whatever was wrong with
		// that name, it was not the router — so the evidence is spent.
		r.markUp('loki');
		expect(
			r.reportAddressFault('loki', 'http://other.loki', 1),
			'a failure after a proven success is the first one again, not the second'
		).toBe(false);
		expect(r.isDown('loki', 1)).toBe(false);
	});

	it('evidence older than the window it would justify is not counted', () => {
		const r = new NetworkReachability();
		expect(r.reportAddressFault('loki', 'http://stale.loki', 0)).toBe(false);
		// An hour later, an unrelated peer publishes another bad name. Two typos
		// far apart are not a router outage, and without expiry every long-lived
		// instance would eventually accumulate enough of them to convict itself.
		expect(
			r.reportAddressFault('loki', 'http://other.loki', NETWORK_DOWN_MS * 60),
			'stale suspicion must not add up to a verdict'
		).toBe(false);
		expect(r.isDown('loki', NETWORK_DOWN_MS * 60)).toBe(false);
	});

	it('two distinct addresses inside the window DO convict', () => {
		const r = new NetworkReachability();
		expect(r.reportAddressFault('loki', 'http://stale.loki', 0)).toBe(false);
		expect(r.reportAddressFault('loki', 'http://other.loki', NETWORK_DOWN_MS - 1)).toBe(true);
		expect(r.isDown('loki', NETWORK_DOWN_MS - 1)).toBe(true);
	});

	it('the SAME address failing twice is still one address', () => {
		const r = new NetworkReachability();
		expect(r.reportAddressFault('loki', 'http://stale.loki', 0)).toBe(false);
		expect(
			r.reportAddressFault('loki', 'http://stale.loki', 1),
			'one peer retried is one peer, however many times it is dialled'
		).toBe(false);
	});

	/**
	 * A peer on a down network is still DIALLED — the breaker may never silence
	 * a peer, because the attempt is how a recovery is found. So this path runs
	 * on every message to a hidden-only peer for as long as the cooldown lasts,
	 * and if each of those re-armed the suspicion map the network would appear
	 * in `networksDown` and `networksSuspected` simultaneously.
	 */
	it('a fault against an ALREADY convicted network adds no new suspicion', () => {
		const r = new NetworkReachability();
		expect(r.reportAddressFault('loki', 'http://a.loki', 0)).toBe(false);
		expect(r.reportAddressFault('loki', 'http://b.loki', 1)).toBe(true);
		expect(r.isDown('loki', 2)).toBe(true);
		// The peer is dialled anyway and fails again, as it will on every message
		// until the cooldown lapses.
		expect(r.reportAddressFault('loki', 'http://c.loki', 2)).toBe(true);
		expect(
			r.pendingSuspicion(2),
			'a network cannot be both convicted and merely suspected'
		).toEqual({});
	});

	/** ...and once the cooldown lapses the evidence bar is the same as it ever
	 *  was: one address is not enough to convict again. */
	it('after the cooldown lapses, one address is not enough again', () => {
		const r = new NetworkReachability();
		r.reportAddressFault('loki', 'http://a.loki', 0);
		r.reportAddressFault('loki', 'http://b.loki', 1);
		expect(r.isDown('loki', NETWORK_DOWN_MS + 2)).toBe(false);
		expect(
			r.reportAddressFault('loki', 'http://c.loki', NETWORK_DOWN_MS + 2),
			'a lapsed conviction is not a head start on the next one'
		).toBe(false);
	});

	it('a self-identifying network needs no corroboration', () => {
		const r = new NetworkReachability();
		expect(r.reportAddressFault('tor', `http://${ONION}`, 0)).toBe(true);
		expect(r.isDown('tor', 0)).toBe(true);
		const r2 = new NetworkReachability();
		expect(r2.reportAddressFault('i2p', `http://${I2P_B32}`, 0)).toBe(true);
	});

	it('clearnet is never convicted, whatever is reported against it', () => {
		const r = new NetworkReachability();
		expect(r.reportAddressFault(null, 'https://peer.example', 0)).toBe(false);
		expect(r.downNetworks(0)).toEqual([]);
	});
});

// ─── the behaviour, end to end ──────────────────────────────────────────────

/** Nothing is listening on port 1, so a push fails the way a box with no Tor
 *  daemon fails: immediately, locally, before the peer is asked. */
const DEAD_DAEMONS: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:1',
	i2pHttpProxy: '127.0.0.1:1'
};

/** Tor configured, I2P switched off — the fan-out needs nothing else. */
const TOR_ONLY: HiddenServiceProxyConfig = { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' };

type Answer = { status: number; body: string } | Error;

/**
 * A sender whose isolated-circuit push is a stub, so the address a push WENT
 * OUT OVER is observable. Every push is made through `postIsolated`:
 * there is no other way out, so a recording of it is a recording of every
 * dial. Without `answer`, the real Tor push is used.
 */
function makeSender(
	proxies: HiddenServiceProxyConfig,
	answer?: (url: string) => Answer | Promise<Answer>,
	timeoutMs = 1_000
): { sender: PeerSender; attempts: string[] } {
	const attempts: string[] = [];
	const sender = new PeerSender({
		proxies,
		timeoutMs,
		...(answer === undefined
			? {}
			: {
					postIsolated: async (url: string) => {
						attempts.push(url);
						const a = await answer(url);
						if (a instanceof Error) throw a;
						return a;
					}
				})
	});
	return { sender, attempts };
}

const torDown = (): Error => new ProxyUnavailableError('local tor transport unavailable');

describe('sending — every address is reached over Tor', () => {
	/**
	 * The fan-out route for a peer with an onion and an https origin: the onion,
	 * then the origin through a Tor exit. A dead local Tor fails both, so the
	 * message waits for the chain — and is never sent over a direct connection
	 * instead, which would hand the peer (and anyone watching) this node's
	 * address alongside the message's timing.
	 */
	it('a dead Tor daemon fails the push, with no direct clearnet attempt', async () => {
		const { sender } = makeSender(DEAD_DAEMONS);
		const peer = fanOutPeerFromRow(row('https://peer.example', { tor: ONION }), DEAD_DAEMONS)!;
		expect(originsOf(peer)).toEqual([`http://${ONION}`, 'https://peer.example']);

		sender.enqueue({ operations: [] }, [peer]);
		await sender.drain(5_000);

		const s = sender.stats();
		expect(s.delivered).toBe(0);
		expect(s.failed).toBe(1);
		expect(s.failures[0]?.localFault).toBe(true);
		// And the instance has LEARNED that its Tor is unusable.
		expect(sender.reachability.isDown('tor')).toBe(true);
	});

	it('a local fault on the onion moves to the https origin, still through Tor', async () => {
		const { sender, attempts } = makeSender(TOR_ONLY, (url) =>
			url.includes('.onion') ? torDown() : { status: 200, body: '{}' }
		);
		const peer = fanOutPeerFromRow(row('https://peer.example', { tor: ONION }), TOR_ONLY)!;
		sender.enqueue({ operations: [] }, [peer]);
		await sender.drain(5_000);

		expect(sender.stats().delivered).toBe(1);
		expect(attempts).toEqual([
			`http://${ONION}/v1/federation/chat-fast`,
			'https://peer.example/v1/federation/chat-fast'
		]);
		// The push that went through proved Tor works.
		expect(sender.reachability.isDown('tor')).toBe(false);
	});

	/**
	 * THE MUTATION THAT SURVIVED THE FIRST BATTERY. Deleting `reach.markUp()`
	 * from the send path changed nothing any test could see. A Tor that
	 * recovers but stays marked down is the state a daemon restart leaves.
	 */
	it('a success clears the Tor mark at once', async () => {
		const { sender } = makeSender(TOR_ONLY, () => ({ status: 200, body: '{}' }));
		sender.reachability.markDown('tor');
		sender.enqueue({ operations: [] }, [
			fanOutPeerFromRow(row('https://peer.example', { tor: ONION }), TOR_ONLY)!
		]);
		await sender.drain(5_000);
		expect(sender.stats().delivered).toBe(1);
		expect(sender.reachability.isDown('tor'), 'a working push is proof Tor is back').toBe(false);
	});

	/**
	 * The counterweight, and the reason the failover is safe. A peer that
	 * ANSWERS — even with a 500 — has been reached. Dialling its other address
	 * would be a second delivery of the same batch to the same instance.
	 */
	it('does NOT try another address when the PEER refused', async () => {
		const { sender, attempts } = makeSender(TOR_ONLY, () => ({ status: 500, body: '{}' }));
		sender.enqueue({ operations: [] }, [
			fanOutPeerFromRow(row('https://peer.example', { tor: ONION }), TOR_ONLY)!
		]);
		await sender.drain(5_000);

		expect(attempts).toEqual([`http://${ONION}/v1/federation/chat-fast`]);
		expect(sender.stats().failed).toBe(1);
		expect(sender.stats().failures[0]?.localFault).not.toBe(true);
	});

	/**
	 * A TIMEOUT IS NOT A LOCAL FAULT: the peer may well have RECEIVED the push —
	 * what was lost is the answer. Treating it as our transport failing would
	 * send the same batch down a second road to the same instance.
	 */
	it('does not fail over when the push merely TIMED OUT', async () => {
		const { sender, attempts } = makeSender(
			TOR_ONLY,
			// What the isolated post throws when its own timer (`timeoutMs`, 50 here)
			// aborts the request: the sender has no timer of its own, it only
			// decides what that error means.
			() => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
			50
		);
		sender.enqueue({ operations: [] }, [
			fanOutPeerFromRow(row('https://peer.example', { tor: ONION }), TOR_ONLY)!
		]);
		await sender.drain(5_000);

		expect(attempts, 'a lost answer must not become a second delivery').toEqual([
			`http://${ONION}/v1/federation/chat-fast`
		]);
		expect(sender.stats().failures[0]?.localFault).not.toBe(true);
		expect(sender.reachability.downNetworks()).toEqual([]);
	});

	it('a peer is still attempted while Tor is marked down, not silently dropped', async () => {
		const { sender, attempts } = makeSender(TOR_ONLY, () => torDown());
		sender.reachability.markDown('tor');
		sender.enqueue({ operations: [] }, [fanOutPeerFromRow(row(`http://${ONION}`), TOR_ONLY)!]);
		await sender.drain(5_000);

		const s = sender.stats();
		expect(attempts).toHaveLength(1);
		expect(s.failed, 'the push was attempted and failed, rather than vanishing').toBe(1);
		expect(s.failures[0]?.localFault).toBe(true);
	});

	it('records WHY a push failed locally, so a failure count is a diagnosis', async () => {
		const { sender } = makeSender(DEAD_DAEMONS);
		sender.enqueue({ operations: [] }, [fanOutPeerFromRow(row(`http://${ONION}`), DEAD_DAEMONS)!]);
		await sender.drain(5_000);
		const f = sender.stats().failures[0];
		expect(f?.localFault).toBe(true);
		expect(f?.origin).toBe(`http://${ONION}`);
	});

	/**
	 * The queue key doing its job. If the key moved with the address, a peer
	 * that failed over would get a second queue and the messages in the first
	 * would never be pumped again.
	 */
	it('failover does not strand messages in a second queue', async () => {
		let inFlight = 0;
		const { sender } = makeSender(TOR_ONLY, async (url) => {
			if (url.includes('.onion')) return torDown();
			inFlight++;
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return { status: 200, body: '{}' };
		});
		const peer = fanOutPeerFromRow(row('https://peer.example', { tor: ONION }), TOR_ONLY)!;
		for (let i = 0; i < 5; i++) sender.enqueue({ operations: [], i }, [peer]);
		await sender.drain(10_000);

		expect(inFlight).toBe(0);
		expect(sender.stats().delivered).toBe(5);
	});
});

/**
 * WHICH ADDRESSES A FAN-OUT PEER HAS. A push carries a signed message
 * ahead of the chain, so where it is sent from is worth protecting: every push
 * gets its own Tor circuit. I2P and Lokinet cannot put two requests on
 * unlinkable paths, so they are not fan-out routes, and a node without Tor has
 * no fan-out route at all — its users' messages travel by chain.
 */
describe('fan-out addressing is Tor only', () => {
	it('an onion first, then the https origin (through an exit); never I2P or Lokinet', () => {
		const peer = fanOutPeerFromRow(
			row('https://peer.example', {
				tor: ONION,
				i2p_b32: I2P_B32,
				i2p_name: I2P_NAME,
				lokinet: LOKI
			}),
			BOTH
		);
		expect(originsOf(peer!)).toEqual([`http://${ONION}`, 'https://peer.example']);
	});

	it('a peer reachable only over I2P or Lokinet has no fan-out route', () => {
		expect(
			fanOutPeerFromRow(row(`http://${I2P_B32}`, { i2p_b32: I2P_B32, lokinet: LOKI }), BOTH)
		).toBeNull();
	});

	it('a peer with I2P and an https origin is reached at the origin, through Tor', () => {
		const peer = fanOutPeerFromRow(row('https://peer.example', { i2p_b32: I2P_B32 }), BOTH);
		expect(originsOf(peer!)).toEqual(['https://peer.example']);
	});

	it('no Tor configured: no fan-out route for anyone', () => {
		expect(fanOutPeerFromRow(row('https://peer.example', { tor: ONION }), I2P_ONLY)).toBeNull();
		expect(fanOutPeerFromRow(row('https://peer.example'), NEITHER)).toBeNull();
	});

	it('a plain http clearnet origin is not a route (only https leaves through an exit)', () => {
		expect(fanOutPeerFromRow(row('http://peer.example'), TOR_ONLY)).toBeNull();
	});

	it('the queue key is the registered origin, whichever address is preferred', () => {
		const peer = fanOutPeerFromRow(row('https://Peer.Example/', { tor: ONION }), TOR_ONLY)!;
		expect(peer.origin).toBe(`http://${ONION}`);
		expect(peerKey(peer)).toBe('https://peer.example');
	});

	it('a zero-clearnet peer whose origin is its onion is listed once', () => {
		const peer = fanOutPeerFromRow(row(`http://${ONION}`, { tor: ONION }), TOR_ONLY)!;
		expect(originsOf(peer)).toEqual([`http://${ONION}`]);
	});
});

describe('fastPeersFromDirectory', () => {
	/** Rows as the directory read returns them: probe-verified unless said
	 *  otherwise. */
	function dbWith(
		rows: (ReturnType<typeof row> & { last_probe_status?: string; last_probe_error?: string })[]
	): FastFederationDb {
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

	it('maps every row through the address builder', async () => {
		const peers = await fastPeersFromDirectory(
			dbWith([
				row('https://one.example', { tor: ONION }),
				row('https://two.example', { i2p_b32: I2P_B32 }),
				row('https://three.example', null)
			]),
			'https://self.example',
			NEITHER
		);
		// No daemons configured → every peer is offered at its clearnet origin,
		// in the ranking's order: one tier, so by origin.
		expect(peers.map((p) => p.origin)).toEqual([
			'https://one.example',
			'https://three.example',
			'https://two.example'
		]);
	});

	it('passes the proxy config through, so the same directory yields different addresses', async () => {
		const rows = [row('https://one.example', { tor: ONION, i2p_b32: I2P_B32 })];
		const torBox = await fastPeersFromDirectory(dbWith(rows), 'https://self.example', BOTH);
		const i2pBox = await fastPeersFromDirectory(dbWith(rows), 'https://self.example', I2P_ONLY);
		const clearBox = await fastPeersFromDirectory(dbWith(rows), 'https://self.example', NEITHER);

		expect(torBox[0]?.origin).toBe(`http://${ONION}`);
		expect(i2pBox[0]?.origin).toBe(`http://${I2P_B32}`);
		expect(clearBox[0]?.origin).toBe('https://one.example');
		// ...and all three keep the same identity, so they are the same peer.
		expect(new Set([peerKey(torBox[0]!), peerKey(i2pBox[0]!), peerKey(clearBox[0]!)]).size).toBe(1);
	});

	it('still excludes this instance from its own peer list', async () => {
		// The SQL does the exclusion; this asserts the parameter is the one the
		// clause reads, by checking it is passed through untouched.
		let captured: readonly unknown[] = [];
		const db: FastFederationDb = {
			query: (async (_t: string, params: readonly unknown[]) => {
				captured = params;
				return { rows: [], rowCount: 0 };
			}) as unknown as FastFederationDb['query']
		};
		await fastPeersFromDirectory(db, 'https://self.example/', BOTH, 7);
		expect(captured[0]).toBe('https://self.example/');
	});

	/**
	 * The fan-out bound is NOT the query's LIMIT any more, and the difference is
	 * the whole reason the ranking could be tested at all.
	 *
	 * The query pulls a bounded SCAN — a memory bound on a table whose size an
	 * attacker has some say in, since registering an origin is an ordinary
	 * on-chain operation — and the fan-out bound is applied afterwards, to the
	 * ranked list. Passing the fan-out bound to SQL instead would hand the
	 * database the decision about which peers get fast chat, using an ordering
	 * no test can execute.
	 */
	it('asks the database for a scan cap, and applies the fan-out bound after ranking', async () => {
		let captured: readonly unknown[] = [];
		const rows = Array.from({ length: 12 }, (_, i) => ({
			origin: `https://peer${i}.example`,
			reg_alt_networks: null,
			last_probe_status: 'good',
			last_probed_at: '2026-09-20T00:00:00Z',
			registered_at_time: '2026-01-01T00:00:00Z'
		}));
		const db: FastFederationDb = {
			query: (async (_t: string, params: readonly unknown[]) => {
				captured = params;
				return { rows, rowCount: rows.length };
			}) as unknown as FastFederationDb['query']
		};
		const peers = await fastPeersFromDirectory(db, 'https://self.example', BOTH, 7);
		expect(captured[1], 'the query bound is the scan cap, not the fan-out bound').toBe(500);
		expect(peers, 'the fan-out bound is applied to the ranked list').toHaveLength(7);
	});

	it('the fan-out read keeps only probe-verified peers, at their Tor addresses', async () => {
		const d = await fastPeerDirectory(
			dbWith([
				row('https://good.example', { tor: ONION, i2p_b32: I2P_B32 }),
				{ ...row('https://new.example', { tor: ONION2 }), last_probe_status: 'never' },
				{ ...row('https://gone.example'), last_probe_status: 'unreachable' },
				{
					...row(`http://${I2P_B32}`),
					last_probe_error: 'hidden_service_not_network_probed'
				},
				{ ...row('https://quiet.example'), last_probe_status: 'quiet' }
			]),
			'https://self.example',
			BOTH
		);
		expect(d.peers.map((p) => originsOf(p))).toEqual([
			[`http://${ONION}`, 'https://good.example'],
			['https://quiet.example']
		]);
	});

	it('uses ONION2 to prove two distinct peers keep distinct keys', () => {
		const a = fastPeerFromRow(row('https://a.example', { tor: ONION }), BOTH);
		const b = fastPeerFromRow(row('https://b.example', { tor: ONION2 }), BOTH);
		expect(peerKey(a)).not.toBe(peerKey(b));
	});
});

/**
 * WHICH peers get one of the bounded fan-out slots.
 *
 * Every chat message goes to every peer, so the fan-out is linear in the peer
 * count and has to be bounded. Past that bound some instances get chain-speed
 * chat, and which ones is then a decision. It used to be an accident: the order
 * was `last_probed_at DESC NULLS LAST` — probe recency, which says nothing
 * about whether a peer can answer.
 *
 * Two consequences, both backwards. An instance known to be DEAD, probed a
 * minute ago, outranked a healthy one probed an hour ago, so slots went to
 * peers that could not take a message. And a newly registered instance has
 * `last_probe_status = 'never'` with a NULL `last_probed_at`, so `NULLS LAST`
 * put it below every corpse — the one instance whose users have no established
 * conversations to fall back on, ranked last.
 *
 * No federation today is anywhere near the bound. That is exactly why this is
 * asserted rather than reasoned about: it is a rule that will first matter on
 * someone else's deployment, years from now, with nobody watching.
 */
describe('which peers get a bounded fan-out slot', () => {
	function peerRow(
		origin: string,
		status: string | null,
		probedAt: string | null = null,
		registeredAt = '2026-01-01T00:00:00Z'
	) {
		return {
			origin,
			reg_alt_networks: null,
			last_probe_status: status,
			last_probed_at: probedAt,
			registered_at_time: registeredAt
		};
	}

	const ordered = (rows: Parameters<typeof rankDirectoryPeers>[0]): string[] =>
		rankDirectoryPeers(rows).map((r) => r.origin);

	it('THE REGRESSION: a healthy peer outranks a dead one probed more recently', () => {
		expect(
			ordered([
				peerRow('https://dead.example', 'unreachable', '2026-09-20T12:00:00Z'),
				peerRow('https://alive.example', 'good', '2026-09-20T09:00:00Z')
			])
		).toEqual(['https://alive.example', 'https://dead.example']);
	});

	it('THE OTHER REGRESSION: a never-probed peer outranks a dead one', () => {
		expect(
			ordered([
				peerRow('https://dead.example', 'unreachable', '2026-09-20T12:00:00Z'),
				peerRow('https://new.example', 'never', null)
			])
		).toEqual(['https://new.example', 'https://dead.example']);
	});

	it('ranks the health tiers in order', () => {
		const rows = [
			peerRow('https://unreachable.example', 'unreachable'),
			peerRow('https://stale.example', 'stale'),
			peerRow('https://never.example', 'never'),
			peerRow('https://blocked.example', 'clearnet_blocked'),
			peerRow('https://syncing.example', 'syncing'),
			peerRow('https://quiet.example', 'quiet'),
			peerRow('https://good.example', 'good')
		];
		expect(ordered(rows)).toEqual([
			'https://good.example',
			'https://quiet.example',
			'https://syncing.example',
			'https://blocked.example',
			'https://never.example',
			'https://stale.example',
			'https://unreachable.example'
		]);
	});

	/**
	 * A censored instance is not a sick one. `clearnet_blocked` means the peer
	 * answered nothing over clearnet but is demonstrably alive on chain, and an
	 * instance reachable only over a hidden address is the case this subsystem
	 * exists for — so it belongs with the healthy tiers, not with the failures.
	 */
	it('keeps a censored peer above the failing tiers', () => {
		expect(peerRank('clearnet_blocked')).toBeLessThan(peerRank('stale'));
		expect(peerRank('clearnet_blocked')).toBeLessThan(peerRank('unreachable'));
		expect(peerRank('clearnet_blocked')).toBeLessThan(peerRank('never'));
	});

	/**
	 * ...and the reason `never` is NOT simply promoted to the top, which is the
	 * tempting fix for the second regression. Registering an origin is an
	 * ordinary on-chain operation, so `never` is the one tier an attacker can
	 * manufacture in bulk. First place would let a burst of junk registrations
	 * evict the entire live federation from every peer list at once.
	 */
	it('does not let a burst of fresh registrations evict the live federation', () => {
		const junk = Array.from({ length: 50 }, (_, i) =>
			peerRow(`https://junk${i}.example`, 'never', null, '2026-09-20T12:00:00Z')
		);
		const real = peerRow('https://real.example', 'good', '2026-09-19T00:00:00Z');
		expect(ordered([...junk, real])[0]).toBe('https://real.example');
	});

	/**
	 * Within a tier, by origin: a key a peer cannot influence by how it answers.
	 * Not probe time — it is stamped when a probe FINISHES, so a peer that stalls
	 * its probe on purpose sorted to the front.
	 */
	it('breaks a tier tie by origin, not by when a probe finished', () => {
		expect(
			ordered([
				peerRow(
					'https://zzz-stalled.example',
					'good',
					'2026-09-20T12:00:00Z',
					'2026-01-01T00:00:00Z'
				),
				peerRow(
					'https://aaa-prompt.example',
					'good',
					'2026-09-20T09:00:00Z',
					'2026-09-01T00:00:00Z'
				)
			])
		).toEqual(['https://aaa-prompt.example', 'https://zzz-stalled.example']);
	});

	it('is a total order, so an unchanged directory does not reshuffle', () => {
		const rows = [peerRow('https://b.example', 'good'), peerRow('https://a.example', 'good')];
		expect(ordered(rows)).toEqual(ordered([...rows].reverse()));
	});

	it('sorts an unrecognised status with the failures, never ahead of the healthy', () => {
		expect(peerRank('some_status_added_later')).toBeGreaterThan(peerRank('good'));
		expect(peerRank(null)).toBeGreaterThan(peerRank('never'));
	});

	/**
	 * v1.18.0 review (S2). The probe writes `good` for a peer it LISTED without
	 * asking — our proxy for its network is down, or it is clearnet-only and we
	 * are hidden-only. It is also what a junk I2P name the proxy refuses gets,
	 * and registering one is free, so that `good` is exactly as manufacturable
	 * as `never` and must rank with it.
	 */
	it('a "good" the probe never verified does not outrank the verified federation', () => {
		const junk = Array.from({ length: 50 }, (_, i) => ({
			...peerRow(`http://junk${i}.i2p`, 'good', '2026-09-20T12:00:00Z', '2026-09-20T12:00:00Z'),
			last_probe_error: 'hidden_service_not_network_probed'
		}));
		const real = peerRow('https://real.example', 'good', '2026-09-19T00:00:00Z');
		expect(ordered([...junk, real])[0]).toBe('https://real.example');
		expect(peerRank('good', 'clearnet_peer_not_probed_hidden_only')).toBe(peerRank('never'));
		// ...and a verified good is still good, whatever else it carries.
		expect(peerRank('good', null)).toBe(peerRank('good'));
	});

	it('does not mutate the caller array', () => {
		const rows = [
			peerRow('https://b.example', 'unreachable'),
			peerRow('https://a.example', 'good')
		];
		const before = rows.map((r) => r.origin);
		rankDirectoryPeers(rows);
		expect(rows.map((r) => r.origin)).toEqual(before);
	});
});

describe('the fan-out bound is reported, not just applied', () => {
	function dbWithRows(n: number): FastFederationDb {
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

	it('reports nothing dropped when the directory fits', async () => {
		const d = await fastPeerDirectory(dbWithRows(5), 'https://self.example', TOR_ONLY, 40);
		expect(d.peers).toHaveLength(5);
		expect(d.dropped).toBe(0);
	});

	/**
	 * The count is the point. Past the bound a peer can be healthy, reachable,
	 * and still on chain timing — and nothing about that instance's behaviour
	 * says why. Every other silent degradation in this subsystem turned out to
	 * be a bug nobody could have found; this one is a DESIGNED limit, which is
	 * only different from the bug if it is visible.
	 */
	it('says how many instances the bound left out', async () => {
		const d = await fastPeerDirectory(dbWithRows(57), 'https://self.example', TOR_ONLY, 40);
		expect(d.peers).toHaveLength(40);
		expect(d.dropped).toBe(17);
	});
});

/**
 * ONE PEER'S BAD ROUTE MUST NOT TAKE TOR AWAY FROM EVERY OTHER PEER.
 *
 * Failover and the breaker are one decision in the code and two in fact.
 * Failover is about this message: any local fault moves to the peer's next
 * address. Marking Tor down is about every other peer, for the next minute,
 * and it needs evidence about OUR end. A fault our own SOCKS connector raised
 * is that evidence; a fault the transport could not pin on our end
 * ('ambiguous') is evidence about the peer until a second peer corroborates it
 * — and one peer's two addresses are one peer.
 */
describe('the Tor breaker needs evidence about our end', () => {
	const ambiguous = (): Error =>
		Object.assign(new ProxyUnavailableError('tunnel refused'), {
			confidence: 'ambiguous' as const
		});

	it('one conclusive local fault marks Tor down immediately', async () => {
		const { sender } = makeSender(TOR_ONLY, () => torDown());
		sender.enqueue({ operations: [] }, [fanOutPeerFromRow(row(`http://${ONION}`), TOR_ONLY)!]);
		await sender.drain(5_000);
		expect(sender.reachability.isDown('tor')).toBe(true);
	});

	it('an ambiguous fault from one peer is held, not convicted — even across its two addresses', async () => {
		const { sender, attempts } = makeSender(TOR_ONLY, () => ambiguous());
		sender.enqueue({ operations: [] }, [
			fanOutPeerFromRow(row('https://stale.example', { tor: ONION }), TOR_ONLY)!
		]);
		await sender.drain(5_000);

		expect(attempts, 'failover still tried both of its addresses').toHaveLength(2);
		expect(sender.reachability.isDown('tor'), 'one peer is evidence about that peer').toBe(false);
		expect(sender.reachability.pendingSuspicion()).toEqual({ tor: 1 });
	});

	it('ambiguous faults from two distinct peers DO mark Tor down', async () => {
		const { sender } = makeSender(TOR_ONLY, () => ambiguous());
		sender.enqueue({ operations: [] }, [
			fanOutPeerFromRow(row(`http://${ONION}`), TOR_ONLY)!,
			fanOutPeerFromRow(row(`http://${ONION2}`), TOR_ONLY)!
		]);
		await sender.drain(5_000);
		expect(sender.reachability.isDown('tor'), 'two peers is our end, not two bad routes').toBe(
			true
		);
	});
});
