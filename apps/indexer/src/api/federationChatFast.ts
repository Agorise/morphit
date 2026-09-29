/**
 * Morphit indexer — POST /v1/federation/chat-fast
 *
 *   body: { "trx": <signed Blurt transaction carrying ONE morphit_chat_v1 op> }
 *      or { "trxs": [ …up to BATCH_MAX of them… ] }  (a peer batches when it
 *      already has a push in flight to us)
 *
 * A peer instance hands us a chat message directly, so the two people talking
 * do not have to wait for the chain. See `chatFastFederation.ts` for why the
 * chain cannot meet a six-second target and why accepting this is safe.
 *
 * WHAT THIS ENDPOINT WILL AND WILL NOT DO
 *
 *   It will: verify the transaction's signature against the sender's posting
 *   key from OUR OWN database, apply the same block check and safe-subset gate
 *   the head tailer applies, and emit on the same event bus.
 *
 *   It will not: write any MESSAGE state. The durable poller remains the sole
 *   writer of chat, orders, keys and everything derived from the chain, so the
 *   worst a bad push can do is produce a live event no durable row ever backs —
 *   which is exactly the head tailer's existing contract, not a new risk. That
 *   is checked rather than intended: `fastpath-always-on-smoke` fails if this
 *   file or `chatFastFederation.ts` grows a write, and
 *   `fastpath-writes-nothing.test.ts` photographs every table around a real
 *   push against a real database.
 *
 *   THE ONE EXCEPTION, stated (v1.18.0 review, R4): when the notify gate
 *   passes and the recipient has a push subscription, delivery enqueues the web
 *   push — one `push_pending` row, keyed on the transaction id under a unique
 *   index, so a message is enqueued once however many routes deliver it. This
 *   header used to say "write anything" without the exception, and the test
 *   above never reached it; it now asserts that `push_pending` is the only
 *   table touched, and by one row.
 *
 * ANYONE CAN CALL IT, and that is fine, because it is not authorisation that
 * makes it safe. A caller must present a transaction signed by the sender's
 * posting key; without that key nothing can be injected, whoever they are and
 * wherever they connect from. Rate limiting is here to bound cost, not to
 * establish trust.
 *
 * ALWAYS ANSWERS 202 ON ACCEPTANCE, never a body worth mining. A peer learns
 * whether we took the message, and nothing about who is connected to us — the
 * reply is identical whether or not the recipient is on this instance, so this
 * endpoint cannot be used to ask "is @alice reading her mail here?"
 */

import { Hono } from 'hono';
import { errorBody } from '$api/shared';
import { rateLimit } from '$api/middleware/ratelimit';
import { fastChatNotifyAllowed } from '$indexer/fastNotifyGate';
import { enqueueChatPush } from '$indexer/chatPushEnqueue';
import {
	verifyPushedChatOp,
	structuralCheckChatOp,
	deliverVerifiedPush,
	postingKeyLookupFromDb,
	recentBadSignature,
	replayTableFullCount,
	replayQuotaRefusedCount,
	BATCH_MAX,
	type CanonicalChatTrx,
	type PostingKeyRefresher,
	type FastDeliveryGates,
	type FastFederationDb
} from '$indexer/chatFastFederation';
import type { LocatedChatOp } from '$indexer/headTailer';

/**
 * Per-IP ceiling — and a warning about how little it means HERE.
 *
 * On a hidden-service instance this limiter cannot tell peers apart. Tor and
 * I2P deliver every inbound request through the local daemon, so nginx sees
 * `127.0.0.1` and sets `X-Real-IP: 127.0.0.1`, and every peer in the federation
 * — along with every human user, on a zero-clearnet instance where all traffic
 * arrives that way — lands in ONE bucket. Measured, not assumed: at the previous
 * value of 240 the 241st push in a minute was refused no matter how many
 * distinct instances sent them.
 *
 * So the number is set where it will not throttle a real federation, and the
 * actual protection is elsewhere: the response path now does no cryptography at
 * all, and the work behind it is bounded by a fixed-size queue that sheds rather
 * than piles up. A ceiling this high still stops an absurd flood from filling
 * memory with parsed JSON, which is all a per-IP limit can honestly do here.
 *
 * IT MUST BE ITS OWN TIER, and that is not a stylistic choice. The limiter keys
 * buckets by `tier:ip`, NOT by `tier:ip:limit`, so two middlewares sharing a tier
 * share one timestamp array while each checks it against its own ceiling — the
 * lower ceiling then throttles both. On the `resource` tier (600/min, where
 * /v1/broadcast lives) a mere 600 peer pushes a minute would 429 every user write
 * on this instance: no chat, no orders, no transfers. Over Tor that is 10
 * requests a second from anyone at all, because every caller is 127.0.0.1.
 * Measured on the real middleware, not reasoned about. See the `federation` tier
 * in api/middleware/ratelimit.ts.
 */
