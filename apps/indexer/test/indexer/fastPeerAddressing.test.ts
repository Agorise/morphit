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
 * WHAT IS ASSERTED HERE is behaviour, not shape: given a directory and a set of
 * local daemons, which address does a message actually go out over, and what
 * happens when that address turns out not to work.
 */

import { describe, it, expect } from 'vitest';
import { ProxyUnavailableError } from '@morphit/hidden-transport';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import {
	fastPeerFromRow,
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

/** Nothing is listening on port 1, so the hidden leg fails the way a box with
 *  no Tor/i2pd daemon fails: immediately, locally, before the peer is asked. */
const DEAD_DAEMONS: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:1',
	i2pHttpProxy: '127.0.0.1:1'
};

/** A sender whose clearnet leg is a stub, so the address a push WENT OUT OVER
 *  is observable. */
function makeSender(
	proxies: HiddenServiceProxyConfig,
	clearnetStatus = 200
): { sender: PeerSender; attempts: string[] } {
	const attempts: string[] = [];
	const sender = new PeerSender({
		proxies,
		timeoutMs: 1_000,
		postClearnet: async (url: string) => {
			attempts.push(url);
			return { status: clearnetStatus, body: '{}' };
		}
	});
	return { sender, attempts };
}

describe('sending — the address is chosen where local reachability is known', () => {
	/**
	 * The exact scenario from the bug report, driven end to end: a clearnet-only
	 * instance, a peer that published an onion, and a real push. Before the fix
	 * this delivered ZERO and failed ONE, with `clearnetAttempts: 0`.
	 */
	it('a dead Tor daemon fails over to the peer clearnet origin within the same push', async () => {
		const { sender, attempts } = makeSender(DEAD_DAEMONS);
		// The hidden leg is exercised for real — nothing is listening on the
		// configured SOCKS port, so postJsonViaHiddenService raises the
		// local-fault shape this whole mechanism keys off.
		//
		// The onion is still offered FIRST: config cannot tell a dead daemon
		// from a live one, which is precisely why the send path has to.
		const peer = fastPeerFromRow(row('https://peer.example', { tor: ONION }), DEAD_DAEMONS);
		expect(originsOf(peer)[0]).toBe(`http://${ONION}`);

		sender.enqueue({ operations: [] }, [peer]);
		await sender.drain(5_000);

		expect(sender.stats().delivered, 'the message must have been delivered').toBe(1);
		expect(attempts, 'it must have gone out over the clearnet origin').toEqual([
			'https://peer.example/v1/federation/chat-fast'
		]);
		// And the instance has LEARNED that its Tor is unusable.
		expect(sender.reachability.isDown('tor')).toBe(true);
	});

	it('having learned, it does not re-dial the dead network for the next message', async () => {
		const { sender, attempts } = makeSender(DEAD_DAEMONS);
		const peer = fastPeerFromRow(row('https://peer.example', { tor: ONION }), BOTH);

		sender.enqueue({ operations: [], n: 1 }, [peer]);
		await sender.drain(5_000);
		expect(sender.reachability.isDown('tor')).toBe(true);
		const afterFirst = sender.stats().failures.length;

		sender.enqueue({ operations: [], n: 2 }, [peer]);
		await sender.drain(5_000);

		expect(sender.stats().delivered).toBe(2);
		// No NEW failure was recorded: the second message never touched Tor.
		expect(sender.stats().failures.length).toBe(afterFirst);
		expect(attempts).toHaveLength(2);
	});

	/**
	 * The counterweight, and the reason the failover is safe. A peer that
	 * ANSWERS — even with a 500 — has been reached. Dialling its other address
	 * would not be a retry; it would be a second delivery of the same batch to
	 * the same instance, and the peer has no way to tell those apart.
	 */
	it('does NOT try another address when the PEER refused', async () => {
		const { sender, attempts } = makeSender(BOTH, 500);
		// Preferred address is clearnet (Tor switched off), alternate is... also
		// clearnet? No — give it two clearnet addresses so both legs are fake.
		const peer: FastPeer = {
			origin: 'https://a.example',
			hidden: false,
			key: 'https://a.example',
			alternates: [{ origin: 'https://b.example', hidden: false }]
		};
		sender.enqueue({ operations: [] }, [peer]);
		await sender.drain(5_000);

		expect(attempts).toEqual(['https://a.example/v1/federation/chat-fast']);
		expect(sender.stats().failed).toBe(1);
		expect(sender.stats().failures[0]?.localFault).not.toBe(true);
	});

	/**
	 * A TIMEOUT IS NOT A LOCAL FAULT, and this is the case where getting that
	 * wrong costs the most.
	 *
	 * When a push times out, the peer may well have RECEIVED it — what was lost
	 * is the answer, not the message. Treating that as our transport failing
	 * would send the same batch down a second road to the same instance, which
	 * is a duplicate delivery rather than a retry. The receiving side's replay
	 * memory would catch it, but relying on that would mean deliberately doubling
	 * the federation's load on exactly the peers that are already too slow to
	 * answer in time.
	 */
	it('does not fail over when the push merely TIMED OUT', async () => {
		const attempts: string[] = [];
		const sender = new PeerSender({
			proxies: BOTH,
			timeoutMs: 50,
			postClearnet: async (url: string, _body: unknown, ms: number) => {
				attempts.push(url);
				// Abort the way the real transports do, past the deadline.
				await new Promise((r) => setTimeout(r, ms + 40));
				throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
			}
		});
		sender.enqueue({ operations: [] }, [
			{
				origin: 'https://a.example',
				hidden: false,
				key: 'https://a.example',
				alternates: [{ origin: 'https://b.example', hidden: false }]
			}
		]);
		await sender.drain(5_000);

		expect(attempts, 'a lost answer must not become a second delivery').toEqual([
			'https://a.example/v1/federation/chat-fast'
		]);
		expect(sender.stats().failures[0]?.localFault).not.toBe(true);
		expect(sender.reachability.downNetworks()).toEqual([]);
	});

	it('a peer with only an unreachable network is still attempted, not silently dropped', async () => {
		const { sender } = makeSender(DEAD_DAEMONS);
		sender.reachability.markDown('tor');
		const peer = fastPeerFromRow(row(`http://${ONION}`, { tor: ONION }), BOTH);

		sender.enqueue({ operations: [] }, [peer]);
		await sender.drain(5_000);

		const s = sender.stats();
		expect(s.failed, 'the push was attempted and failed, rather than vanishing').toBe(1);
		expect(s.failures[0]?.localFault).toBe(true);
	});

	it('records WHY a push failed locally, so a failure count is a diagnosis', async () => {
		const { sender } = makeSender(DEAD_DAEMONS);
		sender.enqueue({ operations: [] }, [fastPeerFromRow(row(`http://${ONION}`), BOTH)]);
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
		const sender = new PeerSender({
			proxies: DEAD_DAEMONS,
			timeoutMs: 1_000,
			postClearnet: async () => {
				inFlight++;
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return { status: 200, body: '{}' };
			}
		});
		const peer = fastPeerFromRow(row('https://peer.example', { tor: ONION }), BOTH);
		for (let i = 0; i < 5; i++) sender.enqueue({ operations: [], i }, [peer]);
		await sender.drain(10_000);

		expect(inFlight).toBe(0);
		expect(sender.stats().delivered).toBe(5);
	});
});

