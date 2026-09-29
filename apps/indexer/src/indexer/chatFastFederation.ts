/**
 * chatFastFederation — deliver a chat message to the other person's instance
 * directly, instead of making them wait for the chain.
 *
 * THE PROBLEM, IN NUMBERS
 * Two people on two different zero-clearnet instances could not chat usefully,
 * and no amount of faster RPC nodes was going to fix it, because the delay was
 * not RPC latency. Adding up the real constants in this tree:
 *
 *   browser → instance A            one hidden round trip
 *   A → chain                       `broadcast_transaction_synchronous` BLOCKS
 *                                   until the transaction is in a block, and
 *                                   the Blurt block interval is 3,000 ms
 *   chain → instance B              the head tailer polls every 2,000 ms, then
 *                                   spends a hidden RPC read fetching the block
 *   B → browser                     one hidden round trip
 *
 * Five seconds of pure waiting before a single tunnel round trip is counted,
 * and three of those round trips to pay for. A six-second target was not
 * reachable that way, ever.
 *
 * THE FIX
 * Take the chain off the delivery path. When instance A accepts a signed chat
 * op from its own browser, it pushes that op straight to the federation's
 * instances at the same time as it broadcasts it to the chain. The chain
 * remains the durable record and the only thing ever written to the database;
 * it simply stops being the thing two people are waiting on.
 *
 * WHY THIS IS NOT A TRUST HOLE
 *
 *  1. THE PUSH IS VERIFIED. What travels is the signed transaction the
 *     browser already produced. The receiving instance recovers the public key
 *     from the signature over the transaction digest and checks it against the
 *     sender's `posting_pubkey`. A CONFIRMED key on file is used offline, with
 *     no network call on the critical path; an unconfirmed one (a pre-v1.18.0
 *     row, a rotation read from a block, a poller far behind) or a signature
 *     that does not match is checked against the chain through a quorum of RPC
 *     operators, OFF the intake queue, under a budget (postingKeyLookupFromDb).
 *     Forging a message requires the sender's posting key — the same bar the
 *     chain itself sets.
 *
 *  2. IT CHANGES NOTHING DURABLE. The fast path writes no message state — not
 *     chat, not orders, not receipts, not keys. It emits to
 *     `chatEventBus.emitFast`, exactly as the head tailer does, and the durable
 *     poller remains the sole writer of history once the block is irreversible.
 *     The ONE write, stated (v1.18.0 review, R4): when the notify gate passes
 *     and the recipient has a push subscription, one `push_pending` row, keyed
 *     on the transaction id under a unique index. The worst a bad push can achieve is an SSE event
 *     that no durable row ever backs — which the client already handles,
 *     because that is the head tailer's existing contract.
 *
 *     THIS IS LOAD-BEARING, NOT A BOAST. It is why a reorg costs nothing here,
 *     why the operator's off switch could be removed (ADR-0051), and why every
 *     "the worst case is a wasted round trip" argument in ADR-0052 holds. A
 *     remediation once added a single well-meaning `UPDATE` to this module to
 *     correct a stale posting key, and voided all of that without anyone
 *     noticing. `fastpath-always-on-smoke` now greps THIS FILE and the intake
 *     route as well as the head tailer, so the next such line fails a test.
 *
 *  3. IT LEAKS NOTHING NEW. `morphit_chat_v1` is a public `custom_json` on a
 *     public chain: the sender/recipient pair is already visible to anyone. The
 *     body stays end-to-end encrypted. Fanning out to peers reveals to them
 *     only what the chain publishes to everyone a few seconds later.
 *
 *  4. IT ADMITS A SUBSET. The same block check and the same safe-subset gate
 *     the head tailer applies are applied here, through the same functions.
 *
 * WHY FAN-OUT RATHER THAN A LOOKUP
 * Accounts are not bound to instances — anyone can read their chat from any
 * instance, which is the point of the federation. There is no "which instance
 * is Bob on" to query. So the op goes to every known instance, each of which
 * emits it only if someone there is actually listening for that conversation.
 * A federation of a few dozen instances makes that a few dozen small POSTs on
 * already-warm connections.
 */

import { Buffer } from 'node:buffer';
import type pg from 'pg';

import { chatEventBus } from '$indexer/chatEventBus';
import { markFastEmitted, wasFastEmitted } from '$indexer/fastEmitLedger';
import {
	locateChatOp,
	clientTagFromHeader,
	CHAT_OP_ID,
	type LocatedChatOp
} from '$indexer/headTailer';
import { postJsonViaHiddenService } from '$indexer/hiddenServicePool';
import { hiddenOriginForDial } from '$indexer/hiddenOriginForDial';
import { primaryPostingKey } from '$indexer/postingKeyBackfill';
import { clearnetRefused } from '@morphit/hidden-transport/router';
import type {
	HiddenServiceProxyConfig,
	HiddenNetwork,
	LocalFaultConfidence
} from '@morphit/hidden-transport';
import {
	hiddenNetworkOf,
	hiddenHostNetworkOf,
	isProxyUnavailable,
	localFaultConfidence,
	lokinetEnabled
} from '@morphit/hidden-transport';

/** The read surface this module needs — the same minimal shape chatGates uses,
 *  so it composes with the indexer's Database wrapper and with a test double
 *  without either having to pretend to be a full pg.Pool. */
export interface FastFederationDb {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
}

/** The wire shape a peer pushes. Just the signed transaction — everything else
 *  is derived from it, so there is no second copy of anything to disagree. */
export interface ChatFastPush {
	readonly trx: unknown;
}

export type PushVerdict =
	| {
			readonly ok: true;
			readonly located: LocatedChatOp;
			readonly trxId: string;
			/**
			 * When the SENDER made this message, not when we received it.
			 *
			 * Derived from the transaction's own expiry, which the client sets a
			 * fixed interval ahead of the chain head it read. It matters because
			 * the two delivery routes would otherwise stamp their events from
			 * different clocks: the head tailer uses the block timestamp, and a
			 * receiver's wall clock at arrival is a different number. The client
			 * sorts a transcript strictly by this field, so two consecutive
			 * messages that happened to arrive by different routes could render
			 * in the wrong order — and a replayed message stamped "now" always
			 * lands past the reader's cursor, which is exactly what a replay
			 * wants. Reading it off the signed bytes makes it the sender's fact
			 * rather than the receiver's.
			 */
			readonly sentAt: Date;
	  }
	| { readonly ok: false; readonly code: PushRejectCode; readonly message: string };

export type PushRejectCode =
	| 'malformed'
	| 'not_a_chat_op'
	| 'too_many_ops'
	| 'expired'
	| 'unknown_sender'
	| 'bad_signature'
	| 'duplicate'
	/**
	 * The replay memory is full of entries still inside the window they exist to
	 * protect, so this push is refused rather than forgetting one of them. A
	 * capacity condition, not a fault in the message — see `rememberSeen`.
	 */
	| 'replay_table_full'
	/**
	 * This SIGNER already holds its whole share of the replay memory (v1.18.0
	 * deep-deep, rv1-4). Refused so that one account's pushes — which it can
	 * mint offline for free — can never occupy the space every other sender
	 * needs. See `SEEN_PER_SIGNER_MAX`.
	 */
	| 'replay_quota'
	/**
	 * Verifying this needs a read of the CHAIN (the stored key is unconfirmed,
	 * the durable record is too far behind to vouch for it, or the signature
	 * did not match the key on file), and the caller asked for no network on
	 * this pass. The intake worker then verifies it again OFF the queue, so one
	 * slow RPC call can never hold up every other message behind it. See
	 * `federationChatFastRoute`.
	 */
	| 'key_refresh_pending';

/**
 * A transaction may carry several operations. The fast path accepts exactly one
 * chat op and nothing else, so a pushed transaction cannot smuggle an unrelated
 * operation past the checks by riding alongside a valid chat message.
 */
const MAX_OPS = 1;

/**
 * How stale a pushed transaction may be. A chat op's `expiration` is minutes
 * out, and the whole point here is that delivery happens in seconds, so
 * anything old is either a replay or so late that the chain has already
 * delivered it. Generous enough to absorb clock skew between instances.
 */
export const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * How far in the FUTURE a pushed transaction's expiry may sit — the other side
 * of the staleness bound, and the one that decides how long a captured message
 * stays replayable.
 *
 * Graphene permits an expiration up to an hour out. Without this bound, a
 * transaction captured off the wire would stay pushable for that whole hour,
 * against a replay memory that only remembers ten minutes — so an attacker could
 * simply wait out the memory and re-push. Morphit's own client sets expiry to
 * head + 60 s (apps/web/src/lib/blurt/sign.ts), so three minutes is generous for
 * it while keeping the total replay window (future bound + staleness grace = 8
 * minutes) comfortably inside SEEN_TTL_MS. The margin is for clock skew between
 * instances, nothing else.
 */
export const MAX_FUTURE_MS = 3 * 60 * 1000;

/**
 * How many signatures one pushed transaction may carry, and how long each may
 * be.
 *
 * Each signature costs a full elliptic-curve key recovery — measured at 2.5-4.4
 * ms depending on the box — and the recovery loop runs to completion without
 * yielding. Unbounded, a single request inside the body cap fits dozens of
 * canonical-but-wrong signatures, and every one of them is recovered before the
 * transaction is refused: tens of milliseconds of uninterrupted CPU per request,
 * from an attacker who needs no key and no valid message, aimed at the event loop
 * that serves the SSE streams this whole mechanism exists to feed.
 *
 * A Morphit chat op has exactly one `required_posting_auth` and therefore one
 * signature, and the recovery loop stops at the first match, so a cap of two
 * costs nothing real. The length cap matches /v1/broadcast's own schema.
 */
const MAX_SIGNATURES = 2;
const MAX_SIGNATURE_CHARS = 200;

/**
 * The longest chat-op `json` the fast path will carry (v1.18.0 deep-deep,
 * rv1-1).
 *
 * WHAT WAS WRONG. Nothing bounded it. /v1/broadcast handed any transaction
 * with a chat op to the sender queue for every peer before the chain had
 * looked at it, so one 120 KB junk request was forty 120 KB POSTs, each too
 * big to share a batch, each a full hidden round trip — and ten of them were
 * enough to push a real message seconds behind.
 *
 * The largest real payload is a 1,536-char ciphertext plus a header capped at
 * 4,096 bytes (which carries the 1,536-char self-copy) plus a recipient and a
 * 256-char order tag: about six kilobytes. 8,192 is the chain's own
 * custom-operation data cap on this Graphene lineage, so nothing larger could
 * ever be durable anyway, and a fast path that refuses it admits a subset.
 */
export const MAX_CHAT_JSON_CHARS = 8_192;

/** Seen transaction ids, so a replayed push cannot re-emit a message. Bounded:
 *  this is attacker-facing and must not grow without limit.
 *
 *  SEEN_MAX is sized against the replay window above, not against ordinary
 *  traffic. An attacker signs transactions of their own for free, so a small
 *  table can be flushed deliberately to make room for a replay of somebody
 *  else's captured message; the table has to outlast the window in which such a
 *  replay would still be accepted. Fifty thousand entries is a few megabytes and
 *  takes minutes of sustained maximum-rate pushing to turn over. */
const seen = new Map<string, { readonly at: number; readonly signer: string }>();
export const SEEN_TTL_MS = 10 * 60 * 1000;
const SEEN_MAX_DEFAULT = 50_000;
let SEEN_MAX = SEEN_MAX_DEFAULT;

/**
 * The most replay-memory entries ONE SIGNER may hold at once (v1.18.0
 * deep-deep, rv1-4).
 *
 * WHAT WAS WRONG. F21 made the table refuse rather than forget, which closed
 * the replay hole and opened a lockout: one cheap account mints validly signed
 * pushes offline (never broadcast, so they cost nothing), fills the table with
 * entries that are all still protected, and every OTHER sender is then refused
 * `replay_table_full` until they age out — eight minutes after the attacker
 * stops. The table did not care whose entries it held.
 *
 * Now it does. A signer at its quota is refused (`replay_quota`) and its extra
 * pushes never take space from anyone else; they go by chain, like every other
 * capacity refusal on this path. 250 is far above any human's rate — it is a
 * message every two seconds, sustained, for the whole eight-minute window —
 * and it means filling the 50,000-entry table now takes 200 distinct accounts,
 * each of which costs an account-creation fee, instead of one.
 *
 * Independent of SEEN_MAX on purpose: the smokes shrink the table to exercise
 * its full behaviour, and the quota must not silently shrink with it and turn
 * a table-full test into a quota test.
 */
const SEEN_PER_SIGNER_MAX_DEFAULT = 250;
let SEEN_PER_SIGNER_MAX = SEEN_PER_SIGNER_MAX_DEFAULT;
/** Live entries per signer, kept in step with `seen`. */
const seenPerSigner = new Map<string, number>();

function forgetSeen(trxId: string): void {
	const entry = seen.get(trxId);
	if (entry === undefined) return;
	seen.delete(trxId);
	const n = (seenPerSigner.get(entry.signer) ?? 1) - 1;
	if (n <= 0) seenPerSigner.delete(entry.signer);
	else seenPerSigner.set(entry.signer, n);
}

/** Pushes refused because their signer already held its whole share. */
let replayQuotaRefused = 0;

/** How many pushes have been refused by the per-signer replay quota. */
export function replayQuotaRefusedCount(): number {
	return replayQuotaRefused;
}

/**
 * How long an entry MUST be kept for the replay guarantee to mean anything.
 *
 * A captured transaction stays pushable for at most `MAX_FUTURE_MS` (how far
 * ahead its expiry may sit) plus `MAX_AGE_MS` (how far past expiry we still
 * accept it). Forget its id inside that span and the replay it was remembered
 * to prevent goes through. Past it, the transaction is expired on its own
 * terms and the entry is free to go.
 *
 * Derived rather than chosen, because it is the exact horizon: the two bounds
 * that define it are right above.
 */
const REPLAY_PROTECTED_MS = MAX_FUTURE_MS + MAX_AGE_MS;

