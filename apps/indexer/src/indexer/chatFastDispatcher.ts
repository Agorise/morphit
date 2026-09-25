/**
 * chatFastDispatcher — the sender side of the federation chat fast path.
 *
 * Owns three things:
 *
 *   1. WHO to push to. The instance directory this indexer already maintains,
 *      refreshed on a slow cadence because it changes on the scale of days, and
 *      cached so a send never waits on a database query.
 *
 *   2. KEEPING THE ROUTE WARM. A cold Tor circuit or I2P tunnel costs 30-60
 *      seconds to build. If the first message of a conversation paid that, the
 *      six-second target would be met for every message except the one that
 *      matters most — the first one, where the other person has no reason to be
 *      watching yet. So connections to hidden peers are established in the
 *      background, before anyone is waiting, and refreshed inside the idle
 *      timeout that would otherwise reclaim them.
 *
 *   3. FANNING OUT. Concurrently, bounded, and never in a way that can slow or
 *      fail the send it came from.
 *
 * Nothing here ever throws into its caller. A peer being unreachable is an
 * ordinary condition in this federation — that is the whole reason the hidden
 * instances exist — and it must cost a sender nothing.
 */

import type { HiddenServiceProxyConfig, HiddenNetwork } from '@morphit/hidden-transport';
import { hiddenNetworkOf } from '@morphit/hidden-transport';
import { logger } from '$log';
import { warmHiddenOrigin, type WarmResult } from '$indexer/hiddenServicePool';
import {
	PeerSender,
	fastPeerDirectory,
	containsChatOp,
	addressesOf,
	peerKey,
	networkConfigured,
	structuralCheckChatOp,
	verifyPushedChatOp,
	postingKeyLookupFromDb,
	type CanonicalChatTrx,
	type FastPeer,
	type DispatchDeps,
	type DispatchFailure,
	type FastFederationDb,
	type PostingKeyLookup,
	NETWORK_DOWN_MS
} from '$indexer/chatFastFederation';
import {
	checkLocalTransports,
	networksDownIn,
	type LocalTransportState
} from '$indexer/localTransportLiveness';

const log = logger('chat-fast-dispatch');

/** How often the peer list is re-read. Instances join on the scale of days. */
const DIRECTORY_REFRESH_MS = 5 * 60 * 1000;

/**
 * How often a hidden peer's connection is refreshed. Comfortably inside both
 * Tor's ~10-minute idle circuit timeout and the pool's own keep-alive window,
 * so a peer we have not messaged in a while is still one round trip away rather
 * than one tunnel build away.
 */
export const WARM_INTERVAL_MS = 3 * 60 * 1000;

/** Budget for one peer push. Deliberately well under the delivery target: a
 *  peer that cannot answer in this long is not going to make the six seconds,
 *  and holding the slot open only delays the others. */
const PUSH_TIMEOUT_MS = 4_000;

/** Budget for one warm-up. Long, because a warm-up may be building a circuit
 *  from cold — that is its job — and nobody is waiting on it. */
const WARM_TIMEOUT_MS = 60_000;

/** How soon to retry the peer directory after a failed read. Long enough that a
 *  database blip is not retried at message rate, short enough that the peer list
 *  is not stale for a whole refresh interval after one bad query. */
const REFRESH_BACKOFF_MS = 15_000;