const PUSHES_PER_MIN = 6_000;

/**
 * The CEILING on how many transactions may be waiting to be verified.
 *
 * SHEDDING IS THE CORRECT FAILURE. Every one of these messages is also on its
 * way through the chain, which delivers it durably regardless. So an overloaded
 * instance quietly degrades to the ordinary chain path — slower, never wrong —
 * instead of queueing work it cannot finish in time or falling over trying.
 *
 * This number used to be the whole rule, and the rule it was trying to express
 * was a TIME: "past this depth the instance is already behind, and anything
 * added would arrive long after the six seconds that make the fast path worth
 * having." That is the right rule. A fixed count does not implement it, because
 * the depth at which a message misses six seconds depends on what a
 * verification costs on THIS box, and that varies by an order of magnitude
 * between a dedicated server and a small VPS running Postgres in Docker.
 *
 * Measured against a real database: 5.75 ms per verification here, so 500 deep
 * is a 2.9 s wait — comfortably inside. At 10 ms it is 5.0 s and at 20 ms it is
 * 10 s, and in both of those the instance ACCEPTS a message (202, the peer
 * counts it delivered) that it then cannot deliver in time. That is strictly
 * worse than shedding it: a shed message travels by chain and nobody ever
 * claimed otherwise, whereas an accepted late one is the silent degradation
 * this feature keeps being audited for.
 *
 * So the live bound is {@link admissionDepth}, derived from the measured cost.
 * This constant remains as the hard ceiling — memory is finite regardless of
 * how fast the box is — and as the value the bound collapses to on a machine
 * fast enough that the budget stops being the binding constraint.
 */
export const VERIFY_QUEUE_MAX = 500;

/**
 * The delivery bar, in its own words: "regardless of which, or which kind of
 * instance you are on, legit chats need to be under 6 seconds, sending and
 * receiving."
 */
const DELIVERY_BUDGET_MS = 6_000;

/**
 * What the rest of the journey already spends, worst case, MEASURED: privacy
 * instance to privacy instance, first contact to the recipient's inbox, across
 * three hidden hops — ~1,367 ms (fastchat-instance-matrix-smoke). Rounded up.
 *
 * The queue wait is a term INSIDE that journey rather than a separate
 * allowance, so what is left for it is the budget minus the path.
 */
const TRANSPORT_WORST_CASE_MS = 1_400;

/**
 * How long a message may sit in this queue and still make the promise.
 *
 * EXPORTED so the tests assert against the shipped value rather than a copy of
 * it. Both the smoke and the integration suite originally hard-coded
 * `6_000 - 1_400`, and changing `TRANSPORT_WORST_CASE_MS` here left them
 * asserting a budget this module no longer used — green, and no longer testing
 * anything that ships. That is the duplicated-decision failure this release
 * keeps finding in other people's code, introduced into it by the round that
 * wrote the fix.
 */
export const QUEUE_WAIT_ALLOWANCE_MS = DELIVERY_BUDGET_MS - TRANSPORT_WORST_CASE_MS;

/**
 * The worst case the transport path is allowed to be, exported for the one
 * check that can falsify it: the instance-matrix smoke MEASURES the real
 * worst-case journey (privacy to privacy, first contact to inbox) and this must
 * not be below it, or the queue allowance is borrowing time the path already
 * spends.
 */
export const TRANSPORT_WORST_CASE_BUDGET_MS = TRANSPORT_WORST_CASE_MS;