/** Pushes refused because the replay memory was full of protected entries.
 *  Surfaced in the intake stats: it is either an attack or an instance far
 *  busier than this table is sized for, and both are worth seeing. */
let replayTableFull = 0;

/** How many pushes have been refused to protect the replay memory. */
export function replayTableFullCount(): number {
	return replayTableFull;
}

/**
 * Returns false for a duplicate, `'full'` when the table cannot take the entry
 * without breaking its own guarantee, true when remembered.
 *
 * TAKES THE CALLER'S CLOCK. It used to read `Date.now()` itself while the
 * expiry checks a few lines up used the injectable `now`, so one decision was
 * being made against two clocks. They agree in production, where `now` is
 * always the wall clock, and they do not agree in a test — which made the
 * table's recovery after the protection horizon impossible to exercise, and
 * that is precisely the branch worth exercising. One clock, threaded through.
 *
 * THE EVICTION RULE IS THE SECURITY PROPERTY. This used to evict the oldest
 * entry whenever the table was full, which quietly converts "remembered for
 * ten minutes" into "remembered until 50,000 other things happen" — and an
 * attacker signs transactions of their own for free, so they control how fast
 * those other things happen.
 *
 * MEASURED, not theorised: at the ~5.75 ms per verification this box manages,
 * 50,000 entries turn over in 288 s, comfortably inside the 480 s a captured
 * push stays valid. The attack is to capture a push, flood the instance with
 * your own signed pushes for five minutes, and send the captured one again —
 * demonstrated end to end against this code with the table shrunk to 8, which
 * is the same mechanism at a scale that fits in a test. Note the inversion: the
 * FASTER the box, the sooner the table turns over, so the better the hardware
 * the wider the hole.
 *
 * Raising `SEEN_MAX` does not fix it, it moves it — the required size depends on
 * hardware nobody can predict, and at 2 ms a verification it would need a
 * quarter of a million entries. So the table refuses instead: an entry still
 * inside `REPLAY_PROTECTED_MS` is never evicted, and a push that would require
 * evicting one is declined. That degrades to chain delivery, which is exactly
 * what every other capacity limit on this path does, and it is correct at any
 * hardware speed and any attack rate because there is no arithmetic left to get
 * wrong.
 */
function rememberSeen(
	trxId: string,
	nowMs: number = Date.now(),
	/** Who signed it — the key the per-signer quota is kept on (rv1-4). */
	signer = ''
): boolean | 'full' | 'quota' {
	const now = nowMs;
	for (const [k, e] of seen) {
		if (now - e.at > SEEN_TTL_MS) forgetSeen(k);
		else break; // Map preserves insertion order; the rest are newer.
	}
	if (seen.has(trxId)) return false;
	// THE SIGNER'S SHARE FIRST (v1.18.0 deep-deep, rv1-4). A signer at its
	// quota is refused before it can reach the table-wide rule below, so its
	// own entries are the only thing its flood can ever displace — which is
	// nothing, since protected entries are never evicted. See
	// SEEN_PER_SIGNER_MAX.
	if ((seenPerSigner.get(signer) ?? 0) >= SEEN_PER_SIGNER_MAX) {
		replayQuotaRefused++;
		return 'quota';
	}
	if (seen.size >= SEEN_MAX) {
		const oldestKey = seen.keys().next().value;
		const oldest = oldestKey === undefined ? undefined : seen.get(oldestKey);
		if (oldestKey === undefined || oldest === undefined) return 'full';
		if (now - oldest.at < REPLAY_PROTECTED_MS) {
			// Even the oldest entry is still protecting against a replay that
			// would currently be accepted. Refusing costs this message its fast
			// path; forgetting would cost the guarantee.
			replayTableFull++;
			return 'full';
		}
		forgetSeen(oldestKey);
	}
	seen.set(trxId, { at: now, signer });
	seenPerSigner.set(signer, (seenPerSigner.get(signer) ?? 0) + 1);
	return true;
}

/** Test seam — reset the replay memory between cases. */
export function _resetSeenForTest(): void {
	seen.clear();
	seenPerSigner.clear();
	replayTableFull = 0;
	replayQuotaRefused = 0;
	SEEN_MAX = SEEN_MAX_DEFAULT;
	SEEN_PER_SIGNER_MAX = SEEN_PER_SIGNER_MAX_DEFAULT;
	badSignatureAt.clear();
}

/** Test seam — shrink the per-signer replay quota. `_resetSeenForTest`
 *  restores it. */
export function _setSeenPerSignerMaxForTest(n: number): void {
	SEEN_PER_SIGNER_MAX = n;
}

/**
 * Signers whose pushes recently failed signature verification, and when
 * (v1.18.0 deep-deep, rv1-4).
 *
 * A junk signature costs its sender nothing and costs us a key recovery, and
 * the name it claims is the only handle we have on it before that cost is
 * paid. The intake uses this to give a claimed signer with a recent
 * `bad_signature` a much smaller share of the verification queue, so a flood in
 * one name is paid for mostly by that name. Bounded and short-lived: it is a
 * priority hint, never a verdict — a real sender whose name was abused is
 * served normally again once the flood stops.
 */
const badSignatureAt = new Map<string, number>();
export const BAD_SIGNATURE_MEMORY_MS = 10 * 60 * 1000;
const BAD_SIGNATURE_TRACK_MAX = 5_000;

function noteBadSignature(signer: string, now: number): void {
	badSignatureAt.delete(signer);
	badSignatureAt.set(signer, now);
	while (badSignatureAt.size > BAD_SIGNATURE_TRACK_MAX) {
		const oldest = badSignatureAt.keys().next().value;
		if (oldest === undefined) break;
		badSignatureAt.delete(oldest);
	}
}

/** Has a push claiming this signer failed signature verification recently? */
export function recentBadSignature(signer: string, now: number = Date.now()): boolean {
	const at = badSignatureAt.get(signer);
	if (at === undefined) return false;
	if (now - at > BAD_SIGNATURE_MEMORY_MS) {
		badSignatureAt.delete(signer);
		return false;
	}
	return true;
}

/**
 * Test seam — shrink the replay memory so its FULL behaviour can be exercised.
 *
 * The eviction rule only does anything once the table is full, and filling the
 * real one means 50,000 signature verifications: about five minutes of CPU,
 * which is not a test anybody will run. Shrinking it exercises the identical
 * code path at a scale that fits in a smoke — the same technique the keep-alive
 * cliff is demonstrated with.
 *
 * `_resetSeenForTest` puts it back, so a test that forgets to restore cannot
 * leak a tiny replay memory into the next one.
 */
export function _setSeenMaxForTest(n: number): void {
	SEEN_MAX = n;
}

/** Look up a sender's posting authority from our OWN database. This is what
 *  makes verification free: the indexer already tracks posting keys.
 *
 *  `network: false` asks for an answer WITHOUT a chain read: where one would be
 *  needed and would be allowed, the lookup throws {@link KeyRefreshPending}
 *  instead of making it. Where one would be needed but the refresh budget
 *  would refuse it, the answer is simply null, exactly as with the network. */
export interface PostingKeyLookup {
	(
		account: string,
		opts?: {
			refresh?: boolean;
			network?: boolean;
			/**
			 * Does this message's signature recover to `key`? Supplied by the
			 * verifier so the lookup can tell WHICH refresh budget a chain read
			 * should be charged to (v1.18.0 deep-deep, rv1-3): a stored key the
			 * signature matches is a question only the key's holder can raise,
			 * while a mismatch is something anyone can produce for free. Absent
			 * means "unknown", which is charged as a mismatch.
			 */
			signedBy?: (key: string) => boolean;
		}
	): Promise<string | null>;
}

/**
 * How far the durable poller may trail the chain HEAD before a stored posting
 * key stops vouching for itself (v1.18.0 review, D6).
 *
 * The poller reads irreversible blocks, so in normal running it trails the head
 * by the irreversibility lag — about fifteen to twenty blocks on Blurt, under a
 * minute. Two hundred blocks is ten minutes: far outside normal running, well
 * inside any real catch-up after downtime, which is when a key rotated during
 * the gap is still missing from the column.
 */
export const DURABLE_TRUST_MAX_LAG_BLOCKS = 200;

/** The same bound as wall time: Blurt makes a block every three seconds. */
export const DURABLE_TRUST_MAX_LAG_MS = DURABLE_TRUST_MAX_LAG_BLOCKS * 3_000;

/** What {@link durableIsCurrentFor} reads off the poller's status. */
export interface DurableProgress {
	readonly running: boolean;
	readonly chainHeadBlock: number;
	readonly indexedBlock: number;
	/** Wall time the chain head was last read. Absent: not tracked (the head,
	 *  when non-zero, is taken as fresh). Null: never read. */
	readonly chainHeadSeenAt?: Date | null;
	/** Block time of the last block the poller committed; null until one is. */
	readonly indexedBlockTime?: Date | null;
}

/**
 * Is the durable record current enough for a stored posting key to vouch for
 * itself? (D6, completed in v1.18.0 deep-deep, rv2-7.)
 *
 * WHAT WAS WRONG. The wiring answered TRUE whenever the chain head was unknown
 * (`chainHeadBlock` 0), on the theory that this was only the boot window and
 * the per-row confirmation flag covered it. It covers only rows never
 * confirmed. A node that was down for days and boots with its RPC unreachable —
 * a cold Tor start on a hidden-only node is the ordinary case — sat at "head
 * unknown" for the whole outage, and a row confirmed BEFORE the downtime was
 * trusted as it stood: a key the owner rotated away from during the gap kept
 * verifying, with no chain check at all.
 *
 * Now an unknown head is not evidence of anything. With a head read recently,
 * the lag is measured in blocks as before. Without one — never read, or read
 * so long ago that the number itself is stale — the record vouches for itself
 * only if the last block it committed is itself recent, by the same bound
 * expressed as time. Otherwise the chain is asked, under the refresh budget,
 * and no answer means chain delivery.
 */
export function durableIsCurrentFor(st: DurableProgress, now: number = Date.now()): boolean {
	const seen = st.chainHeadSeenAt;
	const headFresh =
		st.running &&
		st.chainHeadBlock > 0 &&
		(seen === undefined || (seen !== null && now - seen.getTime() <= DURABLE_TRUST_MAX_LAG_MS));
	if (headFresh) return st.chainHeadBlock - st.indexedBlock <= DURABLE_TRUST_MAX_LAG_BLOCKS;
	const t = st.indexedBlockTime;
	return t !== undefined && t !== null && now - t.getTime() <= DURABLE_TRUST_MAX_LAG_MS;
}

/** The quorum read the chain refresher needs. BlurtClient satisfies it. */
export interface AgreedAccountReader {
	getAccountsAgreed(
		names: readonly string[],
		agreeOn: (account: Parameters<typeof primaryPostingKey>[0] | undefined) => string
	): Promise<ReadonlyMap<string, Parameters<typeof primaryPostingKey>[0]> | null>;
}

/**
 * The fast path's chain re-read of one posting key, through a QUORUM
 * (v1.18.0 deep-deep, rv2-3).
 *
 * WHAT WAS WRONG. main.ts wired this as `blurt.getAccounts`: ONE endpoint,
 * whichever the pool ranked first. It runs for every unconfirmed row, while
 * the poller lags, and after any signature that fails to verify — and its
 * answer is cached for thirty minutes AHEAD of the column. So anyone running a
 * single endpoint in this node's pool could answer with their own key and have
 * their own-signed messages accepted as coming from any account, confirmed
 * rows included. D1 moved the reconcile onto a quorum for exactly this reason;
 * the fast path's read was left behind.
 *
 * Now two independent endpoints must agree on the account's signing key (the
 * same agreement the reconcile uses: a node that does not know the account
 * disagrees rather than abstains). No agreement answers null — "no fast
 * verdict" — and the message goes by chain delivery.
 */
export function chainPostingKeyRefresher(blurt: AgreedAccountReader): PostingKeyRefresher {
	return async (account: string): Promise<string | null> => {
		const agreed = await blurt.getAccountsAgreed([account], (acc) =>
			acc === undefined ? '∅ unknown account' : (primaryPostingKey(acc) ?? '∅ no single key')
		);
		if (agreed === null) return null;
		const acc = agreed.get(account);
		return acc === undefined ? null : primaryPostingKey(acc);
	};
}

/**
 * Thrown by a `network: false` lookup that needs the chain to answer.
 *
 * WHY THIS EXISTS (v1.18.0 review, R3). The intake has ONE worker, and it used
 * to await the chain read inline: `getAccounts` through the RPC pool, a
 * ten-second timeout per endpoint, tried one after another. One unconfirmed
 * sender — every sender, for the minutes after an upgrade while the reconcile
 * runs — or one junk signature naming a real account held the whole queue for
 * that long, while the route kept answering 202 and admitting up to 500 more
 * messages it then delivered late. The worker now verifies without the network
 * and hands anything that needs it to a bounded side pass.
 */
export class KeyRefreshPending extends Error {
	constructor(readonly account: string) {
		super(`posting key for @${account} needs a chain read`);
		this.name = 'KeyRefreshPending';
	}
}

/** Re-read one account's posting key from the CHAIN (main.ts wires
 *  `chainPostingKeyRefresher`, a quorum read). Injected so tests drive key
 *  rotation without a node: test/integration/posting-key-rotation.test.ts and
 *  fastchat-abuse-guards-smoke exercise it, its cooldown and its ceilings. */
export interface PostingKeyRefresher {
	(account: string): Promise<string | null>;
}

/** Per-account cooldown on chain refreshes, and a global ceiling on them.
 *
 *  A refresh is triggered by a signature that did NOT match the key on file
 *  (something anybody can produce for free), and by a key that is not
 *  confirmed or a durable record too far behind (see the budgets below).
 *  Without both bounds, "re-check the key" is an instruction to make an RPC
 *  call on demand, for any account name an attacker cares to name — a
 *  reflected load amplifier pointed at whichever node this instance is using. */
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const REFRESH_PER_MIN = 30;
const refreshedAt = new Map<string, number>();
const REFRESH_TRACK_MAX = 5_000;