export interface ChatFastDispatcherOptions {
	readonly db: FastFederationDb;
	/** This instance's own SITE origin, as the on-chain registration records it —
	 *  not the indexer origin. See fastPeersFromDirectory for why the difference
	 *  matters and why this is the only self-exclusion that is correct. */
	readonly selfOrigin: string;
	readonly proxies: HiddenServiceProxyConfig;
	/** Injected so the smoke can drive the whole thing without a network. */
	readonly postClearnet: DispatchDeps['postClearnet'];
	/**
	 * The warm-up itself. Defaults to the real pooled one.
	 *
	 * Injectable for one specific reason, which is worth stating because
	 * otherwise it looks like a seam added for convenience: the rule below — a
	 * network is marked down only when EVERY route over it failed locally, never
	 * when one did — cannot be tested without it. A dead proxy fails every route
	 * on its network at once, and a live proxy fails none of them locally, so
	 * with the real transport "all failed" and "any failed" are the same
	 * experiment and a mutation between them survives.
	 *
	 * The case that separates them is real, and it is Lokinet: there is no proxy
	 * there, each `.loki` name resolves on its own, and an unresolvable one is a
	 * local fault. Under "any", a single peer with a stale Lokinet name would
	 * take the network away from every other peer on it.
	 */
	readonly warmOrigin?: (
		origin: string,
		proxies: HiddenServiceProxyConfig,
		timeoutMs: number
	) => Promise<WarmResult>;
	/** Overridable for tests. */
	readonly pushTimeoutMs?: number;
	/** The local-daemon liveness check (localTransportLiveness.ts). Injected by
	 *  tests; defaults to the real one. */
	readonly checkLocalTransports?: (
		proxies: HiddenServiceProxyConfig
	) => Promise<LocalTransportState>;
	readonly warmIntervalMs?: number;
	readonly directoryRefreshMs?: number;
	/**
	 * The posting-key lookup the pre-send check verifies against (rv1-1).
	 * Defaults to this instance's own `accounts` column, no chain read: the
	 * check is a filter on what we SEND, not a trust decision — every peer
	 * verifies for itself — so it must never wait on the network.
	 */
	readonly lookupPostingKey?: PostingKeyLookup;
}

/**
 * What became of one transaction handed to {@link ChatFastDispatcher.dispatchIfChat}.
 *
 *   - `dispatched` it verified here and is on its way to every peer.
 *   - `deferred`   it could not be verified here (unknown or unconfirmed key,
 *                  a key rotated since our column was written, a full replay
 *                  memory) and waits for the chain: it goes out only once the
 *                  node has accepted it — see {@link FastDispatchHandle.chainAccepted}.
 *   - `refused`    it will never go out: not a chat-only transaction, over the
 *                  size bound, malformed, or already sent.
 */
export type FastDispatchDecision = 'dispatched' | 'deferred' | 'refused';

export interface FastDispatchHandle {
	readonly decision: Promise<FastDispatchDecision>;
	/** The node accepted the transaction. A `deferred` one goes out now; the
	 *  node's acceptance is what proves its signature real. Idempotent. */
	chainAccepted(): void;
}

const REFUSED_HANDLE: FastDispatchHandle = {
	decision: Promise.resolve('refused'),
	chainAccepted: () => undefined
};

export class ChatFastDispatcher {
	private peers: FastPeer[] = [];
	private peersLoadedAt = 0;
	/** The in-flight directory refresh, so concurrent senders share one query. */
	private refreshing: Promise<void> | null = null;
	private warmTimer: NodeJS.Timeout | null = null;
	private livenessTimer: NodeJS.Timeout | null = null;
	/** What the last local-daemon check found; null until the first one. */
	private lastLiveness: LocalTransportState | null = null;
	private readonly opts: Required<
		Pick<ChatFastDispatcherOptions, 'pushTimeoutMs' | 'warmIntervalMs' | 'directoryRefreshMs'>
	> &
		ChatFastDispatcherOptions;

	/** Counters, surfaced in /v1/health so an operator can see the path working
	 *  rather than infer it from message timing. */
	private dispatched = 0;
	/** Chat transactions this instance declined to fan out (rv1-1). */
	private refusedLocally = 0;
	/** Chat transactions fanned out only after the node accepted them. */
	private dispatchedAfterChain = 0;
	private readonly lookupPostingKey: PostingKeyLookup;
	private peersDropped = 0;
	private lastWarmOk = 0;
	private lastWarmTotal = 0;

	private readonly sender: PeerSender;

	constructor(options: ChatFastDispatcherOptions) {
		this.sender = new PeerSender({
			proxies: options.proxies,
			timeoutMs: options.pushTimeoutMs ?? PUSH_TIMEOUT_MS,
			postClearnet: options.postClearnet
		});
		this.lookupPostingKey = options.lookupPostingKey ?? postingKeyLookupFromDb(options.db);
		this.opts = {
			...options,
			pushTimeoutMs: options.pushTimeoutMs ?? PUSH_TIMEOUT_MS,
			warmIntervalMs: options.warmIntervalMs ?? WARM_INTERVAL_MS,
			directoryRefreshMs: options.directoryRefreshMs ?? DIRECTORY_REFRESH_MS
		};
	}

