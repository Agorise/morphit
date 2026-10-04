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

export interface TradeState {
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

// ────────────────────────────────────────────────────────────────
// Pure mutators — take a Map snapshot, return the next Map
// ────────────────────────────────────────────────────────────────

export function recordAddressSharedPure(
	current: ReadonlyMap<string, TradeState>,
	args: {
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
	const existing = current.get(args.orderPermlink);

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
	// Outgoing engages.  Once engaged, engagement sticks — the
	// user can't accidentally re-engage with a different peer
	// for the same permlink (would only happen via UI bug).
	const engagedPeer =
		args.direction === 'outgoing' ? (existing?.engagedPeer ?? args.peer) : existing?.engagedPeer;
	next.set(args.orderPermlink, {
		...(existing ?? {}),
		orderPermlink: args.orderPermlink,
		peer: args.peer,
		method: args.method,
		phase: advancePhase(existing?.phase, 'address_shared'),
		address: args.address,
		expectedAmount: args.expectedAmount,
		expectedMemo: args.expectedMemo,
		addressSharedAt: existing?.addressSharedAt ?? now,
		engagedPeer,
		updatedAt: now
	});
	return next;
}

export function recordFundsSentPure(
	current: ReadonlyMap<string, TradeState>,
	args: {
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
	const existing = current.get(args.orderPermlink);

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
	const engagedPeer =
		args.direction === 'outgoing' ? (existing?.engagedPeer ?? args.peer) : existing?.engagedPeer;
	next.set(args.orderPermlink, {
		...(existing ?? {
			orderPermlink: args.orderPermlink,
			peer: args.peer,
			method: args.method,
			updatedAt: now
		}),
		peer: args.peer,
		method: args.method,
		phase: advancePhase(existing?.phase, 'paid'),
		txid: args.txid,
		claimedMemo: args.claimedMemo,
		expectedAmount: existing?.expectedAmount ?? args.amount,
		verifyResult: args.method === 'blurt' ? 'pending' : undefined,
		mismatchField: undefined,
		fundsSentAt: existing?.fundsSentAt ?? now,
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
	const existing = current.get(args.orderPermlink);
	if (existing === undefined || existing.engagedPeer !== args.counterparty) return current;
	const next = new Map(current);
	const now = args.now ?? new Date();

	const newPhase = advancePhase(existing.phase, phaseForVerify(args.verifyResult));
	// If phase didn't actually change (first-wins or stickiness),
	// preserve the existing verifyResult + mismatchField too —
	// keep the entire verification record consistent with the
	// phase rather than splitting them.
	if (newPhase === existing.phase) {
		next.set(args.orderPermlink, {
			...existing,
			updatedAt: now
		});
		return next;
	}

	next.set(args.orderPermlink, {
		...existing,
		phase: newPhase,
		verifyResult: args.verifyResult,
		mismatchField: args.verifyResult.kind === 'mismatch' ? args.verifyResult.field : undefined,
		amountConfirmed: args.verifyResult.kind === 'verified' && args.amountConfirmed,
		updatedAt: now
	});
	return next;
}