/**
 * WHICH CEILING a chain read is charged to (v1.18.0 deep-deep, rv1-3).
 *
 * WHAT WAS WRONG. There was one global ceiling of 30 reads a minute, and the
 * cheapest way to spend it was a junk signature: sign with your own key, claim
 * a different real account each time, and every push cost a slot. Thirty such
 * pushes a minute starved every sender who needed the chain for a reason that
 * had nothing to do with a bad signature — every sender after an upgrade while
 * rows are unconfirmed (F37), every sender while the poller lags (D6) — and
 * they all fell back to chain delivery. One request through /v1/broadcast of a
 * peer did it to the whole federation at once.
 *
 *   - `verify`   the stored key is unconfirmed, or the durable record is too
 *                far behind to vouch for it, AND the signature matches that
 *                stored key. Only the key's holder can produce that, so an
 *                attacker cannot spend this budget without a key per account.
 *   - `mismatch` everything else: a signature that does not match the key on
 *                file. Anyone can produce it, so it gets its own ceiling and
 *                can only exhaust itself.
 *
 * Both keep the original per-minute ceiling, so the outbound RPC bound is at
 * most doubled, and the per-account cooldown is shared (a read for an account
 * answers the question whichever budget paid for it; the answer is cached).
 */
export type RefreshBudget = 'verify' | 'mismatch';
const refreshTimes: Record<RefreshBudget, number[]> = { verify: [], mismatch: [] };

/**
 * Chain reads in flight, per account (v1.18.0 deep-deep, rv1-5).
 *
 * WHAT WAS WRONG. The cooldown is stamped when a read STARTS, so for as long as
 * it was running a `network: false` lookup saw "no refresh available" and
 * answered null — `unknown_sender`. An unconfirmed sender's burst (every
 * sender's, after an upgrade) lost every message but the first until the read
 * came back. A lookup that finds a read in flight now says "pending", and the
 * side pass waits on the SAME read instead of being refused.
 */
const refreshInFlight = new Map<string, Promise<string | null>>();

function mayRefresh(account: string, now: number, budget: RefreshBudget): boolean {
	const last = refreshedAt.get(account);
	if (last !== undefined && now - last < REFRESH_COOLDOWN_MS) return false;
	const times = refreshTimes[budget];
	while (times.length > 0 && (times[0] ?? 0) <= now - 60_000) times.shift();
	if (times.length >= REFRESH_PER_MIN) return false;
	times.push(now);
	refreshedAt.delete(account);
	refreshedAt.set(account, now);
	// Bounded: eviction hands somebody back a refresh they had already spent,
	// which costs one RPC call, so the failure is in the harmless direction.
	while (refreshedAt.size > REFRESH_TRACK_MAX) {
		const oldest = refreshedAt.keys().next().value;
		if (oldest === undefined) break;
		refreshedAt.delete(oldest);
	}
	return true;
}

/** Would {@link mayRefresh} allow a refresh right now? Reads the same state and
 *  spends none of it — so the worker can decide whether handing a message to
 *  the side pass is worth anything, without a junk signature costing a slot. */
function refreshAvailable(account: string, now: number, budget: RefreshBudget): boolean {
	const last = refreshedAt.get(account);
	if (last !== undefined && now - last < REFRESH_COOLDOWN_MS) return false;
	let recent = 0;
	for (const t of refreshTimes[budget]) if (t > now - 60_000) recent++;
	return recent < REFRESH_PER_MIN;
}

/** Give back a cooldown slot for an attempt that learned nothing. The global
 *  per-minute entry is deliberately NOT refunded: that one is a cost ceiling on
 *  outbound RPC, and a call we made still cost us whether or not it answered. */
function releaseRefresh(account: string): void {
	refreshedAt.delete(account);
}

/** Test seam — clear the refresh cooldowns between cases. */
export function _resetKeyRefreshForTest(): void {
	refreshedAt.clear();
	refreshTimes.verify.length = 0;
	refreshTimes.mismatch.length = 0;
	refreshInFlight.clear();
	freshKeys.clear();
}

/**
 * Keys re-read from the chain, held IN MEMORY and never written back.
 *
 * THE NOT-WRITING IS THE POINT, and it took a review to see why. The first
 * version of this correction did an `UPDATE accounts SET posting_pubkey`, which
 * is a perfectly ordinary thing to write and quietly broke the premise the whole
 * fast path rests on: ADR-0048's invariant that this path never writes the
 * database. That invariant is not bookkeeping — it is the reason a reorg costs
 * nothing here, the reason the operator's off switch could be removed, and the
 * reason every "the worst case is a wasted round trip" argument in ADR-0052
 * holds. Breaking it in a helper nobody would think to look at is exactly how an
 * invariant dies.
 *
 * It was also a security regression on its own terms. `posting_pubkey` was
 * write-once, so a hostile or compromised RPC node could poison it only at first
 * observation; persisting a re-read let one poison it ON DEMAND, for any account,
 * by answering a single `getAccounts`. Holding the correction in memory means a
 * bad answer expires instead of becoming the record.
 *
 * Bounded like everything else on this path, and deliberately shorter-lived than
 * it could be: this is a patch over a stale cache, not ownership of it.
 *
 * The durable indexer now DOES keep `accounts.posting_pubkey` current — it
 * records `account_update` ops — so this cache covers only the gap between a
 * rotation reaching the chain head and reaching the irreversible block the
 * poller reads, about a minute. It is invalidated per account when the durable
 * record catches up (`forgetFreshKey`), because a correction older than the
 * column must never outrank it.
 */
const freshKeys = new Map<string, { key: string; at: number }>();
const FRESH_KEY_TTL_MS = 30 * 60 * 1000;
const FRESH_KEY_MAX = 5_000;

function rememberFreshKey(account: string, key: string, now: number): void {
	freshKeys.delete(account);
	freshKeys.set(account, { key, at: now });
	while (freshKeys.size > FRESH_KEY_MAX) {
		const oldest = freshKeys.keys().next().value;
		if (oldest === undefined) break;
		freshKeys.delete(oldest);
	}
}

/**
 * Drop a cached correction because the DURABLE record has moved past it.
 *
 * Called by the dispatcher whenever it records an `account_update` that changes
 * a posting key. Without this the cache would be consulted AHEAD of a column
 * that is now more current than it — and the case where that matters most is
 * the one key rotation exists for: an owner rotating AWAY from a stolen key.
 * Rotate A→B, the fast path caches B; rotate B→C because B leaked, and for up to
 * `FRESH_KEY_TTL_MS` the cached B would still verify, ahead of the C the
 * durable indexer had already recorded. Forgetting the entry lets the column
 * win the moment it is right.
 *
 * Touches memory only — the fast path still writes nothing (ADR-0048 #1).
 */
export function forgetFreshKey(account: string): void {
	freshKeys.delete(account);
}

function freshKeyFor(account: string, now: number): string | null {
	const hit = freshKeys.get(account);
	if (hit === undefined) return null;
	if (now - hit.at > FRESH_KEY_TTL_MS) {
		freshKeys.delete(account);
		return null;
	}
	return hit.key;
}

/**
 * Look up a sender's posting key, normally from our own database.
 *
 * WHY THE `refresh` PATH EXISTS. `accounts.posting_pubkey` is the ONLY thing
 * standing between a pushed transaction and a message rendered as
 * authentically from that account, and the column can lag the chain: the
 * dispatcher records rotations only once their block is irreversible (and, since
 * v1.20.0, records them UNCONFIRMED — a block is one RPC endpoint's word), and
 * rows from before v1.18.0 may hold a key their owner rotated away from. So a
 * key that is not confirmed is checked against the chain, and so is a
 * signature that does not match the key on file.
 *
 * So a signature that does not match is treated as a question about the key
 * rather than a verdict about the message, and the chain is asked once — under a
 * per-account cooldown and a global ceiling, because a failing signature is free
 * to produce and an RPC call is not. The answer is remembered in memory, so the
 * correction outlives the request without outliving the process. See `freshKeys`
 * for why it is emphatically not written back.
 */
export function postingKeyLookupFromDb(
	db: FastFederationDb,
	refreshFromChain?: PostingKeyRefresher,
	options: {
		/**
		 * Is the durable record current enough to vouch for a key? False while
		 * the poller is far behind the chain head — after downtime, while it
		 * catches up — when a key rotated during the gap is not in the column
		 * yet. Then no stored key is trusted on its own and the chain is asked,
		 * exactly as for an unconfirmed row (v1.18.0 review, D6). Absent means
		 * always current (tests that drive the column alone).
		 */
		durableIsCurrent?: () => boolean;
	} = {}
): PostingKeyLookup {
	const refreshKey = async (
		refresher: PostingKeyRefresher,
		account: string,
		network: boolean | undefined,
		budget: RefreshBudget
	): Promise<string | null> => {
		// A read for this account is already running: wait for ITS answer
		// rather than refusing on the cooldown it stamped (rv1-5). The worker
		// never waits, so it hands the message to the side pass, which does.
		const running = refreshInFlight.get(account);
		if (network === false) {
			if (running !== undefined) throw new KeyRefreshPending(account);
			// Peek, do not spend: a refused refresh answers null here exactly
			// as it would with the network, and only one that WOULD run is
			// handed back to be made off the queue.
			if (!refreshAvailable(account, Date.now(), budget)) return null;
			throw new KeyRefreshPending(account);
		}
		if (running !== undefined) return running;
		if (!mayRefresh(account, Date.now(), budget)) return null;
		const read = readFromChain(refresher, account);
		refreshInFlight.set(account, read);
		try {
			return await read;
		} finally {
			refreshInFlight.delete(account);
		}
	};
	const readFromChain = async (
		refresher: PostingKeyRefresher,
		account: string
	): Promise<string | null> => {
		let fresh: string | null = null;
		try {
			fresh = await refresher(account);
		} catch {
			// THE COOLDOWN IS RELEASED ON A TRANSPORT FAILURE, and only there. It exists to stop an attacker
			// turning failed signatures into an RPC amplifier, and a call that
			// never reached the chain has not told us anything to be patient
			// about. Left burned, one RPC hiccup would lock a real account out
			// for ten minutes — and the account most likely to be asked about is
			// one that has just rotated its key, i.e. exactly the person this
			// whole path exists to unbreak.
			releaseRefresh(account);
			return null;
		}
		if (fresh === null || fresh.length === 0) {
			// NOT released. The distinction is between "we learned nothing" and
			// "we learned there is nothing to correct", and only the first
			// deserves another try. The chain answered; it simply has no single
			// posting key for this account. Releasing here was a bug in the fix
			// that added the release: an attacker naming an account whose chain
			// answer is empty got a fresh RPC call for every junk signature,
			// which is the reflected amplifier the cooldown exists to prevent.
			// Asking again in ten minutes is the right cadence for a real
			// account that genuinely has no key on file.
			return null;
		}
		rememberFreshKey(account, fresh, Date.now());
		return fresh;
	};
	const lookup = async (
		account: string,
		opts?: {
			refresh?: boolean;
			network?: boolean;
			signedBy?: (key: string) => boolean;
		}
	): Promise<string | null> => {
		if (opts?.refresh === true && refreshFromChain !== undefined) {
			// An explicit refresh is the verifier's "the signature did not match
			// the key on file": the attacker-reachable budget (rv1-3).
			return refreshKey(refreshFromChain, account, opts.network, 'mismatch');
		}
		// A correction we have already been told about beats the stale column.
		// Checked before the query, so a rotated account is not re-refreshed on
		// every message until its cooldown lets it through again.
		const cached = freshKeyFor(account, Date.now());
		if (cached !== null) return cached;
		const r = await db.query<{ posting_pubkey: string | null; posting_key_reconciled: boolean }>(
			'SELECT posting_pubkey, posting_key_reconciled FROM accounts WHERE name = $1',
			[account]
		);
		const row = r.rows[0];
		if (row === undefined) return null;
		// v1.18.0 (F37) — A KEY NOBODY HAS CONFIRMED IS NOT TRUSTED. Rows written
		// before this release recorded the key once and never again, so an owner
		// who rotated away from a LEAKED key before upgrading still has the leaked
		// key here, and it would verify. Until the boot backfill confirms the row
		// against the chain, ask the chain instead, through the refresh path above
		// with its cooldown and ceiling. No answer means no fast verdict: the
		// message goes by chain delivery, slower, and a leaked key gets nothing.
		// Without a refresher (tests that drive the column alone) the column is
		// what there is, as before.
		// A durable record far behind the chain cannot vouch for a key either:
		// a rotation inside the gap is simply not in it yet. Same answer as an
		// unconfirmed row, for the same reason.
		if (
			refreshFromChain !== undefined &&
			(row.posting_key_reconciled === false || options.durableIsCurrent?.() === false)
		) {
			// Charged to the budget junk cannot reach ONLY when the signature
			// matches the stored key — the ordinary case after an upgrade, and
			// one an attacker needs that key to produce (rv1-3). A mismatch
			// here (a key rotated before the upgrade, or a forgery) competes
			// with every other mismatch instead.
			const stored = row.posting_pubkey;
			const budget: RefreshBudget =
				stored !== null && stored.length > 0 && opts?.signedBy?.(stored) === true
					? 'verify'
					: 'mismatch';
			return refreshKey(refreshFromChain, account, opts?.network, budget);
		}
		return row.posting_pubkey ?? null;
	};
	return lookup;
}

/**
 * Verify a pushed transaction and extract the chat op, using no network at all.
 *
 * The digest is computed the same way the chain computes it, and the public key
 * is RECOVERED from the signature — so this proves the holder of the sender's
 * posting key produced exactly these bytes. Nothing about the peer that
 * forwarded it is trusted.
 */