	/** Begin keeping peer routes warm. Safe to call once; idempotent. */
	start(): void {
		if (this.warmTimer !== null) return;
		// Ask each local daemon whether it is alive BEFORE the first peer list is
		// used, so a network this box cannot reach is off the list from the
		// first message rather than after the first failure — then warm, so the
		// first conversation after a restart does not pay for a tunnel build.
		void this.checkTransports().finally(() => void this.warmAll());
		this.warmTimer = setInterval(() => void this.warmAll(), this.opts.warmIntervalMs);
		// Never hold the process open for a warm-up.
		this.warmTimer.unref?.();
		// Re-asked on the down-mark's own period, so a daemon that stays down
		// stays marked, and one that comes back is re-offered within a minute
		// (the down-mark simply lapses; success is still learned from traffic).
		this.livenessTimer = setInterval(() => void this.checkTransports(), NETWORK_DOWN_MS);
		this.livenessTimer.unref?.();
		log.info('chat_fast_dispatch_start', {
			warm_interval_ms: this.opts.warmIntervalMs,
			push_timeout_ms: this.opts.pushTimeoutMs
		});
	}

	stop(): void {
		if (this.warmTimer !== null) {
			clearInterval(this.warmTimer);
			this.warmTimer = null;
		}
		if (this.livenessTimer !== null) {
			clearInterval(this.livenessTimer);
			this.livenessTimer = null;
		}
	}

	/**
	 * Ask each local daemon whether it is alive, and take a network whose local
	 * end is down off the fan-out at once. See localTransportLiveness.ts. Also
	 * records Lokinet's answer process-wide, which is what lets the probe blame
	 * a dead `.loki` name on its owner. Never throws.
	 */
	async checkTransports(): Promise<LocalTransportState | null> {
		try {
			const check = this.opts.checkLocalTransports ?? checkLocalTransports;
			const state = await check(this.opts.proxies);
			const before = this.lastLiveness;
			this.lastLiveness = state;
			for (const net of networksDownIn(state)) this.sender.reachability.markDown(net);
			if (before === null || JSON.stringify(before) !== JSON.stringify(state)) {
				log.info('local_transports', { ...state, down: networksDownIn(state) });
			}
			return state;
		} catch (err) {
			log.warn('local_transport_check_failed', {}, err);
			return null;
		}
	}

	status(): Record<string, number> {
		const s = this.sender.stats();
		return {
			peers: this.peers.length,
			// Instances the fan-out bound left out of the peer list. Zero in every
			// federation smaller than the bound — which is every federation today —
			// and the only thing that would ever explain a peer being reachable,
			// healthy, and still stuck on chain timing.
			peersTruncated: this.peersDropped,
			dispatched: this.dispatched,
			refusedLocally: this.refusedLocally,
			dispatchedAfterChain: this.dispatchedAfterChain,
			peerDeliveries: s.delivered,
			peerFailures: s.failed,
			// Batching is invisible in a delivery count, and an operator wondering
			// whether the federation is keeping up needs to see it: batches well
			// below deliveries means messages are riding together, which is the
			// design working rather than a symptom.
			peerBatches: s.batches,
			largestBatch: s.largestBatch,
			droppedBacklog: s.dropped,
			lastWarmOk: this.lastWarmOk,
			lastWarmTotal: this.lastWarmTotal,
			// A local transport that is down is the single most common reason for
			// a high failure count, and the one an operator is least likely to
			// guess at. Counting it makes it visible in /v1/health next to the
			// failures it explains. (`status()` returns numbers, so this is a
			// count; `reachability.downNetworks()` has the names, and they are
			// logged by name on every warm pass.)
			networksDown: this.sender.reachability.downNetworks().length
		};
	}

