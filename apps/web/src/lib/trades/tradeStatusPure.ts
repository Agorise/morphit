/**
 * tradeStatus pure logic — phase advancement, mutators that
 * take a Map snapshot and return a new Map.
 *
 * Phase F.5.  Lives separately from `tradeStatus.ts` (the
 * Svelte store wrapper) so smoke runners can exercise the
 * logic under tsx without resolving 'svelte/store'.  The store
 * wrapper imports from here and threads results through
 * `writable.update`.
 *
 * Forward-compat: TradePhase has values reserved for future
 * protocol stages ('released', 'disputed', 'completed').  The
 * pure dispatcher handles them in advancePhase + phaseForVerify
 * so the protocol can grow without rewriting the store layer.
 */

import type { VerifyResult } from '../chat/blurtVerify';
import type { ChatAssetTicker } from '../chat/payload';

export type TradePhase =
	| 'address_shared'
	| 'paid'
	| 'paid_verified'
	| 'paid_mismatch'
	| 'paid_unverifiable'
	| 'released'
	| 'disputed'
	| 'completed';

export type MismatchField = 'to' | 'from' | 'amount' | 'memo';

/**
 * Store key of the trade on `orderOwner`'s order `orderPermlink` (review
 * C-L3). A permlink is unique per owner only, so the key names both. NUL
 * occurs in neither a Blurt account name nor a permlink.
 */
export function tradeKey(orderOwner: string, orderPermlink: string): string {
	return `${orderOwner}\u0000${orderPermlink}`;
}

export interface TradeState {
	/** The account that posted the order. */
	readonly orderOwner: string;
	readonly orderPermlink: string;
	readonly peer: string;
	readonly method: ChatAssetTicker;
	readonly phase: TradePhase;

	/** Phase F.5 audit fix (F-40) — peer the local user has
	 *  affirmatively ENGAGED with for this trade.  Set when the
	 *  user sends an outgoing structured payload referencing this
	 *  permlink.  Once set, incoming payloads from any other peer
	 *  for the same permlink are dropped.
	 *
	 *  Critically, the verifier's `expectedMemo` consultation in
	 *  ChatMessage is ONLY trusted when `engagedPeer === message.sender`.
	 *  Otherwise the verifier falls back to the buyer's echoed memo —
	 *  preventing a third party from poisoning the entry's
	 *  `expectedMemo` and tricking the verifier into a false
	 *  mismatch on legitimate trades.
	 *
	 *  Undefined = not yet engaged.  Tentative entries created by
	 *  incoming-only payloads have no engagement; verifier doesn't
	 *  consult their `expectedMemo`. */
	readonly engagedPeer?: string;

	readonly address?: string;
	/** v1.21.17 — the coin of the address record (`address`, `expectedAmount`,
	 *  `expectedMemo`). `method` follows the latest payload of any kind, so a
	 *  receipt in another coin does not say what the ask was in. */
	readonly askMethod?: ChatAssetTicker;
	readonly expectedAmount?: number;
	readonly expectedMemo?: string;
	readonly addressSharedAt?: Date;

	readonly txid?: string;
	readonly claimedMemo?: string;
	readonly fundsSentAt?: Date;

	readonly verifyResult?: VerifyResult | 'pending';
	readonly mismatchField?: MismatchField;
	/** True when a 'paid_verified' result was checked against the amount the
	 *  seller ASKED for in their address payload (expectedAmount). False when
	 *  no amount was asked, so the transfer was checked against the buyer's
	 *  own figure only: "a payment arrived", not "paid in full". Anything that
	 *  acts on a verification (e.g. auto-completing the order) must require
	 *  true. */
	readonly amountConfirmed?: boolean;

	readonly updatedAt: Date;
}

/** Phase rank for monotonic comparison.  Sibling terminal
 *  states share a rank — once any one of paid_verified /
 *  paid_mismatch / paid_unverifiable is reached, others at the
 *  same rank don't replace it (first-wins) — except that
 *  paid_verified replaces paid_mismatch / paid_unverifiable.  Same
 *  for released/disputed.  Only `completed` strictly succeeds them. */
const PHASE_RANK: Record<TradePhase, number> = {
	address_shared: 0,
	paid: 1,
	paid_verified: 2,
	paid_mismatch: 2,
	paid_unverifiable: 2,
	released: 3,
	disputed: 3,
	completed: 4
};

/** Compute the next phase given the current entry's phase and
 *  an incoming candidate.  Strictly monotonic — observing a
 *  stale or sibling event does NOT regress nor flicker the
 *  phase.  paid_verified is additionally sticky against
 *  paid_mismatch / paid_unverifiable arriving later (a confirmed
 *  verification shouldn't get downgraded if a stale RPC error
 *  follows). */