/**
 * The CHEAP half of verification: shape, operation count, expiry and the chat-op
 * parse. No crypto, no database, no I/O of any kind.
 *
 * Split out because signature recovery costs about 4.4 ms — measured, not
 * assumed — which is far too much to spend on a request's response path when a
 * push may carry dozens of transactions. The receiving endpoint runs this much
 * synchronously so it can still refuse obvious rubbish with a 400, then answers
 * and does the expensive half afterwards.
 *
 * Keeping the expensive half off the response path also closes a timing channel.
 * If the endpoint did more work for a message it cared about than for one it did
 * not, the time it took to answer would quietly reveal whether a given account
 * is reading their mail on this instance — which is exactly what the uniform
 * 202 is there to avoid saying.
 */
/**
 * The chain's own expiration format: `YYYY-MM-DDTHH:MM:SS`, no zone, no
 * fraction. This is what every Morphit client signs (sign.ts slices it that way)
 * and what the chain's serializer expects.
 */
const EXPIRATION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** A chat op body with exactly the four fields the chain serializes. */
interface CanonicalCustomJson {
	readonly required_auths: readonly string[];
	readonly required_posting_auths: readonly string[];
	readonly id: string;
	readonly json: string;
}

/**
 * A pushed transaction REBUILT from validated primitives — the only form the
 * fast path hashes, verifies, remembers and queues.
 *
 * WHY A COPY RATHER THAN THE PEER'S OBJECT (v1.18.0 review, R1). The digest is
 * computed by dblurt's serializer, and the serializer COERCES: it builds the
 * expiry as `new Date(value + 'Z')`, so `["2020-01-01T00:00:00"]` — an array —
 * serializes to exactly the bytes the string would. The expiry bounds only ran
 * when the field was a string, so wrapping it in an array skipped them while the
 * signature, digest and transaction id stayed identical. Any chat message ever
 * written to the chain, signatures included, is public: every one of them could
 * be pushed to any instance as new, forever, with its sentAt stamped "now". The
 * replay window every other part of this file reasons about did not exist.
 *
 * A check on one field would close that one field. Rebuilding the transaction
 * from typed primitives closes the CLASS: nothing the peer sent reaches the
 * serializer except values whose type we checked, so the bytes we hash are the
 * bytes we validated. It also stops the queue holding whatever else the peer
 * attached to its object — 500 queued entries of a 256 KB body each was 128 MB
 * of attacker-chosen memory.
 */
export interface CanonicalChatTrx {
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: readonly [readonly ['custom_json', CanonicalCustomJson]];
	readonly extensions: readonly never[];
	readonly signatures: readonly string[];
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function structuralCheckChatOp(
	trxIn: unknown,
	now: Date = new Date()
):
	| {
			ok: true;
			located: LocatedChatOp;
			signatures: readonly string[];
			/** The transaction rebuilt from validated primitives. Hash, verify
			 *  and queue THIS, never the object the peer sent. */
			canonical: CanonicalChatTrx;
	  }
	| { ok: false; code: PushRejectCode; message: string } {
	const trx = trxIn as
		| {
				operations?: unknown;
				signatures?: unknown;
				expiration?: unknown;
				ref_block_num?: unknown;
				ref_block_prefix?: unknown;
				extensions?: unknown;
		  }
		| undefined;
	if (trx === undefined || trx === null || typeof trx !== 'object' || Array.isArray(trx)) {
		return { ok: false, code: 'malformed', message: 'no transaction' };
	}
	if (!Array.isArray(trx.operations) || trx.operations.length === 0) {
		return { ok: false, code: 'malformed', message: 'no operations' };
	}
	if (trx.operations.length > MAX_OPS) {
		return {
			ok: false,
			code: 'too_many_ops',
			message: `a pushed transaction may carry ${MAX_OPS} operation, got ${trx.operations.length}`
		};
	}
	if (!Array.isArray(trx.signatures) || trx.signatures.length === 0) {
		return { ok: false, code: 'malformed', message: 'no signatures' };
	}
	// Bounded BEFORE anything reaches the recovery loop: this is the whole
	// point of the cap. See MAX_SIGNATURES.
	if (trx.signatures.length > MAX_SIGNATURES) {
		return {
			ok: false,
			code: 'malformed',
			message: `a pushed transaction may carry ${MAX_SIGNATURES} signatures, got ${trx.signatures.length}`
		};
	}
	// THE EXPIRY IS MANDATORY AND MUST BE A STRING IN THE CHAIN'S FORMAT. It used
	// to be checked only `if (typeof trx.expiration === 'string')`, and anything
	// else — an array, above all, which the serializer turns back into the same
	// bytes — skipped both bounds with the signature still valid. See
	// CanonicalChatTrx.
	if (typeof trx.expiration !== 'string' || !EXPIRATION_RE.test(trx.expiration)) {
		return { ok: false, code: 'malformed', message: 'expiration missing or not in chain format' };
	}
	const exp = Date.parse(`${trx.expiration}Z`);
	if (!Number.isFinite(exp)) {
		return { ok: false, code: 'malformed', message: 'expiration is not a real time' };
	}
	if (exp < now.getTime() - MAX_AGE_MS) {
		return { ok: false, code: 'expired', message: 'transaction expired' };
	}
	// A far-future expiry is not a message running early; it is a message
	// that stays replayable for as long as its author chose. See
	// MAX_FUTURE_MS.
	if (exp > now.getTime() + MAX_FUTURE_MS) {
		return {
			ok: false,
			code: 'expired',
			message: 'transaction expires too far in the future'
		};
	}
	// The TaPoS fields and extensions go into the digest too, so they get the
	// same treatment: exact types, or no verdict at all.
	const refNum = trx.ref_block_num;
	const refPrefix = trx.ref_block_prefix;
	if (
		typeof refNum !== 'number' ||
		!Number.isInteger(refNum) ||
		refNum < 0 ||
		refNum > 0xffff ||
		typeof refPrefix !== 'number' ||
		!Number.isInteger(refPrefix) ||
		refPrefix < 0 ||
		refPrefix > 0xffffffff
	) {
		return { ok: false, code: 'malformed', message: 'reference block fields malformed' };
	}
	if (!Array.isArray(trx.extensions) || trx.extensions.length !== 0) {
		return { ok: false, code: 'malformed', message: 'transaction extensions must be empty' };
	}
	// The op itself: a two-element [name, body] pair whose body carries exactly
	// the typed fields the chain serializes. Checked BEFORE the parser, which
	// destructures its argument and would otherwise throw on a non-array — a 500
	// for the whole batch instead of a refusal for one entry.
	const op0: unknown = trx.operations[0];
	if (!Array.isArray(op0) || op0.length !== 2 || op0[0] !== 'custom_json') {
		return { ok: false, code: 'not_a_chat_op', message: 'not a custom_json operation' };
	}
	const rawBody: unknown = op0[1];
	if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
		return { ok: false, code: 'not_a_chat_op', message: 'operation body malformed' };
	}
	const b = rawBody as Record<string, unknown>;
	if (
		!isStringArray(b.required_auths) ||
		!isStringArray(b.required_posting_auths) ||
		typeof b.id !== 'string' ||
		typeof b.json !== 'string'
	) {
		return { ok: false, code: 'not_a_chat_op', message: 'operation fields malformed' };
	}
	// Bounded before it is parsed, queued or sent anywhere. See
	// MAX_CHAT_JSON_CHARS.
	if (b.json.length > MAX_CHAT_JSON_CHARS) {
		return { ok: false, code: 'malformed', message: 'chat payload too large' };
	}
	const body: CanonicalCustomJson = {
		required_auths: [...b.required_auths],
		required_posting_auths: [...b.required_posting_auths],
		id: b.id,
		json: b.json
	};
	const located = locateChatOp(['custom_json', body] as unknown as Parameters<
		typeof locateChatOp
	>[0]);
	if (located === null) {
		return { ok: false, code: 'not_a_chat_op', message: 'not a well-formed chat op' };
	}
	// Handed back narrowed, so the caller that goes on to recover keys does not
	// have to re-assert what this function already established.
	const signatures = trx.signatures.filter(
		(x): x is string => typeof x === 'string' && x.length <= MAX_SIGNATURE_CHARS
	);
	if (signatures.length === 0) {
		return { ok: false, code: 'malformed', message: 'no usable signatures' };
	}
	const canonical: CanonicalChatTrx = {
		ref_block_num: refNum,
		ref_block_prefix: refPrefix,
		expiration: trx.expiration,
		operations: [['custom_json', body]],
		extensions: [],
		signatures
	};
	return { ok: true, located, signatures, canonical };
}

export async function verifyPushedChatOp(
	push: ChatFastPush,
	lookupPostingKey: PostingKeyLookup,
	now: Date = new Date(),
	options: {
		/** False: never wait on the chain. Where a chain read is needed and
		 *  permitted, answer `key_refresh_pending` instead of making it — see
		 *  {@link KeyRefreshPending}. */
		network?: boolean;
		/**
		 * False: check only, record nothing in the replay memory. For the
		 * SENDER's pre-fan-out check (rv1-1), which decides what we send, not
		 * what we deliver: recording there would make this instance's own intake
		 * refuse the message as a duplicate and charge our own users' sends
		 * against the per-signer replay quota. The `trxId` is still returned.
		 */
		remember?: boolean;
	} = {}
): Promise<PushVerdict> {
	const network = options.network;
	const pending = (err: unknown): PushVerdict | null =>
		err instanceof KeyRefreshPending
			? { ok: false, code: 'key_refresh_pending', message: err.message }
			: null;
	const trx = push?.trx as
		| { operations?: unknown; signatures?: unknown; expiration?: unknown }
		| undefined;
	// The cheap checks, through the SAME function the endpoint runs before it
	// answers — one definition of "well-formed", so the two can never disagree
	// about what is worth spending a signature recovery on.
	const structural = structuralCheckChatOp(trx, now);
	if (!structural.ok) return structural;
	// Everything below reads the REBUILT transaction, never the peer's object:
	// the digest, the transaction id and the sender's time all come from values
	// whose types were checked. See CanonicalChatTrx.
	const { located, signatures, canonical } = structural;

	const { cryptoUtils, Signature } = await import('@beblurt/dblurt');
	let digest: Buffer;
	try {
		digest = cryptoUtils.transactionDigest(
			canonical as unknown as Parameters<typeof cryptoUtils.transactionDigest>[0]
		);
	} catch (err) {
		return {
			ok: false,
			code: 'malformed',
			message: `digest failed: ${err instanceof Error ? err.message : String(err)}`
		};
	}

	// Recover LAZILY, once each, and compare against as many candidate keys as
	// we end up with. Recovery is the expensive part (milliseconds); comparing a
	// string to a second string is not, so a key rotation costs no extra
	// cryptography.
	//
	// STOP AT THE FIRST MATCH. Recovery is the expensive part — a measured few
	// milliseconds each — and MAX_SIGNATURES is justified on the basis that
	// recovery stops there. Without that, appending one junk signature to every
	// push doubles this instance's verification cost for free, on the queue
	// whose depth is sized against that cost.
	//
	// Lazy (v1.18.0 deep-deep, rv1-3) because the key lookup now asks it too —
	// "does this signature match the stored key?" decides which refresh budget a
	// chain read is charged to — and an unknown sender must still cost no
	// recovery at all.
	const recovered: string[] = [];
	let nextSig = 0;
	const signedBy = (key: string): boolean => {
		if (recovered.includes(key)) return true;
		while (nextSig < signatures.length) {
			const sigStr = signatures[nextSig++];
			if (sigStr === undefined) continue;
			try {
				const k = Signature.fromString(sigStr).recover(digest).toString();
				recovered.push(k);
				if (k === key) return true;
			} catch {
				// A malformed signature proves nothing; keep looking at the rest.
				continue;
			}
		}
		return false;
	};

	let postingKey: string | null;
	try {
		postingKey = await lookupPostingKey(
			located.signer,
			network === false ? { network: false, signedBy } : { signedBy }
		);
	} catch (err) {
		const p = pending(err);
		if (p !== null) return p;
		throw err;
	}
	if (postingKey === null || postingKey.length === 0) {
		// We have never seen this account. Refuse rather than guess: without the
		// key there is nothing to verify against, and an unverified emit is the
		// one thing this path must not do.
		return {
			ok: false,
			code: 'unknown_sender',
			message: `no posting key on file for @${located.signer}`
		};
	}

	let signedByPostingKey = signedBy(postingKey);

	if (!signedByPostingKey) {
		// The key on file may simply be out of date — see postingKeyLookupFromDb.
		// Asked only on failure, so the common path never pays for it, and bounded
		// there so a stream of bad signatures cannot turn this into an RPC flood.
		let fresh: string | null;
		try {
			fresh = await lookupPostingKey(located.signer, {
				refresh: true,
				...(network === false ? { network: false } : {})
			});
		} catch (err) {
			const p = pending(err);
			if (p !== null) return p;
			fresh = null;
		}
		if (fresh !== null && fresh !== postingKey && recovered.includes(fresh)) {
			signedByPostingKey = true;
		}
	}

	if (!signedByPostingKey) {
		// Remembered as a PRIORITY HINT for the intake queue (rv1-4): the name
		// this junk claimed gets a smaller share of the queue for a while, so a
		// flood in one name is paid for by that name. Never a verdict.
		if (options.remember !== false) noteBadSignature(located.signer, now.getTime());
		return {
			ok: false,
			code: 'bad_signature',
			message: `no signature recovers to @${located.signer}'s posting key`
		};
	}

	// Identify the transaction for replay suppression and for dedup against the
	// chain copy that follows. `generateTrxId` is the same id the chain assigns.
	let trxId: string;
	try {
		trxId = cryptoUtils.generateTrxId(
			canonical as unknown as Parameters<typeof cryptoUtils.generateTrxId>[0]
		);
	} catch {
		// Fall back to the client tag, which the client also dedupes on.
		trxId = `tag:${located.clientTag}`;
	}
	const remembered =
		options.remember === false ? true : rememberSeen(trxId, now.getTime(), located.signer);
	if (remembered === 'quota') {
		return {
			ok: false,
			code: 'replay_quota',
			message: `@${located.signer} holds its whole share of the replay memory; message falls back to chain delivery`
		};
	}
	if (remembered === 'full') {
		return {
			ok: false,
			code: 'replay_table_full',
			message: 'replay memory full of protected entries; message falls back to chain delivery'
		};
	}
	if (!remembered) {
		return { ok: false, code: 'duplicate', message: 'already delivered' };
	}

	return { ok: true, located, trxId, sentAt: sentAtFromExpiry(canonical.expiration, now) };
}