/**
 * The floor the derived bound will not go below.
 *
 * On a box slow enough that even this many cannot drain in time, the arithmetic
 * says shed everything — and that is very nearly right, but not quite: a fast
 * path that sheds 100% of what it is offered is indistinguishable, from the
 * outside, from one that is switched off, and it would get there from a single
 * pathological measurement spike. One batch stays admissible so the path keeps
 * working and the collapse is VISIBLE in the diagnostics instead, where
 * `admissionDepth` sitting at the floor is the signal that this box cannot keep
 * the promise and its operator needs to know.
 */
const ADMISSION_FLOOR = BATCH_MAX;

/**
 * Smoothing for the cost estimate. Deliberately slow: the cost of one
 * verification is noisy (a GC pause, a slow pg round trip) and the bound should
 * follow the machine's sustained speed, not flinch at a single outlier.
 */
const COST_EWMA_ALPHA = 0.1;

/**
 * Seed for the estimate, so the first batch after a restart is admitted against
 * something rather than against zero.
 *
 * PESSIMISTIC ON PURPOSE, and it did not start that way. The first version
 * seeded the measured figure from a fast box with a local database (5.75 ms),
 * which is optimistic for most hardware — and an optimistic seed is the
 * dangerous direction. Under-estimate the cost and the instance admits a queue
 * deeper than it can drain, accepting messages it will deliver late; over-
 * estimate it and the instance admits a shallower one, shedding messages the
 * chain then carries. One of those breaks the promise silently and the other
 * keeps it.
 *
 * Caught by the intake test on a run where the box happened to be loaded: at a
 * true 9.88 ms the seeded estimate left the derived depth over budget for the
 * first hundred-odd verifications, which is exactly the window after a restart
 * when a backlog is most likely to arrive.
 *
 * So it starts at the slow end of plausible hardware — a small VPS with
 * Postgres in a container — and relaxes DOWNWARD as the box proves itself,
 * reaching a fast machine's true cost inside a few dozen messages. Every point
 * on that path errs toward shedding.
 */
const INITIAL_VERIFY_COST_MS = 20;

/**
 * The admission bound for a given per-verification cost. PURE, and exported,
 * for a reason worth recording.
 *
 * This arithmetic exists to protect a SLOW box — a small VPS where a
 * verification costs 10-20 ms and a 500-deep queue would blow the six-second
 * promise. No CI machine is that box. When this was first written as a closure
 * over the live estimate, three mutations against it all SURVIVED: on fast
 * hardware the derived depth is the ceiling anyway, so reverting to a flat
 * ceiling, never updating the estimate, and deleting the floor were each
 * indistinguishable from correct. The tests were exercising the one branch
 * where the fix does nothing.
 *
 * Extracting it means the slow-hardware behaviour can be driven directly at
 * costs this machine will never produce, by the same code the instance runs
 * rather than by a copy of the formula in a test — which is the difference
 * between asserting behaviour and asserting a definition.
 */
export function admissionDepthFor(verifyCostMs: number): number {
	const derived = Math.floor(QUEUE_WAIT_ALLOWANCE_MS / Math.max(verifyCostMs, 0.1));
	return Math.min(VERIFY_QUEUE_MAX, Math.max(ADMISSION_FLOOR, derived));
}

/**
 * Let the event loop run between verifications.
 *
 * Verification is ~4.4 ms of synchronous CPU each, and a batch of it back to
 * back would stall everything else the instance owes somebody — including the
 * SSE streams this whole mechanism exists to feed. An `await` on an
 * already-resolved promise does NOT prevent that: it drains the microtask queue
 * without ever reaching the I/O phase, so timers and sockets still wait.
 * `setImmediate` reaches the check phase, which is what lets them run.
 *
 * MEASURED CAVEAT, so nobody removes this thinking it is decoration: with the
 * yield taken out, the loop currently keeps running anyway, because
 * `verifyPushedChatOp` does `await import('@beblurt/dblurt')` on every call and
 * Node's ESM loader happens to settle that on a macrotask. That is an accident
 * of how the import is written, not a property anyone should depend on — hoist
 * that import to module scope as an obvious optimisation and the accidental
 * yield disappears with it. The harness proves the point by doing exactly that:
 * cache the import AND remove this line, and the instance goes deaf.
 */