export function advancePhase(current: TradePhase | undefined, candidate: TradePhase): TradePhase {
	if (!(candidate in PHASE_RANK)) {
		// Forward-compat: unknown candidate phase from a future
		// protocol version.  Don't crash; keep current.
		return current ?? candidate;
	}
	if (current === undefined) return candidate;
	if (!(current in PHASE_RANK)) return candidate;

	const ci = PHASE_RANK[current];
	const ni = PHASE_RANK[candidate];

	// Special-case stickiness: paid_verified holds against later
	// paid_mismatch / paid_unverifiable (same rank).  A confirmed
	// verification is a stronger claim than a later RPC failure.
	if (
		current === 'paid_verified' &&
		(candidate === 'paid_mismatch' || candidate === 'paid_unverifiable')
	) {
		return current;
	}
	// …and it CORRECTS them: a transfer found on chain for the engaged
	// counterparty outweighs an earlier mismatch or failed check (a stale RPC
	// error, or a claim that was not the real payment). Callers record a
	// verification only for the engaged peer.
	if (
		candidate === 'paid_verified' &&
		(current === 'paid_mismatch' || current === 'paid_unverifiable')
	) {
		return candidate;
	}

	// Same rank → first-wins (don't flicker).
	if (ni === ci) return current;
	// Higher rank → advance.
	if (ni > ci) return candidate;
	// Lower rank → stay (no regression).
	return current;
}

/** Map a VerifyResult to its corresponding TradePhase. */
export function phaseForVerify(r: VerifyResult): TradePhase {
	if (r.kind === 'verified') return 'paid_verified';
	if (r.kind === 'mismatch') return 'paid_mismatch';
	return 'paid_unverifiable';
}

/** The entry of `orderOwner`'s order `orderPermlink`, or null (also when
 *  either is unknown). */
export function tradeStateOf(
	states: ReadonlyMap<string, TradeState>,
	orderOwner: string | null | undefined,
	orderPermlink: string | null | undefined
): TradeState | null {
	if (!orderOwner || !orderPermlink) return null;
	return states.get(tradeKey(orderOwner, orderPermlink)) ?? null;
}

/**
 * The entry of `orderOwner`'s order `orderPermlink` as it concerns the trade
 * with `peer`, or null when the entry describes the trade with someone else.
 *
 * v1.21.14 full chat audit, W-H1. The store keeps ONE entry per order, and an
 * order the local user posted can have several inquirers. Every view that
 * shows a thread (peer + order) used to read the entry by order alone, so a
 * claim from one inquirer ("paid") hid Pay now and Share address in the
 * thread with another and offered Leave feedback there. A thread reads the
 * entry only when it is about that thread's peer: the engaged counterparty
 * once there is one, otherwise the peer the entry was last recorded for.
 */
export function tradeStateWith(
	states: ReadonlyMap<string, TradeState>,
	orderOwner: string | null | undefined,
	orderPermlink: string | null | undefined,
	peer: string | null | undefined
): TradeState | null {
	if (!peer) return null;
	const st = tradeStateOf(states, orderOwner, orderPermlink);
	if (st === null) return null;
	return (st.engagedPeer ?? st.peer) === peer ? st : null;
}

/**
 * The entry a new record for `peer` builds on: the existing one, unless it
 * describes the trade with a DIFFERENT peer and nobody is engaged yet — then a
 * fresh one. v1.21.14 full chat audit, W-H1: before, a second inquirer's
 * payload inherited the first one's phase, txid and asked amount, so one
 * peer's "paid" claim became the other peer's state.
 */
function baseFor(existing: TradeState | undefined, peer: string): TradeState | undefined {
	if (existing === undefined) return undefined;
	if (existing.engagedPeer === undefined && existing.peer !== peer) return undefined;
	return existing;
}

// ────────────────────────────────────────────────────────────────
// Pure mutators — take a Map snapshot, return the next Map
// ────────────────────────────────────────────────────────────────

export function recordAddressSharedPure(
	current: ReadonlyMap<string, TradeState>,
	args: {
		/** The account that posted the order. */
		orderOwner: string;
		orderPermlink: string;
		peer: string;
		method: ChatAssetTicker;
		address: string;
		expectedAmount?: number;
		expectedMemo?: string;
		now?: Date;
		/** Phase F.5 audit fix (F-40).  Outgoing payloads from the
		 *  local user lock the entry to that peer.  Incoming
		 *  payloads from a peer different from the engaged peer
		 *  are dropped. */
		direction: 'outgoing' | 'incoming';
	}
): ReadonlyMap<string, TradeState> {
	const key = tradeKey(args.orderOwner, args.orderPermlink);
	const existing = current.get(key);

	// F-40 lock: incoming from a non-engaged peer is dropped.
	if (
		args.direction === 'incoming' &&
		existing !== undefined &&
		existing.engagedPeer !== undefined &&
		existing.engagedPeer !== args.peer
	) {
		return current;
	}

	const next = new Map(current);
	const now = args.now ?? new Date();
	const base = baseFor(existing, args.peer);
	// Outgoing engages.  Once engaged, engagement sticks — the
	// user can't accidentally re-engage with a different peer
	// for the same permlink (would only happen via UI bug).
	const engagedPeer =
		args.direction === 'outgoing' ? (base?.engagedPeer ?? args.peer) : base?.engagedPeer;
	next.set(key, {
		...(base ?? {}),
		orderOwner: args.orderOwner,
		orderPermlink: args.orderPermlink,
		peer: args.peer,
		method: args.method,
		phase: advancePhase(base?.phase, 'address_shared'),
		address: args.address,
		askMethod: args.method,
		expectedAmount: args.expectedAmount,
		expectedMemo: args.expectedMemo,
		addressSharedAt: base?.addressSharedAt ?? now,
		engagedPeer,
		updatedAt: now
	});
	return next;
}