/**
 * The interval the Morphit client puts between the chain head it read and the
 * expiry it signs (apps/web/src/lib/blurt/sign.ts). Subtracting it recovers,
 * near enough, the head-block time the sender was looking at — which is within
 * one block of the timestamp the head tailer would stamp on the same message.
 *
 * WHY THIS IS SAFE ACROSS INSTANCES, which is worth stating because it looks
 * like it should not be. `sentAt` orders the transcript, so a value derived
 * from the SENDER's clock would let two instances with skewed clocks render
 * consecutive messages in the wrong order. It is not derived from a clock: the
 * client builds the expiry from the CHAIN's head block time
 * (`getRefBlockInfo`), and every instance in the federation reads the same
 * chain. Clock skew between operators therefore cannot reorder anything.
 *
 * WHAT IS NOT SAFE is this number drifting from the client's. The two are
 * written in separate packages with nothing linking them, and a change to one
 * alone would shift every fast-path message's `sentAt` by the difference —
 * silently, and only against messages that arrived by the OTHER route, which
 * is the hardest kind of ordering bug to see. `chat-expiry-lead-parity-smoke`
 * exists for exactly that, and asserts the round trip rather than the token.
 */
export const CLIENT_EXPIRY_LEAD_MS = 60_000;

/** Recover the sender's clock from the signed expiry. Falls back to ours when
 *  the field is unusable, and never returns a time in the future: a message
 *  cannot have been sent later than it arrived, and letting one claim otherwise
 *  would park it at the bottom of every transcript it landed in. */
export function sentAtFromExpiry(expiration: unknown, now: Date): Date {
	if (typeof expiration !== 'string') return now;
	const exp = Date.parse(expiration.endsWith('Z') ? expiration : `${expiration}Z`);
	if (!Number.isFinite(exp)) return now;
	const sent = exp - CLIENT_EXPIRY_LEAD_MS;
	return sent > now.getTime() ? now : new Date(sent);
}

/** What the receiving side needs in order to apply the same gates the head
 *  tailer applies. Injected so the smoke can drive it without a database. */
export interface FastDeliveryGates {
	/** Recipient has blocked sender → drop. Fails CLOSED on error. */
	recipientBlockedSender(recipient: string, sender: string): Promise<boolean>;
	/** The safe-subset gate — governs push and snapshot replay, not delivery. */
	/** `at` is the ARRIVAL time, never the sender-chosen `sentAt` (rv1-6). */
	fastNotifyAllowed(located: LocatedChatOp, at: Date): Promise<boolean>;
	/** Enqueue the web push. Only called when the gate allows it. */
	enqueuePush(located: LocatedChatOp, trxId: string, createdAt: Date): Promise<void>;
}

export type DeliveryOutcome = 'emitted' | 'blocked' | 'block_check_failed';

/**
 * Apply a verified push locally: gate it, then emit it on the same bus the head
 * tailer uses, so every existing consumer — the SSE stream, the push enqueue,
 * the replay ring — behaves identically whether the message arrived from a peer
 * or from a block.
 */
export async function deliverVerifiedPush(
	located: LocatedChatOp,
	trxId: string,
	gates: FastDeliveryGates,
	/** DISPLAY time — the sender's, read off the signed expiry. Orders the
	 *  transcript; decides nothing. */
	createdAt: Date = new Date(),
	/**
	 * The time every GATE decision is made against: when the message reached
	 * us (v1.18.0 deep-deep, rv1-6).
	 *
	 * WHAT WAS WRONG. The notify gate was handed `createdAt`, and `createdAt`
	 * on the peer route is `sentAt` — derived from an expiry the SENDER picks.
	 * An expiry as early as `now − MAX_AGE_MS` makes `sentAt` six minutes in
	 * the past, and `checkChatOrder` then judged an order that expired up to
	 * six minutes ago as live: a first-contact notification the durable
	 * handler, which uses the block time, would have put behind the stranger
	 * fee. A sender-chosen clock must never decide admission.
	 */
	gateAt: Date = new Date()
): Promise<DeliveryOutcome> {
	let blocked: boolean;
	try {
		blocked = await gates.recipientBlockedSender(located.recipient, located.signer);
	} catch {
		// Same policy as the head tailer: if we cannot confirm the sender is not
		// blocked, we do not emit. The durable path still delivers later, with
		// its own check.
		return 'block_check_failed';
	}
	if (blocked) return 'blocked';

	// Has this exact transaction already been emitted by ANY route? The head
	// tailer asks the ledger the same question before it emits; this side has to
	// ask it too, because the fast path can reach the same transaction twice by
	// itself. Two peers can both push it, and — on an instance whose registered
	// site origin does not match its indexer origin — the local delivery and this
	// instance's own federation push are both live for the same message. The
	// `seen` map does not cover that: it is written inside verification, and the
	// local-delivery path never goes through verification.
	if (wasFastEmitted(trxId)) return 'emitted';
	// CLAIMED BEFORE THE AWAIT BELOW, not after the emit (v1.18.0 review, R8).
	// The check above and the mark used to straddle `await fastNotifyAllowed`,
	// so a local delivery and a peer's push of the same transaction — the case
	// the comment above names — could both pass the check while the first was
	// still waiting, and both emit. Nothing between here and the emit can stop
	// it: the gate below only decides replay and push, never delivery.
	//
	// A SYNTHETIC ID IS NOT RECORDED. When the transaction id could not be
	// derived, callers fall back to `tag:<client tag>` so the message still has
	// a handle — but the head tailer queries this ledger with the CHAIN's real
	// transaction id, which can never equal that. Writing one here would occupy
	// an entry that nothing can ever match, so it silently fails to suppress the
	// duplicate it was written to suppress. Better to skip the ledger and let
	// the tailer emit a second copy the client already collapses by client tag.
	if (!trxId.startsWith('tag:')) markFastEmitted(trxId);

	const lo = located.signer < located.recipient ? located.signer : located.recipient;
	const hi = located.signer < located.recipient ? located.recipient : located.signer;
	const fastAllowed = await gates.fastNotifyAllowed(located, gateAt).catch(() => false);

	chatEventBus.emitFast({
		lo,
		hi,
		sender: located.signer,
		recipient: located.recipient,
		ciphertext: located.ciphertext,
		header: located.header,
		createdAt,
		clientTag: located.clientTag,
		orderPermlink: located.orderPermlink,
		replayable: fastAllowed
	});

	// The ledger was claimed above, after the block check and before the only
	// await — never on the dropped or could-not-tell paths, so a momentary
	// database failure in the block check still cannot suppress the head
	// tailer's later independent attempt.

	if (fastAllowed) {
		await gates.enqueuePush(located, trxId, createdAt).catch(() => undefined);
	}
	return 'emitted';
}

// ─── Sender side ────────────────────────────────────────────────────────────

/** One dialable address for a peer. */
export interface FastPeerAddress {
	/** Origin to POST to — clearnet or hidden. */
	readonly origin: string;
	/** True when this origin is reached over Tor/I2P/Lokinet. */
	readonly hidden: boolean;
}

/**
 * A federation peer we can push to, and EVERY WAY WE KNOW OF TO REACH IT.
 *
 * An instance is a place, not an address. The same instance may publish a
 * clearnet origin, an onion, an I2P destination and a Lokinet name, and which
 * of those works depends entirely on which daemons are running HERE — a fact
 * the peer knows nothing about and cannot help with.
 *
 * This used to be a single origin, chosen by preferring whatever hidden address
 * the peer had published. That choice was made once, at directory-read time,
 * with no knowledge of local transport, and it DISCARDED everything else the
 * peer had published. The result: an instance without a Tor daemon picked the
 * onion of every onion-publishing peer, threw away the perfectly good clearnet
 * origin sitting in the same row, and failed every push — silently, forever,
 * with chat falling back to chain timing and nothing anywhere saying why.
 *
 * So the peer now carries its addresses in preference order and the choice is
 * made at SEND time, where what this instance can actually reach is known.
 */
export interface FastPeer extends FastPeerAddress {
	/**
	 * Stable identity for queueing, independent of which address is in use.
	 * Defaults to `origin`.
	 *
	 * Load-bearing: the send queue is keyed per peer so that one slow instance
	 * cannot hold up the others. If the key moved when the address did, a peer
	 * that failed over from its onion to its clearnet origin would acquire a
	 * SECOND queue — and the messages still sitting in the first one would
	 * never be sent, because nothing would ever pump a queue whose origin is no
	 * longer in the peer list.
	 */
	readonly key?: string;
	/**
	 * Further addresses for the SAME peer, in preference order, tried when the
	 * preferred one fails because THIS instance cannot reach that network.
	 *
	 * Only on a local transport fault. A peer that answered `500` over Tor has
	 * been reached; dialling its clearnet address would repeat a question that
	 * was already answered, at double the cost.
	 */
	readonly alternates?: readonly FastPeerAddress[];
}

/** Every address for a peer, preferred first. */
export function addressesOf(peer: FastPeer): readonly FastPeerAddress[] {
	const first: FastPeerAddress = { origin: peer.origin, hidden: peer.hidden };
	return peer.alternates === undefined || peer.alternates.length === 0
		? [first]
		: [first, ...peer.alternates];
}

/** The queue key for a peer — its identity, not its current address. */
export function peerKey(peer: FastPeer): string {
	return peer.key ?? peer.origin;
}

/**
 * How long a hidden network stays off the candidate list after OUR end of it
 * proved unusable.
 *
 * Short on purpose. The thing being remembered is local and often transient —
 * a Tor daemon restarting, i2pd still opening tunnels after a reboot, lokinet's
 * tun not yet registered — and re-testing costs almost nothing, because a dead
 * local daemon refuses the connection immediately rather than timing out. The
 * warm-up loop also clears it the moment the network works again, so this is
 * only the ceiling on how long a recovery can go unnoticed if nothing else
 * happens to notice it first.
 */
export const NETWORK_DOWN_MS = 60_000;

/**
 * Networks whose local-fault evidence identifies OUR end of the connection, so
 * that a single failure is enough to take the network off the list. See
 * {@link NetworkReachability.reportAddressFault} for why Lokinet is not one of
 * them and cannot be made one.
 */
const SELF_IDENTIFYING_NETWORKS: ReadonlySet<string> = new Set(['tor', 'i2p']);

/** How many DISTINCT PEERS must fail locally on a network whose evidence does
 *  not name our end, before the failure is read as ours. Two: one is a peer's
 *  record, and a daemon that is actually gone fails every peer it is given, so
 *  the second arrives in the same batch.
 *
 *  PEERS, NOT ADDRESSES (v1.18.0 review, S2). It counted distinct addresses,
 *  and one registration can publish two: an origin `http://a.i2p` and an alt
 *  `i2p_name: b.i2p`. The send path walks a peer's addresses in turn, so one
 *  instance whose names the proxy refused supplied BOTH pieces of evidence in a
 *  single push — and took I2P (or Lokinet) away from every other peer for a
 *  minute, moving any that also publish a clearnet origin onto the clearnet.
 *  That is F11's harm, reopened by the one party F11 said could not cause it. */
const CORROBORATING_PEERS = 2;

/**
 * Which hidden networks this instance has recently failed to use.
 *
 * ONE INSTANCE-WIDE ANSWER, not a per-peer one, because the thing being tracked
 * is not a property of any peer: if our Tor daemon is down it is down for every
 * onion in the federation. Learning it once and applying it to all of them is
 * the difference between one refused connection and one per peer per message.
 *
 * Deliberately NOT persisted. It describes the last minute of local daemon
 * state; carrying it across a restart would mean booting with a stale opinion
 * about the exact thing a restart most often fixes.
 */
export class NetworkReachability {
	private readonly downUntil = new Map<string, number>();
	/** Addresses recently seen to fail locally, per network whose evidence does
	 *  not identify our end. Cleared on success and on a mark-down. */
	private readonly suspect = new Map<string, Map<string, number>>();

	/** Is this network currently off the list? Clearnet never is — there is no
	 *  local daemon for it to be missing. */
	isDown(network: HiddenNetwork, now: number = Date.now()): boolean {
		if (network === null) return false;
		const until = this.downUntil.get(network);
		if (until === undefined) return false;
		if (now >= until) {
			this.downUntil.delete(network);
			return false;
		}
		return true;
	}

	/** Our end of this network just proved unusable.
	 *
	 *  UNCONDITIONAL, and the caller is asserting it has already established
	 *  that the NETWORK is at fault rather than one address on it — which the
	 *  warm-up loop does by requiring every warm-up over the network to have
	 *  failed locally. A caller holding one address's failure wants
	 *  {@link reportAddressFault} instead. */
	markDown(network: HiddenNetwork, now: number = Date.now()): void {
		if (network === null) return;
		this.downUntil.set(network, now + NETWORK_DOWN_MS);
		this.suspect.delete(network);
	}

