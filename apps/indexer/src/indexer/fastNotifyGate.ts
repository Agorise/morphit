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
import {
	checkChatOrder,
	noReplyLimitRefusal,
	noReplyLimits,
	recipientHasReplied,
	senderAdmittedWithoutReply,
	type ChatGateDb
} from '$indexer/chatGates';
import { validateChatOrderPermlink } from '$indexer/permlink';
import { hasRecentOutboundChat } from '$indexer/recentOutboundChat';
import { spendFastNotifyBudget } from '$indexer/fastNotifyBudget';
import { hasHeadStrangerFee } from '$indexer/headStrangerFees';

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

	// A sender the durable gate already admits without a reply: one who paid
	// the stranger fee for this recipient, or whose earlier message to them was
	// admitted (handlers/chat.ts layer 2, same conditions). Not metered: the fee
	// is paid on chain, and an earlier admitted message was itself gated. The
	// one-push-per-day-until-reply cap still applies to the push
	// (chatPushEnqueue.ts). (v1.21.14 full chat audit, S-H3.)
	if (!orderResponseBypass) {
		// A fee the head tailer has just seen and checked counts too: the durable
		// row is a minute behind the payment (headStrangerFees.ts).
		const admitted =
			hasHeadStrangerFee(located.signer, located.recipient) ||
			(await senderAdmittedWithoutReply(db, {
				recipient: located.recipient,
				sender: located.signer
			}));
		if (!admitted) return false;
	}

	// THE NO-REPLY CAPS, as the durable handler counts them (one query,
	// chatGates.noReplyLimits): 50 unanswered messages per pair, 20 new senders
	// per recipient a day. Without them a sender with one admitted message — or
	// answering the recipient's order — had message 51 onward announced, and a
	// 21st paying stranger too, all refused durably (independent review of the
	// audit fixes, finding 2). This sender's own messages announced here and
	// not stored yet are counted on top of the per-pair count (each message
	// once, by its client tag), so a burst cannot outrun it. NOT on top of the
	// fan-in: anyone can push signed messages they never broadcast, and 20
	// such senders would otherwise have silenced a seller's real buyers for
	// free (independent review 2, finding 1) — the fan-in is the durable count.
	const limits = await noReplyLimits(db, {
		recipient: located.recipient,
		sender: located.signer,
		at
	});
	const tag = announcementKey(located);
	const pending = pendingForPair(located.signer, located.recipient, tag, Date.now());
	if (
		noReplyLimitRefusal({
			fanIn: limits.fanIn,
			perPair: limits.perPair === null ? null : limits.perPair + pending
		}) !== null
	)
		return false;

	if (orderResponseBypass && opts.meterFirstContact === true) {
		// Otherwise only a response to the recipient's own live order. First
		// contact, allowed by policy — but from a channel that may cost the
		// sender nothing. Meter it there. See fastNotifyBudget.ts.
		if (!spendFastNotifyBudget(located.signer, located.recipient)) return false;
	}
	noteAnnouncement(located.signer, located.recipient, tag, Date.now());
	return true;
}

/** How long an announced message counts towards the caps before the durable
 *  count includes it (the durable lag is about a minute). */
const ANNOUNCED_WINDOW_MS = 3 * 60 * 1000;
const ANNOUNCED_MAX = 10_000;
/** sender\0recipient → message key → when it was announced, within the window. */
const announced = new Map<string, Map<string, number>>();
let announcedCount = 0;

/** One message, however many routes or rechecks gate it: its client tag, or
 *  its ciphertext when it has none. */
function announcementKey(located: LocatedChatOp): string {
	const tag = (located as { clientTag?: unknown }).clientTag;
	if (typeof tag === 'string' && tag !== '') return `t:${tag}`;
	return `c:${String((located as { ciphertext?: unknown }).ciphertext ?? '').slice(0, 64)}`;
}

/** This pair's OTHER messages announced within the window (not this one). */
function pendingForPair(sender: string, recipient: string, key: string, now: number): number {
	const k = `${sender}\u0000${recipient}`;
	const byMsg = announced.get(k);
	if (byMsg === undefined) return 0;
	let n = 0;
	for (const [m, t] of byMsg) {
		if (now - t > ANNOUNCED_WINDOW_MS) {
			byMsg.delete(m);
			announcedCount--;
		} else if (m !== key) n++;
	}
	if (byMsg.size === 0) announced.delete(k);
	return n;
}

function noteAnnouncement(sender: string, recipient: string, key: string, now: number): void {
	if (announcedCount >= ANNOUNCED_MAX) {
		announced.clear();
		announcedCount = 0;
	}
	const k = `${sender}\u0000${recipient}`;
	let byMsg = announced.get(k);
	if (byMsg === undefined) {
		byMsg = new Map();
		announced.set(k, byMsg);
	}
	if (!byMsg.has(key)) announcedCount++;
	byMsg.set(key, now);
}

/** Test seam. */
export function _resetFastNotifyGateForTest(): void {
	announced.clear();
	announcedCount = 0;
}