const yieldToEventLoop = (): Promise<void> =>
	new Promise<void>((r) => {
		setImmediate(r);
	});

/**
 * How many messages may wait on a chain read at once, OFF the queue.
 *
 * A message whose sender's key needs the chain (unconfirmed row, a durable
 * record far behind, or a signature that did not match the key on file) is not
 * verified by the worker — the worker never waits on the network — but handed
 * to a side pass that makes the read and delivers if it verifies. Bounded,
 * because the side pass is reachable by anyone able to name an account: past
 * the bound the message is refused here and goes by chain, slower and whole.
 * The refresh budget in chatFastFederation (30 a minute, one per account per ten
 * minutes) is the tighter bound in practice; this one caps memory and sockets.
 */
export const KEY_RETRY_MAX_IN_FLIGHT = 16;

/**
 * The longest a side-pass message holds its slot. The chain read itself is not
 * cancelled — it finishes in the background and its answer is cached for the
 * next message from that sender — but a message still waiting after this long
 * has been beaten to the recipient by the chain's own delivery, so the slot is
 * worth more to the next one.
 */
export const KEY_RETRY_DEADLINE_MS = 15_000;

/**
 * How many queued entries a claimed signer with a recent `bad_signature` may
 * hold (v1.18.0 deep-deep, rv1-4). One: enough that a real sender whose name
 * was abused is not locked out completely, small enough that junk in that name
 * costs the worker next to nothing.
 */
export const QUEUE_PER_SUSPECT_SIGNER_MAX = 1;

/** One entry waiting for the worker. */
interface QueuedPush {
	readonly trx: CanonicalChatTrx;
	/** CLAIMED, not verified — the queue exists to verify it. */
	readonly signer: string;
	/** When it reached us: the clock the notify gate judges it by (rv1-6). */
	readonly arrivedAt: Date;
}

export interface GateOptions {
	/**
	 * Charge a first-contact notification against the recipient's budget.
	 *
	 * True only for messages arriving from a PEER, which is the one route where
	 * a message reached us without costing its sender anything. A message we
	 * relayed ourselves went to the chain and paid resource credits for the
	 * privilege, and one the head tailer read came out of a block, so both are
	 * already metered — charging them again would throttle legitimate traffic to
	 * pay for a hole they are not part of. See fastNotifyBudget.ts.
	 */
	readonly meterFirstContact?: boolean;
}

/** Build the gates from the database — the same predicates the head tailer
 *  uses, through the same shared functions in chatGates. */
export function gatesFromDb(db: FastFederationDb, opts: GateOptions = {}): FastDeliveryGates {
	return {
		async recipientBlockedSender(recipient: string, sender: string): Promise<boolean> {
			// Byte-for-byte the head tailer's query. The fast path must admit a
			// SUBSET of durable admission, and two differently-worded block
			// checks is how a subset quietly becomes a superset.
			const r = await db.query<{ exists: boolean }>(
				`SELECT EXISTS (
				   SELECT 1 FROM blocks
				    WHERE blocker = $1 AND blocked = $2 AND state = 'blocked'
				 ) AS exists`,
				[recipient, sender]
			);
			return r.rows[0]?.exists === true;
		},

		async fastNotifyAllowed(located: LocatedChatOp, at: Date): Promise<boolean> {
			// THE SAME FUNCTION the head tailer calls (v1.18.0 deep-deep, rv1-2).
			// This used to be a copy, and both copies let the "recent outbound"
			// shortcut answer before the order tag was validated. A first-contact
			// stranger with no order tag never passes, so a push notification
			// cannot become a spam vector — while DELIVERY to an open chatroom is
			// unconditional, because a message you are looking at is not a
			// notification. `at` is the ARRIVAL time (rv1-6).
			return fastChatNotifyAllowed(db, located, at, {
				...(opts.meterFirstContact === true ? { meterFirstContact: true } : {})
			});
		},

		async enqueuePush(located: LocatedChatOp, trxId: string, createdAt: Date): Promise<void> {
			await enqueueChatPush(db, {
				recipient: located.recipient,
				sender: located.signer,
				orderPermlink: located.orderPermlink,
				sourceTrxId: trxId,
				eventAt: createdAt
			});
		}
	};
}