	/**
	 * ONE address failed locally. Decide whether that is evidence about the
	 * network, and mark it down if it is. Returns whether the network is now
	 * down, so a caller can log the distinction.
	 *
	 * WHY THIS IS NOT SIMPLY `markDown`. Failover and the breaker are one
	 * decision in the send path and two decisions in fact. Moving to the peer's
	 * next address is about THIS message and should happen on any local fault.
	 * Taking the network away from every other peer for a minute is a claim
	 * about our own daemon, and on one of the three networks a single failure
	 * cannot support it.
	 *
	 * On Tor and I2P it can. `makeSocks5Connector` raises `ProxyUnavailableError`
	 * only when the socket to OUR proxy failed or OUR proxy answered the greeting
	 * wrongly — a dead onion takes the other branch and is reported as a plain
	 * error — and the I2P branch of `isLocalTransportFault` matches `address` and
	 * `port` against the proxy we configured. Neither shape is reachable by a
	 * peer publishing a bad address, so one is conclusive.
	 *
	 * On Lokinet the local fault is a DNS miss, and a DNS miss carries THEIR
	 * name. A stale, mistyped or deregistered `.loki` record on one peer produces
	 * exactly the `getaddrinfo ENOTFOUND` our own router being gone produces, and
	 * nothing in the error distinguishes them. Two DISTINCT names failing is the
	 * first point at which our resolver is the better explanation than their
	 * records, so that is where the network goes down — still within the same
	 * batch when the router really is gone, because a dead router fails every
	 * address in it.
	 *
	 * A direct probe of the local daemon was first rejected on the grounds that
	 * the only honest one is resolving a name known to be good, "and we have
	 * none". There is one: lokinet answers `localhost.loki` with this node's own
	 * address, and no peer supplied it. Since v1.18.0 the dispatcher resolves it
	 * at boot and every minute (localTransportLiveness.ts). When it resolves, a
	 * peer's `.loki` miss is not classified as a local fault at all; when it
	 * does not, the fault carries `confidence: 'conclusive'` and convicts on one
	 * address like Tor and I2P. This corroboration rule remains for the window
	 * before the first check, and for a box whose resolver cannot be asked.
	 */
	reportAddressFault(
		network: HiddenNetwork,
		/** WHO the evidence came from: the peer's key, so that one instance's
		 *  several addresses count once (see CORROBORATING_PEERS). */
		addressKey: string,
		now: number = Date.now(),
		confidence?: LocalFaultConfidence
	): boolean {
		if (network === null) return false;
		// The evidence decides, not the network — they do not line up. I2P
		// produces BOTH shapes: a refused connection to our configured proxy
		// address (conclusive, no peer can cause it) and a refused CONNECT,
		// whose status means different things on i2pd and the Java router
		// (ambiguous). A caller that has not classified falls back to what the
		// network alone implies, which is what a blanked config or a test seam
		// gives us.
		const conclusive =
			confidence === undefined
				? SELF_IDENTIFYING_NETWORKS.has(network)
				: confidence === 'conclusive';
		if (conclusive) {
			this.markDown(network, now);
			return true;
		}
		// Already convicted: this address adds nothing until the cooldown lapses,
		// and recording it would put the network in `networksDown` and
		// `networksSuspected` at once — two fields giving contradictory accounts
		// of the same network, which is the confusion the second field was added
		// to remove. A peer on a down network is still DIALLED (the breaker may
		// never silence a peer), so this path is reached on every message to a
		// hidden-only peer for as long as the cooldown lasts.
		if (this.isDown(network, now)) return true;
		const seen = this.suspect.get(network) ?? new Map<string, number>();
		// Drop evidence older than the window it would have justified, so two
		// unrelated typos an hour apart never add up to a verdict.
		for (const [addr, at] of seen) if (now - at >= NETWORK_DOWN_MS) seen.delete(addr);
		seen.set(addressKey, now);
		this.suspect.set(network, seen);
		if (seen.size < CORROBORATING_PEERS) return false;
		this.markDown(network, now);
		return true;
	}

	/** Something just succeeded over this network — clear it immediately rather
	 *  than serving a stale cooldown to the messages arriving behind it. */
	markUp(network: HiddenNetwork): void {
		if (network === null) return;
		this.downUntil.delete(network);
		// The network demonstrably works, so every address we were holding
		// against it is the address's problem, not the router's.
		this.suspect.delete(network);
	}

	/**
	 * Addresses currently held against a network that has not been convicted,
	 * per network, for /v1/health.
	 *
	 * WITHOUT THIS THE RULE IS INVISIBLE. An operator whose lokinet is stopped
	 * and who has exactly one `.loki` peer sees `recentFailures` full of
	 * `localFault: true` and `networksDown: []`, which reads as a contradiction
	 * and is not one — it is the corroboration rule declining to convict on a
	 * single address. Reporting the pending count turns "the health block is
	 * lying to me" into "it is waiting for a second opinion it will never get
	 * here, go look at the daemon".
	 */
	pendingSuspicion(now: number = Date.now()): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [net, seen] of this.suspect) {
			let live = 0;
			for (const at of seen.values()) if (now - at < NETWORK_DOWN_MS) live++;
			if (live > 0) out[net] = live;
		}
		return out;
	}

	/** Networks currently considered down, for /v1/health. An operator staring
	 *  at "peerFailures: 40" needs to be told it is their own Tor. */
	downNetworks(now: number = Date.now()): string[] {
		const out: string[] = [];
		for (const [net, until] of this.downUntil) if (now < until) out.push(net);
		return out.sort();
	}
}

export interface DispatchDeps {
	readonly proxies: HiddenServiceProxyConfig;
	/** Budget for one peer push. Bounded well under the delivery target so a
	 *  slow peer cannot consume it. */
	readonly timeoutMs: number;
	/** Clearnet POST, injected so the smoke can drive it without a network. */
	postClearnet(
		url: string,
		body: unknown,
		timeoutMs: number
	): Promise<{ status: number; body: string }>;
	/**
	 * Hidden-transport POST. Defaults to the real pooled one.
	 *
	 * Injectable for the same reason `postClearnet` is, and for a sharper one:
	 * the three hidden branches are three genuinely different pieces of code — a
	 * hand-written SOCKS5 connector for Tor, undici's `ProxyAgent` for I2P, a
	 * plain agent riding Lokinet's tun — and without a seam here, only the first
	 * was reachable from any test. A branch nothing can drive is a branch whose
	 * behaviour is a matter of opinion, and two of the three networks this
	 * federation is FOR were in that state.
	 *
	 * It is also the only way to exercise the SUCCESS side of a hidden push,
	 * which is what clears a network's down-mark. A test can stand up a failing
	 * hidden transport trivially (point it at a closed port) and a working one
	 * not at all, so without this seam the recovery path could only be argued
	 * for, never shown.
	 */
	postHidden?(
		url: string,
		body: unknown,
		proxies: HiddenServiceProxyConfig,
		timeoutMs: number
	): Promise<{ status: number; body: string }>;
}

/** Why one peer did not take the message. Kept because "failed: 1" is not a
 *  diagnosis: a peer whose circuit timed out and a peer we never tried because
 *  the local Tor daemon is not configured are completely different problems,
 *  and an operator staring at a count cannot tell them apart. */
export interface DispatchFailure {
	readonly origin: string;
	readonly reason: string;
	/** HTTP status, when the peer answered at all. Present so the sender can
	 *  tell a peer that REFUSED THE SIZE (413) from a peer that is broken —
	 *  the first is recoverable by sending less at a time, the second is not. */
	readonly status?: number;
	/**
	 * True when the push never left this machine: our Tor/i2pd/lokinet was
	 * unusable, so the peer was never asked.
	 *
	 * The single most misleading number in this subsystem is a peer failure
	 * count that mixes the two. "40 failures" reads as a federation problem and
	 * sends an operator to look at peers, their firewall, the chain — when the
	 * answer is that `systemctl start tor` was never run on their own box. It
	 * also decides behaviour, not just wording: only a local fault is worth
	 * re-dialling the same peer at a different address for.
	 */
	readonly localFault?: boolean;
	/**
	 * When `localFault`, whether the evidence names OUR end or only the address
	 * that produced it. Decides whether this one failure may take the network
	 * away from every other peer on it — see
	 * {@link NetworkReachability.reportAddressFault}.
	 */
	readonly confidence?: LocalFaultConfidence;
}

/**
 * The most transactions one push may carry.
 *
 * Bounds the receiving side's work per request — it verifies a signature per
 * transaction — and bounds how much is lost if one push fails. Sixty-four at a
 * 1.5-second round trip is roughly forty messages a second to a single peer,
 * which is far more headroom than a federation of a few dozen instances needs.
 */
export const BATCH_MAX = 64;

/**
 * The most BYTES one push may carry — the other half of the bound, and the half
 * that was missing.
 *
 * A count alone is not a bound on a request. Sixty-four maximum-length chat
 * transactions is roughly 240 KB, and an indexer's default body cap is a small
 * number of kilobytes because almost every other endpoint is a read. A batch
 * built to the count alone therefore gets 413'd by a correctly configured peer —
 * and batches form precisely when a peer is already busy, so the fast path would
 * have switched itself off exactly under the load it exists to carry. The
 * receiving side's cap was raised to match (see `bodyCap` and the federation
 * `client_max_body_size` in ops/nginx), and this keeps the SENDER from ever
 * building a request a peer with that cap would refuse.
 *
 * Set below the receiving cap, not equal to it: JSON framing, the `{"trxs":[…]}`
 * wrapper and the commas all land on the wire too, and a peer is entitled to
 * count them.
 */
export const BATCH_MAX_BYTES = 200_000;

/** Wire size of one transaction, near enough to build a batch with. Measured
 *  once per message per peer rather than per batch attempt, because a message
 *  can be weighed once and batched many times. */
function approxJsonBytes(trx: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(trx), 'utf8');
	} catch {
		// Unserialisable: it will fail at send time anyway. Treat it as large so
		// it travels alone and takes nothing else down with it.
		return BATCH_MAX_BYTES;
	}
}

/**
 * PeerSender — one in-flight push per peer, with the messages that arrive
 * meanwhile coalesced into the next one.
 *
 * WHY BATCHING, AND WHY THIS KIND
 *
 * Fan-out means every message goes to every instance, so each instance must
 * ACCEPT the federation's entire message rate. A thousand users sending a
 * message a minute is about seventeen a second. One message per POST over a
 * hidden transport cannot do that: a single connection completes one round trip
 * at a time, so at a 1.5-second round trip it sustains under one message a
 * second. Opening more connections does not rescue it either — seventeen a
 * second would need twenty-five concurrent circuits PER PEER, and a circuit is
 * the expensive thing this whole module exists to avoid building.
 *
 * So the round trip is amortised instead of multiplied. Per-peer throughput
 * becomes batch size divided by round trip rather than one divided by round
 * trip, which is a factor-of-sixty-four difference and scales with the batch
 * rather than with the number of circuits.
 *
 * THE COALESCING IS OPPORTUNISTIC, NOT TIMED. Nothing is ever delayed in the
 * hope that company arrives: an idle peer is pushed to immediately, which is the
 * overwhelmingly common case and the one the six-second target is measured on.
 * A batch forms only from messages that turn up while a push is ALREADY in
 * flight — time they would have spent queued regardless. A timer-based window
 * would have added latency to every message to buy throughput that is only
 * needed under load.
 *
 * The worst latency this adds is therefore one round trip, and only to a message
 * that arrives while the peer is mid-push.
 *
 * PEERS DO NOT QUEUE BEHIND EACH OTHER. The queue is per ORIGIN, so a slow or
 * dead peer holds up only its own stream; every other peer is pushed to at the
 * same time. The recipient may well be behind the slowest peer in the list.
 */
export class PeerSender {
	private readonly queues = new Map<
		string,
		{ peer: FastPeer; pending: { trx: unknown; bytes: number }[]; inFlight: boolean }
	>();

	private delivered = 0;
	private failed = 0;
	private batches = 0;
	private largestBatch = 0;
	private dropped = 0;
	/** Recent failure reasons, bounded. "failed: 3" is not a diagnosis; an
	 *  operator needs to see whether it was a refused proxy, a timeout or an
	 *  HTTP 500, and so does any test asserting the difference. */
	private readonly recentFailures: DispatchFailure[] = [];

	/**
	 * Which hidden networks this instance has recently failed to use.
	 *
	 * Owned here rather than module-scoped: a process-wide singleton would be a
	 * hidden global that every test has to remember to reset, and forgetting
	 * would make one case's dead Tor leak into the next one's — a failure mode
	 * that reads as flakiness rather than as the wiring mistake it is.
	 * Public so the warm-up loop can feed it the failures it sees first.
	 */
	readonly reachability = new NetworkReachability();

	constructor(private readonly deps: DispatchDeps) {}

	/**
	 * Queue one transaction for every peer. Returns immediately: the caller is on
	 * a send path and must never wait for the federation.
	 */
	enqueue(trx: unknown, peers: readonly FastPeer[]): void {
		// Forget instances that have left the directory. Without this the map
		// keeps a queue per origin ever seen, which for a federation is small but
		// unbounded — and an origin that is gone will never drain, so its backlog
		// would sit there for the life of the process. A queue mid-flight is left
		// alone; it removes itself on the next pass.
		if (this.queues.size > peers.length) {
			const live = new Set(peers.map((p) => peerKey(p)));
			for (const [key, q] of this.queues) {
				if (!live.has(key) && !q.inFlight && q.pending.length === 0) {
					this.queues.delete(key);
				}
			}
		}
		// Weighed once, not once per peer: the same object goes to every peer, so
		// serialising it in the loop would cost N stringifies of the same bytes.
		const bytes = approxJsonBytes(trx);
		for (const peer of peers) {
			const key = peerKey(peer);
			let q = this.queues.get(key);
			if (q === undefined) {
				q = { peer, pending: [], inFlight: false };
				this.queues.set(key, q);
			} else {
				// Keep the freshest address list. The directory is re-read every
				// few minutes, and a peer that added or dropped a hidden address
				// in the meantime must not keep being dialled from a list this
				// queue happened to capture the first time it was created.
				q.peer = peer;
			}
			// A peer that has been unreachable long enough to accumulate this much
			// is not coming back inside anyone's six seconds, and holding the
			// backlog only costs memory. Dropping is safe: the chain still carries
			// every one of these messages durably.
			if (q.pending.length >= BATCH_MAX * 4) {
				this.dropped++;
				continue;
			}
			q.pending.push({ trx, bytes });
			if (!q.inFlight) void this.pump(key);
		}
	}

