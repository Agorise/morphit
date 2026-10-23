/**
 * Who an order belongs to, for the trade-payload gate (v1.21.14 full chat
 * audit, W-H1).
 *
 * A structured trade payload (an address to pay, a payment claim) moves the
 * trade store only when it arrived in the thread about the order it names AND
 * its sender is a party to that order. A chat thread is between the local user
 * and one peer, so the parties are: the order's owner, and, for an order the
 * local user posted, whoever answers it. In other words: the order must belong
 * to the sender or to the local user. Before, an order named inside a message
 * was taken at its word: a peer in an unrelated direct message could mark the
 * local user's trade with someone else as paid, or overwrite the amount and
 * memo it asked for.
 *
 * Both accounts may have an order by the same permlink; the thread names
 * only the permlink, so the sender's is taken first.
 *
 * The owner is read with `findOrder` (the single-order read of this
 * instance's indexer, whatever the order's state). A definite "yes" is kept
 * for the session: an order never changes owner. A "no" is not kept (a
 * freshly posted order may not be indexed yet), and a failed read is
 * "unknown" — the caller then leaves the payload's effects for the next
 * delivery of the message instead of guessing either way.
 */

import { findOrder } from '$lib/indexer/client';

/** account + permlink → that account has that order (positive answers only). */
const owned = new Set<string>();
/** Bound on `owned`: a session that has seen this many orders starts over. */
const OWNED_MAX = 500;

export type OrderLookup = (
	account: string,
	permlink: string
) => Promise<unknown | null | undefined>;

async function owns(
	account: string,
	permlink: string,
	lookup: OrderLookup
): Promise<boolean | null> {
	const key = `${account}\u0000${permlink}`;
	if (owned.has(key)) return true;
	let r: unknown;
	try {
		r = await lookup(account, permlink);
	} catch {
		return null;
	}
	if (r === undefined) return null;
	if (r === null) return false;
	if (owned.size >= OWNED_MAX) owned.clear();
	owned.add(key);
	return true;
}

/**
 * Whose order `permlink` is, in the thread between `sender` and `me`: `sender`
 * when they have an order by that permlink (asked first, as the conversation
 * list and the chat view do), else `me` when we have one; false when neither;
 * null when it could not be told (a read failed). The trade store is keyed by
 * this owner (review C-L3).
 */
export async function orderOwnerOf(
	permlink: string,
	sender: string,
	me: string,
	lookup: OrderLookup = findOrder
): Promise<string | false | null> {
	const theirs = await owns(sender, permlink, lookup);
	if (theirs === true) return sender;
	// Theirs could not be told: neither can whose it is.
	if (theirs === null) return null;
	const mine = await owns(me, permlink, lookup);
	if (mine === true) return me;
	return mine === null ? null : false;
}

/** For tests: forget every answer. */
export function __resetOrderParties(): void {
	owned.clear();
}
