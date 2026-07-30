/**
 * tradeVerify — orchestrates BLURT verification against the
 * trade-status store.
 *
 * Phase F.5 audit fix (F-41).  Before this module, the on-chain
 * verifier ran only inside ChatMessage's `$effect`, meaning the
 * verification fired only when the user opened the chat page.
 * On /my/orders the badge would stay at "Payment pending"
 * indefinitely if the user never visited chat.
 *
 * The cross-page promise of Phase F.5 was that state
 * propagates without the user navigating to chat.  This module
 * fulfills that promise by extracting the verifier trigger so
 * any caller — chatService's merge layer, the global SSE
 * listener, ChatMessage's $effect — can fire it.
 *
 * ─── Idempotency ─────────────────────────────────────────────
 *
 * `verifyBlurtTransfer` caches by full input tuple.  Repeated
 * calls hit the cache.  The store's first-wins semantics for
 * sibling terminal phases (paid_verified vs paid_mismatch vs
 * paid_unverifiable) mean that the FIRST result through
 * recordVerification sticks regardless of subsequent calls.
 *
 * Multiple callers firing the same trigger for the same
 * funds-sent event is therefore safe.
 *
 * ─── F-40 engagement gate ────────────────────────────────────
 *
 * The expected memo passed to verifyBlurtTransfer comes from
 * the trade-status store IFF the entry's `engagedPeer ===
 * sender`.  Otherwise, fall back to the echoedMemo (the value
 * the buyer claimed in their funds-sent payload).  This
 * prevents a third-party-poisoned tentative entry from driving
 * a false-mismatch verification.
 */

import { browser } from '$app/environment';
import { verifyBlurtTransfer } from '$lib/chat/blurtVerify';
import { getTradeState, recordVerification } from '$lib/trades/tradeStatus';
import { triggerBalanceRefresh } from '$lib/balance/bus';

export interface VerifyTriggerArgs {
	/** The seller's account — recipient of the BLURT transfer
	 *  on chain. */
	readonly recipient: string;
	/** The buyer's account — sender of the BLURT transfer on
	 *  chain.  Same as the chat message's sender. */
	readonly sender: string;
	/** Expected BLURT amount as a number (parsed from the
	 *  funds-sent payload's amount string upstream). */
	readonly amountBlurt: number;
	/** The buyer's echoed memo from the funds-sent payload.
	 *  Used as fallback when the trade isn't engaged with the
	 *  sender. */
	readonly echoedMemo: string;
	/** Order permlink — keys the trade-status store entry. */
	readonly orderPermlink: string;
	/** Chain transaction id from the funds-sent payload. */
	readonly txid: string;
}

/** cp508 (tt.txt #10) — a freshly-broadcast transfer isn't queryable for a few
 *  seconds: it has to land in a block and be indexed by the RPC. So the FIRST
 *  verify — especially the SENDER's own immediate self-check — comes back
 *  `not_found` or `rpc_error`. That is transient, not a failure. Recording it
 *  as final was what made the sender's receipt read "Could not verify on chain
 *  (RPC unreachable)" while the receiver still showed "Verifying…". We retry a
 *  transient result on a short interval for up to this window before recording
 *  it; the trade entry stays 'pending' (set on funds-sent) throughout, so BOTH
 *  parties show "Verifying…" until the transfer clears (or the window lapses and
 *  the real error is finally shown). */
export const VERIFY_RETRY_WINDOW_MS = 90_000;
export const VERIFY_RETRY_INTERVAL_MS = 6_000;

/** orderPermlink\u0000txid currently inside a retry chain — so re-renders that
 *  re-call triggerBlurtVerification don't spawn parallel chains hammering the
 *  RPC. verifyBlurtTransfer already caches DEFINITIVE results, but transient
 *  ones (the whole point of the retry) are deliberately not cached. */
const verifyInFlight = new Set<string>();

/** Kick off a BLURT chain verification and route the result to
 *  the trade-status store.  Returns void — callers don't need
 *  to await; the store mutation is the side effect.  Errors are
 *  caught and recorded as `rpc_error` results.
 *
 *  Skips entirely when not in a browser context (server-side
 *  rendering, smoke runners that don't have window). */
export function triggerBlurtVerification(args: VerifyTriggerArgs): void {
	if (!browser) return;
	if (!Number.isFinite(args.amountBlurt) || args.amountBlurt <= 0) return;

	// F-40 engagement gate: consult store's expectedMemo only when
	// the trade is engaged with this sender.  Tentative entries
	// (no engagement) or entries engaged with a different peer
	// fall back to the buyer's echo.
	let expectedMemo = args.echoedMemo;
	const trade = getTradeState(args.orderPermlink);
	if (trade?.expectedMemo !== undefined && trade.engagedPeer === args.sender) {
		expectedMemo = trade.expectedMemo;
	}

	const key = `${args.orderPermlink}\u0000${args.txid}`;
	if (verifyInFlight.has(key)) return; // a retry chain is already running
	verifyInFlight.add(key);

	const startedAt = Date.now();
	const attempt = (): void => {
		void verifyBlurtTransfer(args.txid, {
			recipient: args.recipient,
			sender: args.sender,
			amountBlurt: args.amountBlurt,
			memo: expectedMemo
		})
			.then((r) => {
				// not_found / rpc_error right after broadcast just means the tx
				// hasn't been included + indexed yet — retry within the window
				// and leave the entry 'pending' ("Verifying…"). verified /
				// mismatch / wrong_op are definitive (the tx WAS found), so record
				// immediately and stop.
				const transient = r.kind === 'not_found' || r.kind === 'rpc_error';
				if (transient && Date.now() - startedAt < VERIFY_RETRY_WINDOW_MS) {
					setTimeout(attempt, VERIFY_RETRY_INTERVAL_MS);
					return;
				}
				verifyInFlight.delete(key);
				recordVerification({
					orderPermlink: args.orderPermlink,
					verifyResult: r
				});
				// When the chain confirms the transfer landed, the recipient's
				// BLURT balance has just changed. Nudge any visible balance card to
				// refetch. Safe from any caller — args.recipient is always the
				// current user (the listener only routes transfers TO us).
				if (r.kind === 'verified') {
					triggerBalanceRefresh();
				}
			})
			.catch(() => {
				// verifyBlurtTransfer wraps RPC errors into rpc_error rather than
				// throwing; this only fires on a truly unexpected throw. Free the
				// key so the trade isn't wedged un-verifiable, and leave the entry
				// 'pending' for a later re-trigger.
				verifyInFlight.delete(key);
			});
	};
	attempt();
}