	/** Take the next batch off a queue, bounded by BOTH the count and the byte
	 *  budget. Always takes at least one, so an oversized lone message still
	 *  travels (alone) rather than wedging the queue behind itself forever. */
	private takeBatch(pending: { trx: unknown; bytes: number }[]): unknown[] {
		let n = 0;
		let total = 0;
		while (n < pending.length && n < BATCH_MAX) {
			const next = pending[n];
			if (next === undefined) break;
			if (n > 0 && total + next.bytes > BATCH_MAX_BYTES) break;
			total += next.bytes;
			n++;
		}
		return pending.splice(0, Math.max(1, n)).map((e) => e.trx);
	}

	private async pump(key: string): Promise<void> {
		const q = this.queues.get(key);
		if (q === undefined || q.inFlight) return;
		q.inFlight = true;
		try {
			while (q.pending.length > 0) {
				const batch = this.takeBatch(q.pending);
				this.batches++;
				if (batch.length > this.largestBatch) this.largestBatch = batch.length;
				const res = await sendBatchToPeer(q.peer, batch, this.deps, this.reachability, (f) =>
					this.note(f)
				);

				// A peer that refuses the SIZE is not a peer that refuses the
				// MESSAGES. Our own budget keeps us under a correctly configured
				// peer's cap, but a peer running an older or tighter configuration
				// is entitled to say no — and dropping the batch would silently
				// disable the fast path for that pair, which is the failure this
				// whole block exists to avoid. Send them one at a time instead:
				// one extra pass, no recursion, and the slow answer is still an
				// answer. A peer that 413s a SINGLE message cannot take it at all,
				// so that is left as a plain failure.
				if (res !== null && res.status === 413 && batch.length > 1) {
					// RECORDED EVEN WHEN THE SPLIT SUCCEEDS. If every single then
					// gets through, `failed` stays zero and an operator sees a
					// healthy delivery count beside a mysteriously large backlog —
					// with nothing anywhere naming the peer that is refusing whole
					// batches. That peer turns each batch into up to sixty-four
					// sequential round trips, which over a hidden transport is a
					// minute and a half per batch and is precisely the condition
					// worth seeing. This class exists on the principle that
					// "failed: 3" is not a diagnosis; neither is silence.
					this.note({
						origin: q.peer.origin,
						reason: `HTTP 413 — batch of ${batch.length} refused, sent one at a time`,
						status: 413
					});
					let ok = 0;
					for (const one of batch) {
						const r = await sendBatchToPeer(q.peer, [one], this.deps, this.reachability, (f) =>
							this.note(f)
						);
						if (r === null) ok++;
						else this.note(r);
					}
					this.delivered += ok;
					this.failed += batch.length - ok;
					continue;
				}

				if (res === null) {
					this.delivered += batch.length;
				} else {
					this.failed += batch.length;
					this.note(res);
				}
			}
		} finally {
			q.inFlight = false;
		}
	}

	/** Record why a push did not land, bounded. One place, so every path that
	 *  learns something an operator would want cannot forget to say it. */
	private note(f: DispatchFailure): void {
		this.recentFailures.push(f);
		while (this.recentFailures.length > 20) this.recentFailures.shift();
	}

	/** Is there traffic to this peer right now? Asked by the warm-up, which must
	 *  not take the peer's single pooled connection away from a real message. */
	isBusy(origin: string): boolean {
		const q = this.queues.get(origin);
		return q !== undefined && (q.inFlight || q.pending.length > 0);
	}

	/**
	 * Wait for every peer's queue to empty. Tests and shutdown only.
	 *
	 * Takes a deadline because the caller always has one: shutdown races this
	 * against a couple of seconds and then carries on regardless. Without it the
	 * losing branch of that race went on polling at a hundred hertz for as long
	 * as the process took to die, which — with a long-lived SSE client holding
	 * the HTTP server open — is not a short time.
	 */
	async drain(deadlineMs = 30_000): Promise<void> {
		const until = Date.now() + deadlineMs;
		for (;;) {
			const busy = [...this.queues.values()].some((q) => q.inFlight || q.pending.length > 0);
			if (!busy || Date.now() >= until) return;
			await new Promise<void>((r) => {
				setTimeout(r, 10);
			});
		}
	}

	stats(): {
		delivered: number;
		failed: number;
		batches: number;
		largestBatch: number;
		dropped: number;
		failures: readonly DispatchFailure[];
	} {
		return {
			delivered: this.delivered,
			failed: this.failed,
			batches: this.batches,
			largestBatch: this.largestBatch,
			dropped: this.dropped,
			failures: [...this.recentFailures]
		};
	}
}

/** POST one batch to ONE ADDRESS. Returns null on success, or why it failed. */
async function sendBatchToAddress(
	addr: FastPeerAddress,
	batch: readonly unknown[],
	deps: DispatchDeps
): Promise<DispatchFailure | null> {
	const url = `${addr.origin.replace(/\/+$/, '')}/v1/federation/chat-fast`;
	// A single transaction is sent in the single-transaction shape, so the
	// common case stays the simplest thing on the wire and is readable in a log.
	const body = batch.length === 1 ? { trx: batch[0] } : { trxs: batch };
	try {
		const postHidden = deps.postHidden ?? postJsonViaHiddenService;
		const res = addr.hidden
			? await postHidden(url, body, deps.proxies, deps.timeoutMs)
			: await deps.postClearnet(url, body, deps.timeoutMs);
		if (res.status >= 200 && res.status < 300) return null;
		// AN ANSWER, even an unhappy one. The peer was reached, so this is never
		// a local fault however bad the status is — and must not be, or a peer
		// returning 500 would take our whole Tor transport off the list.
		return { origin: addr.origin, reason: `HTTP ${res.status}`, status: res.status };
	} catch (err) {
		const localFault = isProxyUnavailable(err);
		return {
			origin: addr.origin,
			reason: err instanceof Error ? err.message : String(err),
			localFault,
			// Classified at the transport entry point and carried on the marker,
			// because by here the wrapper looks the same whatever produced it.
			confidence: localFault ? localFaultConfidence(err, hiddenNetworkOf(addr.origin)) : undefined
		};
	}
}

/**
 * POST one batch to one peer, at the best address this instance can reach.
 *
 * The ONE place a peer push is made — nothing else opens a connection to a
 * peer, so transport, status handling and error reporting cannot drift.
 *
 * ADDRESS CHOICE, IN ORDER OF WHAT IT COSTS TO GET WRONG:
 *
 *  1. Addresses on a network we recently failed to use are skipped. This is
 *     what keeps a dead local Tor daemon from costing one refused connection
 *     per peer per message.
 *
 *  2. ...unless that leaves nothing. A peer with only an onion, on an instance
 *     whose Tor is briefly down, must still be ATTEMPTED — both because the
 *     cooldown may be stale and because the attempt is how we find out it is.
 *     A breaker that can silence a peer permanently is worse than the failure
 *     it was added to avoid.
 *
 *  3. On a LOCAL fault, the network is marked down and the next address is
 *     tried immediately, within the same push. Failing this batch and waiting
 *     for the next one to discover the fallback would sacrifice the first
 *     message of the conversation — the one message whose latency the whole
 *     subsystem exists to protect.
 *
 *  4. On a PEER failure, we stop. The peer answered; asking it again somewhere
 *     else is not a retry, it is a duplicate.
 */
async function sendBatchToPeer(
	peer: FastPeer,
	batch: readonly unknown[],
	deps: DispatchDeps,
	reach: NetworkReachability,
	/** Records a failure that did NOT cost the message — see below. */
	note?: (f: DispatchFailure) => void
): Promise<DispatchFailure | null> {
	const all = addressesOf(peer);
	const usable = all.filter((a) => !reach.isDown(hiddenNetworkOf(a.origin)));
	const order = usable.length > 0 ? usable : all;

	// A peer with nowhere to send is a FAILURE, never a success.
	//
	// It cannot happen today — `addressesOf` always yields at least one address
	// and the line above falls back to the full list — so this is insurance, and
	// the thing it insures against is specific. Without it, an empty candidate
	// list falls straight out of the loop below and returns `null`, and `null`
	// means delivered: the caller would count a message nobody was sent as a
	// successful push. A mutation that removed the fallback produced exactly
	// that, and it is the worst possible shape for this bug to take, because a
	// silence that reports success is one nothing downstream can question.
	if (order.length === 0) {
		return { origin: peerKey(peer), reason: 'no usable address for this peer', localFault: true };
	}

	// EVERY FAILURE IS RECORDED EXACTLY ONCE — the same principle the 413
	// split-and-retry follows above, and for the same reason.
	//
	// A successful failover returns `null`, so without `note` the only trace of
	// a dead Tor daemon would be a reachability flag nobody reads. An operator
	// would see federated chat working, a delivery count climbing, and no hint
	// that every message to every onion-publishing peer is taking the long way
	// round — losing the privacy property those addresses were published for,
	// silently, for as long as nobody happens to restart the daemon. The message
	// got through; something is still wrong, and saying so is the whole
	// difference between a failover and a cover-up.
	//
	// The bookkeeping: whatever this returns is recorded by the CALLER (which
	// also counts it against `failed`), so anything noted here is a fault the
	// message SURVIVED. Those are logged but not counted as failures, because
	// no message was lost to them — `failed` stays a count of undelivered
	// messages rather than of unlucky attempts.
	let last: DispatchFailure | null = null;
	const supersede = (next: DispatchFailure | null): void => {
		if (last !== null) note?.(last);
		last = next;
	};

	for (const addr of order) {
		const network = hiddenNetworkOf(addr.origin);
		const res = await sendBatchToAddress(addr, batch, deps);
		if (res === null) {
			reach.markUp(network);
			supersede(null);
			return null;
		}
		if (res.localFault !== true) {
			// The peer answered. Whatever went wrong before this is history worth
			// keeping, and this failure is the caller's to record.
			supersede(null);
			return res;
		}
		// The failover below is unconditional — any local fault moves to this
		// peer's next address, because that is about THIS message. Whether the
		// NETWORK comes off the list for every other peer is a separate and
		// larger claim, and `reportAddressFault` is where the evidence for it is
		// weighed rather than assumed.
		// Keyed on the PEER, not the address: one instance's two bad names are
		// one piece of evidence about that instance, never two about our router
		// (S2 — see CORROBORATING_PEERS).
		reach.reportAddressFault(network, peerKey(peer), Date.now(), res.confidence);
		supersede(res);
	}
	return last;
}

/** Every alt-network key that names something this indexer can DIAL, in the
 *  order it would rather use them.
 *
 *  `ens` is deliberately absent: it is a name to be resolved, not a transport,
 *  and there is no resolver on this path. The other four are shape-validated
 *  on-chain at registration (operatorRegister), so a value here is already
 *  known to look like an address of its network — but it is re-classified
 *  below anyway, because "validated when it was written" and "valid now, in
 *  this row, after however many migrations" are different claims. */
const DIALABLE_ALT_KEYS = ['tor', 'i2p_b32', 'i2p_name', 'lokinet'] as const;

/** Rows as the directory query returns them. */
interface DirectoryRow {
	readonly origin: string;
	readonly reg_alt_networks: Partial<Record<string, string | null>> | null;
}

/** Has the operator turned this network off outright? Blank means "I do not
 *  run this daemon", which is the one reachability signal that is CONFIGURED
 *  rather than discovered — and so the one that can be trusted before anything
 *  has been tried. Everything else is learned at send time, because the
 *  defaults (`127.0.0.1:9050`, `127.0.0.1:4444`) are non-empty on every
 *  install whether or not the daemon behind them exists. */
/** Exported so the warm-up uses the same rule as the sender: an address on a
 *  network this node does not run is neither dialled nor warmed. */
export function networkConfigured(
	network: HiddenNetwork,
	proxies: HiddenServiceProxyConfig
): boolean {
	if (network === 'tor') return proxies.torSocks.length > 0;
	if (network === 'i2p') return proxies.i2pHttpProxy.length > 0;
	// Lokinet answers on its own tun, so there is no proxy setting to consult —
	// but there IS the operator's say-so (v1.18.0 review, S3). Without lokinet
	// a `.loki` name goes to the system resolver, which is the ISP's; such an
	// address is simply not one this node can use.
	return lokinetEnabled(proxies);
}

/** Compare origins the way the self-exclusion clause does, so "already have
 *  this address" means the same thing in SQL and in TypeScript. */
function normalisedOrigin(origin: string): string {
	return origin.toLowerCase().replace(/\/+$/, '');
}

