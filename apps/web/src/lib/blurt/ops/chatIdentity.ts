/**
 * Morphit — chat identity op broadcaster.
 *
 * Builds a `morphit_chat_identity_v1` custom_json payload and
 * broadcasts it with the user's posting key. The indexer records
 * the published X25519 chat pubkey in the `chat_identities` table
 * (ADR-0015, migration v13).
 *
 * This op is broadcast automatically by the UI — on first chat
 * interaction, if the user has never published — so there is no
 * "set up chat" screen the user sees. Key derivation (from the
 * posting priv) is deterministic, so this op is idempotent in
 * effect: broadcasting twice produces the same row.
 */

// cp165 byte-budget: broadcastCustomJson is dynamically imported
// at the call site below so dblurt (a 2 MB chunk) doesn't land in
// the eager-load graph of routes that pull this ops file for its
// types/helpers but don't immediately trigger a broadcast.
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import { getUserBlurtAccount, BroadcastError } from './profile';

/** Body shape. Kept narrow — just the pubkey. Schema version in
 *  `v` field so a future rotation-with-reason op can be
 *  distinguished if we ever need that. */
export interface ChatIdentityPayload {
	readonly v: 1;
	/** Base64 of the 32-byte X25519 public key. Must be
	 *  canonically-encoded (libsodium's `base64_variants.ORIGINAL`
	 *  is what the indexer's handler checks against). */
	readonly chat_pub: string;
	/** Unix seconds at which the op was produced — helps the
	 *  indexer tiebreak when multiple ops land in the same
	 *  block (rare but possible after a rotation). */
	readonly ts: number;
}

/**
 * Broadcast a `morphit_chat_identity_v1` op for the current
 * account. Throws `BroadcastError('no_account', ...)` if the
 * user has no Blurt account on file.
 *
 * The caller is responsible for computing `chat_pub` via
 * `deriveChatIdentity` in `$lib/chat/crypto.ts` + encoding with
 * `encodeChatPub`. This module does not touch crypto directly.
 */
export async function broadcastChatIdentity(
	live: LiveIdentity,
	chatPubBase64: string
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	const body: ChatIdentityPayload = {
		v: 1,
		chat_pub: chatPubBase64,
		ts: Math.floor(Date.now() / 1000)
	};
	const { broadcastCustomJson } = await import('../sign');
	return await broadcastCustomJson(live, OP_IDS.chatIdentity, body, account);
}