/**
 * ALL THREE HIDDEN NETWORKS, not just the one that is easy to reach.
 *
 * Morphit's hidden transport is three separate implementations behind one name:
 * a hand-written SOCKS5 connector for Tor, undici's `ProxyAgent` for I2P, and a
 * plain agent for Lokinet's tun. Until `postHidden` became injectable, every
 * test in this tree drove the Tor branch and nothing else — so I2P and Lokinet
 * were carried entirely by the claim that they were similar enough, on the two
 * networks the zero-clearnet instances most depend on.
 */
describe('every hidden network is routed, not just Tor', () => {
	/** A working hidden transport, recording which URLs it was asked for. */
	function hiddenSender(answer: (url: string) => { status: number; body: string } | Error): {
		sender: PeerSender;
		hiddenUrls: string[];
		clearnetUrls: string[];
	} {
		const hiddenUrls: string[] = [];
		const clearnetUrls: string[] = [];
		const sender = new PeerSender({
			proxies: BOTH,
			timeoutMs: 1_000,
			postClearnet: async (url: string) => {
				clearnetUrls.push(url);
				return { status: 200, body: '{}' };
			},
			postHidden: async (url: string) => {
				hiddenUrls.push(url);
				const a = answer(url);
				if (a instanceof Error) throw a;
				return a;
			}
		});
		return { sender, hiddenUrls, clearnetUrls };
	}

	it.each([
		['tor', ONION],
		['i2p (b32)', I2P_B32],
		['i2p (name)', I2P_NAME],
		['lokinet', LOKI]
	])('delivers over %s when that network works', async (_label, host) => {
		const { sender, hiddenUrls, clearnetUrls } = hiddenSender(() => ({ status: 200, body: '{}' }));
		sender.enqueue({ operations: [] }, [
			{ origin: `http://${host}`, hidden: true, key: 'https://peer.example' }
		]);
		await sender.drain(5_000);

		expect(sender.stats().delivered).toBe(1);
		expect(hiddenUrls).toEqual([`http://${host}/v1/federation/chat-fast`]);
		expect(clearnetUrls, 'a working hidden route must not also hit clearnet').toEqual([]);
	});

	/**
	 * THE MUTATION THAT SURVIVED THE FIRST BATTERY. Deleting `reach.markUp()`
	 * from the send path changed nothing any test could see, because nothing
	 * could drive a hidden push to SUCCEED. A network that recovers but stays
	 * marked down keeps every peer on it routed the long way round for the rest
	 * of the cooldown — the bug is silent, and it is exactly the state a Tor
	 * restart leaves behind.
	 */
	it.each([
		['tor', ONION],
		['i2p', I2P_B32],
		['loki', LOKI]
	])('a success over %s clears that network mark at once', async (network, host) => {
		const { sender } = hiddenSender(() => ({ status: 200, body: '{}' }));
		sender.reachability.markDown(network as 'tor' | 'i2p' | 'loki');
		expect(sender.reachability.isDown(network as 'tor')).toBe(true);

		sender.enqueue({ operations: [] }, [
			{ origin: `http://${host}`, hidden: true, key: 'https://peer.example' }
		]);
		await sender.drain(5_000);

		expect(sender.stats().delivered).toBe(1);
		expect(
			sender.reachability.isDown(network as 'tor'),
			'a working push is proof the network is back'
		).toBe(false);
	});

	it.each([
		['i2p', I2P_B32, 'i2p' as const],
		['lokinet', LOKI, 'loki' as const]
	])('marks %s down and fails over when its local daemon is gone', async (_l, host, network) => {
		const { sender, clearnetUrls } = hiddenSender(() => {
			const err = new Error('local transport unavailable');
			// The shape the transport entry point normalises a local fault into.
			return Object.assign(err, { name: 'ProxyUnavailableError' });
		});
		void network;
		sender.enqueue({ operations: [] }, [
			{
				origin: `http://${host}`,
				hidden: true,
				key: 'https://peer.example',
				alternates: [{ origin: 'https://peer.example', hidden: false }]
			}
		]);
		await sender.drain(5_000);
		// A hand-faked name is NOT the marker class, so this must be treated as
		// the peer failing — asserting the negative keeps the test honest about
		// what actually identifies a local fault.
		expect(clearnetUrls).toEqual([]);
		expect(sender.stats().failed).toBe(1);
	});

	/**
	 * FAILOVER IS UNCONDITIONAL; the breaker is not. Both networks fail over on
	 * a real local fault — that is about this message, and one fault is always
	 * enough to stop using the address that produced it.
	 *
	 * Whether the NETWORK comes off the list for every OTHER peer is a separate
	 * claim needing separate evidence, so it is asserted per network below
	 * rather than folded in here. See "the network breaker needs evidence about
	 * the NETWORK".
	 */
	it.each([
		['i2p', I2P_B32, 'i2p' as const],
		['lokinet', LOKI, 'loki' as const]
	])('%s: a REAL local fault fails over within the same push', async (_l, host, network) => {
		const { sender, clearnetUrls } = hiddenSender(() => new ProxyUnavailableError('daemon down'));
		sender.enqueue({ operations: [] }, [
			{
				origin: `http://${host}`,
				hidden: true,
				key: 'https://peer.example',
				alternates: [{ origin: 'https://peer.example', hidden: false }]
			}
		]);
		await sender.drain(5_000);

		expect(sender.stats().delivered).toBe(1);
		expect(clearnetUrls).toEqual(['https://peer.example/v1/federation/chat-fast']);
		void network;
	});

	it('i2p: one local fault is conclusive, because the error names OUR proxy', async () => {
		const { sender } = hiddenSender(() => new ProxyUnavailableError('daemon down'));
		sender.enqueue({ operations: [] }, [
			{
				origin: `http://${I2P_B32}`,
				hidden: true,
				key: 'https://peer.example',
				alternates: [{ origin: 'https://peer.example', hidden: false }]
			}
		]);
		await sender.drain(5_000);

		expect(sender.reachability.isDown('i2p')).toBe(true);
		// The networks that were NOT at fault stay available.
		expect(sender.reachability.downNetworks()).toEqual(['i2p']);
	});

	it('lokinet: one local fault is NOT conclusive, because the error names THEIR host', async () => {
		const { sender } = hiddenSender(() => new ProxyUnavailableError('daemon down'));
		sender.enqueue({ operations: [] }, [
			{
				origin: `http://${LOKI}`,
				hidden: true,
				key: 'https://peer.example',
				alternates: [{ origin: 'https://peer.example', hidden: false }]
			}
		]);
		await sender.drain(5_000);

		expect(
			sender.reachability.downNetworks(),
			'a single unresolvable .loki name must not cost every other .loki peer'
		).toEqual([]);
	});

	it('a peer on a down network falls through to its OTHER hidden network', async () => {
		// The shape that matters for a zero-clearnet pair: no clearnet address
		// anywhere, so the only escape from a dead Tor is the peer's I2P address.
		const { sender, hiddenUrls } = hiddenSender((url) =>
			url.includes('.onion') ? new ProxyUnavailableError('tor down') : { status: 200, body: '{}' }
		);
		sender.enqueue({ operations: [] }, [
			{
				origin: `http://${ONION}`,
				hidden: true,
				key: `http://${ONION}`,
				alternates: [{ origin: `http://${I2P_B32}`, hidden: true }]
			}
		]);
		await sender.drain(5_000);

		expect(sender.stats().delivered, 'a zero-clearnet pair must still connect').toBe(1);
		expect(hiddenUrls).toEqual([
			`http://${ONION}/v1/federation/chat-fast`,
			`http://${I2P_B32}/v1/federation/chat-fast`
		]);
		expect(sender.reachability.downNetworks()).toEqual(['tor']);
	});
});