/** Turn one directory row into a peer with every address we could reach it at. */
export function fastPeerFromRow(row: DirectoryRow, proxies: HiddenServiceProxyConfig): FastPeer {
	const addresses: FastPeerAddress[] = [];
	const seen = new Set<string>();
	const add = (origin: string, hidden: boolean): void => {
		const norm = normalisedOrigin(origin);
		if (norm.length === 0 || seen.has(norm)) return;
		seen.add(norm);
		addresses.push({ origin, hidden });
	};

	// Hidden addresses first — the preference is unchanged and its reasons still
	// hold: a zero-clearnet instance has no other route, and a clearnet peer
	// reached over its onion keeps this instance's own network position out of
	// the peer's logs. What changed is that preferring one no longer means
	// DISCARDING the rest.
	const alt = row.reg_alt_networks ?? null;
	if (alt !== null) {
		for (const key of DIALABLE_ALT_KEYS) {
			const host = alt[key];
			if (typeof host !== 'string' || host.length === 0) continue;
			const bare = host.replace(/^https?:\/\//, '');
			const network = hiddenHostNetworkOf(bare);
			// Junk, or a network whose daemon the operator says they do not run.
			if (network === null || !networkConfigured(network, proxies)) continue;
			add(host.startsWith('http') ? host : `http://${host}`, true);
		}
	}

	// The registered site origin goes on LAST, and unconditionally.
	//
	// Unconditionally, because this is the address the peer is guaranteed to
	// have — it is what they registered — and dropping it is the bug this whole
	// shape exists to prevent. Last, because it is usually the clearnet one and
	// the privacy preference above still stands. When the peer is itself
	// zero-clearnet its origin IS a hidden address, in which case `add`'s
	// de-duplication keeps it from appearing twice.
	//
	// EXCEPT on a hidden-only node (v1.18.0 deep-deep, C1, defence in depth).
	// There a clearnet origin is not an address at all: dialling it means a
	// system-resolver query and a connection from this node's own IP, which is
	// the one thing the node exists not to do. The router refuses it too, but
	// the router once let `https://10.<attacker>` through as "local", and a
	// registered origin is attacker-chosen — so it is never offered to the
	// sender in the first place.
	const originHidden = hiddenNetworkOf(row.origin) !== null;
	const hiddenOnly = clearnetRefused();
	// A legacy https:// hidden origin is dialled as http (v1.20.0, S9): the
	// hidden transports carry plain HTTP, and `:443` meant plaintext to a TLS
	// port. The peer's IDENTITY below stays the registered origin.
	if (originHidden || !hiddenOnly)
		add(originHidden ? hiddenOriginForDial(row.origin) : row.origin, originHidden);

	// A hidden-only node with no hidden address for this peer: the peer keeps
	// its identity (its queue key) but its one "address" is marked hidden, so it
	// goes to the hidden transport, which rejects a non-hidden URL before any
	// lookup (`dispatcherFor`: "not a hidden-service URL") — never to
	// `postClearnet`.
	const first = addresses[0] ?? { origin: row.origin, hidden: hiddenOnly || originHidden };
	return {
		origin: first.origin,
		hidden: first.hidden,
		// The peer's IDENTITY is its registered origin, never whichever address
		// we happen to be dialling. See `FastPeer.key`.
		key: normalisedOrigin(row.origin),
		alternates: addresses.slice(1)
	};
}

/**
 * Peers to push to, from the instance directory this indexer already maintains.
 *
 * Each peer carries EVERY address it has published that this instance could
 * plausibly dial, in preference order, rather than a single address chosen here
 * and then lived with. Choosing at read time meant choosing without knowing
 * what this instance can reach: a box with no Tor daemon would pick the onion
 * of every onion-publishing peer, drop their clearnet origins on the floor, and
 * have federated chat quietly not work at all — every push refused locally,
 * every message falling back to chain timing, and a healthy-looking peer count
 * the whole time. `proxies` is threaded in for the one reachability fact that
 * IS knowable here: a network the operator has explicitly switched off.
 */
/**
 * How a directory row is ranked when there are more instances than the fan-out
 * can carry. Lower is better.
 *
 * WHY THERE IS A RANKING AT ALL. The fan-out is bounded — every chat message
 * goes to every peer, so the cost is linear in the peer count and cannot simply
 * be allowed to grow. When the directory outgrows that bound, some instances
 * get chain-speed chat instead of fast chat, and WHICH ones is then a decision
 * rather than an accident. It used to be an accident: the order was
 * `last_probed_at DESC NULLS LAST`, which is probe recency and says nothing
 * about whether a peer is alive. Two consequences, both backwards:
 *
 *   - An instance known to be DEAD, probed a minute ago, outranked a healthy
 *     one probed an hour ago. Slots went to peers that could not answer.
 *   - A newly registered instance has `last_probe_status = 'never'` and a NULL
 *     `last_probed_at`, so `NULLS LAST` put it dead last — the one instance
 *     whose users have nothing else yet, ranked below every corpse.
 *
 * WHY 'never' IS NOT PROMOTED TO THE TOP, which is the tempting fix. Anyone can
 * register an origin on chain, so `never` is the one tier an attacker can
 * manufacture in bulk. Ranking it first would let a burst of junk registrations
 * evict the entire live federation from every peer list at once. It sits in the
 * middle: ahead of instances known to be failing, behind instances known to
 * work, and one probe cycle away from proving which it is.
 *
 * `clearnet_blocked` ranks WITH the healthy tiers on purpose. It means the peer
 * answered nothing over clearnet but is demonstrably alive on chain — which is
 * not a sick instance, it is a censored one, and a censored instance reachable
 * only over a hidden address is the case this whole subsystem exists for.
 */
const PEER_RANK: Readonly<Record<string, number>> = {
	good: 0,
	quiet: 1,
	syncing: 2,
	clearnet_blocked: 3,
	never: 4,
	stale: 5,
	unreachable: 6
};
/** Anything unrecognised sorts with the known-bad, never ahead of the known-good. */
const PEER_RANK_UNKNOWN = 7;

export function peerRank(status: string | null, lastProbeError?: string | null): number {
	if (status === null) return PEER_RANK_UNKNOWN;
	// 'good' WITHOUT A PROBE IS NOT GOOD (v1.18.0 review, S2). The probe writes
	// `good` for a peer it LISTED but could not ask — our proxy for its network
	// is down, or the peer is clearnet-only and we are hidden-only — so as not to
	// penalise a peer for our own state. That is right for the directory and
	// wrong for this ranking: it is also what an I2P name the proxy refuses
	// produces, which any registration can manufacture, so a burst of junk
	// registrations sat in the top tier and could push the live federation out of
	// the fan-out. Unverified ranks as unverified: with 'never'.
	if (
		status === 'good' &&
		lastProbeError !== undefined &&
		lastProbeError !== null &&
		LISTED_NOT_PROBED.has(lastProbeError)
	) {
		return PEER_RANK.never ?? PEER_RANK_UNKNOWN;
	}
	return PEER_RANK[status] ?? PEER_RANK_UNKNOWN;
}

/** The reasons `federationProbe.persistListedNotProbed` records beside a
 *  `good` it did not verify. */
const LISTED_NOT_PROBED: ReadonlySet<string> = new Set([
	'hidden_service_not_network_probed',
	'clearnet_peer_not_probed_hidden_only'
]);

/** One directory row, with the columns the ranking needs. */
export interface DirectoryPeerRow extends DirectoryRow {
	readonly last_probe_status: string | null;
	readonly last_probed_at: Date | string | null;
	readonly registered_at_time: Date | string | null;
	/** Read so a `good` the probe did not verify ranks as unverified. */
	readonly last_probe_error?: string | null;
}

function timeValue(v: Date | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	const t = v instanceof Date ? v.getTime() : Date.parse(v);
	return Number.isFinite(t) ? t : null;
}

/**
 * Order directory rows by who most deserves one of the bounded fan-out slots.
 *
 * Done HERE rather than in the `ORDER BY`, and that is the point of the
 * function existing. An ordering expressed only in SQL can be checked only by
 * reading the SQL — and this release has already had to replace one test that
 * asserted a source token instead of a behaviour, and watched it go red for a
 * change that made the behaviour better. A federation of a few instances never
 * reaches the bound, so this is a rule that will first matter on somebody
 * else's deployment, years from now, with nobody watching. That is precisely
 * the kind of rule that has to be executable in a test.
 *
 * Stable within a tier: most recently confirmed first, then the longest
 * registered. The last key matters against the same abuse the `never` tier is
 * placed for — a burst of fresh registrations ranks behind instances that have
 * been part of the federation for a while.
 */
export function rankDirectoryPeers(rows: readonly DirectoryPeerRow[]): DirectoryPeerRow[] {
	return [...rows].sort((a, b) => {
		const ra = peerRank(a.last_probe_status, a.last_probe_error);
		const rb = peerRank(b.last_probe_status, b.last_probe_error);
		if (ra !== rb) return ra - rb;

		// Most recently confirmed first; never-probed rows fall to the tiebreak
		// below rather than being scattered by a missing value.
		const pa = timeValue(a.last_probed_at);
		const pb = timeValue(b.last_probed_at);
		if (pa !== pb) {
			if (pa === null) return 1;
			if (pb === null) return -1;
			return pb - pa;
		}

		const ga = timeValue(a.registered_at_time);
		const gb = timeValue(b.registered_at_time);
		if (ga !== gb) {
			if (ga === null) return 1;
			if (gb === null) return -1;
			return ga - gb;
		}
		// Total order, so a refresh cannot reshuffle an unchanged directory.
		return a.origin.localeCompare(b.origin);
	});
}

/**
 * The most rows the directory read will pull back before ranking.
 *
 * Not the fan-out bound — that is `limit`, applied after ranking. This is a
 * memory bound on a table whose size an attacker has some say in, because
 * registering an origin is an ordinary on-chain operation. A few hundred rows
 * of origin and status is a few tens of kilobytes every five minutes, which is
 * nothing; a directory that has somehow grown past it is a situation where
 * taking the healthiest slice is still the right answer.
 */
const DIRECTORY_SCAN_MAX = 500;

/** What a directory read found, beyond the peers themselves. */
export interface FastPeerDirectory {
	readonly peers: FastPeer[];
	/** Instances the fan-out bound left out. Zero in any federation smaller
	 *  than the bound, which is every federation today — see `peersTruncated`
	 *  in /v1/health for why it is reported anyway. */
	readonly dropped: number;
}

export async function fastPeerDirectory(
	db: FastFederationDb,
	selfOrigin: string,
	proxies: HiddenServiceProxyConfig,
	limit = 40
): Promise<FastPeerDirectory> {
	const r = await db.query<DirectoryPeerRow>(
		// Self-exclusion is on the ORIGIN, NORMALISED — lowercased and with any
		// trailing slash trimmed — rather than compared exactly.
		// `known_instances.origin` comes from the on-chain registration, so it is
		// the SITE origin, while the value passed in here is whatever the operator
		// configured; the two differ by a subdomain, a case, or a trailing slash
		// often enough that an exact `<>` quietly leaves this instance in its own
		// peer list. It would then push every message to itself over Tor, paying a
		// round trip to deliver what it had already delivered locally.
		//
		// A ROW IS EXCLUDED BEFORE ITS HIDDEN ADDRESS IS EVER READ, which is worth
		// stating because it is easy to talk yourself out of. The loop below may
		// replace the origin with the operator's `.onion`, so our own row *reached
		// by its onion* would not match the value passed in — but that
		// substitution happens to the SELECT's output, and this clause filters on
		// `ki.origin`, which is always the registered site origin. Filtering here
		// means the row never reaches the loop at all.
		//
		// An earlier version of this also excluded rows by operator account, on
		// the theory that the origin compare could not catch a row wearing an
		// onion. That was wrong twice over: the origin compare does catch it, per
		// the paragraph above, and `config.operatorAccountName` FALLS BACK to the
		// federation-wide `officialAccountName` when an operator has not set their
		// own — which the shipped env example leaves blank. So every community
		// instance would have silently excluded the canonical instance, and every
		// other instance whose operator had also left it unset, from its peer list
		// — reverting chat with the largest instance in the federation to the
		// chain path, with nothing logged and a plausible-looking peer count.
		//
		// (The fast-emit ledger is the structural backstop behind this: a
		// self-push that slips through is a wasted round trip, not a duplicate.)
		// The ORDER BY here is only about which rows survive the SCAN cap, not
		// which peers get pushed to — `rankDirectoryPeers` decides that, in
		// TypeScript, where it can be tested. Kept roughly aligned with the tiers
		// so that a directory large enough to hit the cap still hands the ranking
		// a sensible slice to choose from.
		`SELECT ki.origin, o.reg_alt_networks,
		        ki.last_probe_status, ki.last_probed_at, ki.registered_at_time,
		        ki.last_probe_error
		   FROM known_instances ki
		   LEFT JOIN operators o ON o.account = ki.operator_account
		  WHERE lower(rtrim(ki.origin, '/')) <> lower(rtrim($1, '/'))
		    AND (ki.last_probe_status IS NULL OR ki.last_probe_status <> 'mismatch')
		  ORDER BY CASE ki.last_probe_status
		             WHEN 'good' THEN 0
		             WHEN 'quiet' THEN 1
		             WHEN 'syncing' THEN 2
		             WHEN 'clearnet_blocked' THEN 3
		             WHEN 'never' THEN 4
		             WHEN 'stale' THEN 5
		             WHEN 'unreachable' THEN 6
		             ELSE 7
		           END,
		           ki.last_probed_at DESC NULLS LAST,
		           ki.registered_at_time ASC NULLS LAST
		  LIMIT $2`,
		[selfOrigin, DIRECTORY_SCAN_MAX]
	);

	const ranked = rankDirectoryPeers(r.rows);
	return {
		peers: ranked.slice(0, limit).map((row) => fastPeerFromRow(row, proxies)),
		dropped: Math.max(0, ranked.length - limit)
	};
}

/** Peers only — the shape most callers want. */
export async function fastPeersFromDirectory(
	db: FastFederationDb,
	selfOrigin: string,
	proxies: HiddenServiceProxyConfig,
	limit = 40
): Promise<FastPeer[]> {
	return (await fastPeerDirectory(db, selfOrigin, proxies, limit)).peers;
}

/**
 * True when the transaction carries a Morphit chat op — the dispatch predicate.
 *
 * Shape-only and cheap; the receiving side does the real validation. It lives
 * here rather than in the dispatcher because the dispatcher already depends on
 * this module, and having the dependency run the other way as well would make
 * the two files a cycle: importing either one would then get a half-initialised
 * copy of the other, and the failure would show up as an unhelpful "not a
 * function" at call time rather than at load.
 */
export function containsChatOp(trx: unknown): boolean {
	const ops = (trx as { operations?: unknown })?.operations;
	if (!Array.isArray(ops)) return false;
	for (const op of ops) {
		if (!Array.isArray(op) || op.length !== 2) continue;
		if (op[0] !== 'custom_json') continue;
		if ((op[1] as { id?: unknown })?.id === CHAT_OP_ID) return true;
	}
	return false;
}

/**
 * The transaction id the chain will assign, computed from the signed bytes.
 *
 * Needed because the ASYNCHRONOUS `broadcast_transaction` a chat send uses does
 * not reliably hand one back — blurtd's confirmation for it is `{ id }` at best
 * and empty at worst, since there is no block yet to report. The id is a pure
 * function of the transaction, so deriving it locally is not a guess: it is the
 * same value the chain arrives at, available before the chain has it.
 */
export async function computeTrxId(trx: unknown): Promise<string | null> {
	try {
		const { cryptoUtils } = await import('@beblurt/dblurt');
		return cryptoUtils.generateTrxId(trx as Parameters<typeof cryptoUtils.generateTrxId>[0]);
	} catch {
		return null;
	}
}
