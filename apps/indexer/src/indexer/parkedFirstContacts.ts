/**
 * First contacts waiting for their stranger fee to be recognised
 * (v1.21.14 full chat audit, S-H3).
 *
 * WHY. A paid first contact is two transactions: the fee, then the message.
 * The message can reach this instance first — pushed by the sender's instance
 * over the federation, delivered locally, or in the same head block as the fee
 * — while the fee is still being checked (its ACTIVE signature needs a quorum
 * key read, headStrangerFees.ts). The notify gate then says no: the message is
 * shown live in an open chatroom but not announced, not pushed, not replayed.
 * And it is never looked at again — every fast route marks it emitted — so the
 * paid message reached the inbox only at durable time, 45-63 s later.
 *
 * WHAT. A message the gate refused is parked here, briefly, keyed by
 * (sender → recipient). When a stranger fee for exactly that pair is
 * recognised at the head, each parked message is gated AGAIN (the same gate,
 * the same admission clock) and, if it now passes, emitted again as
 * replayable and pushed. The open chatroom already showed it; the browser
 * collapses the second copy by client tag. The block list is asked again
 * first: a recipient who blocked the sender while the message waited is not
 * notified (independent review of the audit fixes, finding 10).
 *
 * Bounded: PARK_TTL_MS, PARK_PER_PAIR per pair, PARK_MAX in all. Nothing here
 * decides admission: the gate does, as before.
 */

import { chatEventBus } from '$indexer/chatEventBus';
import { hasHeadStrangerFee, onHeadStrangerFee } from '$indexer/headStrangerFees';
import type { LocatedChatOp } from '$indexer/headTailer';

export const PARK_TTL_MS = 2 * 60 * 1000;
export const PARK_PER_PAIR = 5;
/** Parked messages of one SENDER, across recipients: a few accounts pushing
 *  messages they never broadcast must not fill the table for everyone
 *  (independent review 2, finding 9). */
export const PARK_PER_SENDER = 10;
export const PARK_MAX = 5_000;

export interface ParkedFirstContact {
	readonly located: LocatedChatOp;
	readonly trxId: string;
	/** Display time, as first emitted. */
	readonly createdAt: Date;
	/** The admission clock the gate was first asked with. */
	readonly gateAt: Date;
	/** Has the recipient blocked the sender (the route's own check, head blocks
	 *  included)? Asked again at release. */
	readonly blocked: (located: LocatedChatOp) => Promise<boolean>;
	/** The same gate that refused it. */
	readonly gate: (located: LocatedChatOp, at: Date) => Promise<boolean>;
	/** The same push enqueue the route uses once the gate passes. */
	readonly notify: (located: LocatedChatOp, trxId: string, createdAt: Date) => Promise<void>;
}

interface Entry {
	readonly item: ParkedFirstContact;
	readonly at: number;
}

const parked = new Map<string, Entry[]>();
/** sender → messages parked for it, across recipients. */
const bySender = new Map<string, number>();
let total = 0;

function countSender(sender: string, delta: number): void {
	const n = (bySender.get(sender) ?? 0) + delta;
	if (n <= 0) bySender.delete(sender);
	else bySender.set(sender, n);
}
const senderOf = (k: string): string => k.slice(0, k.indexOf('\u0000'));
let released = 0;

const pairKey = (sender: string, recipient: string): string => `${sender}\u0000${recipient}`;

function prune(now: number): void {
	for (const [k, list] of parked) {
		const keep = list.filter((e) => now - e.at <= PARK_TTL_MS);
		total -= list.length - keep.length;
		countSender(senderOf(k), keep.length - list.length);
		if (keep.length === 0) parked.delete(k);
		else if (keep.length !== list.length) parked.set(k, keep);
	}
}

/**
 * Park a message the notify gate refused. If a fee for the pair is ALREADY
 * known — recognised while the gate was being asked — it is released at once.
 */
export function parkFirstContact(item: ParkedFirstContact, now: number = Date.now()): void {
	const { signer, recipient } = item.located;
	if (signer === recipient) return;
	if (total >= PARK_MAX) prune(now);
	if (total >= PARK_MAX) return;
	const k = pairKey(signer, recipient);
	const list = parked.get(k) ?? [];
	if (list.some((e) => e.item.trxId === item.trxId)) return;
	if (list.length >= PARK_PER_PAIR) return;
	if ((bySender.get(signer) ?? 0) >= PARK_PER_SENDER) prune(now);
	if ((bySender.get(signer) ?? 0) >= PARK_PER_SENDER) return;
	list.push({ item, at: now });
	parked.set(k, list);
	total++;
	countSender(signer, 1);
	if (hasHeadStrangerFee(signer, recipient, now)) void releaseFirstContacts(signer, recipient, now);
}

/** A stranger fee for (sender → recipient) was recognised: gate each parked
 *  message again and announce the ones that now pass. Never throws. */
export async function releaseFirstContacts(
	sender: string,
	recipient: string,
	now: number = Date.now()
): Promise<number> {
	const k = pairKey(sender, recipient);
	const list = parked.get(k);
	if (list === undefined) return 0;
	parked.delete(k);
	total -= list.length;
	countSender(sender, -list.length);
	let n = 0;
	for (const { item, at } of list) {
		if (now - at > PARK_TTL_MS) continue;
		const { located, trxId, createdAt, gateAt } = item;
		try {
			if (await item.blocked(located)) continue;
			if (!(await item.gate(located, gateAt))) continue;
			const lo = located.signer < located.recipient ? located.signer : located.recipient;
			const hi = located.signer < located.recipient ? located.recipient : located.signer;
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
				replayable: true
			});
			n++;
			released++;
			await item.notify(located, trxId, createdAt).catch(() => undefined);
		} catch {
			// The durable path still delivers it.
		}
	}
	return n;
}

onHeadStrangerFee((payer, recipient) => {
	void releaseFirstContacts(payer, recipient);
});

export function parkedFirstContactsStatus(): { parked: number; released: number } {
	return { parked: total, released };
}

/** Test seam. */
export function _resetParkedFirstContactsForTest(): void {
	parked.clear();
	bySender.clear();
	total = 0;
	released = 0;
}
