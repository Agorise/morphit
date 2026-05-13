/**
 * Morphit — chat read-ack op broadcaster.
 *
 * Builds a `morphit_chat_read_v1` custom_json and broadcasts it
 * with the user's posting key. The indexer records the read-ack
 * in the `chat_read_state` table (Phase B inbox read receipts).
 *
 * When to broadcast:
 *   - The user opens a conversation at /chat/[peer]. Broadcast an
 *     ack with last_read_at = the most-recent message timestamp
 *     visible in that conversation.
 *   - The user explicitly "marks as read" from the inbox. Broadcast
 *     an ack with last_read_at = that conversation's
 *     last_message_at.
 *   - The user "marks all as read" from the inbox. Broadcast one
 *     ack per unread conversation (the handler deduplicates, and
 *     acks are cheap chain ops — no coalesced multi-peer op
 *     needed for typical inbox sizes).
 *
 * Monotonic advance: the handler rejects acks with a timestamp
 * earlier than the stored value, so out-of-order delivery from
 * multiple devices doesn't regress read state. Clients don't need
 * to track that themselves — just broadcast whenever the user's
 * visible read position advances.
 */

import { broadcastCustomJson } from '../sign';
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import { getUserBlurtAccount, BroadcastError } from './profile';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/** Body shape. Parallel to other chat ops. */
export interface ChatReadPayload {
	readonly v: 1;
	/** Peer whose conversation we're ack'ing reads for. */
	readonly peer: string;
	/** ISO 8601 UTC timestamp through which we've read. Any
	 *  chat_messages.created_at <= this is marked read. */
	readonly last_read_at: string;
	/** Unix seconds at which the op was produced. Tiebreak /
	 *  audit aid. */
	readonly ts: number;
}

/**
 * Broadcast a `morphit_chat_read_v1` op for the current account.
 *
 * @param live The session's LiveIdentity (posting key).
 * @param peer Blurt account name of the conversation peer.
 * @param lastReadAt Timestamp through which reads are
 *                   acknowledged. Defaults to "now" — the common
 *                   case where the user just finished reading
 *                   everything visible in the conversation.
 *
 * @throws BroadcastError('no_account') if the user has no Blurt
 *         account on file. This is the user-facing condition
 *         callers already handle for other broadcasters.
 * @throws Error on structural-invariant violations (invalid peer
 *         name, self-chat). These shouldn't happen from real UI
 *         flows — the caller got `peer` from a
 *         ConversationSummary or a validated route param. We use
 *         plain Error to signal programmer error, not a localized
 *         user message.
 */
export async function broadcastChatRead(
	live: LiveIdentity,
	peer: string,
	lastReadAt: Date = new Date()
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	if (!ACCOUNT_NAME_RE.test(peer)) {
		throw new Error(`broadcastChatRead: invalid peer account name: ${peer}`);
	}
	if (peer === account) {
		throw new Error('broadcastChatRead: cannot ack reads for self-chat');
	}
	const body: ChatReadPayload = {
		v: 1,
		peer,
		last_read_at: lastReadAt.toISOString(),
		ts: Math.floor(Date.now() / 1000)
	};
	return broadcastCustomJson(live, OP_IDS.chatRead, body, account);
}