	/**
	 * Why recent pushes did not land, and which of our own transports are down.
	 *
	 * `status()` can only carry numbers, and a number was never the point. The
	 * whole reason this subsystem keeps failure REASONS is that "peerFailures:
	 * 40" sends an operator to look at the federation when the answer is that
	 * `systemctl start tor` was never run on their own box — and until this was
	 * surfaced, the list that says which it is existed only for the tests to
	 * read. A diagnosis nobody can reach is not a diagnosis.
	 *
	 * Same sensitivity as the counters beside it: a peer's published origin and
	 * an error string. No accounts, no message content, nothing about who was
	 * talking to whom.
	 */
	diagnostics(): {
		networksDown: readonly string[];
		networksSuspected: Readonly<Record<string, number>>;
		recentFailures: readonly DispatchFailure[];
		localTransports: LocalTransportState | null;
	} {
		return {
			networksDown: this.sender.reachability.downNetworks(),
			// What each local daemon said when asked directly (null = not yet
			// asked; per network, null = not run here). The reason a network is
			// in `networksDown` without a single failed message to explain it.
			localTransports: this.lastLiveness,
			// Local faults recorded against a network that has NOT been taken off
			// the list, because its failures do not name our end and only one
			// address has produced one. Without this the operator sees
			// `localFault: true` failures beside an empty `networksDown` and has
			// no way to tell a deliberate rule from a broken field.
			networksSuspected: this.sender.reachability.pendingSuspicion(),
			recentFailures: this.sender.stats().failures
		};
	}

	/** Wait for every peer queue to empty, or until the deadline. Tests and
	 *  shutdown only — and shutdown always has a deadline, so it passes one
	 *  rather than racing a poll loop it then leaves running. */
	async drain(deadlineMs?: number): Promise<void> {
		await this.sender.drain(deadlineMs);
	}

	/** Refresh the cached peer list if it is stale. Never throws. */
	async peersNow(): Promise<readonly FastPeer[]> {
		const now = Date.now();
		if (now - this.peersLoadedAt < this.opts.directoryRefreshMs && this.peers.length > 0) {
			return this.peers;
		}
		// ONE refresh at a time. Every chat send passes through here, so without
		// this a burst arriving the moment the cache expires issues one directory
		// query per message — and if the database is the thing that is unwell,
		// that is a stampede aimed straight at it.
		if (this.refreshing === null) {
			this.refreshing = (async (): Promise<void> => {
				try {
					const dir = await fastPeerDirectory(
						this.opts.db,
						this.opts.selfOrigin,
						this.opts.proxies
					);
					this.peers = dir.peers;
					this.peersDropped = dir.dropped;
					this.peersLoadedAt = Date.now();
					if (dir.dropped > 0) {
						// NOT a debug line. The fan-out is bounded, so past that bound
						// some instances get chain-speed chat and nothing about their
						// users' experience says why. Every other silent degradation in
						// this subsystem turned out to be a bug an operator could not
						// have found; this one is a DESIGNED limit, and saying so out
						// loud is the whole difference between a limit and the same bug
						// wearing a justification.
						log.warn('peer_directory_truncated', {
							pushed_to: dir.peers.length,
							left_out: dir.dropped
						});
					}
				} catch (err) {
					// Keep whatever list we had. A directory read failing must not
					// silently turn the fast path off. Back off before trying
					// again, rather than re-querying on the very next message:
					// a failing query retried at message rate is how a database
					// blip becomes a database outage.
					this.peersLoadedAt = Date.now() - this.opts.directoryRefreshMs + REFRESH_BACKOFF_MS;
					log.warn('peer_directory_refresh_failed', {}, err);
				} finally {
					this.refreshing = null;
				}
			})();
		}
		await this.refreshing;
		return this.peers;
	}