export function recordFundsSentPure(
	current: ReadonlyMap<string, TradeState>,
	args: {
		/** The account that posted the order. */
		orderOwner: string;
		orderPermlink: string;
		peer: string;
		method: ChatAssetTicker;
		txid: string;
		claimedMemo?: string;
		amount?: number;
		now?: Date;
		/** Phase F.5 audit fix (F-40).  See recordAddressSharedPure. */
		direction: 'outgoing' | 'incoming';
	}
): ReadonlyMap<string, TradeState> {
	const key = tradeKey(args.orderOwner, args.orderPermlink);
	const existing = current.get(key);

	// F-40 lock.
	if (
		args.direction === 'incoming' &&
		existing !== undefined &&
		existing.engagedPeer !== undefined &&
		existing.engagedPeer !== args.peer
	) {
		return current;
	}

	const next = new Map(current);
	const now = args.now ?? new Date();
	const base = baseFor(existing, args.peer);
	const engagedPeer =
		args.direction === 'outgoing' ? (base?.engagedPeer ?? args.peer) : base?.engagedPeer;
	// v1.21.14 full chat audit, W-M4: the SAME claim recorded again (its
	// durable copy after the fast one, a second listener, a reopened thread)
	// keeps the verification it already has. Resetting it to 'pending' left a
	// verified receipt reading "Verifying…" for good: the verifier's cached
	// answer then changes no phase, so nothing ever overwrote 'pending' again.
	const sameClaim =
		base !== undefined &&
		base.txid === args.txid &&
		base.verifyResult !== undefined &&
		base.verifyResult !== 'pending';
	next.set(key, {
		...(base ?? {
			orderOwner: args.orderOwner,
			orderPermlink: args.orderPermlink,
			peer: args.peer,
			method: args.method,
			updatedAt: now
		}),
		peer: args.peer,
		method: args.method,
		phase: advancePhase(base?.phase, 'paid'),
		txid: args.txid,
		claimedMemo: args.claimedMemo,
		expectedAmount: base?.expectedAmount ?? args.amount,
		verifyResult: sameClaim ? base.verifyResult : args.method === 'blurt' ? 'pending' : undefined,
		mismatchField: sameClaim ? base.mismatchField : undefined,
		fundsSentAt: base?.fundsSentAt ?? now,
		engagedPeer,
		updatedAt: now
	});
	return next;
}

/** Record a chain verification of `counterparty`'s payment on an order.
 *  Refused (state unchanged) unless the order is ENGAGED with exactly that
 *  counterparty: a verification of anyone else's transfer — a stranger who
 *  sent a token amount and claimed it — must never mark the order paid. */
export function recordVerificationPure(
	current: ReadonlyMap<string, TradeState>,
	args: {
		orderOwner: string;
		orderPermlink: string;
		verifyResult: VerifyResult;
		/** The other party of this payment (the buyer on the seller's side,
		 *  the seller on the buyer's). */
		counterparty: string;
		/** See TradeState.amountConfirmed. */
		amountConfirmed: boolean;
		now?: Date;
	}
): ReadonlyMap<string, TradeState> {
	const key = tradeKey(args.orderOwner, args.orderPermlink);
	const existing = current.get(key);
	if (existing === undefined || existing.engagedPeer !== args.counterparty) return current;
	const next = new Map(current);
	const now = args.now ?? new Date();

	const newPhase = advancePhase(existing.phase, phaseForVerify(args.verifyResult));
	// If phase didn't actually change (first-wins or stickiness),
	// preserve the existing verifyResult + mismatchField too —
	// keep the entire verification record consistent with the
	// phase rather than splitting them.
	if (newPhase === existing.phase) {
		next.set(key, {
			...existing,
			updatedAt: now
		});
		return next;
	}

	next.set(key, {
		...existing,
		phase: newPhase,
		verifyResult: args.verifyResult,
		mismatchField: args.verifyResult.kind === 'mismatch' ? args.verifyResult.field : undefined,
		amountConfirmed: args.verifyResult.kind === 'verified' && args.amountConfirmed,
		updatedAt: now
	});
	return next;
}
