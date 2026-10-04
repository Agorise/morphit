/**
 * fastNotifyGate — the ONE safe-subset gate for a fast-path chat message.
 *
 *
 * It decides two things at once — whether the message may fast-notify (web
 * push) and whether it may be REPLAYED into a chatroom opened moments later —
 * and it must admit a strict SUBSET of what the durable handler will admit,
 * because a notification cannot be recalled and a replayed message that the
 * durable row never backs vanishes on reload (ADR-0052 §4).
 *
 * WHAT WAS WRONG. The head tailer and the federation intake each carried their
 * own copy of this gate, and both opened with the 1.18.0 "recent outbound"
 * shortcut — `return true` if the recipient had just written to the sender
 * through this instance — BEFORE the order tag was looked at. The durable
 * handler rejects a message whose tag is not a valid permlink
 * (`order_permlink_bad_chars`) or names no order of either party
 * (`order_permlink_not_found`), whatever the conversation history. So a
 * counterparty the victim had just replied to could send
 * `order_permlink: "NOT-AN-ORDER?x=1&next=/en/settings#"`, and the fast path
 * replayed it and queued a push whose click path and notification tag carried
 * that string — a message the chain would never keep.
 *
 * The order tag is now validated FIRST, with the durable handler's own
 * validator and its own order query, and only then may any shortcut apply.
 * One function, called from both routes, so the two cannot drift again.
 */

import type { LocatedChatOp } from '$indexer/headTailer';
import { checkChatOrder, recipientHasReplied, type ChatGateDb } from '$indexer/chatGates';
import { validateChatOrderPermlink } from '$indexer/permlink';
import { hasRecentOutboundChat } from '$indexer/recentOutboundChat';
import { spendFastNotifyBudget } from '$indexer/fastNotifyBudget';

export interface FastNotifyGateOptions {
	/**
	 * Charge a first-contact notification against the recipient's budget. True
	 * only on the peer route, where a message arrived without costing its
	 * sender anything; see fastNotifyBudget.ts.
	 */
	readonly meterFirstContact?: boolean;
}

/**
 * True iff this (already block-passed) message may fast-notify and be replayed.
 *
 * `at` is the time admission is judged at — the block time on the head
 * tailer, the ARRIVAL time on the peer route (never the sender-chosen
 * `sentAt`; see deliverVerifiedPush). Throws on a database error; callers deny
 * on a throw.
 */
export async function fastChatNotifyAllowed(
	db: ChatGateDb,
	located: LocatedChatOp,
	at: Date,
	opts: FastNotifyGateOptions = {}
): Promise<boolean> {
	// THE ORDER TAG FIRST, before anything can short-circuit. A tag the
	// durable handler would reject sinks the whole message there, so it must
	// sink the notification here, whoever the sender is.
	let orderResponseBypass = false;
	if (located.orderPermlink !== null) {
		if (validateChatOrderPermlink(located.orderPermlink) !== null) return false;
		const oc = await checkChatOrder(db, {
			permlink: located.orderPermlink,
			recipient: located.recipient,
			signer: located.signer,
			blockTime: at
		});
		// A tag naming no real owned order → the durable REJECTS the message
		// (order_permlink_not_found). Never fast-path it.
		if (!oc.found) return false;
		orderResponseBypass = oc.ownedByRecipient && oc.live;
	}

	// Did the recipient write to this sender through US, recently enough that
	// `chat_messages` has not caught up? That is the ordinary marketplace reply,
	// and the durable answer is 45-63 s late for exactly the person waiting.
	// Our own relay log is first-hand and already proven by the chain's
	// acceptance. See recentOutboundChat.ts.
	if (hasRecentOutboundChat(located.recipient, located.signer)) return true;

	// A genuine two-way conversation — the recipient has replied — is never
	// metered: two people mid-negotiation are not strangers.
	const recipientReplied = await recipientHasReplied(db, {
		recipient: located.recipient,
		sender: located.signer
	});
	if (recipientReplied) return true;

	// Otherwise only a response to the recipient's own live order. A
	// first-contact stranger with no such order never passes, so neither the
	// push nor the replay can become a spam vector.
	if (!orderResponseBypass) return false;
	// First contact, allowed by policy — but from a channel that may cost the
	// sender nothing. Meter it there. See fastNotifyBudget.ts.
	if (opts.meterFirstContact === true) {
		return spendFastNotifyBudget(located.signer, located.recipient);
	}
	return true;
}
