/**
 * Morphit — block-list op broadcaster.
 *
 * Builds a `morphit_block_v1` custom_json and broadcasts it with
 * the user's posting key. The indexer records (or reverses) the
 * block relationship in the `blocks` table, gating subsequent
 * chat messages from the blocked account to this recipient.
 *
 * Op shape (indexer contract):
 *   {
 *     v: 1,
 *     blocked: "<account>",
 *     action: "block" | "unblock"
 *   }
 *
 * When to broadcast:
 *   - User taps the "Block" action in a chat or on a profile.
 *     → broadcastBlock(live, otherAccount).
 *   - User revokes a previous block via the Settings > Blocked
 *     Accounts list. → broadcastUnblock(live, otherAccount).
 *
 * Idempotency: the handler accepts re-blocks and re-unblocks
 * silently (no DB mutation). The caller doesn't need to
 * refetch-before-broadcast to know the current state — just
 * issue the intent and trust the indexer to converge.
 *
 * Finding H layer 1. See docs/REVISIT-LIST.md §Finding H for
 * the belt-and-suspenders rationale.
 */

// cp165 byte-budget: broadcastCustomJson is dynamically imported
// at the call site below so dblurt (a 2 MB chunk) doesn't land in
// the eager-load graph of routes that pull this ops file for its
// types/helpers but don't immediately trigger a broadcast.
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import { getUserBlurtAccount, BroadcastError } from './profile';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** On-wire payload shape. Kept minimal; the indexer re-derives
 *  blocker from the signer. */
export interface BlockPayload {
	readonly v: 1;
	readonly blocked: string;
	readonly action: 'block' | 'unblock';
	/** Unix seconds at op production. Not used by the handler
	 *  (block time comes from the chain), but useful as a
	 *  client-side timestamp when displaying a pending op. */
	readonly ts: number;
}

async function broadcastBlockOp(
	live: LiveIdentity,
	blocked: string,
	action: 'block' | 'unblock'
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	if (!ACCOUNT_NAME_RE.test(blocked)) {
		throw new Error(`broadcastBlockOp: invalid blocked account name: ${blocked}`);
	}
	if (blocked === account) {
		throw new Error('broadcastBlockOp: cannot block self');
	}
	const body: BlockPayload = {
		v: 1,
		blocked,
		action,
		ts: Math.floor(Date.now() / 1000)
	};
	const { broadcastCustomJson } = await import('../sign');
	return await broadcastCustomJson(live, OP_IDS.block, body, account);
}

/** Block `blocked` from sending further chat messages to us. */
export async function broadcastBlock(
	live: LiveIdentity,
	blocked: string
): Promise<{ block_num: number; trx_id: string }> {
	return broadcastBlockOp(live, blocked, 'block');
}

/** Reverse a previous block of `blocked`. */
export async function broadcastUnblock(
	live: LiveIdentity,
	blocked: string
): Promise<{ block_num: number; trx_id: string }> {
	return broadcastBlockOp(live, blocked, 'unblock');
}