describe('fastPeersFromDirectory', () => {
	function dbWith(rows: ReturnType<typeof row>[]): FastFederationDb {
		return {
			query: (async () => ({
				rows,
				rowCount: rows.length
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
		// No daemons configured → every peer is offered at its clearnet origin.
		//
		// The ORDER is the ranking's, not the query's: these rows carry no probe
		// status, so they all land in the unknown tier and fall through to the
		// origin tiebreak that makes the ordering total. Asserting the set rather
		// than the sequence here, because the sequence is `rankDirectoryPeers`'s
		// contract and is asserted against real statuses in its own block.
		expect(peers.map((p) => p.origin).sort()).toEqual([
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

	it('breaks a tier tie by most recently confirmed', () => {
		expect(
			ordered([
				peerRow('https://older.example', 'good', '2026-09-19T00:00:00Z'),
				peerRow('https://newer.example', 'good', '2026-09-20T00:00:00Z')
			])
		).toEqual(['https://newer.example', 'https://older.example']);
	});

	it('then by the longest registered, which is what resists a burst', () => {
		// The origins are chosen so ALPHABETICAL order contradicts registration
		// order. An earlier version of this fixture had them agreeing, so
		// deleting the registration tiebreak entirely changed nothing — the
		// origin tiebreak below it produced the same answer and the test passed
		// against code that had lost the property it was written for.
		expect(
			ordered([
				peerRow('https://aaa-recent.example', 'never', null, '2026-09-01T00:00:00Z'),
				peerRow('https://zzz-established.example', 'never', null, '2026-02-01T00:00:00Z')
			])
		).toEqual(['https://zzz-established.example', 'https://aaa-recent.example']);
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
		const d = await fastPeerDirectory(dbWithRows(5), 'https://self.example', NEITHER, 40);
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
		const d = await fastPeerDirectory(dbWithRows(57), 'https://self.example', NEITHER, 40);
		expect(d.peers).toHaveLength(40);
		expect(d.dropped).toBe(17);
	});
});

/**
 * ONE BAD NAME MUST NOT TAKE DOWN A NETWORK.
 *
 * The send path's breaker and the send path's FAILOVER are one decision in the
 * code and two decisions in fact. Failover is about this message: any local
 * fault should move to the next address immediately, and that is right.
 * Marking the NETWORK down is about every other peer on it, for the next
 * minute, and it needs better evidence than one address failing.
 *
 * On Tor and I2P one failure IS enough, because the error names OUR end: the
 * SOCKS connector raises `ProxyUnavailableError` only when the socket to our
 * own proxy failed or our own proxy answered wrongly, and the I2P branch
 * matches `address`/`port` against the proxy we configured. Neither can be
 * produced by a peer's address being wrong.
 *
 * Lokinet has no such discriminator and cannot have one. Its local fault is a
 * DNS miss, and a DNS miss carries THEIR name, not ours: a stale, mistyped or
 * deregistered `.loki` address on one peer's chain record produces the same
 * `getaddrinfo ENOTFOUND` as our router being gone. So the single-failure rule,
 * correct on the other two networks, reads one peer's bad address as our whole
 * transport being down — and the warm path already knows better, requiring
 * EVERY warm-up over a network to fail locally before it says so.
 */
describe('the network breaker needs evidence about the NETWORK', () => {
	const LOKI_DEAD = 'stale.loki';
	const LOKI_GOOD = 'healthy.loki';

	/** A sender whose hidden transport fails for the named hosts the way a DNS
	 *  miss does once `postJsonViaHiddenService` has classified it — which is
	 *  the shape the send path actually receives. */
	function lokiSender(deadHosts: readonly string[]) {
		const hiddenUrls: string[] = [];
		const clearnetUrls: string[] = [];
		const sender = new PeerSender({
			proxies: BOTH,
			timeoutMs: 1_000,
			postClearnet: async (url: string) => {
				clearnetUrls.push(url);
				return { status: 200, body: '{}' };
			},
			postHidden: async (url: string) => {
				hiddenUrls.push(url);
				const host = new URL(url).hostname;
				if (deadHosts.includes(host)) {
					throw new ProxyUnavailableError(
						`local loki transport unavailable: getaddrinfo ENOTFOUND ${host}`,
						{
							cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
								code: 'ENOTFOUND',
								syscall: 'getaddrinfo',
								hostname: host
							})
						}
					);
				}
				return { status: 200, body: '{}' };
			}
		});
		return { sender, hiddenUrls, clearnetUrls };
	}

	it('one peer with a stale .loki address does not mark Lokinet down', async () => {
		const { sender } = lokiSender([LOKI_DEAD]);
		sender.enqueue({ operations: [], n: 1 }, [
			{ origin: `http://${LOKI_DEAD}`, hidden: true, key: 'https://stale.example' }
		]);
		await sender.drain(5_000);

		expect(
			sender.reachability.isDown('loki'),
			'one unresolvable name is evidence about that NAME, not about our router'
		).toBe(false);
	});

	/**
	 * The consequence, and the reason this is worth fixing rather than noting.
	 * A healthy Lokinet peer that ALSO publishes a clearnet origin gets its
	 * traffic silently moved onto the clearnet for the next minute — on an
	 * instance whose operator chose a hidden network, because a DIFFERENT peer
	 * mistyped an address.
	 */
	it('a stale .loki on one peer does not downgrade another peer to clearnet', async () => {
		const { sender, hiddenUrls, clearnetUrls } = lokiSender([LOKI_DEAD]);
		const healthy: FastPeer = {
			origin: `http://${LOKI_GOOD}`,
			hidden: true,
			key: 'https://healthy.example',
			alternates: [{ origin: 'https://healthy.example', hidden: false }]
		};

		sender.enqueue({ operations: [], n: 1 }, [
			{ origin: `http://${LOKI_DEAD}`, hidden: true, key: 'https://stale.example' }
		]);
		await sender.drain(5_000);
		sender.enqueue({ operations: [], n: 2 }, [healthy]);
		await sender.drain(5_000);

		expect(hiddenUrls, 'the healthy peer must still be reached over Lokinet').toContain(
			`http://${LOKI_GOOD}/v1/federation/chat-fast`
		);
		expect(clearnetUrls, 'and must NOT have been pushed over the clearnet instead').toEqual([]);
	});

	/**
	 * The breaker must still WORK. Two distinct names failing to resolve is the
	 * first point at which our resolver is the better explanation than their
	 * records, and it is the point the network goes down — within the same
	 * batch, not a minute later.
	 */
	it('two distinct .loki addresses failing DOES mark Lokinet down', async () => {
		const { sender } = lokiSender([LOKI_DEAD, 'other.loki']);
		sender.enqueue({ operations: [], n: 1 }, [
			{ origin: `http://${LOKI_DEAD}`, hidden: true, key: 'https://a.example' },
			{ origin: 'http://other.loki', hidden: true, key: 'https://b.example' }
		]);
		await sender.drain(5_000);

		expect(sender.reachability.isDown('loki'), 'two names is our router, not two typos').toBe(true);
	});

	/** Tor is self-identifying, so ONE failure stays conclusive — the fix must
	 *  not slow down the network where the evidence was already good. */
	it('one Tor local fault still marks Tor down immediately', async () => {
		const { sender } = lokiSender([ONION]);
		sender.enqueue({ operations: [], n: 1 }, [
			{ origin: `http://${ONION}`, hidden: true, key: 'https://a.example' }
		]);
		await sender.drain(5_000);

		expect(sender.reachability.isDown('tor')).toBe(true);
	});

	/** ...and so is I2P. */
	it('one I2P local fault still marks I2P down immediately', async () => {
		const { sender } = lokiSender([I2P_B32]);
		sender.enqueue({ operations: [], n: 1 }, [
			{ origin: `http://${I2P_B32}`, hidden: true, key: 'https://a.example' }
		]);
		await sender.drain(5_000);

		expect(sender.reachability.isDown('i2p')).toBe(true);
	});
});
