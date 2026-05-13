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

	void verifyBlurtTransfer(args.txid, {
		recipient: args.recipient,
		sender: args.sender,
		amountBlurt: args.amountBlurt,
		memo: expectedMemo
	}).then((r) => {
		recordVerification({
			orderPermlink: args.orderPermlink,
			verifyResult: r
		});
		// When the chain confirms the transfer landed, the
		// recipient's BLURT balance has just changed.  Nudge any
		// visible balance card to refetch.  Safe to call from any
		// caller of triggerBlurtVerification — `args.recipient` is
		// always the current user (the listener only routes
		// transfers TO us; outbound transfers go through a
		// different path).
		if (r.kind === 'verified') {
			triggerBalanceRefresh();
		}
	});
	// No catch: verifyBlurtTransfer wraps RPC errors and returns
	// `{ kind: 'rpc_error', message }` rather than throwing.  If
	// it threw unexpectedly, we'd want to know — letting the
	// promise's rejection surface to the browser console is fine.
}