	/**
	 * Establish/refresh connections to every hidden peer.
	 *
	 * ALSO THE INSTANCE'S CHEAPEST TRANSPORT DIAGNOSTIC. This runs at boot,
	 * before a single message has been sent, and again every few minutes. So it
	 * is where a dead local Tor daemon or an i2pd that has not finished coming
	 * up gets NOTICED — and, because the outcome feeds the sender's reachability
	 * tracker, the first chat message of the day is dialled over a route that
	 * already works rather than discovering the dead daemon on its own time.
	 * A route that comes back up clears the mark here too, so recovery needs no
	 * failed message to be observed through.
	 */
	async warmAll(): Promise<void> {
		const peers = await this.peersNow();
		// SKIP THE PEERS WE ARE TALKING TO. A hidden origin holds exactly one
		// pooled connection — deliberately, because a second one costs a circuit
		// build — so a warm-up GET and a chat push to the same peer contend for
		// it, and the warm-up is allowed sixty seconds while a push is allowed
		// four. A slow peer's warm-up would therefore park in front of real
		// messages and make them time out for a reason that has nothing to do
		// with the peer refusing them. A peer with traffic in flight needs no
		// warming anyway: the traffic IS the warm connection.
		//
		// WHICH ADDRESSES, and why not simply all of them.
		//
		// The preferred hidden address of every peer is warmed — that is the one a
		// message will actually use. Warming a peer's ALTERNATES as well is only
		// worth its cost where the failover has nowhere cheap to land:
		//
		//   - A peer with a clearnet origin falls back to it, and clearnet has no
		//     circuit to build. Warming its second hidden address would buy a few
		//     milliseconds on a path that is already fast enough.
		//
		//   - A peer with NO clearnet address anywhere — a zero-clearnet instance,
		//     the case this whole subsystem exists for — can only fall back to
		//     another hidden network. Cold, that is a 30-60 second tunnel build,
		//     which does not miss the six-second target so much as ignore it. For
		//     those peers the alternates are warmed too.
		//
		// The distinction matters because the cost is not free. Every warmed
		// hidden origin holds a pooled connection and, underneath it, a live
		// circuit or tunnel pair — and I2P tunnels in particular are not cheap to
		// the local router. Warming every address of every peer would multiply
		// that by however many networks the federation happens to publish, to
		// protect a failover most peers will never need.
		const targets: { origin: string; network: HiddenNetwork; peer: string }[] = [];
		const seen = new Set<string>();
		for (const peer of peers) {
			if (this.sender.isBusy(peerKey(peer))) continue;
			const addresses = addressesOf(peer);
			const hasCheapFallback = addresses.some((a) => !a.hidden);
			for (const addr of addresses) {
				if (!addr.hidden || seen.has(addr.origin)) continue;
				// A network this node does not run is never dialled by the sender,
				// so warming it is wasted — and on Lokinet, which is opt-in, the
				// refused warm-up was reported as Lokinet being DOWN every three
				// minutes on nodes that never had it (v1.18.0 review, S3). Skip
				// to the address the sender would actually use.
				const net = hiddenNetworkOf(addr.origin);
				if (net !== null && !networkConfigured(net, this.opts.proxies)) continue;
				seen.add(addr.origin);
				targets.push({
					origin: addr.origin,
					network: hiddenNetworkOf(addr.origin),
					peer: peerKey(peer)
				});
				// Preferred address only, unless this peer has no clearnet road.
				if (hasCheapFallback) break;
			}
		}
		if (targets.length === 0) {
			this.lastWarmOk = 0;
			this.lastWarmTotal = 0;
			return;
		}
		const warm = this.opts.warmOrigin ?? warmHiddenOrigin;
		const results = await Promise.all(
			targets.map((t) => warm(t.origin, this.opts.proxies, WARM_TIMEOUT_MS))
		);

		// A network is only marked down when EVERY warm-up over it failed locally.
		// One peer's tunnel refusing to build is that peer's problem; the local
		// daemon being gone fails all of them at once, and only the second is a
		// reason to stop offering the network to the other peers on it.
		//
		// THE VERDICT IS NOT REACHED HERE. Having established that no warm-up
		// over this network worked, each failing ADDRESS is reported to
		// `reportAddressFault`, which owns the question of whether the evidence
		// reaches the network — immediately on Tor and I2P, whose failures name
		// our own proxy, and only on a second distinct address on Lokinet, whose
		// failure is a DNS miss carrying the peer's name and is therefore the
		// same shape as a stale `.loki` record.
		//
		// This used to call `markDown` directly, which meant the rule existed in
		// two places and the two disagreed: a directory with a single `.loki`
		// peer convicted the network here while the send path (once fixed)
		// would not. One rule, one owner.
		// Each fault is reported against the PEER it came from, with the
		// confidence its error carried — never an address alone, and never the
		// network's default (S2: an ambiguous refusal from one peer's two names
		// used to convict I2P for everyone).
		const perNetwork = new Map<
			string,
			{
				any: boolean;
				allLocalFault: boolean;
				faulted: { peer: string; confidence: WarmResult['confidence'] }[];
			}
		>();
		results.forEach((res, i) => {
			const t = targets[i];
			const net = t?.network;
			if (net === null || net === undefined || t === undefined) return;
			const seenNet = perNetwork.get(net) ?? { any: false, allLocalFault: true, faulted: [] };
			seenNet.any = seenNet.any || res.ok;
			seenNet.allLocalFault = seenNet.allLocalFault && !res.ok && res.localFault;
			if (!res.ok && res.localFault)
				seenNet.faulted.push({ peer: t.peer, confidence: res.confidence });
			perNetwork.set(net, seenNet);
		});
		for (const [net, verdict] of perNetwork) {
			if (verdict.any) this.sender.reachability.markUp(net as HiddenNetwork);
			else if (verdict.allLocalFault)
				for (const f of verdict.faulted)
					this.sender.reachability.reportAddressFault(
						net as HiddenNetwork,
						f.peer,
						Date.now(),
						f.confidence
					);
		}

		this.lastWarmTotal = targets.length;
		this.lastWarmOk = results.filter((r) => r.ok).length;
		log.info('peer_routes_warmed', {
			ok: this.lastWarmOk,
			total: this.lastWarmTotal,
			networks_down: this.sender.reachability.downNetworks()
		});
	}