/** The mounted route plus a window into its intake queue. Returned together
 *  because an operator cannot tell "fast chat is working" from "fast chat gave
 *  up and everyone is back on chain timing" without seeing the shed count. */
export interface FederationChatFastIntake {
	readonly app: Hono;
	stats(): {
		queueDepth: number;
		verified: number;
		refused: number;
		shed: number;
		/** Rolling per-verification cost on this box, ms. The thing the
		 *  admission bound is derived from, exposed so an operator can see WHY
		 *  their instance is shedding rather than only that it is. */
		verifyCostMs: number;
		/** The live admission bound. Below VERIFY_QUEUE_MAX means this box is
		 *  slow enough that the six-second promise, not memory, is the binding
		 *  constraint; sitting at the floor means it cannot keep the promise at
		 *  all and everything beyond one batch is going by chain. */
		admissionDepth: number;
		/**
		 * Pushes refused to protect the replay memory.
		 *
		 * Non-zero means the replay table was full of entries still inside the
		 * window they exist to protect, so pushes were declined rather than
		 * forgetting one. That is either someone deliberately flooding to flush
		 * the table — the attack the rule exists to stop — or an instance far
		 * busier than the table is sized for. Both are worth seeing, and neither
		 * is visible from a delivery count.
		 */
		replayTableFull: number;
		/** Pushes refused because their signer already held its whole share of
		 *  the replay memory (rv1-4). Non-zero is one account pushing far more
		 *  than any person types — a flood aimed at the table, contained to
		 *  that account. */
		replayQuota: number;
	};
}