	/**
	 * If this transaction carries a chat op, push it to the federation.
	 *
	 * Returns immediately. The caller is on the send path and must not wait:
	 * the point of this whole mechanism is to take waiting off that path, and
	 * blocking it on a fan-out would be a comic way to lose the benefit.
	 */
	/**
	 * WHAT IS SENT, AND WHEN (v1.18.0 deep-deep, rv1-1).
	 *
	 * WHAT WAS WRONG. Anything with a chat op in it was queued to every peer
	 * the moment it reached /v1/broadcast, before the chain had looked at it:
	 * a bogus signature, a 2020 expiry, a 120 KB payload, extra non-chat ops
	 * riding along, and the client's raw object rather than a rebuilt copy.
	 * One junk request cost forty POSTs of whatever size it liked; ten of
	 * them put a real message seconds behind, and a steady trickle filled every
	 * per-peer queue until real users' messages were silently dropped — the
	 * instance's whole outbound fast path, off, for free. Peers also saw THIS
	 * instance as the source of the junk.
	 *
	 * Now a transaction is fanned out only if it passes the receiving side's
	 * own cheap check (exactly one chat op, bounded, well-formed — the same
	 * function every peer runs) AND its signature verifies here against our
	 * own `accounts` row. What goes to the queue is the REBUILT copy, never the
	 * client's object. Anything that cannot be verified here waits for the
	 * chain: if the node accepts it, the signature is real and it goes out
	 * then (`chainAccepted`); if the node refuses it, it never goes anywhere.
	 */
	dispatchIfChat(trx: unknown): FastDispatchHandle {
		if (!containsChatOp(trx)) return REFUSED_HANDLE;
		const structural = structuralCheckChatOp(trx);
		if (!structural.ok) {
			this.refusedLocally++;
			return REFUSED_HANDLE;
		}
		const canonical = structural.canonical;
		const decision: Promise<FastDispatchDecision> = verifyPushedChatOp(
			{ trx: canonical },
			this.lookupPostingKey,
			undefined,
			{ network: false, remember: false }
		).then(
			(v): FastDispatchDecision => {
				if (v.ok) {
					this.dispatched++;
					void this.doDispatch(canonical);
					return 'dispatched';
				}
				return 'deferred';
			},
			(): FastDispatchDecision => 'deferred'
		);
		let accepted = false;
		return {
			decision,
			chainAccepted: (): void => {
				if (accepted) return;
				accepted = true;
				void decision.then((d) => {
					if (d !== 'deferred') return;
					this.dispatched++;
					this.dispatchedAfterChain++;
					void this.doDispatch(canonical);
				});
			}
		};
	}

	private async doDispatch(trx: CanonicalChatTrx): Promise<void> {
		try {
			const peers = await this.peersNow();
			if (peers.length === 0) return;
			// Handed to the sender, which owns the per-peer queueing. It returns at
			// once; a push already in flight to a peer means this message rides
			// along with the next one rather than waiting for a connection.
			this.sender.enqueue(trx, peers);
		} catch (err) {
			log.warn('chat_fast_dispatch_failed', {}, err);
		}
	}
}

/** Re-exported so the dispatch predicate is reachable from the module that owns
 *  dispatching, even though it is DEFINED in chatFastFederation — see the note
 *  there on why the dependency runs one way only. */
export { containsChatOp } from '$indexer/chatFastFederation';