export function federationChatFastRoute(
	db: FastFederationDb,
	refreshPostingKey?: PostingKeyRefresher,
	options: {
		/** See `postingKeyLookupFromDb` — false while the durable poller is too
		 *  far behind the chain to vouch for a stored key. */
		durableIsCurrent?: () => boolean;
	} = {}
): FederationChatFastIntake {
	const app = new Hono();
	// The refresher is optional so this route can be constructed without a chain
	// client (the smokes do exactly that). Without it, a rotated key simply
	// behaves as it did before: the message falls back to the chain path.
	const lookupPostingKey = postingKeyLookupFromDb(db, refreshPostingKey, {
		...(options.durableIsCurrent !== undefined
			? { durableIsCurrent: options.durableIsCurrent }
			: {})
	});
	// meterFirstContact: this is the peer route, the one where a message
	// arrived without costing its sender a thing. See GateOptions.
	const gates = gatesFromDb(db, { meterFirstContact: true });

	// Transactions accepted but not yet verified. One worker drains it, yielding
	// between each so a burst never monopolises the process.
	//
	// Each entry carries its CLAIMED signer (not yet verified — that is what the
	// queue is for) and when it arrived, which is the clock the notify gate
	// judges it by (rv1-6).
	const queue: QueuedPush[] = [];
	/** Queued entries per claimed signer, kept in step with `queue`. */
	const queuedPerSigner = new Map<string, number>();
	const countOf = (signer: string): number => queuedPerSigner.get(signer) ?? 0;
	const bump = (signer: string, by: number): void => {
		const n = countOf(signer) + by;
		if (n <= 0) queuedPerSigner.delete(signer);
		else queuedPerSigner.set(signer, n);
	};
	/** Remove the entry at `i`, keeping the per-signer counts true. */
	const dropAt = (i: number): void => {
		const [gone] = queue.splice(i, 1);
		if (gone !== undefined) bump(gone.signer, -1);
	};
	let working = false;
	let shed = 0;
	let verified = 0;
	let refused = 0;
	/** Messages currently waiting on a chain read in the side pass. */
	let keyRetries = 0;

	/**
	 * Verify one message WITH the network, off the queue. See
	 * KEY_RETRY_MAX_IN_FLIGHT. Never throws; always releases its slot.
	 */
	function verifyOffQueue(trx: unknown, arrivedAt: Date): void {
		if (keyRetries >= KEY_RETRY_MAX_IN_FLIGHT) {
			refused++;
			return;
		}
		keyRetries++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<'late'>((r) => {
			timer = setTimeout(() => r('late'), KEY_RETRY_DEADLINE_MS);
			timer.unref?.();
		});
		void (async () => {
			try {
				const verdict = await Promise.race([
					verifyPushedChatOp({ trx }, lookupPostingKey),
					deadline
				]);
				if (verdict === 'late') {
					refused++;
					return;
				}
				if (verdict.ok) {
					verified++;
					// sentAt orders the transcript; the gate is judged at arrival
					// (rv1-6).
					await deliverVerifiedPush(
						verdict.located,
						verdict.trxId,
						gates,
						verdict.sentAt,
						arrivedAt
					).catch(() => undefined);
				} else if (verdict.code !== 'duplicate') {
					refused++;
				}
			} catch {
				refused++;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				keyRetries--;
			}
		})();
	}

	/**
	 * Rolling estimate of what one verification costs on this box, in ms.
	 * Updated from the worker below on every attempt — including failures, which
	 * cost real time too and would otherwise make a struggling instance look
	 * faster than it is.
	 */
	let verifyCostMs = INITIAL_VERIFY_COST_MS;

	/**
	 * How deep the queue may go right now and still deliver inside six seconds.
	 *
	 * This is the admission rule the fixed ceiling was always trying to express.
	 * Derived rather than configured, because the operator cannot know what a
	 * verification costs on their hardware and should not have to: the instance
	 * measures it and adjusts. Bounded above by {@link VERIFY_QUEUE_MAX} (memory
	 * is finite however fast the box) and below by {@link ADMISSION_FLOOR} (a
	 * path that sheds everything is indistinguishable from one that is off).
	 */
	const admissionDepth = (): number => admissionDepthFor(verifyCostMs);

	/**
	 * With the queue full, which queued entry should make room for one from
	 * `signer`? The index to drop, or -1 to shed the newcomer instead (rv1-4).
	 *
	 *   1. The newest entry of a recently bad-signed name — unless the newcomer
	 *      is one itself. Those names have already shown junk under them.
	 *   2. Otherwise the newest entry of the claimed signer holding the MOST of
	 *      the queue, if that is strictly more than the newcomer would then
	 *      hold. So one name's flood is the only thing its flood can displace,
	 *      and a sender holding little is never pushed out by one holding a lot.
	 *
	 * Newest, not oldest: the oldest is nearest delivery and has waited
	 * longest; the newest has waited least and loses least by going by chain.
	 * O(queue) at most, and only when the queue is already full.
	 *
	 * THE RESIDUAL LIMIT, stated rather than implied. The signer here is
	 * CLAIMED: nothing distinguishes junk that names @alice from @alice's own
	 * message until the signature is checked, and over Tor every caller is
	 * 127.0.0.1, so there is no source to be fair between. This rule therefore
	 * confines a flood to the NAME it uses — @alice's own fast delivery may
	 * suffer while junk in her name arrives, nobody else's does. A flood that
	 * spreads one entry each across hundreds of real names has no heaviest
	 * signer and none yet marked bad, so it can still fill the queue; the
	 * instance then sheds as it always has and every message still arrives by
	 * chain, slower and never wrong. Documented in OPERATIONS.md, "When
	 * someone floods fast chat".
	 */
	function pickShedVictim(signer: string, newcomerSuspect: boolean): number {
		if (!newcomerSuspect) {
			for (let i = queue.length - 1; i >= 0; i--) {
				const q = queue[i];
				if (q !== undefined && q.signer !== signer && recentBadSignature(q.signer)) return i;
			}
		}
		let heaviest = '';
		let most = 0;
		for (const [name, n] of queuedPerSigner) {
			if (n > most) {
				most = n;
				heaviest = name;
			}
		}
		if (most <= countOf(signer) + 1) return -1;
		for (let i = queue.length - 1; i >= 0; i--) if (queue[i]?.signer === heaviest) return i;
		return -1;
	}

	async function work(): Promise<void> {
		if (working) return;
		working = true;
		try {
			while (queue.length > 0) {
				const entry = queue.shift();
				if (entry === undefined) break;
				bump(entry.signer, -1);
				const trx = entry.trx;
				// THE TRY GOES INSIDE THE LOOP, and that placement is the whole
				// point. `verifyPushedChatOp` awaits a database read for the
				// sender's posting key, so any transient pg failure — a reset
				// connection, an exhausted pool, a failover — rejects. Wrapped
				// around the loop instead, one such blip would unwind it and
				// abandon every transaction still queued, with nothing scheduled
				// to come back for them: the fast path would go quiet until the
				// next inbound push happened to restart the worker, while the
				// orphans went on occupying the queue until it was permanently
				// full and shedding everything. One failure must cost one
				// message.
				// Timed around the WHOLE attempt, including the posting-key read
				// and the delivery, because all of it is time the next message in
				// the queue spends waiting. Timing only the signature recovery
				// would flatter a box whose database is the slow part, which is
				// exactly the box this estimate exists to protect.
				// performance.now(), not Date.now(): a wall-clock step backwards
				// made this sample negative, and a negative estimate reads as an
				// infinitely fast box that may admit the full ceiling.
				const startedAt = performance.now();
				try {
					// network:false — THE WORKER NEVER WAITS ON THE CHAIN. A message
					// that needs a chain read goes to the side pass instead, so one
					// slow RPC call cannot hold every message behind it (R3).
					const verdict = await verifyPushedChatOp({ trx }, lookupPostingKey, undefined, {
						network: false
					});
					if (!verdict.ok && verdict.code === 'key_refresh_pending') {
						verifyOffQueue(trx, entry.arrivedAt);
					} else if (verdict.ok) {
						verified++;
						// DISPLAY in the SENDER's time, read off the signed
						// transaction (see PushVerdict.sentAt) — but GATE on ours at
						// arrival: sentAt is sender-chosen and may sit six minutes in
						// the past, which moved the order-liveness check (rv1-6).
						await deliverVerifiedPush(
							verdict.located,
							verdict.trxId,
							gates,
							verdict.sentAt,
							entry.arrivedAt
						).catch(() => undefined);
					} else if (verdict.code !== 'duplicate') {
						refused++;
					}
				} catch {
					// Counted, not swallowed silently: a rising `refused` with no
					// corresponding peer complaint is how an operator sees that
					// something local is failing. The message is not lost — the
					// chain is still carrying it.
					refused++;
				}
				verifyCostMs =
					COST_EWMA_ALPHA * Math.max(0, performance.now() - startedAt) +
					(1 - COST_EWMA_ALPHA) * verifyCostMs;
				await yieldToEventLoop();
			}
		} finally {
			working = false;
		}
	}

	app.post('/', rateLimit('federation', PUSHES_PER_MIN), async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json(errorBody('bad_request', 'invalid JSON body'), 400);
		}

		// One transaction, or a batch of them. A peer batches when messages arrive
		// while it already has a push in flight to us — see PeerSender — so a
		// busy federation costs us one request per round trip instead of one per
		// message. Both shapes are part of this endpoint's contract from its
		// first release, so there is no older peer that can only speak one.
		// `JSON.parse('null')` succeeds and gives null, and reading `.trx` off it
		// throws — which Hono turns into a 500. A peer sending a malformed body
		// should hear "your request is wrong", not "this instance is broken";
		// the second sends them hunting for a fault that is theirs.
		const body: { trx?: unknown; trxs?: unknown } =
			typeof json === 'object' && json !== null ? (json as { trx?: unknown; trxs?: unknown }) : {};
		const single = body.trx;
		const many = body.trxs;
		let batch: unknown[];
		if (Array.isArray(many)) {
			if (many.length === 0) return c.json(errorBody('bad_request', 'empty batch'), 400);
			// Bounded: each entry costs a signature recovery, so an unbounded
			// array would be a cheap way to make us do expensive work.
			if (many.length > BATCH_MAX) {
				return c.json(errorBody('bad_request', 'batch too large'), 400);
			}
			batch = many;
		} else {
			batch = [single];
		}

		// CHEAP checks only, and a bad entry NEVER discards the good ones beside
		// it. A batch is an accident of timing, not a unit of trust: the
		// transactions in it are unrelated, separately signed, and usually from
		// different senders, so one being malformed says nothing about the rest.
		let queued = 0;
		let rejected = 0;
		// Per-REQUEST, deliberately separate from the lifetime `shed` counter that
		// feeds stats(). The verdict below asks "did we shed anything in THIS
		// batch"; asking the lifetime counter instead means that once the instance
		// has ever shed a single message, it answers 202 to an all-rubbish batch
		// forever and the peer never learns it is sending garbage.
		let shedHere = 0;
		// THE STRUCTURAL CHECK COMES FIRST, and stays first, even though shedding
		// without parsing would be marginally cheaper.
		//
		// Reordering these was tried and reverted, because it quietly changes what
		// this endpoint SAYS. The 400 below means "nothing in your batch was
		// usable" — the one answer that tells a peer with a broken serializer to
		// fix itself. Shed first and a rubbish batch arriving while the queue is
		// full is counted as shed rather than rejected, so the peer is told 202 and
		// never learns, with the failure showing up only when the instance is
		// under load. An instance cannot honestly report "your batch was garbage"
		// without having looked at it.
		//
		// The saving was small in any case: the per-entry parse is bounded by
		// BATCH_MAX (64 small payloads), and the request body as a whole was
		// already parsed above — bounded by the body cap — before this loop runs.
		for (const trx of batch) {
			// Per ENTRY, inside a try: the check is written to be total, but a
			// throw here would turn one malformed entry into a 500 for the whole
			// batch and drop the good entries beside it — the exact contract
			// stated above. It did exactly that for `op: null` until v1.18.0's
			// review.
			let structural: ReturnType<typeof structuralCheckChatOp>;
			try {
				structural = structuralCheckChatOp(trx);
			} catch {
				rejected++;
				continue;
			}
			if (!structural.ok) {
				rejected++;
				continue;
			}
			const signer = structural.located.signer;
			const suspect = recentBadSignature(signer);
			// A name whose pushes recently failed signature verification gets a
			// token share of the queue (rv1-4): junk in one name is paid for by
			// that name, not by everyone queued behind it.
			if (suspect && countOf(signer) >= QUEUE_PER_SUSPECT_SIGNER_MAX) {
				shed++;
				shedHere++;
				continue;
			}
			if (queue.length >= admissionDepth()) {
				// Already further behind than the six seconds this path exists to
				// meet — measured on this box rather than assumed, so a slow
				// machine sheds sooner and a fast one carries more. The chain
				// still carries this message, so dropping it costs delivery speed
				// and nothing else.
				//
				// BUT WHOSE MESSAGE IS DROPPED is the whole question (v1.18.0
				// deep-deep, rv1-4). This was a single FIFO that shed the
				// newcomer, so anyone could keep it full — 16 requests a second of
				// junk in one name, well inside the rate limit and indistinguishable
				// by source over Tor — and every real sender was shed. Now a full
				// queue sheds from the sender holding the most of it, or from a
				// recently bad-signed name, before it sheds a sender holding less.
				const victim = pickShedVictim(signer, suspect);
				if (victim < 0) {
					shed++;
					shedHere++;
					continue;
				}
				dropAt(victim);
				shed++;
			}
			// The REBUILT transaction, not the peer's object: only validated
			// primitives are held while the entry waits, whatever else the peer
			// attached to it. See CanonicalChatTrx.
			queue.push({ trx: structural.canonical, signer, arrivedAt: new Date() });
			bump(signer, 1);
			queued++;
		}

		// Nothing usable in the whole batch is the peer's problem to hear about.
		// Shedding is NOT that: the peer did nothing wrong and retrying would only
		// add to the backlog, so an overloaded instance still answers 202.
		if (queued === 0 && shedHere === 0 && rejected > 0) {
			return c.json(errorBody('bad_request', `no acceptable transactions (${rejected})`), 400);
		}

		// Verification and delivery happen AFTER this answer, never before it.
		// Signature recovery is ~4.4 ms each; doing it here would put a batch's
		// worth of CPU inside the sender's round trip, and — worse — would make
		// this instance take measurably longer over a message it cared about than
		// one it did not, which is a timing oracle for "is @alice reading her mail
		// here?" The uniform 202 would then be undermined by the clock.
		void work();

		return c.json({ status: 'accepted' }, 202);
	});

	return {
		app,
		stats: () => ({
			queueDepth: queue.length,
			verified,
			refused,
			shed,
			verifyCostMs,
			admissionDepth: admissionDepth(),
			replayTableFull: replayTableFullCount(),
			replayQuota: replayQuotaRefusedCount()
		})
	};
}
